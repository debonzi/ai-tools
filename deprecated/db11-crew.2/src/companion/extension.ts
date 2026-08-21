import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import { GitIsolationService } from "../adapters/git/isolation.ts";
import { renderTaskPrompt } from "../adapters/pi/launcher.ts";
import { BlockerSchema, ResultSchema } from "../protocol/contracts.ts";
import { LIMITS, SCHEMA_VERSION } from "../protocol/limits.ts";
import { validateContract } from "../protocol/validate.ts";
import { TransientProgressQueue } from "../delivery/transient.ts";
import { FencedLeaseManager, type FencedLease } from "../state/leases.ts";
import type { BuiltInRole as MemberRole } from "../security/binding.ts";
import { DurableStateStore } from "../state/store.ts";
import { SecureStateRoot } from "../state/filesystem.ts";
import {
  RunCapabilityManager,
  type ClaimedCompanionBootstrap,
} from "../security/capabilities.ts";
import { redactDiagnostic } from "../security/redaction.ts";
import { stateError } from "../security/errors.ts";
import {
  CompanionProtocol,
  type Blocker,
  type CompanionProtocolOptions,
  type ProgressFrame,
  type RoleResult,
  type TaskPacket,
} from "./protocol.ts";

interface CleanupAttempt {
  bootstrap: ClaimedCompanionBootstrap;
  manager: RunCapabilityManager;
  lease?: FencedLease;
  leases?: FencedLeaseManager;
  leaseBinding?: ReadyRuntime["leaseBinding"];
}

interface ReadyRuntime extends CleanupAttempt {
  protocol: CompanionProtocol;
  progressQueue: TransientProgressQueue;
  lease: FencedLease;
  leases: FencedLeaseManager;
  leaseBinding: {
    protocolVersion: 1;
    scope: "companion";
    crewleadSessionId: string;
    herdrWorkspaceId: string;
    canonicalProjectPath: string;
    runId: string;
    memberSessionId: string;
    role: MemberRole;
  };
  initialPrompt: string;
  initialPromptAccepted: boolean;
}

export interface MemberCompanionExtensionOptions {
  extensionPath: string;
  environment?: NodeJS.ProcessEnv;
  openStore?: () => Promise<DurableStateStore>;
  openRoot?: () => Promise<SecureStateRoot>;
  createLeaseManager?: (root: SecureStateRoot) => FencedLeaseManager;
  leaseLifetimeMilliseconds?: number;
  scheduleInterval?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearScheduledInterval?: (timer: NodeJS.Timeout) => void;
  /** Deterministic Builder evidence boundary for component tests. Production observes Git directly. */
  verifyBuilderOutcome?: CompanionProtocolOptions["verifyBuilderOutcome"];
}

const COMPANION_TOOL_NAMES = ["db11_report_blocker", "db11_finalize"] as const;
const ACTIVE_RUN_STATES = new Set(["starting", "working", "blocked"]);

function providerCompatibleToolSchema(schema: TSchema, selectedRole?: MemberRole): TSchema {
  const visit = (input: unknown, key?: string): unknown => {
    if (input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map((item) => visit(item));
    const value = structuredClone(input) as Record<string, unknown>;
    if (key === "roleDetails" && selectedRole && Array.isArray(value.anyOf)) {
      const selected = value.anyOf.find((candidate) => {
        if (candidate === null || typeof candidate !== "object") return false;
        const properties = (candidate as { properties?: Record<string, unknown> }).properties;
        const roleSchema = properties?.role;
        return roleSchema !== null && typeof roleSchema === "object" &&
          (roleSchema as { const?: unknown }).const === selectedRole;
      });
      if (!selected) throw stateError("invalid_record");
      return visit(selected, key);
    }
    if (
      Object.hasOwn(value, "const") &&
      ["string", "number", "boolean"].includes(typeof value.const)
    ) {
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
      const constants = value.anyOf.map((candidate) => (candidate as { const: string | number | boolean }).const);
      delete value.anyOf;
      value.type = typeof constants[0];
      value.enum = constants;
    }
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, visit(child, childKey)]));
  };
  return visit(schema) as TSchema;
}

function text(content: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: content }], details };
}

function asRole(value: string | undefined): MemberRole {
  if (value !== "scout" && value !== "planner" && value !== "builder") throw stateError("invalid_binding");
  return value;
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function verifyCompanionProvenance(
  extensionPath: string,
  role: MemberRole,
  expectedEntryPath: string,
  expectedEntryDigest: string,
  expectedProfilePath: string,
  expectedProfileDigest: string,
  launchedProfilePath: string | undefined,
): Promise<void> {
  const packageRoot = await realpath(resolve(dirname(extensionPath), "../../../.."));
  const manifestValue = JSON.parse(await readFile(join(packageRoot, "agents/pi/roles/manifest.json"), "utf8")) as unknown;
  const validation = validateContract("roleManifest", manifestValue);
  if (!validation.ok) throw stateError("invalid_record");
  const manifest = validation.value as {
    resources: Array<{ id: string; resourcePath: string; sha256: string }>;
    roles: Array<{ id: MemberRole; profilePath: string; profileSha256: string }>;
  };
  const profile = manifest.roles.find((candidate) => candidate.id === role);
  const profilePath = profile ? await realpath(join(packageRoot, profile.profilePath)) : undefined;
  const required = [
    "member_companion",
    "member_companion_runtime",
    "member_companion_protocol",
    "member_progress_transport",
  ];
  if (
    !profile ||
    profile.profilePath !== expectedProfilePath ||
    profile.profileSha256 !== expectedProfileDigest ||
    !profilePath?.startsWith(`${packageRoot}/`) ||
    !launchedProfilePath ||
    await realpath(launchedProfilePath) !== profilePath ||
    await sha256File(profilePath) !== profile.profileSha256
  ) {
    throw stateError("invalid_binding");
  }
  for (const id of required) {
    const candidates = manifest.resources.filter((resource) => resource.id === id);
    if (candidates.length !== 1) throw stateError("invalid_binding");
    const resource = candidates[0]!;
    const path = await realpath(join(packageRoot, resource.resourcePath));
    if (!path.startsWith(`${packageRoot}/`) || await sha256File(path) !== resource.sha256) {
      throw stateError("invalid_binding");
    }
    if (
      id === "member_companion" &&
      (resource.resourcePath !== expectedEntryPath || resource.sha256 !== expectedEntryDigest)
    ) {
      throw stateError("invalid_binding");
    }
  }
}

function userText(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const value = entry as { type?: unknown; message?: { role?: unknown; content?: unknown } };
  if (value.type !== "message" || value.message?.role !== "user") return undefined;
  if (typeof value.message.content === "string") return value.message.content;
  if (!Array.isArray(value.message.content)) return undefined;
  return value.message.content
    .filter((item): item is { type: "text"; text: string } =>
      item !== null && typeof item === "object" && (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string")
    .map((item) => item.text)
    .join("");
}

export function installMemberCompanion(pi: ExtensionAPI, options: MemberCompanionExtensionOptions): void {
  const environment = options.environment ?? process.env;
  const scheduleInterval = options.scheduleInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
  const clearScheduledInterval = options.clearScheduledInterval ?? ((timer) => clearInterval(timer));
  const leaseLifetimeMilliseconds = options.leaseLifetimeMilliseconds ?? LIMITS.leaseLifetimeDefaultMilliseconds;
  let role: MemberRole;
  try {
    role = asRole(environment.DB11_CREW_ROLE);
  } catch {
    role = "scout";
  }
  let runtime: ReadyRuntime | undefined;
  let initializationError: string | undefined;
  let initializationAttempted = false;
  let invalidation: Promise<void> | undefined;
  let shuttingDown = false;
  let cancellationBusy = false;
  let renewalBusy = false;
  let cancellationTimer: NodeJS.Timeout | undefined;
  let renewalTimer: NodeJS.Timeout | undefined;
  let progressQueue: Promise<void> = Promise.resolve();
  const recentActivity: string[] = [];
  const git = new GitIsolationService();
  const verifyBuilderOutcome: NonNullable<CompanionProtocolOptions["verifyBuilderOutcome"]> =
    options.verifyBuilderOutcome ?? (async (run) => {
      if (run.role !== "builder" || run.repositoryResource?.kind !== "builder_worktree") {
        throw stateError("invalid_binding");
      }
      const evidence = await git.validateBuilderOutcome(run.repositoryResource);
      return {
        repositoryRootDigest: evidence.repository.canonicalRootDigest,
        baseCommit: evidence.baseCommit,
        headCommit: evidence.headCommit,
        commits: [...evidence.commits],
        changedPaths: [...evidence.changedPaths],
        noChange: evidence.noChange,
        worktreeClean: evidence.worktreeClean,
      };
    });

  const setCompanionToolsActive = (active: boolean): void => {
    const selected = new Set<string>(COMPANION_TOOL_NAMES);
    const current = pi.getActiveTools();
    pi.setActiveTools(active
      ? [...new Set([...current, ...COMPANION_TOOL_NAMES])]
      : current.filter((name) => !selected.has(name)));
  };

  const stopTimers = (): void => {
    if (cancellationTimer) clearScheduledInterval(cancellationTimer);
    if (renewalTimer) clearScheduledInterval(renewalTimer);
    cancellationTimer = undefined;
    renewalTimer = undefined;
  };

  const cleanupAttempt = async (attempt: CleanupAttempt): Promise<void> => {
    const operations: Promise<unknown>[] = [
      attempt.manager.revokeClaimedCapabilities(
        attempt.bootstrap.binding,
        attempt.bootstrap.capabilities,
        "member companion attempt ended",
      ),
    ];
    if (attempt.leases && attempt.leaseBinding && attempt.lease) {
      operations.push(attempt.leases.release(
        attempt.leaseBinding,
        attempt.lease.leaseToken,
        attempt.lease.fencingEpoch,
      ));
    }
    await Promise.allSettled(operations);
  };

  const invalidateRuntime = (error: unknown, attempt: CleanupAttempt): Promise<void> => {
    if (invalidation) return invalidation;
    initializationError = redactDiagnostic(error);
    shuttingDown = true;
    stopTimers();
    if (runtime?.bootstrap.binding.runId === attempt.bootstrap.binding.runId) {
      runtime.protocol.clearProgress("invalidated");
      runtime = undefined;
    }
    try {
      setCompanionToolsActive(false);
    } catch {
      // Cleanup below still revokes the exact attempt when Pi tool-state mutation fails.
    }
    invalidation = cleanupAttempt(attempt);
    return invalidation;
  };

  const assertRuntimeHealthy = async (
    value: ReadyRuntime,
    ctx?: ExtensionContext,
  ): Promise<void> => {
    if (
      shuttingDown ||
      initializationError ||
      runtime !== value ||
      (ctx && ctx.sessionManager.getSessionId() !== value.bootstrap.binding.memberSessionId)
    ) {
      throw stateError("invalid_binding");
    }
    const [run, capabilityHealth, leaseHealth] = await Promise.all([
      value.protocol.currentRun(),
      value.manager.inspectExactBinding(value.bootstrap.binding),
      value.leases!.inspectExactBinding(value.leaseBinding!, value.lease!.fencingEpoch),
      value.leases!.assertActive(value.leaseBinding!, value.lease!.leaseToken, value.lease!.fencingEpoch),
    ]);
    if (!ACTIVE_RUN_STATES.has(run.state)) throw stateError("invalid_transition");
    if (!capabilityHealth.healthy) throw stateError("capability_invalid");
    if (!leaseHealth.healthy) throw stateError("lease_expired");
  };

  const requireRuntime = async (ctx: ExtensionContext): Promise<ReadyRuntime> => {
    const value = runtime;
    if (!value || initializationError) {
      throw new Error("The authenticated DB11 Crew member companion is not ready.");
    }
    try {
      await assertRuntimeHealthy(value, ctx);
      return value;
    } catch (error) {
      await invalidateRuntime(error, value);
      throw new Error("The authenticated DB11 Crew member companion is not ready.");
    }
  };

  const emitProgress = (
    kind: ProgressFrame["kind"],
    values: Partial<ProgressFrame> = {},
    ctx?: ExtensionContext,
  ): void => {
    progressQueue = progressQueue.then(async () => {
      const value = runtime;
      if (!value || !value.bootstrap.configuration.progressEnabled || shuttingDown) return;
      try {
        await assertRuntimeHealthy(value, ctx);
      } catch (error) {
        await invalidateRuntime(error, value);
        return;
      }
      try {
        const run = await value.protocol.currentRun();
        const sequence = await value.protocol.nextSequence("progress");
        const frame = {
          schemaVersion: SCHEMA_VERSION,
          progressId: `progress-${randomUUID()}`,
          runId: run.runId,
          sequence,
          fencingEpoch: run.fencingEpoch,
          kind,
          timestamp: new Date().toISOString(),
          ...values,
        } as ProgressFrame;
        const accepted = await value.protocol.acceptProgress(frame);
        if (accepted.frame) {
          await value.progressQueue.enqueue(value.bootstrap.binding, accepted.frame as unknown as Record<string, unknown>);
          pi.events.emit("db11-crew:member-progress", accepted.frame);
        }
      } catch {
        // Rich progress is best-effort and never changes task correctness.
      }
    });
  };

  const acknowledgePendingCancellation = async (ctx: ExtensionContext): Promise<void> => {
    if (!runtime || cancellationBusy || shuttingDown) return;
    const value = await requireRuntime(ctx);
    const pending = await value.protocol.pendingCancellation();
    if (!pending) return;
    cancellationBusy = true;
    try {
      if (!ctx.isIdle()) {
        ctx.abort();
        return;
      }
      const run = await value.protocol.currentRun();
      const sequence = await value.protocol.nextSequence("control");
      const timestamp = new Date().toISOString();
      await value.protocol.acknowledgeCancellation(
        {
          messageId: `cancel-ack-${pending.controlId}`,
          sequence,
          expectedRevision: run.revision,
        },
        {
          schemaVersion: SCHEMA_VERSION,
          checkpointId: `checkpoint-${pending.controlId}`,
          cancelRequestId: pending.controlId,
          runId: run.runId,
          expectedRevision: run.revision,
          fencingEpoch: run.fencingEpoch,
          summary: "The companion settled Pi and recorded a bounded graceful-cancellation checkpoint.",
          completedWork: recentActivity.slice(-LIMITS.resultItems),
          validation: [],
          unresolvedEffects: ["Inspect retained member and workspace artifacts before retry or cleanup."],
          retainedArtifacts: [],
          timestamp,
        },
        { abort: () => ctx.abort(), settled: () => ctx.isIdle() },
      );
    } finally {
      cancellationBusy = false;
    }
  };

  const renewLease = async (ctx: ExtensionContext): Promise<void> => {
    const value = runtime;
    if (!value || renewalBusy || shuttingDown) return;
    renewalBusy = true;
    try {
      await assertRuntimeHealthy(value, ctx);
      const renewed = await value.leases.renew(
        value.leaseBinding,
        value.lease.leaseToken,
        value.lease.fencingEpoch,
        leaseLifetimeMilliseconds,
      );
      if (runtime !== value) return;
      value.lease = renewed;
      await assertRuntimeHealthy(value, ctx);
    } catch (error) {
      await invalidateRuntime(error, value);
    } finally {
      renewalBusy = false;
    }
  };

  pi.registerTool({
    name: "db11_report_blocker",
    label: "DB11 Blocker",
    description: "Create, revise, or explicitly clear the exact revisioned durable blocker for this run.",
    parameters: providerCompatibleToolSchema(BlockerSchema),
    async execute(_id, params, _signal, _update, ctx) {
      const input = params as Blocker;
      const value = await requireRuntime(ctx);
      const sequence = await value.protocol.nextSequence("finalization");
      const operation = await value.protocol.recordBlocker(
        { messageId: `blocker-${input.blockerId}-${input.blockerRevision}`, sequence, expectedRevision: input.expectedRevision },
        input,
      );
      emitProgress(input.status === "open" ? "blocked" : "phase", {
        ...(input.status === "open" ? { summary: input.summary } : { phase: "resumed" }),
      }, ctx);
      return text(input.status === "open" ? "The durable blocker revision is active." : "The durable blocker was explicitly cleared.", {
        runId: operation.run.runId,
        revision: operation.run.revision,
        duplicate: operation.duplicate,
      });
    },
  });

  pi.registerTool({
    name: "db11_finalize",
    label: "DB11 Finalize",
    description: "Validate and atomically commit one immutable structured completion or failure result.",
    parameters: providerCompatibleToolSchema(ResultSchema, role),
    async execute(_id, params, _signal, _update, ctx) {
      const input = params as RoleResult;
      const value = await requireRuntime(ctx);
      emitProgress("finalizing", { summary: "Validating the structured final result." }, ctx);
      const run = await value.protocol.currentRun();
      const sequence = await value.protocol.nextSequence("finalization");
      const operation = await value.protocol.finalize(
        { messageId: `result-${input.resultId}`, sequence, expectedRevision: run.revision },
        input,
      );
      return {
        ...text(`The immutable ${input.outcome} result is committed.`, {
          runId: operation.run.runId,
          resultId: input.resultId,
          revision: operation.run.revision,
          duplicate: operation.duplicate,
        }),
        terminate: true,
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (initializationAttempted) return;
    initializationAttempted = true;
    shuttingDown = false;
    invalidation = undefined;
    let attempt: CleanupAttempt | undefined;
    try {
      const bootstrapPath = environment.DB11_CREW_MEMBER_BOOTSTRAP;
      const expectedRole = asRole(environment.DB11_CREW_ROLE);
      if (!bootstrapPath || !ctx.isProjectTrusted()) throw stateError("bootstrap_invalid");
      const extensionPath = await realpath(options.extensionPath);
      if (
        !environment.DB11_CREW_MEMBER_EXTENSION_PATH ||
        await realpath(environment.DB11_CREW_MEMBER_EXTENSION_PATH) !== extensionPath
      ) {
        throw stateError("invalid_binding");
      }
      const root = await (options.openRoot?.() ?? SecureStateRoot.openDefault());
      const manager = new RunCapabilityManager(root);
      const bootstrap = await manager.claimCompanionBootstrap(bootstrapPath, {
        memberSessionId: ctx.sessionManager.getSessionId(),
        role: expectedRole,
      });
      attempt = { bootstrap, manager };
      await verifyCompanionProvenance(
        extensionPath,
        expectedRole,
        bootstrap.configuration.memberExtensionPath,
        bootstrap.configuration.memberExtensionSha256,
        bootstrap.configuration.roleProfilePath,
        bootstrap.configuration.roleProfileSha256,
        environment.DB11_CREW_ROLE_PROFILE_PATH,
      );
      if (
        bootstrap.configuration.memberExtensionSha256 !== await sha256File(extensionPath) ||
        bootstrap.configuration.assignedRoot !== await realpath(ctx.cwd) ||
        bootstrap.binding.role !== expectedRole
      ) {
        throw stateError("invalid_binding");
      }
      const store = await (options.openStore?.() ?? DurableStateStore.openDefault());
      const leases = options.createLeaseManager?.(root) ?? new FencedLeaseManager(root);
      const leaseBinding = {
        protocolVersion: SCHEMA_VERSION,
        scope: "companion" as const,
        crewleadSessionId: bootstrap.binding.crewleadSessionId,
        herdrWorkspaceId: bootstrap.binding.herdrWorkspaceId,
        canonicalProjectPath: bootstrap.binding.canonicalProjectPath,
        runId: bootstrap.binding.runId,
        memberSessionId: bootstrap.binding.memberSessionId,
        role: bootstrap.binding.role,
      };
      const lease = await leases.acquire(leaseBinding, leaseLifetimeMilliseconds);
      attempt = { ...attempt, lease, leases, leaseBinding };
      if (lease.fencingEpoch !== bootstrap.binding.fencingEpoch) throw stateError("epoch_conflict");
      const progressQueue = new TransientProgressQueue(root);
      const protocol = new CompanionProtocol(
        store,
        manager,
        bootstrap.binding,
        bootstrap.capabilities,
        bootstrap.configuration,
        {
          onProgress: (frame) => pi.events.emit("db11-crew:member-progress", frame),
          onBlocker: (blocker) => pi.events.emit("db11-crew:member-blocker", blocker),
          verifyBuilderOutcome,
        },
      );
      const initialPrompt = renderTaskPrompt(bootstrap.configuration.packet as TaskPacket, bootstrap.binding.role);
      const ready: ReadyRuntime = {
        ...attempt,
        bootstrap,
        manager,
        protocol,
        progressQueue,
        lease,
        leases,
        leaseBinding,
        initialPrompt,
        initialPromptAccepted: ctx.sessionManager.getEntries().some((entry) => userText(entry) === initialPrompt),
      };
      runtime = ready;
      await assertRuntimeHealthy(ready, ctx);
      cancellationTimer = scheduleInterval(() => void acknowledgePendingCancellation(ctx).catch(() => {}), 250);
      cancellationTimer.unref?.();
      renewalTimer = scheduleInterval(
        () => void renewLease(ctx),
        Math.max(250, Math.floor(leaseLifetimeMilliseconds / 2)),
      );
      renewalTimer.unref?.();
      role = expectedRole;
      initializationError = undefined;
      setCompanionToolsActive(true);
      emitProgress("started", { summary: "Authenticated member companion ready." }, ctx);
    } catch (error) {
      if (attempt) await invalidateRuntime(error, attempt);
      else {
        initializationError = redactDiagnostic(error);
        shuttingDown = true;
        stopTimers();
        try {
          setCompanionToolsActive(false);
        } catch {
          // The fixed, redacted readiness notification below remains the only diagnostic.
        }
      }
      if (ctx.hasUI) ctx.ui.notify("DB11 Crew member companion readiness failed closed.", "error");
    }
  });

  pi.on("input", async (event, ctx) => {
    const value = await requireRuntime(ctx);
    if (!value.initialPromptAccepted) {
      if (event.text !== value.initialPrompt || (event.images?.length ?? 0) > 0) {
        if (ctx.hasUI) ctx.ui.notify("The immutable initial DB11 Crew prompt did not match the authenticated packet.", "error");
        return { action: "handled" as const };
      }
      value.initialPromptAccepted = true;
      return { action: "continue" as const };
    }
    if (event.source !== "interactive" && event.source !== "rpc") {
      return { action: "handled" as const };
    }
    const crewleadAmendment = (event.images?.length ?? 0) === 0
      ? await value.protocol.matchCrewleadAmendmentPrompt(event.text)
      : undefined;
    if (crewleadAmendment) {
      return {
        action: "transform" as const,
        text: `DB11 Crew loaded authenticated Crewlead amendment ${crewleadAmendment.sequence}. Apply it only inside the immutable task objective, permissions, and scope; otherwise report a blocker.\n\n${crewleadAmendment.summary}`,
        images: event.images,
      };
    }
    if ((event.images?.length ?? 0) > 0 || Buffer.byteLength(event.text, "utf8") > LIMITS.amendmentTextLength) {
      if (ctx.hasUI) ctx.ui.notify("The direct prompt could not be recorded as a bounded amendment.", "error");
      return { action: "handled" as const };
    }
    const run = await value.protocol.currentRun();
    const amendmentSequence = await value.protocol.nextAmendmentSequence();
    const capabilitySequence = await value.protocol.nextSequence("control");
    const amendment = {
      schemaVersion: SCHEMA_VERSION,
      amendmentId: `amendment-${randomUUID()}`,
      runId: run.runId,
      sequence: amendmentSequence,
      expectedRevision: run.revision,
      author: "human",
      timestamp: new Date().toISOString(),
      kind: "clarification",
      summary: event.text,
    };
    await value.protocol.appendAmendment(
      { messageId: amendment.amendmentId, sequence: capabilitySequence, expectedRevision: run.revision },
      amendment,
    );
    return {
      action: "transform" as const,
      text: `DB11 Crew recorded this direct-human prompt as ordered amendment ${amendmentSequence}. Apply it only inside the immutable task objective, permissions, and scope; otherwise report a blocker.\n\n${event.text}`,
      images: event.images,
    };
  });

  pi.on("turn_start", (_event, ctx) => emitProgress("phase", { phase: "working" }, ctx));
  pi.on("tool_execution_start", (event, ctx) => emitProgress("tool", { tool: event.toolName, outcome: "started" }, ctx));
  pi.on("tool_execution_end", (event, ctx) => {
    recentActivity.push(`Tool ${event.toolName} ${event.isError ? "failed" : "succeeded"}.`);
    if (recentActivity.length > LIMITS.resultItems) recentActivity.shift();
    emitProgress("tool", { tool: event.toolName, outcome: event.isError ? "failed" : "succeeded" }, ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    emitProgress("terminal_observation", { summary: "Pi settled without inventing a terminal run outcome." }, ctx);
    await acknowledgePendingCancellation(ctx);
  });

  pi.on("session_before_switch", () => ({ cancel: true }));
  pi.on("session_before_fork", () => ({ cancel: true }));
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    stopTimers();
    const value = runtime;
    runtime = undefined;
    value?.protocol.clearProgress("shutdown");
    if (value) await cleanupAttempt(value);
    else if (invalidation) await invalidation;
  });
}
