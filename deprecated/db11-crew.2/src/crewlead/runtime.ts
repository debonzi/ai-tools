import { randomUUID } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

import type { Static } from "typebox";

import type { EffectiveConfiguration, RoleId, RuntimeOverride } from "../config/config.ts";
import type { HerdrAdapter, HerdrEvent, MemberResources } from "../adapters/herdr/contracts.ts";
import { HerdrAdapterError } from "../adapters/herdr/contracts.ts";
import type { MemberLaunchPlan } from "../adapters/pi/launcher.ts";
import { AmendmentSchema, TaskPacketSchema } from "../protocol/contracts.ts";
import {
  ACCOUNT_CONFIGURATION_VERSION,
  COMPANION_CONFIGURATION_VERSION,
  LIMITS,
  SCHEMA_VERSION,
} from "../protocol/limits.ts";
import { validateContract } from "../protocol/validate.ts";
import type { RoleReadinessReceipt } from "../roles/resolve.ts";
import type { CompanionConfiguration, RunCapabilityManager } from "../security/capabilities.ts";
import type { LeaseBinding } from "../security/binding.ts";
import { digestJson, sha256 } from "../security/json.ts";
import { redactDiagnostic } from "../security/redaction.ts";
import { stateError } from "../security/errors.ts";
import {
  LifecycleError,
  LifecycleService,
  admissionCounts,
  type AdmissionCandidate,
  type RepositoryAllocationMetadata,
  type RepositoryResource,
  type RunRecord,
} from "../orchestration/lifecycle.ts";
import {
  BuilderIntegrationService,
  RepositoryCleanupService,
  RuntimeCleanupService,
  type RepositoryCleanupRequest,
} from "../orchestration/disposition.ts";
import {
  RecoveryService,
  matchManagedMember,
  type ExplicitRecoveryRequest,
  type ExplicitRecoveryResult,
  type MemberReadinessCode,
  type MemberReadinessResult,
  type ReconciliationReport,
} from "../orchestration/recovery.ts";
import type { FencedLease, FencedLeaseManager } from "../state/leases.ts";
import type { DurableStateStore, HistoryInput } from "../state/store.ts";
import { assertStoredContract } from "../state/contracts.ts";

export type TaskPacket = Static<typeof TaskPacketSchema>;
export type Amendment = Static<typeof AmendmentSchema>;

export interface CrewleadIdentity {
  crewleadSessionId: string;
  herdrWorkspaceId: string;
  herdrPaneId: string;
  canonicalProjectPath: string;
}

export interface DispatchItem {
  role: RoleId;
  purpose: string;
  packet: unknown;
  runtime?: RuntimeOverride;
  allowRedundantIntent?: boolean;
}

export interface DispatchRequest {
  items: readonly DispatchItem[];
  mode: "start" | "queue";
  evidenceRefs: readonly string[];
  /** Stable Pi tool-call identity used to make dispatch replay side-effect free. */
  requestId?: string;
}

export interface WorkspacePreparation {
  assignedRoot: string;
  sessionDirectory: string;
  evidenceRef: string;
  repositoryResource: RepositoryResource;
}

export interface BuilderWorkspacePlan {
  kind: "builder_allocation";
  assignedRoot: string;
  sessionDirectory: string;
  evidenceRef: string;
  allocation: Omit<
    RepositoryAllocationMetadata,
    "status" | "expectedRevision" | "fencingEpoch" | "preparedAt" | "updatedAt" | "diagnostic"
  >;
  /** In-memory adapter evidence; it is never persisted in the bounded run record. */
  adapterPlan?: unknown;
}

export interface LaunchInput {
  run: Readonly<RunRecord>;
  packet: Readonly<TaskPacket>;
  readiness: Readonly<RoleReadinessReceipt>;
  preparation: Readonly<WorkspacePreparation>;
  bootstrapPath: string;
}

export interface LaunchOutput {
  resources: MemberResources;
  plan?: MemberLaunchPlan;
}

export interface DispatchReceipt {
  runId: string;
  role: RoleId;
  purpose: string;
  state: RunRecord["state"];
  revision: number;
  queuedPosition?: number;
  resources?: Readonly<RunRecord["resources"]>;
  readiness?: Readonly<RoleReadinessReceipt>;
  warnings: readonly string[];
}

export interface CrewleadRuntimeDependencies {
  store: DurableStateStore;
  lifecycle: LifecycleService;
  herdr: HerdrAdapter;
  runtimeCleanup?: RuntimeCleanupService;
  integration?: BuilderIntegrationService;
  repositoryCleanup?: RepositoryCleanupService;
  capabilities: RunCapabilityManager;
  leases: FencedLeaseManager;
  configuration: EffectiveConfiguration;
  packageName?: "@debonzi/db11-crew";
  packageVersion?: "0.2.0";
  memberExtensionSha256: string;
  resolveReadiness(role: RoleId, explicitRuntime?: RuntimeOverride): Promise<RoleReadinessReceipt>;
  prepareWorkspace(run: Readonly<RunRecord>, packet: Readonly<TaskPacket>): Promise<WorkspacePreparation>;
  /** Production Builder path: read-only planning before the runtime persists allocation intent. */
  planBuilderWorkspace(run: Readonly<RunRecord>, packet: Readonly<TaskPacket>): Promise<BuilderWorkspacePlan>;
  /** Production Builder path: the adapter repeats preflight and creates only the persisted plan. */
  createBuilderWorkspace(
    run: Readonly<RunRecord>,
    packet: Readonly<TaskPacket>,
    plan: Readonly<BuilderWorkspacePlan>,
  ): Promise<WorkspacePreparation>;
  /** Fresh exact Git evidence required by active Builder reconciliation and recovery. */
  verifyBuilderResource?: (
    resource: Readonly<Extract<RepositoryResource, { kind: "builder_worktree" }>>,
  ) => Promise<void>;
  launch(input: LaunchInput): Promise<LaunchOutput>;
  now?: () => number;
  id?: () => string;
  leaseLifetimeMilliseconds?: number;
  enableRenewalTimer?: boolean;
}

export type ResultSection =
  | "full"
  | "summary"
  | "deliverables"
  | "completion_criteria"
  | "validation"
  | "unresolved"
  | "state_changes"
  | "references"
  | "recommended_next_steps"
  | "role_details";

export function selectResultSection(
  result: Readonly<Record<string, unknown>>,
  section: ResultSection,
): Readonly<Record<string, unknown>> {
  if (section === "full") return Object.freeze(structuredClone(result));
  const identity = {
    resultId: result.resultId,
    runId: result.runId,
    outcome: result.outcome,
    role: result.role,
  };
  const sections: Record<Exclude<ResultSection, "full">, Record<string, unknown>> = {
    summary: { ...identity, summary: result.summary, failure: result.failure },
    deliverables: { ...identity, deliverables: result.deliverables },
    completion_criteria: { ...identity, completionCriteria: result.completionCriteria },
    validation: { ...identity, validation: result.validation },
    unresolved: {
      ...identity,
      unresolvedBlockerIds: result.unresolvedBlockerIds,
      unresolvedDecisions: result.unresolvedDecisions,
    },
    state_changes: { ...identity, stateChanges: result.stateChanges },
    references: { ...identity, durableReferences: result.durableReferences },
    recommended_next_steps: { ...identity, recommendedNextSteps: result.recommendedNextSteps },
    role_details: { ...identity, roleDetails: result.roleDetails },
  };
  const selected = sections[section as Exclude<ResultSection, "full">];
  if (!selected) throw stateError("invalid_record");
  return Object.freeze(structuredClone(selected));
}

export interface RunInspection {
  run: Readonly<RunRecord>;
  packet?: Readonly<TaskPacket>;
  result?: Readonly<Record<string, unknown>>;
  blocker?: Readonly<Record<string, unknown>>;
  resultAcknowledged: boolean;
}

const ACTIVE = new Set<RunRecord["state"]>(["starting", "working", "blocked"]);
const TERMINAL = new Set<RunRecord["state"]>(["completed", "failed", "cancelled", "abandoned"]);

function eventFor(
  previous: RunRecord,
  next: RunRecord,
  operationId: string,
  type:
    | "state_transition"
    | "amendment_appended"
    | "delivery_changed"
    | "diagnostic",
  reason: string,
  evidenceRefs: readonly string[],
): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: operationId,
    runId: next.runId,
    sequence: next.revision,
    timestamp: next.updatedAt,
    actor: "crewlead",
    type,
    reason,
    evidenceRefs: [...evidenceRefs],
    expectedPriorState: previous.state,
    resultingState: next.state,
    expectedRevision: previous.revision,
    resultingRevision: next.revision,
    fencingEpoch: next.fencingEpoch,
  };
}

function validatePurpose(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized || normalized.length > LIMITS.labelLength) throw stateError("invalid_record");
  return normalized;
}

function validateEvidence(values: readonly string[]): string[] {
  if (values.length < 1 || values.length > LIMITS.listItems || new Set(values).size !== values.length) {
    throw stateError("invalid_record");
  }
  return [...values];
}

function asRun(value: Readonly<Record<string, unknown>>): RunRecord {
  const validation = validateContract("run", value);
  if (!validation.ok) throw stateError("invalid_record");
  return structuredClone(value) as RunRecord;
}

function packetValue(value: unknown, role?: RoleId): TaskPacket {
  const validation = validateContract("taskPacket", value);
  if (!validation.ok) throw stateError(validation.error.code === "oversized" ? "oversized" : "invalid_record");
  const packet = validation.value as TaskPacket;
  if (role !== undefined && packet.role !== role) throw stateError("invalid_record");
  return structuredClone(packet);
}

function safeDiagnostic(error: unknown): string {
  return redactDiagnostic(error).slice(0, LIMITS.diagnosticLength) || "A bounded startup operation failed.";
}

function resourceRecord(resources: MemberResources): RunRecord["resources"] {
  return {
    tabId: resources.tabId,
    paneId: resources.paneId,
    agentId: resources.agentTarget,
  };
}

function partialResourceRecord(error: unknown): Partial<NonNullable<RunRecord["resources"]>> | undefined {
  if (!(error instanceof HerdrAdapterError) || !error.partialResources) return undefined;
  const partial = error.partialResources;
  const value: Partial<NonNullable<RunRecord["resources"]>> = {};
  if (partial.tabId) value.tabId = partial.tabId;
  if (partial.paneId) value.paneId = partial.paneId;
  if (partial.agentTarget) value.agentId = partial.agentTarget;
  return Object.keys(value).length > 0 ? value : undefined;
}

function amendmentPrompt(amendment: Amendment): string {
  return [
    `DB11 Crew authenticated amendment ${amendment.amendmentId} (sequence ${amendment.sequence}).`,
    "Apply it only within the immutable task objective, role, permissions, and scope. Block if it would widen them.",
    "",
    amendment.summary,
  ].join("\n");
}

/** Session-bound asynchronous supervisor. It never waits for member work or completion. */
export class CrewleadRuntime {
  readonly identity: Readonly<CrewleadIdentity>;
  readonly dependencies: CrewleadRuntimeDependencies;

  private lease?: FencedLease;
  private unsubscribe?: () => void;
  private renewalTimer?: NodeJS.Timeout;
  private stopping = false;
  private operationsEnabled = false;
  private pendingReconciliation = false;
  private promotion: Promise<readonly DispatchReceipt[]> = Promise.resolve([]);
  private reconciliation: Promise<ReconciliationReport | undefined> = Promise.resolve(undefined);
  private readonly startupInFlight = new Set<string>();
  private readonly recovery: RecoveryService;

  constructor(identity: CrewleadIdentity, dependencies: CrewleadRuntimeDependencies) {
    this.identity = Object.freeze(structuredClone(identity));
    this.dependencies = dependencies;
    this.recovery = new RecoveryService(this.identity, {
      store: dependencies.store,
      lifecycle: dependencies.lifecycle,
      herdr: dependencies.herdr,
    }, {
      now: dependencies.now,
      id: (prefix) => this.identifier(prefix),
      isStartupInFlight: (runId) => this.startupInFlight.has(runId),
      verifyMemberReadiness: (run) => this.verifyMemberReadiness(run),
    });
  }

  private get leaseBinding(): LeaseBinding {
    return {
      protocolVersion: SCHEMA_VERSION,
      scope: "supervisor",
      crewleadSessionId: this.identity.crewleadSessionId,
      herdrWorkspaceId: this.identity.herdrWorkspaceId,
      canonicalProjectPath: this.identity.canonicalProjectPath,
    };
  }

  private timestamp(): string {
    return new Date(this.dependencies.now?.() ?? Date.now()).toISOString();
  }

  private identifier(prefix: string): string {
    return `${prefix}-${(this.dependencies.id?.() ?? randomUUID()).replace(/[^A-Za-z0-9._:-]/gu, "-")}`.slice(0, LIMITS.idLength);
  }

  private dispatchIdentifier(prefix: string, requestId: string | undefined, index: number): string {
    if (!requestId) return this.identifier(prefix);
    return `${prefix}-${sha256([
      this.identity.crewleadSessionId,
      this.identity.herdrWorkspaceId,
      this.identity.canonicalProjectPath,
      requestId,
      String(index),
      prefix,
    ].join("\0")).slice(0, 40)}`;
  }

  /** Acquire fencing and subscribe without permitting queued or member operations. */
  async startFenced(): Promise<void> {
    if (this.lease) return;
    const probe = await this.dependencies.herdr.probe();
    if (probe.protocol !== 17 || probe.apiSchema !== 1) throw stateError("invalid_binding");
    const [workspace, pane] = await Promise.all([
      this.dependencies.herdr.getWorkspace(this.identity.herdrWorkspaceId),
      this.dependencies.herdr.getPane(this.identity.herdrPaneId),
    ]);
    if (workspace.workspaceId !== this.identity.herdrWorkspaceId || pane.workspaceId !== workspace.workspaceId) {
      throw stateError("invalid_binding");
    }
    this.lease = await this.dependencies.leases.acquire(
      this.leaseBinding,
      this.dependencies.leaseLifetimeMilliseconds,
    );
    try {
      this.unsubscribe = await this.dependencies.herdr.subscribe({
        onEvent: (event) => this.onHerdrEvent(event),
        onReconcile: async (snapshot, generation) => {
          if (!this.operationsEnabled) {
            this.pendingReconciliation = true;
            return;
          }
          await this.enqueueReconciliation(() => this.recovery.reconcile(snapshot, generation));
          await this.promoteAvailable();
        },
        onGap: (reason) => {
          if (!this.operationsEnabled) {
            this.pendingReconciliation = true;
            return;
          }
          void this.enqueueReconciliation(async () => {
            await this.recovery.markConnectionGap(reason);
            return this.recovery.report();
          }).catch(() => {});
        },
      });
      if (this.dependencies.enableRenewalTimer !== false) {
        const interval = Math.max(
          LIMITS.leaseLifetimeMinimumMilliseconds,
          Math.floor((this.dependencies.leaseLifetimeMilliseconds ?? LIMITS.leaseLifetimeDefaultMilliseconds) / 2),
        );
        this.renewalTimer = setInterval(() => void this.renew().catch(() => {}), interval);
        this.renewalTimer.unref();
      }
    } catch (error) {
      await this.releaseLease();
      throw error;
    }
  }

  /** Open the operation latch after durable Crewlead designation. */
  async enableOperations(): Promise<void> {
    if (this.operationsEnabled) return;
    await this.assertActive(false);
    this.operationsEnabled = true;
    try {
      if (this.pendingReconciliation) {
        this.pendingReconciliation = false;
        await this.reconcileFresh();
      }
      await this.promoteAvailable();
    } catch (error) {
      this.operationsEnabled = false;
      throw error;
    }
  }

  /** Convenience startup for callers that do not own the designation lifecycle. */
  async start(): Promise<void> {
    await this.startFenced();
    await this.enableOperations();
  }

  private onHerdrEvent(event: HerdrEvent): void {
    if (event.workspaceId !== this.identity.herdrWorkspaceId) return;
    if (!this.operationsEnabled) {
      this.pendingReconciliation = true;
      return;
    }
    void this.reconcileFresh().then(() => this.promoteAvailable()).catch(() => {});
  }

  private enqueueReconciliation(
    operation: () => Promise<ReconciliationReport | undefined>,
  ): Promise<ReconciliationReport | undefined> {
    const next = this.reconciliation.then(async () => {
      await this.assertActive();
      return operation();
    });
    this.reconciliation = next.catch(() => undefined);
    return next;
  }

  private reconcileFresh(): Promise<ReconciliationReport | undefined> {
    return this.enqueueReconciliation(async () => {
      const snapshot = await this.dependencies.herdr.snapshot();
      const generation = (this.recovery.report()?.generation ?? 0) + 1;
      return this.recovery.reconcile(snapshot, generation);
    });
  }

  private async renew(): Promise<void> {
    const current = this.lease;
    if (!current || this.stopping) return;
    this.lease = await this.dependencies.leases.renew(
      this.leaseBinding,
      current.leaseToken,
      current.fencingEpoch,
      this.dependencies.leaseLifetimeMilliseconds,
    );
  }

  private async assertActive(requireOperations = true): Promise<void> {
    const current = this.lease;
    if (!current || this.stopping || (requireOperations && !this.operationsEnabled)) {
      throw stateError("lease_invalid");
    }
    await this.dependencies.leases.assertActive(
      this.leaseBinding,
      current.leaseToken,
      current.fencingEpoch,
    );
  }

  private async releaseLease(): Promise<void> {
    const current = this.lease;
    this.lease = undefined;
    if (!current) return;
    try {
      await this.dependencies.leases.release(
        this.leaseBinding,
        current.leaseToken,
        current.fencingEpoch,
      );
    } catch {
      // An expired or replaced lease is already fenced.
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.operationsEnabled = false;
    this.pendingReconciliation = false;
    if (this.renewalTimer) clearInterval(this.renewalTimer);
    this.renewalTimer = undefined;
    await this.reconciliation.catch(() => undefined);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.dependencies.herdr.stop();
    await this.releaseLease();
  }

  private owns(run: Readonly<RunRecord>): boolean {
    return (
      run.binding.crewleadSessionId === this.identity.crewleadSessionId &&
      run.binding.herdrWorkspaceId === this.identity.herdrWorkspaceId &&
      run.binding.canonicalProjectPath === this.identity.canonicalProjectPath
    );
  }

  private async verifyMemberReadiness(run: Readonly<RunRecord>): Promise<MemberReadinessResult> {
    const result = (code: MemberReadinessCode): MemberReadinessResult => ({
      ready: code === "ready",
      code,
      evidenceRefs: [`member-readiness:${code}`],
    });
    if (!ACTIVE.has(run.state)) return result("inactive_run");
    if (run.startup?.phase !== "prompt_acknowledged") return result("startup_incomplete");
    if (
      !this.owns(run) ||
      !run.binding.memberSessionId ||
      !run.resources ||
      run.resourceDisposition !== "open" ||
      !run.repositoryResource ||
      run.repositoryResource.runId !== run.runId ||
      (run.role === "builder") !== (run.repositoryResource.kind === "builder_worktree")
    ) {
      return result("resource_binding_invalid");
    }

    const assignedRoot = run.startup.assignedRoot;
    const sourceRoot = run.repositoryResource.source.canonicalRoot;
    const resourcePath = run.repositoryResource.path;
    if (
      !assignedRoot ||
      [run.binding.canonicalProjectPath, assignedRoot, sourceRoot, resourcePath].some((path) =>
        !isAbsolute(path) || normalize(path) !== path) ||
      sourceRoot !== run.binding.canonicalProjectPath ||
      resourcePath !== assignedRoot
    ) {
      return result("path_binding_invalid");
    }

    if (run.role === "builder") {
      const resource = run.repositoryResource;
      if (
        resource.kind !== "builder_worktree" ||
        !resource.protectedRefDigest ||
        !this.dependencies.verifyBuilderResource
      ) {
        return result("builder_resource_invalid");
      }
      try {
        await this.dependencies.verifyBuilderResource(Object.freeze(structuredClone(resource)));
      } catch {
        return result("builder_resource_invalid");
      }
    }

    const readiness = await this.dependencies.resolveReadiness(run.role, run.runtimeRequest);
    if (
      !readiness.ready ||
      readiness.role !== run.role ||
      !readiness.runtime ||
      !readiness.profile ||
      readiness.checks.length < 1 ||
      readiness.checks.some((check) => !check.ready)
    ) {
      return result("role_readiness_failed");
    }
    const companionResources = readiness.resources.filter((resource) => resource.id === "member_companion");
    if (
      companionResources.length !== 1 ||
      companionResources[0]!.sha256 !== this.dependencies.memberExtensionSha256
    ) {
      return result("companion_provenance_failed");
    }

    const capabilityBinding = {
      protocolVersion: SCHEMA_VERSION,
      crewleadSessionId: run.binding.crewleadSessionId,
      herdrWorkspaceId: run.binding.herdrWorkspaceId,
      canonicalProjectPath: run.binding.canonicalProjectPath,
      runId: run.runId,
      memberSessionId: run.binding.memberSessionId,
      role: run.role,
      fencingEpoch: run.fencingEpoch,
    } as const;
    const companionLeaseBinding: LeaseBinding = {
      protocolVersion: SCHEMA_VERSION,
      scope: "companion",
      crewleadSessionId: run.binding.crewleadSessionId,
      herdrWorkspaceId: run.binding.herdrWorkspaceId,
      canonicalProjectPath: run.binding.canonicalProjectPath,
      runId: run.runId,
      memberSessionId: run.binding.memberSessionId,
      role: run.role,
    };
    const [capabilities, lease] = await Promise.all([
      this.dependencies.capabilities.inspectExactBinding(capabilityBinding),
      this.dependencies.leases.inspectExactBinding(companionLeaseBinding, run.fencingEpoch),
    ]);
    if (!capabilities.healthy) {
      return result(capabilities.code === "healthy" ? "verification_error" : `capability_${capabilities.code}`);
    }
    if (!lease.healthy) {
      return result(lease.code === "healthy" ? "verification_error" : `lease_${lease.code}`);
    }
    return result("ready");
  }

  private requireOwned(run: RunRecord): RunRecord {
    if (!this.owns(run)) throw stateError("invalid_binding");
    return run;
  }

  private async ownedRuns(): Promise<RunRecord[]> {
    return (await this.dependencies.store.listRuns()).map(asRun).filter((run) => this.owns(run));
  }

  private async packetFor(runId: string): Promise<TaskPacket> {
    const records = await this.dependencies.store.readHistory(runId);
    const packets = records
      .filter((record) => record.kind === "control" && validateContract("taskPacket", record.payload).ok)
      .map((record) => packetValue(record.payload));
    if (packets.length !== 1) throw stateError("invalid_record");
    return packets[0]!;
  }

  private async sameStateCommit(
    current: RunRecord,
    operationId: string,
    type: "state_transition" | "amendment_appended" | "delivery_changed" | "diagnostic",
    reason: string,
    evidenceRefs: readonly string[],
    extra: readonly HistoryInput[],
    mutate: (next: RunRecord) => void,
  ): Promise<RunRecord> {
    const next = structuredClone(current);
    next.revision += 1;
    next.updatedAt = this.timestamp();
    mutate(next);
    const result = await this.dependencies.store.commitRun({
      operationId,
      expectedRevision: current.revision,
      expectedFencingEpoch: current.fencingEpoch,
      run: next,
      history: [
        {
          kind: "lifecycle",
          payload: eventFor(current, next, operationId, type, reason, evidenceRefs),
        },
        ...extra,
      ],
    });
    return asRun(result.run);
  }

  private async markStartup(
    current: RunRecord,
    operationId: string,
    phase: NonNullable<RunRecord["startup"]>["phase"],
    values: Partial<NonNullable<RunRecord["startup"]>>,
    reason: string,
    evidenceRefs: readonly string[],
    mutate?: (next: RunRecord) => void,
  ): Promise<RunRecord> {
    return this.sameStateCommit(
      current,
      operationId,
      "diagnostic",
      reason,
      evidenceRefs,
      [],
      (next) => {
        next.startup = { phase, ...structuredClone(values) };
        mutate?.(next);
      },
    );
  }

  private receipt(run: RunRecord, readiness?: RoleReadinessReceipt, warnings: readonly string[] = []): DispatchReceipt {
    return Object.freeze({
      runId: run.runId,
      role: run.role,
      purpose: run.purposeLabel,
      state: run.state,
      revision: run.revision,
      ...(run.queue ? { queuedPosition: run.queue.enqueueSequence } : {}),
      ...(run.resources ? { resources: Object.freeze(structuredClone(run.resources)) } : {}),
      ...(readiness ? { readiness: Object.freeze(structuredClone(readiness)) } : {}),
      warnings: Object.freeze([...warnings]),
    });
  }

  private async requireRoleReadiness(
    role: RoleId,
    explicitRuntime?: RuntimeOverride,
  ): Promise<RoleReadinessReceipt> {
    const readiness = await this.dependencies.resolveReadiness(role, explicitRuntime);
    const companionResources = readiness.resources.filter((resource) => resource.id === "member_companion");
    if (
      !readiness.ready ||
      readiness.role !== role ||
      !readiness.runtime ||
      !readiness.profile ||
      readiness.checks.length < 1 ||
      readiness.checks.some((check) => !check.ready) ||
      companionResources.length !== 1 ||
      companionResources[0]!.sha256 !== this.dependencies.memberExtensionSha256
    ) {
      throw stateError("invalid_binding");
    }
    return readiness;
  }

  private async preflightItem(item: DispatchItem): Promise<{
    item: DispatchItem;
    packet: TaskPacket;
    purpose: string;
  }> {
    const packet = packetValue(item.packet, item.role);
    const purpose = validatePurpose(item.purpose);
    if (item.runtime !== undefined) {
      const runtimeValidation = validateContract("configuration", {
        schemaVersion: ACCOUNT_CONFIGURATION_VERSION,
        runtimes: { [item.role]: item.runtime },
      });
      if (!runtimeValidation.ok) throw stateError("invalid_record");
    }
    await this.requireRoleReadiness(item.role, item.runtime);
    return { item, packet, purpose };
  }

  async dispatch(request: DispatchRequest): Promise<readonly DispatchReceipt[]> {
    await this.assertActive();
    if (request.items.length < 1 || request.items.length > LIMITS.stateBatchTransactions) {
      throw stateError("oversized");
    }
    const evidenceRefs = validateEvidence(request.evidenceRefs);
    if (request.mode !== "start" && request.mode !== "queue") throw stateError("invalid_record");

    // Every packet and role is checked before the atomic admission write and before
    // any Git, Herdr, Pi-session, bootstrap, or member side effect.
    const preflight = await Promise.all(request.items.map((item) => this.preflightItem(item)));
    const timestamp = this.timestamp();
    const candidates: AdmissionCandidate[] = preflight.map(({ item, packet, purpose }, index) => {
      const runId = this.dispatchIdentifier("run", request.requestId, index);
      return {
        admissionId: this.dispatchIdentifier("admission", request.requestId, index),
        runId,
        packetId: packet.packetId,
        intentDigest: digestJson(
          { packet, canonicalProjectPath: this.identity.canonicalProjectPath },
          LIMITS.taskPacketBytes + LIMITS.pathLength,
        ),
        purposeLabel: purpose,
        role: item.role,
        binding: {
          crewleadSessionId: this.identity.crewleadSessionId,
          memberSessionId: this.dispatchIdentifier("member", request.requestId, index),
          herdrWorkspaceId: this.identity.herdrWorkspaceId,
          canonicalProjectPath: this.identity.canonicalProjectPath,
        },
        retentionPolicy: this.dependencies.configuration.retention.policy,
        createdAt: timestamp,
        allowRedundantIntent: item.allowRedundantIntent,
        ...(item.runtime === undefined ? {} : { runtimeRequest: structuredClone(item.runtime) }),
        packet,
      };
    });
    if (request.requestId) {
      const existingRuns = await this.ownedRuns();
      const existing = candidates.map((candidate) =>
        existingRuns.find((run) => run.admissionId === candidate.admissionId));
      if (existing.some(Boolean)) {
        if (!existing.every(Boolean)) throw stateError("idempotency_conflict");
        for (const [index, run] of (existing as RunRecord[]).entries()) {
          const candidate = candidates[index]!;
          if (
            run.runId !== candidate.runId ||
            run.packetId !== candidate.packetId ||
            run.intentDigest !== candidate.intentDigest ||
            run.role !== candidate.role ||
            run.purposeLabel !== candidate.purposeLabel ||
            run.admission.mode !== request.mode ||
            digestJson(run.runtimeRequest ?? null, LIMITS.runBytes) !==
              digestJson(candidate.runtimeRequest ?? null, LIMITS.runBytes)
          ) {
            throw stateError("idempotency_conflict");
          }
        }
        return Object.freeze((existing as RunRecord[]).map((run) =>
          this.receipt(run, undefined, ["The stable dispatch request was already admitted; no startup side effect was repeated."])));
      }
    }
    if (request.mode === "start" && this.dependencies.runtimeCleanup) {
      const runs = (await this.dependencies.store.listRuns()).map(asRun).filter((run) => this.owns(run));
      const shortage = Math.max(0,
        admissionCounts(runs).openResources + request.items.length -
        this.dependencies.configuration.limits.maxOpenMemberResources,
      );
      if (shortage > 0) await this.dependencies.runtimeCleanup.reclaim(shortage);
    }
    const admission = await this.dependencies.lifecycle.admitBatch({
      candidates,
      mode: request.mode,
      explicitQueueAuthorization: request.mode === "queue" ? true : undefined,
      actor: "crewlead",
      evidenceRefs,
    });
    if (request.mode === "queue") return admission.runs.map((run) => this.receipt(run));

    const settled = await Promise.all(
      admission.runs.map((run) => this.startRun(run)),
    );
    return Object.freeze(settled);
  }

  private async startRun(runValue: RunRecord): Promise<DispatchReceipt> {
    let run = this.requireOwned(runValue);
    if (run.state !== "starting") throw stateError("invalid_transition");
    let readiness: RoleReadinessReceipt | undefined;
    this.startupInFlight.add(run.runId);
    try {
      const packet = await this.packetFor(run.runId);
      // Admission and queue-promotion receipts are point-in-time evidence only.
      // Re-resolve immediately before the first workspace side effect.
      await this.requireRoleReadiness(run.role, run.runtimeRequest);
      let preparation: WorkspacePreparation;
      const planBuilder = this.dependencies.planBuilderWorkspace;
      const createBuilder = this.dependencies.createBuilderWorkspace;
      if (run.role === "builder") {
        const plan = await planBuilder(run, packet);
        const allocation = plan.allocation;
        if (
          plan.kind !== "builder_allocation" ||
          plan.assignedRoot !== allocation.path ||
          plan.sessionDirectory !== allocation.sessionDirectory ||
          allocation.runId !== run.runId ||
          allocation.source.canonicalRoot !== this.identity.canonicalProjectPath ||
          !/^[a-f0-9]{64}$/u.test(allocation.sourceStatusDigest) ||
          !/^[a-f0-9]{64}$/u.test(allocation.protectedRefDigest)
        ) {
          throw stateError("invalid_binding");
        }
        const preparedAt = this.timestamp();
        const expectedRevision = run.revision;
        run = await this.sameStateCommit(
          run,
          this.identifier("startup-allocation"),
          "diagnostic",
          "The exact Builder allocation intent was persisted before Git mutation.",
          [plan.evidenceRef],
          [],
          (next) => {
            next.repositoryAllocation = {
              ...structuredClone(allocation),
              status: "prepared",
              expectedRevision,
              fencingEpoch: run.fencingEpoch,
              preparedAt,
              updatedAt: preparedAt,
            };
          },
        );
        const persisted = this.requireOwned(asRun(await this.dependencies.store.readRun(run.runId)));
        await this.assertActive();
        if (
          persisted.revision !== run.revision ||
          persisted.fencingEpoch !== run.fencingEpoch ||
          persisted.repositoryAllocation?.status !== "prepared" ||
          digestJson(persisted.repositoryAllocation, LIMITS.runBytes) !==
            digestJson(run.repositoryAllocation, LIMITS.runBytes)
        ) {
          throw stateError("revision_conflict");
        }
        run = persisted;
        try {
          preparation = await createBuilder(run, packet, plan);
        } catch (error) {
          const latest = this.requireOwned(asRun(await this.dependencies.store.readRun(run.runId)));
          if (
            latest.state === "starting" &&
            latest.repositoryAllocation?.status === "prepared" &&
            latest.repositoryAllocation.expectedRevision === expectedRevision &&
            latest.repositoryAllocation.fencingEpoch === run.fencingEpoch
          ) {
            const diagnostic = safeDiagnostic(error);
            run = await this.sameStateCommit(
              latest,
              this.identifier("startup-allocation-failed"),
              "diagnostic",
              "The exact Builder allocation failed and was retained without cleanup or retry.",
              [plan.evidenceRef],
              [],
              (next) => {
                next.repositoryAllocation = {
                  ...next.repositoryAllocation!,
                  status: "failed",
                  updatedAt: next.updatedAt,
                  diagnostic,
                };
              },
            );
          }
          throw error;
        }
        if (
          preparation.repositoryResource.runId !== run.runId ||
          preparation.repositoryResource.source.canonicalRoot !== this.identity.canonicalProjectPath ||
          preparation.repositoryResource.path !== preparation.assignedRoot ||
          preparation.repositoryResource.kind !== "builder_worktree" ||
          preparation.repositoryResource.protectedRefDigest !== allocation.protectedRefDigest
        ) {
          throw stateError("invalid_binding");
        }
        run = await this.markStartup(
          run,
          this.identifier("startup-workspace"),
          "workspace_prepared",
          {
            assignedRoot: preparation.assignedRoot,
            sessionDirectory: preparation.sessionDirectory,
          },
          "The freshly verified exact Builder resource was promoted from its durable allocation intent.",
          [preparation.evidenceRef],
          (next) => {
            next.repositoryResource = structuredClone(preparation.repositoryResource);
            next.repositoryAllocation = {
              ...next.repositoryAllocation!,
              status: "created",
              updatedAt: next.updatedAt,
            };
          },
        );
      } else {
        preparation = await this.dependencies.prepareWorkspace(run, packet);
        if (
          preparation.repositoryResource.runId !== run.runId ||
          preparation.repositoryResource.source.canonicalRoot !== this.identity.canonicalProjectPath ||
          preparation.repositoryResource.path !== preparation.assignedRoot
        ) throw stateError("invalid_binding");
        run = await this.markStartup(
          run,
          this.identifier("startup-workspace"),
          "workspace_prepared",
          {
            assignedRoot: preparation.assignedRoot,
            sessionDirectory: preparation.sessionDirectory,
          },
          "The role workspace was prepared after durable admission.",
          [preparation.evidenceRef],
          (next) => {
            next.repositoryResource = structuredClone(preparation.repositoryResource);
          },
        );
      }
      if (!run.repositoryResource) throw stateError("invalid_record");
      const memberSessionId = run.binding.memberSessionId;
      if (!memberSessionId) throw stateError("invalid_binding");
      // Workspace preparation can outlive its admission evidence. Resolve the
      // complete role/runtime/profile/resource boundary again for member launch.
      readiness = await this.requireRoleReadiness(run.role, run.runtimeRequest);
      const memberExtension = readiness.resources.find((resource) => resource.id === "member_companion");
      if (
        !readiness.profile ||
        !memberExtension ||
        memberExtension.sha256 !== this.dependencies.memberExtensionSha256
      ) {
        throw stateError("invalid_binding");
      }
      const configuration: CompanionConfiguration = {
        schemaVersion: COMPANION_CONFIGURATION_VERSION,
        packageName: this.dependencies.packageName ?? "@debonzi/db11-crew",
        packageVersion: this.dependencies.packageVersion ?? "0.2.0",
        memberExtensionPath: memberExtension.resourcePath,
        memberExtensionSha256: memberExtension.sha256,
        roleProfileVersion: readiness.profile.profileVersion,
        roleProfilePath: readiness.profile.profilePath,
        roleProfileSha256: readiness.profile.profileSha256,
        assignedRoot: preparation.assignedRoot,
        sourceCanonicalProjectPath: this.identity.canonicalProjectPath,
        packet,
        progressEnabled: this.dependencies.configuration.progress.enabled,
      };
      const bootstrap = await this.dependencies.capabilities.provision(
        {
          protocolVersion: SCHEMA_VERSION,
          crewleadSessionId: this.identity.crewleadSessionId,
          herdrWorkspaceId: this.identity.herdrWorkspaceId,
          canonicalProjectPath: this.identity.canonicalProjectPath,
          runId: run.runId,
          memberSessionId,
          role: run.role,
          fencingEpoch: run.fencingEpoch,
        },
        configuration,
      );
      run = await this.markStartup(
        run,
        this.identifier("startup-bootstrap"),
        "bootstrap_provisioned",
        {
          assignedRoot: preparation.assignedRoot,
          sessionDirectory: preparation.sessionDirectory,
          bootstrapId: bootstrap.bootstrapId,
        },
        "The one-time companion bootstrap was provisioned outside model context.",
        [`bootstrap:${bootstrap.bootstrapId}`],
      );
      const launchReadiness = await this.requireRoleReadiness(run.role, run.runtimeRequest);
      if (
        digestJson(
          { runtime: launchReadiness.runtime, profile: launchReadiness.profile, resources: launchReadiness.resources },
          LIMITS.roleManifestBytes,
        ) !== digestJson(
          { runtime: readiness.runtime, profile: readiness.profile, resources: readiness.resources },
          LIMITS.roleManifestBytes,
        )
      ) {
        throw stateError("invalid_binding");
      }
      readiness = launchReadiness;
      const launched = await this.dependencies.launch({
        run,
        packet,
        readiness,
        preparation,
        bootstrapPath: bootstrap.bootstrapPath,
      });
      if (
        launched.resources.workspaceId !== this.identity.herdrWorkspaceId ||
        (launched.resources.memberSession?.kind === "id" &&
          launched.resources.memberSession.value !== memberSessionId)
      ) {
        throw stateError("invalid_binding");
      }
      run = await this.sameStateCommit(
        run,
        this.identifier("startup-prompt"),
        "diagnostic",
        "Pi readiness and non-waiting prompt submission were acknowledged.",
        [preparation.evidenceRef, `pane:${launched.resources.paneId}`],
        [],
        (next) => {
          next.resources = resourceRecord(launched.resources);
          next.startup = {
            phase: "prompt_acknowledged",
            assignedRoot: preparation.assignedRoot,
            sessionDirectory: preparation.sessionDirectory,
            bootstrapId: bootstrap.bootstrapId,
          };
        },
      );
      run = await this.dependencies.lifecycle.transition({
        operationId: this.identifier("dispatch-working"),
        runId: run.runId,
        expectedRevision: run.revision,
        expectedFencingEpoch: run.fencingEpoch,
        actor: "crewlead",
        targetState: "working",
        reason: "The bounded dispatch success gate completed without waiting for member work.",
        evidenceRefs: [preparation.evidenceRef, `pane:${launched.resources.paneId}`],
        timestamp: this.timestamp(),
      });
      return this.receipt(run, readiness);
    } catch (error) {
      const diagnostic = safeDiagnostic(error);
      let latest = this.requireOwned(asRun(await this.dependencies.store.readRun(run.runId)));
      if (latest.state === "starting" && latest.repositoryAllocation?.status === "prepared") {
        latest = await this.sameStateCommit(
          latest,
          this.identifier("startup-allocation-failed"),
          "diagnostic",
          "The exact Builder allocation failed and was retained without cleanup or retry.",
          ["builder-allocation:failed"],
          [],
          (next) => {
            next.repositoryAllocation = {
              ...next.repositoryAllocation!,
              status: "failed",
              updatedAt: next.updatedAt,
              diagnostic,
            };
          },
        );
      }
      if (latest.state === "starting") {
        run = await this.sameStateCommit(
          latest,
          this.identifier("startup-partial"),
          "diagnostic",
          "Dispatch did not satisfy the success gate and was retained for explicit diagnosis.",
          ["startup:partial"],
          [],
          (next) => {
            next.startup = {
              phase: "partial_failure",
              ...(latest.startup?.assignedRoot ? { assignedRoot: latest.startup.assignedRoot } : {}),
              ...(latest.startup?.sessionDirectory ? { sessionDirectory: latest.startup.sessionDirectory } : {}),
              ...(latest.startup?.bootstrapId ? { bootstrapId: latest.startup.bootstrapId } : {}),
              ...(partialResourceRecord(error) ? { partialResources: partialResourceRecord(error) } : {}),
              diagnostic,
            };
            next.health = {
              status: "recovery_required",
              reconciliationRequired: true,
              reason: diagnostic,
              evidenceRefs: ["startup:partial"],
              updatedAt: next.updatedAt,
            };
          },
        );
      } else {
        run = latest;
      }
      return this.receipt(run, readiness, [diagnostic, "No automatic retry or cleanup was attempted."]);
    } finally {
      this.startupInFlight.delete(run.runId);
    }
  }

  async promoteAvailable(): Promise<readonly DispatchReceipt[]> {
    if (!this.operationsEnabled) return Object.freeze([]);
    this.promotion = this.promotion.then(async () => {
      if (!this.lease || this.stopping || !this.operationsEnabled) return [];
      await this.assertActive();
      const receipts: DispatchReceipt[] = [];
      while (true) {
        const queue = (await this.ownedRuns())
          .filter((run) => run.state === "queued")
          .sort((left, right) =>
            (left.queue?.enqueueSequence ?? Number.MAX_SAFE_INTEGER) -
              (right.queue?.enqueueSequence ?? Number.MAX_SAFE_INTEGER) ||
            left.runId.localeCompare(right.runId));
        const head = queue[0];
        if (!head) break;
        let readiness: RoleReadinessReceipt | undefined;
        let packet: TaskPacket | undefined;
        let failure: string | undefined;
        try {
          packet = await this.packetFor(head.runId);
          readiness = await this.requireRoleReadiness(head.role, head.runtimeRequest);
        } catch (error) {
          failure = (error as { code?: unknown }).code === "invalid_binding"
            ? "The FIFO head is not currently role-ready."
            : safeDiagnostic(error);
        }
        const promoted = await this.dependencies.lifecycle.promoteNext({
          operationId: this.identifier("queue-promote"),
          actor: "crewlead",
          evidenceRefs: ["queue:fifo-head"],
          timestamp: this.timestamp(),
          online: true,
          expectedRunId: head.runId,
          expectedRevision: head.revision,
          expectedFencingEpoch: head.fencingEpoch,
          revalidate: () => failure || !packet
            ? { ok: false, reason: failure ?? "The durable task packet is unavailable." }
            : { ok: true },
        });
        if (promoted.status === "capacity_blocked" || promoted.status === "start_blocked") {
          receipts.push(this.receipt(promoted.run, readiness));
          break;
        }
        if (promoted.status !== "promoted") break;
        receipts.push(await this.startRun(promoted.run));
      }
      return Object.freeze(receipts);
    });
    return this.promotion;
  }

  async list(limit: number = LIMITS.listItems): Promise<readonly RunRecord[]> {
    await this.assertActive();
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.listItems) throw stateError("invalid_record");
    return Object.freeze(
      (await this.ownedRuns())
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.runId.localeCompare(right.runId))
        .slice(0, limit)
        .map((run) => Object.freeze(structuredClone(run))),
    );
  }

  async inspect(runId: string): Promise<RunInspection> {
    await this.assertActive();
    const run = this.requireOwned(asRun(await this.dependencies.store.readRun(runId)));
    const records = await this.dependencies.store.readHistory(runId);
    const packetRecord = records.find(
      (record) => record.kind === "control" && validateContract("taskPacket", record.payload).ok,
    );
    const resultRecord = [...records].reverse().find((record) => record.kind === "result");
    const blockerRecord = [...records].reverse().find(
      (record) => record.kind === "control" && validateContract("blocker", record.payload).ok,
    );
    const acknowledged = records.some(
      (record) => record.kind === "control" &&
        (record.payload as { type?: unknown }).type === "result_acknowledged",
    );
    return Object.freeze({
      run: Object.freeze(structuredClone(run)),
      ...(packetRecord ? { packet: Object.freeze(packetValue(packetRecord.payload)) } : {}),
      ...(resultRecord ? { result: Object.freeze(structuredClone(resultRecord.payload as Record<string, unknown>)) } : {}),
      ...(blockerRecord ? { blocker: Object.freeze(structuredClone(blockerRecord.payload as Record<string, unknown>)) } : {}),
      resultAcknowledged: acknowledged,
    });
  }

  private async exactLiveMemberTarget(expected: Readonly<RunRecord>): Promise<
    | { run: RunRecord; paneId: string }
    | { run: RunRecord; reason: string }
  > {
    const snapshot = await this.dependencies.herdr.snapshot();
    const current = this.requireOwned(asRun(await this.dependencies.store.readRun(expected.runId)));
    await this.assertActive();
    if (
      current.revision !== expected.revision ||
      current.fencingEpoch !== expected.fencingEpoch ||
      !ACTIVE.has(current.state) ||
      !current.resources
    ) {
      return {
        run: current,
        reason: "The durable run identity changed before member targeting; explicit reconciliation is required.",
      };
    }
    const match = matchManagedMember(snapshot, current);
    if (match.status !== "exact") {
      return {
        run: current,
        reason: "The exact live member identity changed before targeting; explicit reconciliation is required.",
      };
    }
    return { run: current, paneId: match.agent.paneId };
  }

  private async nextAmendmentSequence(runId: string): Promise<number> {
    const sequences = (await this.dependencies.store.readHistory(runId))
      .filter((record) => record.kind === "control" && validateContract("amendment", record.payload).ok)
      .map((record) => Number((record.payload as { sequence: number }).sequence));
    return (sequences.length ? Math.max(...sequences) : 0) + 1;
  }

  async amend(input: {
    runId: string;
    expectedRevision: number;
    kind: Amendment["kind"];
    summary: string;
    evidenceRefs: readonly string[];
  }): Promise<{ run: RunRecord; promptAcknowledged: boolean; warning?: string }> {
    await this.assertActive();
    let current = this.requireOwned(asRun(await this.dependencies.store.readRun(input.runId)));
    if (!ACTIVE.has(current.state) || current.revision !== input.expectedRevision || !current.resources) {
      throw stateError(current.revision !== input.expectedRevision ? "revision_conflict" : "invalid_transition");
    }
    const evidenceRefs = validateEvidence(input.evidenceRefs);
    const amendment: Amendment = {
      schemaVersion: SCHEMA_VERSION,
      amendmentId: this.identifier("amendment"),
      runId: current.runId,
      sequence: await this.nextAmendmentSequence(current.runId),
      expectedRevision: current.revision,
      author: "crewlead",
      timestamp: this.timestamp(),
      kind: input.kind,
      summary: input.summary,
    };
    const validation = validateContract("amendment", amendment);
    if (!validation.ok) throw stateError(validation.error.code === "oversized" ? "oversized" : "invalid_record");
    current = await this.sameStateCommit(
      current,
      `op-${amendment.amendmentId}`,
      "amendment_appended",
      "The Crewlead appended an authenticated same-task amendment before prompt delivery.",
      evidenceRefs,
      [{ kind: "control", payload: amendment }],
      () => {},
    );
    try {
      const target = await this.exactLiveMemberTarget(current);
      current = target.run;
      if ("reason" in target) {
        if (ACTIVE.has(current.state) && current.revision === amendment.expectedRevision + 1) {
          current = await this.controlFailureHealth(
            current,
            "recovery_required",
            target.reason,
            ["herdr:exact-member-changed"],
          );
        }
        return {
          run: current,
          promptAcknowledged: false,
          warning: `${target.reason} The durable amendment was not retried.`,
        };
      }
      await this.dependencies.herdr.prompt(target.paneId, amendmentPrompt(amendment));
      return { run: current, promptAcknowledged: true };
    } catch (error) {
      return {
        run: current,
        promptAcknowledged: false,
        warning: `${safeDiagnostic(error)} The durable amendment was not retried.`,
      };
    }
  }

  async respondToBlocker(input: {
    runId: string;
    expectedRevision: number;
    blockerId: string;
    blockerRevision: number;
    response: string;
    evidenceRefs: readonly string[];
  }): ReturnType<CrewleadRuntime["amend"]> {
    const inspection = await this.inspect(input.runId);
    const blocker = inspection.blocker as { blockerId?: unknown; blockerRevision?: unknown; status?: unknown } | undefined;
    if (
      inspection.run.state !== "blocked" ||
      inspection.run.activeBlockerId !== input.blockerId ||
      blocker?.blockerId !== input.blockerId ||
      blocker.blockerRevision !== input.blockerRevision ||
      blocker.status !== "open"
    ) {
      throw stateError("revision_conflict");
    }
    return this.amend({
      runId: input.runId,
      expectedRevision: input.expectedRevision,
      kind: "clarification",
      summary: `Response to blocker ${input.blockerId} revision ${input.blockerRevision}: ${input.response}`,
      evidenceRefs: input.evidenceRefs,
    });
  }

  private stableControlId(prefix: "cancel" | "force", requestId?: string): string {
    if (!requestId) return this.identifier(prefix);
    return `${prefix}-${sha256([
      this.identity.crewleadSessionId,
      this.identity.herdrWorkspaceId,
      this.identity.canonicalProjectPath,
      requestId,
      prefix,
    ].join("\0")).slice(0, 40)}`;
  }

  private async controlAction(
    runId: string,
    type: "cancel_requested" | "force_requested",
    controlId?: string,
  ): Promise<Record<string, unknown> | undefined> {
    return [...await this.dependencies.store.readHistory(runId)].reverse().find((record) =>
      record.kind === "control" &&
      (record.payload as { type?: unknown }).type === type &&
      (controlId === undefined || (record.payload as { controlId?: unknown }).controlId === controlId),
    )?.payload as Record<string, unknown> | undefined;
  }

  private assertControlReplay(
    action: Record<string, unknown>,
    input: { expectedRevision: number; reason: string; evidenceRefs: readonly string[] },
  ): void {
    if (
      action.expectedRevision !== input.expectedRevision ||
      action.reason !== input.reason ||
      !Array.isArray(action.evidenceRefs) ||
      JSON.stringify(action.evidenceRefs.slice(0, input.evidenceRefs.length)) !== JSON.stringify(input.evidenceRefs)
    ) {
      throw stateError("idempotency_conflict");
    }
  }

  private async controlFailureHealth(
    current: RunRecord,
    status: "unreachable" | "orphan_suspected" | "recovery_required",
    reason: string,
    evidenceRefs: readonly string[],
  ): Promise<RunRecord> {
    return this.dependencies.lifecycle.recordHealth({
      operationId: this.identifier("control-health"),
      runId: current.runId,
      expectedRevision: current.revision,
      expectedFencingEpoch: current.fencingEpoch,
      actor: "crewlead",
      status,
      reconciliationRequired: true,
      reason,
      evidenceRefs,
      timestamp: this.timestamp(),
    });
  }

  async cancel(input: {
    runId: string;
    expectedRevision: number;
    reason: string;
    evidenceRefs: readonly string[];
    requestId?: string;
  }): Promise<{ run: RunRecord; interruptAcknowledged: boolean; duplicate: boolean; warning?: string }> {
    await this.assertActive();
    let current = this.requireOwned(asRun(await this.dependencies.store.readRun(input.runId)));
    const evidenceRefs = validateEvidence(input.evidenceRefs);
    const controlId = this.stableControlId("cancel", input.requestId);
    const existing = await this.controlAction(current.runId, "cancel_requested", controlId);
    if (existing) {
      this.assertControlReplay(existing, { ...input, evidenceRefs });
      return {
        run: current,
        interruptAcknowledged: current.state === "cancelled",
        duplicate: true,
        warning: current.state === "cancelled"
          ? undefined
          : "The identical cancellation intent is already durable; no interrupt was repeated.",
      };
    }
    if (TERMINAL.has(current.state)) {
      return {
        run: current,
        interruptAcknowledged: current.state === "cancelled",
        duplicate: false,
        warning: `The run already has immutable terminal outcome ${current.state}; cancellation made no change.`,
      };
    }
    if (current.revision !== input.expectedRevision) throw stateError("revision_conflict");
    const control = {
      schemaVersion: SCHEMA_VERSION,
      controlId,
      runId: current.runId,
      type: "cancel_requested",
      actor: "crewlead",
      reason: input.reason,
      expectedRevision: current.revision,
      fencingEpoch: current.fencingEpoch,
      timestamp: this.timestamp(),
      evidenceRefs,
    };
    assertStoredContract("controlAction", control);
    if (current.state === "queued") {
      current = await this.sameStateCommit(
        current,
        `op-${control.controlId}`,
        "state_transition",
        "The queued delegation was atomically tombstoned by an explicit cancellation intent.",
        evidenceRefs,
        [{ kind: "control", payload: control }],
        (next) => { next.state = "cancelled"; },
      );
      await this.promoteAvailable();
      return { run: current, interruptAcknowledged: true, duplicate: false };
    }
    if (!ACTIVE.has(current.state)) throw stateError("invalid_transition");
    try {
      current = await this.sameStateCommit(
        current,
        `op-${control.controlId}`,
        "diagnostic",
        "A graceful cancellation request was durably recorded before interrupt delivery.",
        evidenceRefs,
        [{ kind: "control", payload: control }],
        () => {},
      );
    } catch (error) {
      if ((error as { code?: unknown }).code !== "revision_conflict") throw error;
      const winner = this.requireOwned(asRun(await this.dependencies.store.readRun(current.runId)));
      if (!TERMINAL.has(winner.state)) throw error;
      return {
        run: winner,
        interruptAcknowledged: winner.state === "cancelled",
        duplicate: false,
        warning: `The concurrent terminal outcome ${winner.state} won the cancellation revision race; no interrupt was sent.`,
      };
    }
    if (!current.resources) {
      current = await this.controlFailureHealth(
        current,
        "orphan_suspected",
        "The cancellation intent is durable but the run has no complete authoritative pane identity.",
        evidenceRefs,
      );
      return {
        run: current,
        interruptAcknowledged: false,
        duplicate: false,
        warning: "The run has no complete authoritative pane identity; no blind interrupt was attempted.",
      };
    }
    try {
      const target = await this.exactLiveMemberTarget(current);
      current = target.run;
      if ("reason" in target) {
        if (ACTIVE.has(current.state) && current.revision === control.expectedRevision + 1) {
          current = await this.controlFailureHealth(
            current,
            "recovery_required",
            target.reason,
            [
              "herdr:exact-member-changed",
              ...evidenceRefs,
            ].slice(0, LIMITS.listItems),
          );
        }
        return {
          run: current,
          interruptAcknowledged: false,
          duplicate: false,
          warning: `${target.reason} No blind interrupt, retry, or force escalation was attempted.`,
        };
      }
      await this.dependencies.herdr.interruptAgent(target.paneId);
      return { run: current, interruptAcknowledged: true, duplicate: false };
    } catch (error) {
      current = await this.controlFailureHealth(
        current,
        "unreachable",
        "The graceful cancellation interrupt was not acknowledged; explicit reconciliation is required.",
        evidenceRefs,
      );
      return {
        run: current,
        interruptAcknowledged: false,
        duplicate: false,
        warning: `${safeDiagnostic(error)} The interrupt was not retried and force was not inferred.`,
      };
    }
  }

  async forceCancel(input: {
    runId: string;
    expectedRevision: number;
    reason: string;
    evidenceRefs: readonly string[];
    confirmation: "terminate_exact_member";
    requestId?: string;
  }): Promise<{ run: RunRecord; terminationConfirmed: boolean; duplicate: boolean; warning?: string }> {
    await this.assertActive();
    if (input.confirmation !== "terminate_exact_member") throw stateError("invalid_actor");
    let current = this.requireOwned(asRun(await this.dependencies.store.readRun(input.runId)));
    const evidenceRefs = validateEvidence(input.evidenceRefs);
    const controlId = this.stableControlId("force", input.requestId);
    const existing = await this.controlAction(current.runId, "force_requested", controlId);
    if (existing) {
      this.assertControlReplay(existing, { ...input, evidenceRefs });
      return {
        run: current,
        terminationConfirmed: current.state === "cancelled" && current.resourceDisposition === "closed",
        duplicate: true,
        warning: current.state === "cancelled"
          ? undefined
          : "The identical force intent is already durable; the destructive side effect was not repeated.",
      };
    }
    if (TERMINAL.has(current.state)) {
      return {
        run: current,
        terminationConfirmed: current.state === "cancelled" && current.resourceDisposition === "closed",
        duplicate: false,
        warning: `The run already has immutable terminal outcome ${current.state}; force made no change.`,
      };
    }
    if (current.revision !== input.expectedRevision) throw stateError("revision_conflict");
    if (!ACTIVE.has(current.state) || !current.resources ||
      !await this.controlAction(current.runId, "cancel_requested")) {
      throw stateError("invalid_transition");
    }
    const before = await this.dependencies.herdr.snapshot();
    const exact = matchManagedMember(before, current);
    if (exact.status !== "exact") throw stateError("invalid_binding");
    const control = {
      schemaVersion: SCHEMA_VERSION,
      controlId,
      runId: current.runId,
      type: "force_requested",
      actor: "crewlead",
      reason: input.reason,
      expectedRevision: current.revision,
      fencingEpoch: current.fencingEpoch,
      timestamp: this.timestamp(),
      evidenceRefs: [...evidenceRefs, `herdr:pane:${current.resources.paneId}`].slice(0, LIMITS.listItems),
    };
    assertStoredContract("controlAction", control);
    try {
      current = await this.sameStateCommit(
        current,
        `op-${control.controlId}`,
        "diagnostic",
        "A separately confirmed force request was persisted after exact member identity validation.",
        control.evidenceRefs,
        [{ kind: "control", payload: control }],
        () => {},
      );
    } catch (error) {
      if ((error as { code?: unknown }).code !== "revision_conflict") throw error;
      const winner = this.requireOwned(asRun(await this.dependencies.store.readRun(current.runId)));
      if (!TERMINAL.has(winner.state)) throw error;
      return {
        run: winner,
        terminationConfirmed: winner.state === "cancelled" && winner.resourceDisposition === "closed",
        duplicate: false,
        warning: `The concurrent terminal outcome ${winner.state} won the force revision race; no resource was closed.`,
      };
    }
    try {
      await this.dependencies.herdr.closeTabExact({
        workspaceId: current.binding.herdrWorkspaceId,
        tabId: current.resources!.tabId,
        paneId: current.resources!.paneId,
      });
    } catch (error) {
      current = await this.controlFailureHealth(
        current,
        "recovery_required",
        "Force termination has an unknown side-effect outcome and must be reconciled from a fresh snapshot.",
        evidenceRefs,
      );
      return {
        run: current,
        terminationConfirmed: false,
        duplicate: false,
        warning: `${safeDiagnostic(error)} No force retry, outcome inference, cleanup, or rollback was attempted.`,
      };
    }
    const after = await this.dependencies.herdr.snapshot();
    if (
      after.tabs.some((tab) => tab.tabId === current.resources!.tabId) ||
      after.panes.some((pane) => pane.paneId === current.resources!.paneId)
    ) {
      current = await this.controlFailureHealth(
        current,
        "recovery_required",
        "Force termination was not confirmed by the fresh Herdr snapshot.",
        evidenceRefs,
      );
      return {
        run: current,
        terminationConfirmed: false,
        duplicate: false,
        warning: "The exact targeted runtime is still present; no automatic retry or escalation was attempted.",
      };
    }
    current = this.requireOwned(asRun(await this.dependencies.store.readRun(current.runId)));
    if (!TERMINAL.has(current.state)) {
      current = await this.dependencies.lifecycle.transition({
        operationId: this.identifier("force-cancelled"),
        runId: current.runId,
        expectedRevision: current.revision,
        expectedFencingEpoch: current.fencingEpoch,
        actor: "crewlead",
        targetState: "cancelled",
        reason: "The separately confirmed exact member force termination was observed.",
        evidenceRefs: [`herdr:absent:${current.resources!.paneId}`],
        timestamp: this.timestamp(),
      });
    }
    if (current.resourceDisposition !== "closed") {
      current = await this.dependencies.lifecycle.recordResourceDisposition({
        operationId: this.identifier("force-resource-closed"),
        runId: current.runId,
        expectedRevision: current.revision,
        expectedFencingEpoch: current.fencingEpoch,
        actor: "crewlead",
        disposition: "closed",
        reason: "The exact force-targeted Herdr member runtime was confirmed absent.",
        evidenceRefs: [`herdr:absent:${current.resources!.paneId}`],
        timestamp: this.timestamp(),
      });
    }
    return { run: current, terminationConfirmed: true, duplicate: false };
  }

  async reconcile(): Promise<ReconciliationReport> {
    const report = await this.reconcileFresh();
    if (!report) throw stateError("invalid_record");
    return report;
  }

  reconciliationReport(): ReconciliationReport | undefined {
    return this.recovery.report();
  }

  async recover(input: ExplicitRecoveryRequest): Promise<ExplicitRecoveryResult> {
    await this.assertActive();
    return this.recovery.recover(input);
  }

  async result(
    runId: string,
    section: ResultSection = "full",
  ): Promise<Readonly<Record<string, unknown>>> {
    const inspection = await this.inspect(runId);
    if (!inspection.result) throw stateError("not_found");
    return selectResultSection(inspection.result, section);
  }

  async sweepRuntimeCleanup(): Promise<readonly unknown[]> {
    await this.assertActive();
    return this.dependencies.runtimeCleanup?.sweep() ?? [];
  }

  async cleanupAssessment(runId: string) {
    await this.assertActive();
    if (!this.dependencies.runtimeCleanup) throw stateError("invalid_binding");
    return this.dependencies.runtimeCleanup.assess(runId);
  }

  async pinRuntime(input: { runId: string; expectedRevision: number; evidenceRefs: readonly string[] }) {
    await this.assertActive();
    if (!this.dependencies.runtimeCleanup) throw stateError("invalid_binding");
    return this.dependencies.runtimeCleanup.pin(input);
  }

  async unpinRuntime(input: { runId: string; expectedRevision: number; evidenceRefs: readonly string[] }) {
    await this.assertActive();
    if (!this.dependencies.runtimeCleanup) throw stateError("invalid_binding");
    return this.dependencies.runtimeCleanup.unpin(input);
  }

  async leaseRuntimeInspection(input: { runId: string; expectedRevision: number; leaseMilliseconds: number; evidenceRefs: readonly string[] }) {
    await this.assertActive();
    if (!this.dependencies.runtimeCleanup) throw stateError("invalid_binding");
    return this.dependencies.runtimeCleanup.inspect(input);
  }

  async closeRuntime(input: {
    requestId: string; runId: string; expectedRevision: number; evidenceRefs: readonly string[];
    confirmation: "close_exact_terminal_runtime";
  }) {
    await this.assertActive();
    if (!this.dependencies.runtimeCleanup || input.confirmation !== "close_exact_terminal_runtime") throw stateError("invalid_binding");
    return this.dependencies.runtimeCleanup.close({ ...input, source: "human", explicitTerminalReview: true });
  }

  async reconcileExternalRuntimeClose(input: {
    runId: string; expectedRevision: number; evidenceRef: string; confirmation: "record_confirmed_external_close";
  }) {
    await this.assertActive();
    if (!this.dependencies.runtimeCleanup || input.confirmation !== "record_confirmed_external_close") throw stateError("invalid_binding");
    return this.dependencies.runtimeCleanup.reconcileExternalClose({ ...input, confirmedByHuman: true });
  }

  async integrateBuilder(input: {
    requestId: string; runId: string; expectedRevision: number; evidenceRefs: readonly string[];
    confirmation: "integrate_exact_builder_ff_only";
  }) {
    await this.assertActive();
    if (!this.dependencies.integration) throw stateError("invalid_binding");
    return this.dependencies.integration.integrate(input);
  }

  async cleanupRepository(input: RepositoryCleanupRequest) {
    await this.assertActive();
    if (!this.dependencies.repositoryCleanup) throw stateError("invalid_binding");
    return this.dependencies.repositoryCleanup.cleanup(input);
  }

  async acknowledgeResult(input: {
    runId: string;
    expectedRevision: number;
    evidenceRefs: readonly string[];
  }): Promise<RunRecord> {
    await this.assertActive();
    const inspection = await this.inspect(input.runId);
    let current = inspection.run as RunRecord;
    if (
      current.revision !== input.expectedRevision ||
      !TERMINAL.has(current.state) ||
      !inspection.result ||
      inspection.resultAcknowledged ||
      current.runtimeCleanup?.intent?.status === "prepared"
    ) {
      throw stateError(current.revision !== input.expectedRevision ? "revision_conflict" : "invalid_transition");
    }
    const evidenceRefs = validateEvidence(input.evidenceRefs);
    const resultId = String(inspection.result.resultId);
    const control = {
      schemaVersion: SCHEMA_VERSION,
      controlId: this.identifier("result-ack"),
      runId: current.runId,
      type: "result_acknowledged",
      actor: "crewlead",
      reason: `The Crewlead explicitly acknowledged retrieved result ${resultId}.`,
      expectedRevision: current.revision,
      fencingEpoch: current.fencingEpoch,
      timestamp: this.timestamp(),
      evidenceRefs,
    };
    assertStoredContract("controlAction", control);
    current = await this.sameStateCommit(
      current,
      `op-${control.controlId}`,
      "delivery_changed",
      control.reason,
      evidenceRefs,
      [{ kind: "control", payload: control }],
      () => {},
    );
    return current;
  }
}

export function lifecycleCapacityDiagnostic(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof LifecycleError)) return undefined;
  return {
    code: error.code,
    limitingResource: error.details.limitingResource,
    limit: error.details.limit,
    requested: error.details.requested,
    counts: error.details.counts,
  };
}
