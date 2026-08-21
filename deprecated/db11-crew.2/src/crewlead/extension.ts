import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import Type, { type TSchema } from "typebox";

import { GitDispositionAdapter } from "../adapters/git/disposition.ts";
import {
  GitIsolationService,
  type BuilderAllocationPlan,
  type MutableScopeOwner,
} from "../adapters/git/isolation.ts";
import { Protocol17HerdrAdapter, type HerdrAdapter } from "../adapters/herdr/adapter.ts";
import {
  TerminalDeliveryService,
  type DeliveryBatch,
  type DeliveryIdentity,
  type HumanNotification,
} from "../delivery/service.ts";
import { TransientProgressQueue } from "../delivery/transient.ts";
import {
  assertFreshSessionDestination,
  launchMember,
  verifyLaunchResources,
} from "../adapters/pi/launcher.ts";
import { minimalCommandEnvironment, runBoundedCommand } from "../adapters/process.ts";
import {
  DEFAULT_CONFIGURATION,
  configurationPath,
  parseConfigurationText,
  type EffectiveConfiguration,
  type RoleId,
  type RuntimeOverride,
} from "../config/config.ts";
import { LifecycleService } from "../orchestration/lifecycle.ts";
import {
  BuilderIntegrationService,
  RepositoryCleanupService,
  RuntimeCleanupService,
} from "../orchestration/disposition.ts";
import {
  COMPATIBILITY_DESCRIPTOR,
  resolveCompatibility,
  type CompatibilityReadiness,
} from "../protocol/compatibility.ts";
import { AmendmentSchema, TaskPacketSchema } from "../protocol/contracts.ts";
import { LIMITS, SCHEMA_VERSION } from "../protocol/limits.ts";
import {
  BUILT_IN_ROLE_MANIFEST,
  resolveRoleReadiness,
  type RoleReadinessReceipt,
} from "../roles/resolve.ts";
import { RunCapabilityManager } from "../security/capabilities.ts";
import { redactDiagnostic } from "../security/redaction.ts";
import { installSetupCommands } from "../setup/commands.ts";
import { FencedLeaseManager } from "../state/leases.ts";
import { DurableStateStore } from "../state/store.ts";
import { SecureStateRoot } from "../state/filesystem.ts";
import { DurableDeliveryClaims, DurableNotificationReceipts } from "../state/claims.ts";
import { CrewObservabilityService, CrewleadUIController } from "../ui/observability.ts";
import {
  classifyCrewleadActivationInput,
  createCrewleadDesignation,
  CREWLEAD_DESIGNATION_ENTRY_TYPE,
  hasCurrentCrewleadDesignation,
  isManagedMemberSession,
  withCrewleadTools,
  withoutCrewleadTools,
} from "./activation.ts";
import {
  CrewleadRuntime,
  lifecycleCapacityDiagnostic,
  type CrewleadRuntimeDependencies,
  type BuilderWorkspacePlan,
  type CrewleadIdentity,
  type DispatchReceipt,
  type ResultSection,
  type TaskPacket,
} from "./runtime.ts";

interface ManifestResource {
  id: string;
  packageName: string;
  packageVersion: string;
  resourcePath: string;
  sha256: string;
  npmIntegrity?: string;
}

interface ManifestRole {
  id: RoleId;
  profileVersion: 2;
  profilePath: string;
  profileSha256: string;
}

interface ManifestValue {
  resources: ManifestResource[];
  roles: ManifestRole[];
}

export interface CrewleadRuntimePreparation {
  initialize(): Promise<CrewleadRuntime | undefined>;
}

export interface CrewleadExtensionOptions {
  extensionPath: string;
  environment?: NodeJS.ProcessEnv;
  /** Testable nonmutating preparation boundary. Production uses the canonical preparation below. */
  prepareRuntime?: (ctx: ExtensionContext) => Promise<CrewleadRuntimePreparation | undefined>;
  /** Testable mutating initialization boundary used after preparation. */
  createRuntime?: (ctx: ExtensionContext) => Promise<CrewleadRuntime | undefined>;
}

const Identifier = Type.String({
  minLength: 1,
  maxLength: LIMITS.idLength,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});
const EvidenceRefs = Type.Array(
  Type.String({ minLength: 1, maxLength: LIMITS.referenceLength }),
  { minItems: 1, maxItems: LIMITS.listItems, uniqueItems: true },
);
const closed = <Properties extends Parameters<typeof Type.Object>[0]>(properties: Properties) =>
  Type.Object(properties, { additionalProperties: false });

function providerCompatibleSchema(schema: TSchema): TSchema {
  const visit = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map(visit);
    const value = structuredClone(input) as Record<string, unknown>;
    if (Object.hasOwn(value, "const") && ["string", "number", "boolean"].includes(typeof value.const)) {
      const constant = value.const as string | number | boolean;
      delete value.const;
      value.type = typeof constant;
      value.enum = [constant];
    }
    if (
      Array.isArray(value.anyOf) &&
      value.anyOf.length > 0 &&
      value.anyOf.every((candidate) =>
        candidate !== null && typeof candidate === "object" &&
        ["string", "number", "boolean"].includes(typeof (candidate as { const?: unknown }).const))
    ) {
      const constants = value.anyOf.map((candidate) =>
        (candidate as { const: string | number | boolean }).const);
      delete value.anyOf;
      value.type = typeof constants[0];
      value.enum = constants;
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
  };
  return visit(schema) as TSchema;
}

function text(value: unknown, maximum = 48 * 1_024) {
  const serialized = JSON.stringify(value);
  const bytes = Buffer.byteLength(serialized, "utf8");
  const truncated = bytes > maximum;
  const output = truncated
    ? JSON.stringify({
        truncated: true,
        bytes,
        maximumBytes: maximum,
        message: "Use a narrower structured result section or a smaller list limit.",
      })
    : serialized;
  return {
    content: [{ type: "text" as const, text: output }],
    details: { truncated },
  };
}

function version(textValue: Buffer, pattern: RegExp): string {
  const match = pattern.exec(textValue.toString("utf8"));
  if (!match?.[1]) throw new Error("A required runtime version could not be parsed.");
  return match[1];
}

async function packageVersion(packageName: string, from: string): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.resolve(packageName, pathToFileURL(from).href)));
  while (true) {
    try {
      const value = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (value.name === packageName && typeof value.version === "string") return value.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("A package version could not be verified.");
}

async function loadConfiguration(environment: NodeJS.ProcessEnv): Promise<EffectiveConfiguration> {
  const home = environment.HOME;
  if (!home || !isAbsolute(home)) throw new Error("The account home is unavailable.");
  try {
    const parsed = parseConfigurationText(await readFile(configurationPath(home)));
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIGURATION;
    throw error;
  }
}

async function compatibility(
  cwd: string,
  extensionPath: string,
  herdr: HerdrAdapter,
): Promise<CompatibilityReadiness> {
  const [probe, git, wyrd, piVersion] = await Promise.all([
    herdr.probe(),
    runBoundedCommand("git", ["--version"], {
      cwd,
      environment: minimalCommandEnvironment(),
      maximumOutputBytes: 4_096,
      timeoutMilliseconds: 5_000,
    }),
    runBoundedCommand("wyrd", ["--version"], {
      cwd,
      environment: minimalCommandEnvironment(),
      maximumOutputBytes: 4_096,
      timeoutMilliseconds: 5_000,
    }),
    packageVersion("@earendil-works/pi-coding-agent", extensionPath),
  ]);
  return resolveCompatibility({
    schemaVersion: SCHEMA_VERSION,
    platform: "linux",
    pi: {
      version: piVersion,
      capabilities: [...COMPATIBILITY_DESCRIPTOR.pi.requiredCapabilities],
    },
    herdr: {
      version: probe.version,
      protocol: probe.protocol,
      apiSchema: probe.apiSchema,
      capabilities: [...probe.capabilities],
    },
    wyrd: {
      version: version(wyrd.stdout, /(?:wyrd\s+)?([0-9]+\.[0-9]+\.[0-9]+)/u),
      capabilities: [...COMPATIBILITY_DESCRIPTOR.wyrd.requiredCapabilities],
    },
    git: {
      version: version(git.stdout, /git version ([0-9]+\.[0-9]+\.[0-9]+)/u),
      capabilities: [...COMPATIBILITY_DESCRIPTOR.git.requiredCapabilities],
    },
  });
}

function packageRootFromExtension(extensionPath: string): string {
  return resolve(dirname(extensionPath), "../../../..");
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function defaultRuntimePreparation(
  ctx: ExtensionContext,
  options: CrewleadExtensionOptions,
): Promise<CrewleadRuntimePreparation | undefined> {
  const environment = options.environment ?? process.env;
  if (
    !ctx.isProjectTrusted() ||
    !ctx.sessionManager.getSessionFile() ||
    environment.HERDR_ENV !== "1" ||
    !environment.HERDR_SOCKET_PATH ||
    !environment.HERDR_WORKSPACE_ID ||
    !environment.HERDR_PANE_ID ||
    !isAbsolute(environment.HERDR_SOCKET_PATH) ||
    normalize(environment.HERDR_SOCKET_PATH) !== environment.HERDR_SOCKET_PATH
  ) {
    return undefined;
  }
  const socketPath = environment.HERDR_SOCKET_PATH;
  const workspaceId = environment.HERDR_WORKSPACE_ID;
  const paneId = environment.HERDR_PANE_ID;
  const extensionPath = await realpath(options.extensionPath);
  const packageRoot = await realpath(packageRootFromExtension(extensionPath));
  const git = new GitIsolationService();
  const source = await git.discover(ctx.cwd);
  const herdr = new Protocol17HerdrAdapter({ socketPath });
  const pane = await herdr.getPane(paneId);
  if (pane.workspaceId !== workspaceId || !pane.cwd) return undefined;
  const paneSource = await git.discover(pane.cwd);
  if (
    paneSource.identity.canonicalRoot !== source.identity.canonicalRoot ||
    paneSource.identity.commonGitDirectoryDigest !== source.identity.commonGitDirectoryDigest
  ) {
    return undefined;
  }
  const configuration = await loadConfiguration(environment);
  const compatibilityReadiness = await compatibility(source.identity.canonicalRoot, extensionPath, herdr);
  if (!compatibilityReadiness.ready) return undefined;
  const verified = await verifyLaunchResources(packageRoot, "builder");
  const memberExtensionSha256 = await sha256File(verified.memberCompanionPath);
  if (await SecureStateRoot.inspectDefault() === "blocked") return undefined;

  return {
    initialize: async () => {
  const root = await SecureStateRoot.openDefault();
  const store = await DurableStateStore.openRoot(root);
  const lifecycle = new LifecycleService(store, configuration.limits);
  const capabilities = new RunCapabilityManager(root);
  const leases = new FencedLeaseManager(root);
  const manifest = BUILT_IN_ROLE_MANIFEST as ManifestValue;

  const resolveReadiness = async (
    role: RoleId,
    explicitRuntime?: RuntimeOverride,
  ): Promise<RoleReadinessReceipt> => {
    const profile = manifest.roles.find((candidate) => candidate.id === role);
    if (!profile || !ctx.model) throw new Error("The requested role profile is unavailable.");
    const thinking = ctx.thinkingLevel ?? "off";
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
    const availableModels = ctx.scopedModels.length > 0
      ? ctx.scopedModels.map((entry) => entry.model)
      : ctx.modelRegistry.getAvailable();
    const availableRuntimes = availableModels.map((model) => ({
      provider: model.provider,
      model: model.id,
      thinkingLevels: model.reasoning
        ? levels.filter((level) => model.thinkingLevelMap?.[level] !== null)
        : ["off" as const],
    }));
    const observedProfile = {
      profileVersion: profile.profileVersion,
      profilePath: profile.profilePath,
      profileSha256: await sha256File(join(packageRoot, profile.profilePath)),
    };
    const observedResources = await Promise.all(manifest.resources.map(async (resource) => ({
      ...resource,
      sha256: await sha256File(join(packageRoot, resource.resourcePath)),
    })));
    return resolveRoleReadiness({
      role,
      configuration,
      compatibility: compatibilityReadiness,
      profile: observedProfile,
      resources: observedResources,
      availableRuntimes,
      explicitRuntime,
      crewleadRuntime: {
        provider: ctx.model.provider,
        model: ctx.model.id,
        thinking,
      },
    });
  };

  const workspaceDestinations = async (runId: string) => {
    const sessionParent = "runtime/sessions";
    await root.ensurePrivateDirectory("runtime/workspaces");
    await root.ensurePrivateDirectory(sessionParent);
    return {
      destinationPath: root.absolutePath(`runtime/workspaces/${runId}`),
      sessionDirectory: root.absolutePath(`${sessionParent}/${runId}`),
    };
  };

  const prepareWorkspace: CrewleadRuntimeDependencies["prepareWorkspace"] = async (run) => {
    if (run.role === "builder") throw new Error("Builder workspace creation requires a durable allocation plan.");
    const { destinationPath, sessionDirectory } = await workspaceDestinations(run.runId);
    const record = await git.createReadSnapshot({
      runId: run.runId,
      sourcePath: source.identity.canonicalRoot,
      destinationPath,
    });
    return {
      assignedRoot: record.path,
      sessionDirectory,
      evidenceRef: `read-snapshot:${record.baselineManifest.digest}`,
      repositoryResource: {
        kind: "read_snapshot",
        runId: record.runId,
        source: structuredClone(record.source),
        path: record.path,
        sourceHead: record.sourceHead,
        baselineManifestDigest: record.baselineManifest.digest,
      },
    };
  };

  const planBuilderWorkspace: NonNullable<CrewleadRuntimeDependencies["planBuilderWorkspace"]> =
    async (run, packet): Promise<BuilderWorkspacePlan> => {
      const { destinationPath, sessionDirectory } = await workspaceDestinations(run.runId);
      await assertFreshSessionDestination(sessionDirectory);
      const latest = await git.discover(source.identity.canonicalRoot);
      if (!latest.attachedBranch) throw new Error("Builder dispatch requires an attached target branch.");
      const owners: MutableScopeOwner[] = [];
      for (const raw of await store.listRuns()) {
        const other = raw as unknown as { runId: string; role: RoleId; state: string };
        if (other.runId === run.runId || other.role !== "builder" || !["starting", "working", "blocked"].includes(other.state)) continue;
        const history = await store.readHistory(other.runId);
        const packetRecord = history.find((record) => record.kind === "control" &&
          record.payload !== null && typeof record.payload === "object" &&
          (record.payload as { packetId?: unknown }).packetId !== undefined);
        const otherPacket = packetRecord?.payload as TaskPacket | undefined;
        owners.push({
          runId: other.runId,
          repositoryDigest: source.identity.canonicalRootDigest,
          mutablePaths: otherPacket?.scope.mutablePaths,
        });
      }
      const adapterPlan = await git.planBuilderAllocation({
        runId: run.runId,
        sourcePath: source.identity.canonicalRoot,
        destinationPath,
        sessionDirectory,
        targetBranch: latest.attachedBranch,
        mutablePaths: packet.scope.mutablePaths,
        existingOwners: owners,
      });
      return {
        kind: "builder_allocation",
        assignedRoot: adapterPlan.path,
        sessionDirectory: adapterPlan.sessionDirectory,
        evidenceRef: `builder-allocation:${adapterPlan.branch}`,
        allocation: {
          runId: adapterPlan.runId,
          source: structuredClone(adapterPlan.source),
          sourceStatusDigest: adapterPlan.sourceStatusDigest,
          path: adapterPlan.path,
          sessionDirectory: adapterPlan.sessionDirectory,
          branch: adapterPlan.branch,
          branchRef: adapterPlan.branchRef,
          baseCommit: adapterPlan.baseCommit,
          targetBranch: adapterPlan.targetBranch,
          targetRef: adapterPlan.targetRef,
          targetCommit: adapterPlan.targetCommit,
          protectedRefDigest: adapterPlan.protectedRefDigest,
          automaticIntegrationEligible: adapterPlan.automaticIntegrationEligible,
        },
        adapterPlan,
      };
    };

  const createBuilderWorkspace: NonNullable<CrewleadRuntimeDependencies["createBuilderWorkspace"]> =
    async (run, _packet, plan) => {
      const adapterPlan = plan.adapterPlan as BuilderAllocationPlan | undefined;
      const current = await store.readRun(run.runId) as unknown as {
        revision: number;
        fencingEpoch: number;
        repositoryAllocation?: typeof run.repositoryAllocation;
      };
      const persisted = current.repositoryAllocation;
      if (
        !adapterPlan ||
        current.revision !== run.revision ||
        current.fencingEpoch !== run.fencingEpoch ||
        persisted?.status !== "prepared" ||
        persisted.runId !== run.runId ||
        persisted.path !== adapterPlan.path ||
        persisted.sessionDirectory !== adapterPlan.sessionDirectory ||
        persisted.branchRef !== adapterPlan.branchRef ||
        persisted.baseCommit !== adapterPlan.baseCommit ||
        persisted.targetRef !== adapterPlan.targetRef ||
        persisted.targetCommit !== adapterPlan.targetCommit ||
        persisted.protectedRefDigest !== adapterPlan.protectedRefDigest ||
        persisted.expectedRevision + 1 !== run.revision ||
        persisted.fencingEpoch !== run.fencingEpoch
      ) {
        throw new Error("The persisted Builder allocation no longer matches its exact plan.");
      }
      const record = await git.createBuilderWorktree(adapterPlan);
      return {
        assignedRoot: record.path,
        sessionDirectory: adapterPlan.sessionDirectory,
        evidenceRef: `builder-worktree:${record.branch}`,
        repositoryResource: {
          kind: "builder_worktree",
          runId: record.runId,
          source: structuredClone(record.source),
          path: record.path,
          branch: record.branch,
          branchRef: record.branchRef,
          baseCommit: record.baseCommit,
          targetBranch: record.targetBranch,
          targetRef: record.targetRef,
          targetCommit: record.targetCommit,
          protectedRefDigest: record.protectedRefDigest,
          automaticIntegrationEligible: record.automaticIntegrationEligible,
        },
      };
    };

  const identity: CrewleadIdentity = {
    crewleadSessionId: ctx.sessionManager.getSessionId(),
    herdrWorkspaceId: workspaceId,
    herdrPaneId: paneId,
    canonicalProjectPath: source.identity.canonicalRoot,
  };
  const gitDisposition = new GitDispositionAdapter();
  const runtimeCleanup = new RuntimeCleanupService(identity, { store, herdr }, {
    inspectionGraceMilliseconds: configuration.retention.inspectionGraceMilliseconds,
  });
  const integration = new BuilderIntegrationService(identity, { store, git: gitDisposition });
  const repositoryCleanup = new RepositoryCleanupService(identity, { store, git: gitDisposition });
  const runtime = new CrewleadRuntime(identity, {
    store,
    lifecycle,
    herdr,
    runtimeCleanup,
    integration,
    repositoryCleanup,
    capabilities,
    leases,
    configuration,
    memberExtensionSha256,
    resolveReadiness,
    prepareWorkspace,
    planBuilderWorkspace,
    createBuilderWorkspace,
    verifyBuilderResource: async (resource) => {
      await git.validateActiveBuilderResource(resource);
    },
    launch: async ({ run, packet, readiness, preparation, bootstrapPath }) => {
      const memberSessionId = run.binding.memberSessionId;
      if (!memberSessionId) throw new Error("The member session binding is unavailable.");
      return launchMember({
        packageRoot,
        herdr,
        runId: run.runId,
        memberSessionId,
        role: run.role,
        purpose: run.purposeLabel,
        herdrWorkspaceId: identity.herdrWorkspaceId,
        canonicalProjectPath: identity.canonicalProjectPath,
        repositoryResource: preparation.repositoryResource,
        assignedRoot: preparation.assignedRoot,
        projectTrusted: true,
        sessionDirectory: preparation.sessionDirectory,
        companionBootstrapPath: bootstrapPath,
        packet,
        readiness,
        sourceEnvironment: environment,
      });
    },
  });
  return runtime;
    },
  };
}

function receiptView(receipts: readonly DispatchReceipt[]) {
  return receipts.map((receipt) => ({
    runId: receipt.runId,
    role: receipt.role,
    purpose: receipt.purpose,
    state: receipt.state,
    revision: receipt.revision,
    queuedPosition: receipt.queuedPosition,
    resources: receipt.resources,
    warnings: receipt.warnings,
    readiness: receipt.readiness && {
      role: receipt.readiness.role,
      profileVersion: receipt.readiness.profileVersion,
      runtime: receipt.readiness.runtime,
      profile: receipt.readiness.profile,
      resources: receipt.readiness.resources,
    },
  }));
}

type CrewleadExtensionState = "undesignated" | "designated-unavailable" | "designated-active";

/** Register the passive Crewlead tool surface and bind it only after direct designation. */
export function installCrewleadExtension(pi: ExtensionAPI, options: CrewleadExtensionOptions): void {
  installSetupCommands(pi, {
    extensionPath: options.extensionPath,
    environment: options.environment,
  });
  let state: CrewleadExtensionState = "undesignated";
  let runtime: CrewleadRuntime | undefined;
  let initializationError: string | undefined;
  let activationChain: Promise<void> = Promise.resolve();
  let delivery: TerminalDeliveryService | undefined;
  let observability: CrewObservabilityService | undefined;
  let uiController: CrewleadUIController | undefined;
  let progressQueue: TransientProgressQueue | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let refreshChain: Promise<void> = Promise.resolve();
  let presentationStopping = false;
  let nextCleanupSweepAt = 0;

  const insertedDeliveryIds = (ctx: ExtensionContext): ReadonlySet<string> => {
    const ids = new Set<string>();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom_message" || entry.customType !== "db11-crew-terminal-delivery") continue;
      const details = entry.details as { deliveryIds?: unknown } | undefined;
      if (!Array.isArray(details?.deliveryIds)) continue;
      for (const value of details.deliveryIds) if (typeof value === "string") ids.add(value);
    }
    return ids;
  };

  const refreshPresentation = async (ctx: ExtensionContext): Promise<void> => {
    if (presentationStopping || !runtime || !delivery || !observability) return;
    if (Date.now() >= nextCleanupSweepAt) {
      nextCleanupSweepAt = Date.now() + LIMITS.inspectionGraceMinimumMilliseconds;
      await runtime.sweepRuntimeCleanup();
    }
    await delivery.reconcile({
      idle: ctx.isIdle(),
      hasPendingMessages: ctx.hasPendingMessages(),
      insertedDeliveryIds: insertedDeliveryIds(ctx),
    });
    if (uiController) uiController.render(await observability.snapshot());
  };

  const scheduleRefresh = (ctx: ExtensionContext): Promise<void> => {
    refreshChain = refreshChain.then(() => refreshPresentation(ctx)).catch(() => {
      // Durable state remains authoritative; a later bounded refresh retries.
    });
    return refreshChain;
  };

  const synchronizeToolSurface = (): void => {
    const current = pi.getActiveTools();
    pi.setActiveTools(state === "designated-active"
      ? withCrewleadTools(current)
      : withoutCrewleadTools(current));
  };

  const requireRuntime = (): CrewleadRuntime => {
    if (state !== "designated-active" || !runtime) {
      throw new Error(initializationError ?? "DB11 Crew is inactive until this exact session is directly designated and ready.");
    }
    return runtime;
  };

  const DispatchItemSchema = closed({
    role: StringEnum(["scout", "planner", "builder"] as const),
    purpose: Type.String({ minLength: 1, maxLength: LIMITS.labelLength }),
    packet: providerCompatibleSchema(TaskPacketSchema),
    runtime: Type.Optional(closed({
      provider: Type.Optional(Type.String({ minLength: 1, maxLength: LIMITS.labelLength, pattern: "^[^\\s\\u0000-\\u001F]+$" })),
      model: Type.Optional(Type.String({ minLength: 1, maxLength: LIMITS.idLength, pattern: "^[^\\s\\u0000-\\u001F]+$" })),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
    })),
    allowRedundantIntent: Type.Optional(Type.Boolean()),
  });

  pi.registerTool({
    name: "db11_crew_dispatch",
    label: "DB11 Crew Dispatch",
    description: "Atomically admit one explicit single or batch delegation, or explicitly queue it, then return after bounded startup without waiting for member work.",
    promptSnippet: "Dispatch an explicit bounded Scout, Planner, or Builder delegation asynchronously",
    promptGuidelines: [
      "Use db11_crew_dispatch only for explicit independently completable delegations; never infer queueing, decompose work automatically, or wait for completion.",
    ],
    executionMode: "sequential",
    parameters: closed({
      mode: StringEnum(["start", "queue"] as const),
      items: Type.Array(DispatchItemSchema, { minItems: 1, maxItems: LIMITS.stateBatchTransactions }),
      evidenceRefs: EvidenceRefs,
    }),
    async execute(id, params) {
      try {
        return text(receiptView(await requireRuntime().dispatch({ ...params, requestId: id })));
      } catch (error) {
        const capacity = lifecycleCapacityDiagnostic(error);
        if (capacity) return text({ status: "rejected", ...capacity });
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "db11_crew_list",
    label: "DB11 Crew List",
    description: "List bounded runs owned by this exact Crewlead session, Herdr workspace, and canonical project.",
    executionMode: "parallel",
    parameters: closed({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.listItems })) }),
    async execute(_id, params) {
      const runs = await requireRuntime().list(params.limit);
      return text(runs.map((run) => ({
        runId: run.runId,
        role: run.role,
        purpose: run.purposeLabel,
        state: run.state,
        revision: run.revision,
        observation: run.observation,
        resourceDisposition: run.resourceDisposition,
        health: run.health,
        queue: run.queue,
        startup: run.startup,
      })));
    },
  });

  pi.registerTool({
    name: "db11_crew_inspect",
    label: "DB11 Crew Inspect",
    description: "Inspect one exact owned run with optional immutable packet and result details.",
    executionMode: "parallel",
    parameters: closed({
      runId: Identifier,
      includePacket: Type.Optional(Type.Boolean()),
      includeResult: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params) {
      const inspected = await requireRuntime().inspect(params.runId);
      return text({
        run: inspected.run,
        blocker: inspected.blocker,
        resultAcknowledged: inspected.resultAcknowledged,
        ...(params.includePacket ? { packet: inspected.packet } : {}),
        ...(params.includeResult ? { result: inspected.result } : {}),
      });
    },
  });

  pi.registerTool({
    name: "db11_crew_amend",
    label: "DB11 Crew Amend",
    description: "Append and submit one revision-checked same-task Crewlead amendment; scope expansion requires a new dispatch.",
    executionMode: "sequential",
    parameters: closed({
      runId: Identifier,
      expectedRevision: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
      kind: StringEnum(["correction", "clarification", "input", "narrowing", "recovery"] as const),
      summary: Type.String({ minLength: 1, maxLength: LIMITS.amendmentTextLength }),
      evidenceRefs: EvidenceRefs,
    }),
    async execute(_id, params) {
      return text(await requireRuntime().amend(params));
    },
  });

  pi.registerTool({
    name: "db11_crew_respond_blocker",
    label: "DB11 Crew Respond Blocker",
    description: "Respond to one exact open blocker revision without implicitly clearing it or widening the task.",
    executionMode: "sequential",
    parameters: closed({
      runId: Identifier,
      expectedRevision: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
      blockerId: Identifier,
      blockerRevision: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
      response: Type.String({ minLength: 1, maxLength: LIMITS.amendmentTextLength }),
      evidenceRefs: EvidenceRefs,
    }),
    async execute(_id, params) {
      return text(await requireRuntime().respondToBlocker(params));
    },
  });

  pi.registerTool({
    name: "db11_crew_result",
    label: "DB11 Crew Result",
    description: "Retrieve a full immutable result or one structured section, or explicitly acknowledge it, for an exact owned run.",
    executionMode: "sequential",
    parameters: closed({
      action: StringEnum(["get", "acknowledge"] as const),
      runId: Identifier,
      section: Type.Optional(StringEnum([
        "full",
        "summary",
        "deliverables",
        "completion_criteria",
        "validation",
        "unresolved",
        "state_changes",
        "references",
        "recommended_next_steps",
        "role_details",
      ] as const)),
      expectedRevision: Type.Optional(Type.Integer({ minimum: 0, maximum: 2_147_483_647 })),
      evidenceRefs: Type.Optional(EvidenceRefs),
    }),
    async execute(_id, params) {
      if (params.action === "get") {
        return text(
          await requireRuntime().result(params.runId, (params.section ?? "full") as ResultSection),
          LIMITS.resultBytes + 4_096,
        );
      }
      if (params.expectedRevision === undefined || params.evidenceRefs === undefined) {
        throw new Error("expectedRevision and evidenceRefs are required for acknowledgement.");
      }
      return text(await requireRuntime().acknowledgeResult({
        runId: params.runId,
        expectedRevision: params.expectedRevision,
        evidenceRefs: params.evidenceRefs,
      }));
    },
  });

  pi.registerTool({
    name: "db11_crew_cancel",
    label: "DB11 Crew Cancel",
    description: "Cancel an exact queued run or durably request graceful cancellation of one exact active run without blind retry or cleanup.",
    executionMode: "sequential",
    parameters: closed({
      runId: Identifier,
      expectedRevision: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
      reason: Type.String({ minLength: 1, maxLength: LIMITS.summaryLength }),
      evidenceRefs: EvidenceRefs,
    }),
    async execute(id, params) {
      return text(await requireRuntime().cancel({ ...params, requestId: id }));
    },
  });

  pi.registerTool({
    name: "db11_crew_force_cancel",
    label: "DB11 Crew Force Cancel",
    description: "Separately confirm and identity-scope one exact force termination after a durable graceful cancellation request; never escalates automatically.",
    executionMode: "sequential",
    parameters: closed({
      runId: Identifier,
      expectedRevision: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
      reason: Type.String({ minLength: 1, maxLength: LIMITS.summaryLength }),
      evidenceRefs: EvidenceRefs,
      confirmation: StringEnum(["terminate_exact_member"] as const),
    }),
    async execute(id, params) {
      return text(await requireRuntime().forceCancel({ ...params, requestId: id }));
    },
  });

  pi.registerTool({
    name: "db11_crew_recover",
    label: "DB11 Crew Recover",
    description: "Explicitly continue only an exact natively resumed Pi session after responsible-human side-effect review, or return the new-run boundary without mutation when effects are unknown.",
    executionMode: "sequential",
    parameters: closed({
      runId: Identifier,
      expectedRevision: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
      effectAssessment: StringEnum(["none_found", "reviewed_bounded", "unknown"] as const),
      reviewedByHuman: Type.Boolean(),
      summary: Type.String({ minLength: 1, maxLength: LIMITS.amendmentTextLength }),
      evidenceRefs: EvidenceRefs,
    }),
    async execute(_id, params) {
      return text(await requireRuntime().recover(params));
    },
  });

  pi.registerTool({
    name: "db11_crew_runtime_cleanup",
    label: "DB11 Crew Runtime Cleanup",
    description: "Assess, pin, unpin, inspect, explicitly close, or reconcile an external close for one exact terminal Herdr member runtime. This never deletes Pi sessions, durable state/results, or Git resources.",
    promptGuidelines: [
      "Use db11_crew_runtime_cleanup mutating actions only when the responsible human explicitly requests that exact action; never infer cleanup authority from result delivery or capacity pressure.",
    ],
    executionMode: "sequential",
    parameters: closed({
      action: StringEnum(["assess", "pin", "unpin", "inspect", "close", "external_close"] as const),
      runId: Identifier,
      expectedRevision: Type.Optional(Type.Integer({ minimum: 0, maximum: 2_147_483_647 })),
      leaseMilliseconds: Type.Optional(Type.Integer({ minimum: LIMITS.inspectionGraceMinimumMilliseconds, maximum: LIMITS.inspectionGraceMaximumMilliseconds })),
      evidenceRefs: Type.Optional(EvidenceRefs),
      evidenceRef: Type.Optional(Type.String({ minLength: 1, maxLength: LIMITS.referenceLength })),
      confirmation: Type.Optional(StringEnum(["close_exact_terminal_runtime", "record_confirmed_external_close"] as const)),
    }),
    async execute(id, params) {
      const value = requireRuntime();
      if (params.action === "assess") return text(await value.cleanupAssessment(params.runId));
      if (params.expectedRevision === undefined) throw new Error("expectedRevision is required for a runtime cleanup mutation.");
      if (params.action === "pin" || params.action === "unpin") {
        if (!params.evidenceRefs) throw new Error("evidenceRefs are required for pin changes.");
        return text(await (params.action === "pin" ? value.pinRuntime({ runId: params.runId, expectedRevision: params.expectedRevision, evidenceRefs: params.evidenceRefs }) : value.unpinRuntime({ runId: params.runId, expectedRevision: params.expectedRevision, evidenceRefs: params.evidenceRefs })));
      }
      if (params.action === "inspect") {
        if (!params.evidenceRefs || params.leaseMilliseconds === undefined) throw new Error("leaseMilliseconds and evidenceRefs are required for inspection.");
        return text(await value.leaseRuntimeInspection({ runId: params.runId, expectedRevision: params.expectedRevision, leaseMilliseconds: params.leaseMilliseconds, evidenceRefs: params.evidenceRefs }));
      }
      if (params.action === "close") {
        if (!params.evidenceRefs || params.confirmation !== "close_exact_terminal_runtime") throw new Error("Exact close confirmation and evidenceRefs are required.");
        return text(await value.closeRuntime({ requestId: id, runId: params.runId, expectedRevision: params.expectedRevision, evidenceRefs: params.evidenceRefs, confirmation: params.confirmation }));
      }
      if (!params.evidenceRef || params.confirmation !== "record_confirmed_external_close") throw new Error("External-close confirmation and evidenceRef are required.");
      return text(await value.reconcileExternalRuntimeClose({ runId: params.runId, expectedRevision: params.expectedRevision, evidenceRef: params.evidenceRef, confirmation: params.confirmation }));
    },
  });

  pi.registerTool({
    name: "db11_crew_integrate",
    label: "DB11 Crew Integrate",
    description: "Perform one separately responsible-human-authorized, local, exact Builder fast-forward-only integration after durable run/result/head/base/target checks. Never pushes or performs conflict reconciliation.",
    promptGuidelines: [
      "Use db11_crew_integrate only after the responsible human explicitly names the exact run and authorizes local ff-only integration; result delivery and acceptance are not authorization.",
    ],
    executionMode: "sequential",
    parameters: closed({
      runId: Identifier,
      expectedRevision: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
      evidenceRefs: EvidenceRefs,
      confirmation: StringEnum(["integrate_exact_builder_ff_only"] as const),
    }),
    async execute(id, params) {
      return text(await requireRuntime().integrateBuilder({ ...params, requestId: id }));
    },
  });

  pi.registerTool({
    name: "db11_crew_repository_cleanup",
    label: "DB11 Crew Repository Cleanup",
    description: "Reconcile and remove only an exact proven-owned detached snapshot or Builder worktree/branch after verified integration, verified supersession, or separately confirmed discard.",
    promptGuidelines: [
      "Use db11_crew_repository_cleanup only for exact run resources under explicit responsible-human authority; never prune globally, force automatically, or remove foreign branches/worktrees.",
    ],
    executionMode: "sequential",
    parameters: closed({
      runId: Identifier,
      expectedRevision: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
      authorization: StringEnum(["integrated", "superseded", "discard", "read_snapshot"] as const),
      evidenceRefs: EvidenceRefs,
      replacementRunId: Type.Optional(Identifier),
      confirmation: Type.Optional(StringEnum(["discard_exact_unmerged_artifacts"] as const)),
      acknowledgedArtifacts: Type.Optional(EvidenceRefs),
    }),
    async execute(id, params) {
      return text(await requireRuntime().cleanupRepository({ ...params, requestId: id }));
    },
  });

  pi.registerTool({
    name: "db11_crew_reconcile",
    label: "DB11 Crew Reconcile",
    description: "Rebuild bounded health and quarantine evidence from durable records plus one fresh Herdr snapshot without adopting, recreating, prompting, closing, or retrying orphan resources.",
    executionMode: "sequential",
    parameters: closed({}),
    async execute() {
      return text(await requireRuntime().reconcile());
    },
  });

  const stopRuntimeResources = async (ctx: ExtensionContext): Promise<void> => {
    presentationStopping = true;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    await refreshChain.catch(() => {});
    const current = runtime;
    const queue = progressQueue;
    const identity = current && {
      crewleadSessionId: current.identity.crewleadSessionId,
      herdrWorkspaceId: current.identity.herdrWorkspaceId,
      canonicalProjectPath: current.identity.canonicalProjectPath,
    };
    runtime = undefined;
    delivery = undefined;
    observability?.clearTransient();
    observability = undefined;
    uiController?.clear();
    uiController = undefined;
    progressQueue = undefined;
    if (queue && identity) await queue.discard(identity).catch(() => {});
    try {
      if (current) await current.stop();
    } finally {
      if (ctx.hasUI) {
        try { ctx.ui.setStatus("db11-crew", undefined); } catch {}
        try { ctx.ui.setWidget("db11-crew-runs", undefined); } catch {}
      }
    }
  };

  const prepareRuntime = async (
    ctx: ExtensionContext,
  ): Promise<CrewleadRuntimePreparation | undefined> => {
    if (options.prepareRuntime) return options.prepareRuntime(ctx);
    if (options.createRuntime) {
      return { initialize: () => options.createRuntime!(ctx) };
    }
    return defaultRuntimePreparation(ctx, options);
  };

  const initializeFencedRuntime = async (
    preparation: CrewleadRuntimePreparation,
    ctx: ExtensionContext,
  ): Promise<boolean> => {
    let candidate: CrewleadRuntime | undefined;
    try {
      presentationStopping = false;
      nextCleanupSweepAt = 0;
      candidate = await preparation.initialize();
      if (!candidate) {
        initializationError = "DB11 Crew readiness failed closed.";
        return false;
      }
      runtime = candidate;
      await candidate.startFenced();
      initializationError = undefined;
      return true;
    } catch (error) {
      if (runtime === candidate) {
        await stopRuntimeResources(ctx).catch(() => {});
      } else if (candidate) {
        await candidate.stop().catch(() => {});
      }
      initializationError = redactDiagnostic(error instanceof Error ? error.message : error, {
        homeDirectory: (options.environment ?? process.env).HOME,
      });
      return false;
    }
  };

  const startPresentation = async (ctx: ExtensionContext): Promise<void> => {
    const candidate = runtime;
    if (!candidate) throw new Error("The fenced Crewlead runtime is unavailable.");
    const identity: DeliveryIdentity = {
      crewleadSessionId: candidate.identity.crewleadSessionId,
      herdrWorkspaceId: candidate.identity.herdrWorkspaceId,
      canonicalProjectPath: candidate.identity.canonicalProjectPath,
    };
    const claims = new DurableDeliveryClaims(candidate.dependencies.store.root);
    const notifications = new DurableNotificationReceipts(candidate.dependencies.store.root);
    progressQueue = new TransientProgressQueue(candidate.dependencies.store.root);
    const notify = async (notification: HumanNotification): Promise<boolean> => {
      if (presentationStopping) return false;
      let shown = false;
      if (ctx.hasUI) {
        try {
          ctx.ui.notify(notification.body, notification.kind === "blocker" ? "warning" : "info");
          shown = true;
        } catch {
          // Herdr remains the independent human-notification fallback.
        }
      }
      try {
        const result = await candidate.dependencies.herdr.notify({
          title: notification.title,
          body: notification.body,
          sound: notification.sound,
        });
        shown ||= result.shown;
      } catch {
        // Durable state and the next bounded reconciliation remain available.
      }
      return shown;
    };
    const sendBatch = (batch: DeliveryBatch): void => {
      if (presentationStopping) throw new Error("The Crewlead session is shutting down.");
      pi.sendMessage({
        customType: "db11-crew-terminal-delivery",
        content: batch.context,
        display: true,
        details: { batchId: batch.batchId, deliveryIds: [...batch.deliveryIds] },
      }, { deliverAs: "followUp", triggerTurn: true });
    };
    delivery = new TerminalDeliveryService(identity, {
      store: candidate.dependencies.store,
      claims,
      notifications,
      hooks: { notify, sendBatch },
    });
    observability = new CrewObservabilityService(identity, {
      store: candidate.dependencies.store,
      herdr: candidate.dependencies.herdr,
      claims,
      progressQueue,
    });
    uiController = ctx.hasUI ? new CrewleadUIController(ctx.ui) : undefined;
    await refreshPresentation(ctx);
    refreshTimer = setInterval(() => void scheduleRefresh(ctx), LIMITS.progressCoalesceMilliseconds);
    refreshTimer.unref();
  };

  const enableDesignatedRuntime = async (ctx: ExtensionContext): Promise<boolean> => {
    try {
      await runtime!.enableOperations();
      await startPresentation(ctx);
      initializationError = undefined;
      return true;
    } catch (error) {
      await stopRuntimeResources(ctx).catch(() => {});
      initializationError = redactDiagnostic(error instanceof Error ? error.message : error, {
        homeDirectory: (options.environment ?? process.env).HOME,
      });
      return false;
    }
  };

  const serializeActivation = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const pending = activationChain.then(operation, operation);
    activationChain = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const notifyActivationFailure = (ctx: ExtensionContext, message: string): void => {
    if (ctx.hasUI) ctx.ui.notify(message, "error");
  };

  pi.on("session_start", async (_event, ctx) => {
    const environment = options.environment ?? process.env;
    const designated = hasCurrentCrewleadDesignation(
      ctx.sessionManager.getEntries(),
      ctx.sessionManager.getSessionId(),
    );
    state = designated ? "designated-unavailable" : "undesignated";
    initializationError = undefined;
    // Pi action methods are unavailable while an extension factory is loading.
    // session_start runs before agent processing, so this is the first safe point
    // to remove the newly registered Crewlead tools from undesignated sessions.
    synchronizeToolSurface();

    if (isManagedMemberSession(environment)) {
      if (designated) initializationError = "DB11 Crew is unavailable in managed member sessions.";
      return;
    }
    if (!designated) return;

    let preparation: CrewleadRuntimePreparation | undefined;
    try {
      preparation = await prepareRuntime(ctx);
    } catch (error) {
      initializationError = redactDiagnostic(error instanceof Error ? error.message : error, {
        homeDirectory: environment.HOME,
      });
    }
    if (
      preparation &&
      await initializeFencedRuntime(preparation, ctx) &&
      await enableDesignatedRuntime(ctx)
    ) {
      state = "designated-active";
    }
    synchronizeToolSurface();
    if (state === "designated-unavailable") {
      notifyActivationFailure(ctx, "DB11 Crew readiness failed closed for this designated session.");
    }
  });

  pi.on("input", async (event, ctx) => {
    const classification = classifyCrewleadActivationInput(event);
    if (classification === "none") return { action: "continue" };
    if (classification === "extension") {
      notifyActivationFailure(ctx, "DB11 Crew activation accepts only direct requester input.");
      return { action: "handled" };
    }
    if (isManagedMemberSession(options.environment ?? process.env)) {
      notifyActivationFailure(ctx, "DB11 Crew activation is unavailable in managed member sessions.");
      return { action: "handled" };
    }

    return serializeActivation(async () => {
      if (state === "designated-active") {
        synchronizeToolSurface();
        return { action: "continue" } as const;
      }
      if (state === "designated-unavailable") {
        notifyActivationFailure(
          ctx,
          "This session remains designated, but DB11 Crew is unavailable. Retry with /reload or /resume.",
        );
        synchronizeToolSurface();
        return { action: "handled" } as const;
      }

      let marker: ReturnType<typeof createCrewleadDesignation>;
      try {
        marker = createCrewleadDesignation(ctx.sessionManager.getSessionId());
      } catch {
        initializationError = "DB11 Crew requires a valid persistent session identity.";
        notifyActivationFailure(ctx, "DB11 Crew activation failed closed.");
        synchronizeToolSurface();
        return { action: "handled" } as const;
      }

      let preparation: CrewleadRuntimePreparation | undefined;
      try {
        preparation = await prepareRuntime(ctx);
      } catch (error) {
        initializationError = redactDiagnostic(error instanceof Error ? error.message : error, {
          homeDirectory: (options.environment ?? process.env).HOME,
        });
      }
      if (!preparation || !await initializeFencedRuntime(preparation, ctx)) {
        state = "undesignated";
        synchronizeToolSurface();
        notifyActivationFailure(ctx, "DB11 Crew activation failed closed.");
        return { action: "handled" } as const;
      }

      try {
        pi.appendEntry(CREWLEAD_DESIGNATION_ENTRY_TYPE, marker);
      } catch {
        await stopRuntimeResources(ctx).catch(() => {});
        state = "undesignated";
        initializationError = "DB11 Crew designation could not be persisted.";
        synchronizeToolSurface();
        notifyActivationFailure(ctx, "DB11 Crew activation failed closed before designation.");
        return { action: "handled" } as const;
      }

      if (!await enableDesignatedRuntime(ctx)) {
        state = "designated-unavailable";
        synchronizeToolSurface();
        notifyActivationFailure(ctx, "DB11 Crew readiness failed closed for this designated session.");
        return { action: "handled" } as const;
      }
      state = "designated-active";
      synchronizeToolSurface();
      return { action: "continue" } as const;
    });
  });

  pi.on("before_agent_start", () => {
    synchronizeToolSurface();
  });

  pi.on("session_tree", () => {
    synchronizeToolSurface();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (state === "designated-active") await scheduleRefresh(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const wasDesignated = state !== "undesignated";
    state = wasDesignated ? "designated-unavailable" : "undesignated";
    synchronizeToolSurface();
    await stopRuntimeResources(ctx);
  });
}
