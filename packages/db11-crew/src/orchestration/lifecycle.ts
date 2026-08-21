import { type EffectiveConfiguration, type RoleId, type RuntimeOverride } from "../config/config.ts";
import { validateContract } from "../protocol/validate.ts";
import { LIMITS, SCHEMA_VERSION } from "../protocol/limits.ts";
import { validateIdentifier } from "../security/binding.ts";
import { digestJson } from "../security/json.ts";
import { StateSecurityError, stateError, type StateErrorCode } from "../security/errors.ts";
import {
  DurableStateStore,
  type CommitRunRequest,
  type HistoryInput,
} from "../state/store.ts";

export type RunState =
  | "queued"
  | "starting"
  | "working"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "abandoned";
export type ActiveRunState = "starting" | "working" | "blocked";
export type TerminalRunState = "completed" | "failed" | "cancelled" | "abandoned";
export type LifecycleActor = "crewlead" | "companion" | "recovery" | "human";
export type ObservedAgentState = "working" | "blocked" | "done" | "idle" | "unknown";
export type ResourceDisposition = "unallocated" | "open" | "retained" | "closed" | "missing";
export type RunHealthStatus =
  | "healthy"
  | "degraded"
  | "unreachable"
  | "recovery_required"
  | "orphan_suspected"
  | "inconsistent";

interface RunBinding {
  crewleadSessionId: string;
  memberSessionId?: string;
  herdrWorkspaceId: string;
  canonicalProjectPath: string;
}

interface RunResources {
  tabId: string;
  paneId: string;
  agentId: string;
}

export interface CompactRepositoryIdentity {
  canonicalRoot: string;
  canonicalRootDigest: string;
  commonGitDirectory: string;
  commonGitDirectoryDigest: string;
  commonGitDevice: string;
  commonGitInode: string;
}

export type RepositoryResource =
  | {
      kind: "read_snapshot";
      runId: string;
      source: CompactRepositoryIdentity;
      path: string;
      sourceHead: string;
      baselineManifestDigest: string;
    }
  | {
      kind: "builder_worktree";
      runId: string;
      source: CompactRepositoryIdentity;
      path: string;
      branch: string;
      branchRef: string;
      baseCommit: string;
      targetBranch: string;
      targetRef: string;
      targetCommit: string;
      protectedRefDigest?: string;
      automaticIntegrationEligible: boolean;
    };

export interface RepositoryAllocationMetadata {
  status: "prepared" | "created" | "failed";
  runId: string;
  source: CompactRepositoryIdentity;
  sourceStatusDigest: string;
  path: string;
  sessionDirectory: string;
  branch: string;
  branchRef: string;
  baseCommit: string;
  targetBranch: string;
  targetRef: string;
  targetCommit: string;
  protectedRefDigest: string;
  automaticIntegrationEligible: boolean;
  expectedRevision: number;
  fencingEpoch: number;
  preparedAt: string;
  updatedAt: string;
  diagnostic?: string;
}

export interface RuntimeCleanupMetadata {
  graceStartedAt?: string;
  pinnedAt?: string;
  unpinnedAt?: string;
  lastInteractionAt?: string;
  inspectionLease?: { leaseId: string; actor: "human"; acquiredAt: string; expiresAt: string };
  intent?: {
    requestId: string;
    source: "automatic" | "capacity" | "human";
    status: "prepared" | "failed" | "completed";
    expectedTabId: string;
    expectedPaneId: string;
    preparedAt: string;
    updatedAt: string;
    diagnostic?: string;
  };
  closedAt?: string;
  closeProvenance?: "automatic" | "capacity" | "human" | "external";
  externalEvidenceRef?: string;
}

export interface IntegrationMetadata {
  requestId: string;
  mode: "ff_only";
  status: "prepared" | "completed" | "failed";
  targetRef: string;
  expectedBase: string;
  expectedHead: string;
  preparedAt: string;
  updatedAt: string;
  integratedAt?: string;
  commandExitCode?: number;
  diagnostic?: string;
  evidenceRefs: string[];
}

export interface RepositoryCleanupMetadata {
  requestId: string;
  authorization: "integrated" | "superseded" | "discard" | "read_snapshot";
  status: "prepared" | "worktree_removed" | "failed" | "completed";
  expectedHead: string;
  replacementRunId?: string;
  preparedAt: string;
  updatedAt: string;
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  diagnostic?: string;
  evidenceRefs: string[];
}

interface RunStartup {
  phase:
    | "admitted"
    | "workspace_prepared"
    | "bootstrap_provisioned"
    | "prompt_acknowledged"
    | "partial_failure";
  assignedRoot?: string;
  sessionDirectory?: string;
  bootstrapId?: string;
  partialResources?: Partial<RunResources>;
  diagnostic?: string;
}

interface RunObservation {
  state: ObservedAgentState;
  observedAt: string;
  sourceSequence?: number;
}

interface RunHealth {
  status: RunHealthStatus;
  reconciliationRequired: boolean;
  reason?: string;
  evidenceRefs: string[];
  updatedAt: string;
}

interface QueueMetadata {
  enqueuedAt: string;
  enqueueSequence: number;
  startBlockedReason?: string;
}

export interface RunRecord extends Record<string, unknown> {
  schemaVersion: typeof SCHEMA_VERSION;
  admissionId: string;
  admission: {
    mode: "start" | "queue";
    actor: "crewlead" | "human";
    evidenceRefs: string[];
  };
  runId: string;
  packetId: string;
  intentDigest: string;
  purposeLabel: string;
  role: RoleId;
  state: RunState;
  revision: number;
  fencingEpoch: number;
  binding: RunBinding;
  resources?: RunResources;
  runtimeRequest?: RuntimeOverride;
  startup?: RunStartup;
  observation?: RunObservation;
  resourceDisposition: ResourceDisposition;
  health: RunHealth;
  queue?: QueueMetadata;
  retentionPolicy: "auto_close" | "retain";
  repositoryResource?: RepositoryResource;
  repositoryAllocation?: RepositoryAllocationMetadata;
  runtimeCleanup?: RuntimeCleanupMetadata;
  integration?: IntegrationMetadata;
  repositoryCleanup?: RepositoryCleanupMetadata;
  activeBlockerId?: string;
  resultId?: string;
  resultDigest?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdmissionCounts {
  active: number;
  openResources: number;
  queued: number;
  activeRuns: Array<{ runId: string; role: RoleId; purposeLabel: string }>;
}

export interface AdmissionCandidate {
  admissionId: string;
  runId: string;
  packetId: string;
  intentDigest: string;
  purposeLabel: string;
  role: RoleId;
  binding: RunBinding;
  retentionPolicy: "auto_close" | "retain";
  createdAt: string;
  allowRedundantIntent?: boolean;
  runtimeRequest?: RuntimeOverride;
  /** Validated immutable packet persisted atomically with admission when supplied. */
  packet?: unknown;
}

export interface AdmitBatchRequest {
  candidates: readonly AdmissionCandidate[];
  mode: "start" | "queue";
  explicitQueueAuthorization?: boolean;
  actor: "crewlead" | "human";
  evidenceRefs: readonly string[];
}

export interface AdmissionReceipt {
  runs: readonly RunRecord[];
  counts: AdmissionCounts;
  idempotent: boolean;
}

export interface PromotionRequest {
  operationId: string;
  actor: "crewlead" | "recovery";
  evidenceRefs: readonly string[];
  timestamp: string;
  online: boolean;
  expectedRunId: string;
  expectedRevision: number;
  expectedFencingEpoch: number;
  revalidate: (run: Readonly<RunRecord>) =>
    | { ok: true }
    | { ok: false; reason: string; evidenceRefs?: readonly string[] };
}

export type PromotionResult =
  | { status: "dormant" | "empty"; run?: RunRecord }
  | { status: "promoted" | "start_blocked" | "capacity_blocked"; run: RunRecord };

export interface TransitionRequest {
  operationId: string;
  runId: string;
  expectedRevision: number;
  expectedFencingEpoch: number;
  actor: LifecycleActor;
  targetState: Exclude<RunState, "queued" | "starting">;
  reason: string;
  evidenceRefs: readonly string[];
  timestamp: string;
  activeBlockerId?: string;
  result?: unknown;
}

export interface ObservationRequest {
  operationId: string;
  runId: string;
  expectedRevision: number;
  expectedFencingEpoch: number;
  actor: "crewlead" | "recovery";
  observation: RunObservation;
  reason: string;
  evidenceRefs: readonly string[];
  timestamp: string;
}

export interface ResourceDispositionRequest {
  operationId: string;
  runId: string;
  expectedRevision: number;
  expectedFencingEpoch: number;
  actor: LifecycleActor;
  disposition: ResourceDisposition;
  resources?: RunResources;
  reason: string;
  evidenceRefs: readonly string[];
  timestamp: string;
}

export interface HealthRequest {
  operationId: string;
  runId: string;
  expectedRevision: number;
  expectedFencingEpoch: number;
  actor: "crewlead" | "recovery" | "companion";
  status: RunHealthStatus;
  reconciliationRequired: boolean;
  reason?: string;
  evidenceRefs: readonly string[];
  timestamp: string;
}

export interface LifecycleErrorDetails {
  counts?: AdmissionCounts;
  limitingResource?: "active" | "open_resources" | "queue";
  limit?: number;
  requested?: number;
  duplicateRunIds?: readonly string[];
}

export class LifecycleError extends StateSecurityError {
  readonly details: LifecycleErrorDetails;

  constructor(code: StateErrorCode, details: LifecycleErrorDetails = {}) {
    super(code);
    this.name = "LifecycleError";
    this.details = Object.freeze(structuredClone(details));
  }
}

const ACTIVE_STATES = new Set<RunState>(["starting", "working", "blocked"]);
const TERMINAL_STATES = new Set<RunState>(["completed", "failed", "cancelled", "abandoned"]);
const TRANSITIONS: Readonly<Record<RunState, ReadonlySet<RunState>>> = Object.freeze({
  queued: new Set<RunState>(["starting", "cancelled", "abandoned"]),
  starting: new Set<RunState>(["working", "failed", "cancelled", "abandoned"]),
  working: new Set<RunState>(["blocked", "completed", "failed", "cancelled", "abandoned"]),
  blocked: new Set<RunState>(["working", "failed", "cancelled", "abandoned"]),
  completed: new Set<RunState>(),
  failed: new Set<RunState>(),
  cancelled: new Set<RunState>(),
  abandoned: new Set<RunState>(),
});

function asRun(value: Readonly<Record<string, unknown>>): RunRecord {
  const validation = validateContract("run", value);
  if (!validation.ok) throw stateError("invalid_record");
  return value as RunRecord;
}

function validateEvidence(evidenceRefs: readonly string[]): string[] {
  if (evidenceRefs.length < 1 || evidenceRefs.length > LIMITS.listItems) {
    throw stateError("invalid_record");
  }
  const values = [...evidenceRefs];
  if (new Set(values).size !== values.length) throw stateError("invalid_record");
  return values;
}

function validateTimestamp(timestamp: string): void {
  if (Number.isNaN(Date.parse(timestamp))) throw stateError("invalid_record");
}

function requireCurrent(
  runs: readonly Readonly<Record<string, unknown>>[],
  runId: string,
  expectedRevision: number,
  expectedFencingEpoch: number,
): RunRecord {
  validateIdentifier(runId);
  const current = runs.find((candidate) => candidate.runId === runId);
  if (!current) throw stateError("not_found");
  const run = asRun(current);
  if (run.revision !== expectedRevision) throw stateError("revision_conflict");
  if (run.fencingEpoch !== expectedFencingEpoch) throw stateError("epoch_conflict");
  return run;
}

function copyRun(run: RunRecord): RunRecord {
  return structuredClone(run);
}

function operationEvent(
  run: RunRecord,
  operationId: string,
  actor: LifecycleActor,
  type: "run_created" | "state_transition" | "result_committed" | "cleanup_changed" | "diagnostic",
  reason: string,
  evidenceRefs: readonly string[],
  timestamp: string,
  resultingState: RunState,
): Record<string, unknown> {
  validateIdentifier(operationId);
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: operationId,
    runId: run.runId,
    sequence: run.revision,
    timestamp,
    actor,
    type,
    reason,
    evidenceRefs: [...evidenceRefs],
    resultingState,
    expectedRevision: run.revision - 1,
    resultingRevision: run.revision,
    fencingEpoch: run.fencingEpoch,
  };
}

function transitionEvent(
  previous: RunRecord,
  next: RunRecord,
  operationId: string,
  actor: LifecycleActor,
  type: "state_transition" | "result_committed" | "cleanup_changed" | "diagnostic",
  reason: string,
  evidenceRefs: readonly string[],
  timestamp: string,
): Record<string, unknown> {
  return {
    ...operationEvent(next, operationId, actor, type, reason, evidenceRefs, timestamp, next.state),
    expectedPriorState: previous.state,
  };
}

function commitRequest(
  previous: RunRecord | undefined,
  next: RunRecord,
  operationId: string,
  event: Record<string, unknown>,
  extraHistory: readonly HistoryInput[] = [],
): CommitRunRequest {
  return {
    operationId,
    expectedRevision: previous?.revision ?? 0,
    expectedFencingEpoch: previous?.fencingEpoch ?? 0,
    run: next,
    history: [{ kind: "lifecycle", payload: event }, ...extraHistory],
  };
}

export function admissionCounts(runs: readonly Readonly<Record<string, unknown>>[]): AdmissionCounts {
  const parsed = runs.map(asRun);
  const activeRuns = parsed
    .filter((run) => ACTIVE_STATES.has(run.state))
    .map(({ runId, role, purposeLabel }) => ({ runId, role, purposeLabel }));
  return {
    active: activeRuns.length,
    openResources: parsed.filter((run) => {
      if (ACTIVE_STATES.has(run.state)) return true;
      return (
        TERMINAL_STATES.has(run.state) &&
        ["open", "retained", "missing"].includes(run.resourceDisposition)
      );
    }).length,
    queued: parsed.filter((run) => run.state === "queued").length,
    activeRuns,
  };
}

function capacityError(
  counts: AdmissionCounts,
  limitingResource: "active" | "open_resources" | "queue",
  limit: number,
  requested: number,
): never {
  throw new LifecycleError("admission_capacity", {
    counts,
    limitingResource,
    limit,
    requested,
  });
}

function checkCapacity(
  counts: AdmissionCounts,
  limits: EffectiveConfiguration["limits"],
  mode: "start" | "queue",
  requested: number,
): void {
  if (mode === "queue") {
    if (counts.queued + requested > limits.maxQueuedDelegations) {
      capacityError(counts, "queue", limits.maxQueuedDelegations, requested);
    }
    return;
  }
  if (counts.active + requested > limits.maxActiveMembers) {
    capacityError(counts, "active", limits.maxActiveMembers, requested);
  }
  if (counts.openResources + requested > limits.maxOpenMemberResources) {
    capacityError(counts, "open_resources", limits.maxOpenMemberResources, requested);
  }
}

function nextQueueSequence(runs: readonly RunRecord[]): number {
  return runs.reduce((maximum, run) => Math.max(maximum, run.queue?.enqueueSequence ?? 0), 0) + 1;
}

function validateAdmissionCandidate(candidate: AdmissionCandidate): void {
  validateIdentifier(candidate.admissionId);
  validateIdentifier(candidate.runId);
  validateIdentifier(candidate.packetId);
  validateTimestamp(candidate.createdAt);
  if (!/^[a-f0-9]{64}$/.test(candidate.intentDigest)) throw stateError("invalid_record");
  if (candidate.runtimeRequest !== undefined && Object.keys(candidate.runtimeRequest).length === 0) {
    throw stateError("invalid_record");
  }
  if (candidate.packet !== undefined) {
    const validation = validateContract("taskPacket", candidate.packet);
    if (!validation.ok) throw stateError(validation.error.code === "oversized" ? "oversized" : "invalid_record");
    const packet = validation.value as { packetId: string; role: RoleId };
    if (packet.packetId !== candidate.packetId || packet.role !== candidate.role) {
      throw stateError("invalid_record");
    }
  }
}

function sameAdmission(
  run: RunRecord,
  candidate: AdmissionCandidate,
  mode: "start" | "queue",
  actor: "crewlead" | "human",
  evidenceRefs: readonly string[],
): boolean {
  return (
    run.admissionId === candidate.admissionId &&
    run.runId === candidate.runId &&
    run.packetId === candidate.packetId &&
    run.intentDigest === candidate.intentDigest &&
    run.role === candidate.role &&
    run.purposeLabel === candidate.purposeLabel &&
    run.retentionPolicy === candidate.retentionPolicy &&
    digestJson(run.runtimeRequest ?? null, LIMITS.runBytes) ===
      digestJson(candidate.runtimeRequest ?? null, LIMITS.runBytes) &&
    run.createdAt === candidate.createdAt &&
    digestJson(run.binding, LIMITS.runBytes) === digestJson(candidate.binding, LIMITS.runBytes) &&
    run.admission.mode === mode &&
    run.admission.actor === actor &&
    JSON.stringify(run.admission.evidenceRefs) === JSON.stringify(evidenceRefs)
  );
}

function sameCrewScope(
  left: Pick<RunBinding, "crewleadSessionId" | "herdrWorkspaceId" | "canonicalProjectPath">,
  right: Pick<RunBinding, "crewleadSessionId" | "herdrWorkspaceId" | "canonicalProjectPath">,
): boolean {
  return (
    left.crewleadSessionId === right.crewleadSessionId &&
    left.herdrWorkspaceId === right.herdrWorkspaceId &&
    left.canonicalProjectPath === right.canonicalProjectPath
  );
}

function sortedQueue(runs: readonly RunRecord[]): RunRecord[] {
  return runs
    .filter((run) => run.state === "queued")
    .sort(
      (left, right) =>
        (left.queue?.enqueueSequence ?? Number.MAX_SAFE_INTEGER) -
          (right.queue?.enqueueSequence ?? Number.MAX_SAFE_INTEGER) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.runId.localeCompare(right.runId),
    );
}

export function isLifecycleTransitionAllowed(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].has(to);
}

function validateResultForTransition(run: RunRecord, target: "completed" | "failed", result: unknown): void {
  const validation = validateContract("result", result);
  if (!validation.ok) throw stateError("invalid_record");
  const value = validation.value as Record<string, unknown>;
  if (
    value.runId !== run.runId ||
    value.packetId !== run.packetId ||
    value.role !== run.role ||
    value.outcome !== target
  ) {
    throw stateError("invalid_record");
  }
  if (target === "completed") {
    if (run.activeBlockerId !== undefined) throw stateError("invalid_transition");
    if ((value.unresolvedBlockerIds as unknown[]).length || (value.unresolvedDecisions as unknown[]).length) {
      throw stateError("invalid_transition");
    }
    if ((value.deliverables as Array<{ status: string }>).some((item) => item.status === "not_produced")) {
      throw stateError("invalid_transition");
    }
    if ((value.completionCriteria as Array<{ status: string }>).some((item) => item.status === "not_met")) {
      throw stateError("invalid_transition");
    }
    if ((value.validation as Array<{ status: string }>).some((item) => item.status === "failed")) {
      throw stateError("invalid_transition");
    }
  }
}

export function assessRunDimensions(run: Readonly<RunRecord>): readonly string[] {
  const issues: string[] = [];
  if (run.state === "queued" && run.resourceDisposition !== "unallocated") {
    issues.push("queued_run_owns_resources");
  }
  if (run.state !== "queued" && run.resourceDisposition === "unallocated") {
    issues.push("nonqueued_run_has_no_reservation");
  }
  if (TERMINAL_STATES.has(run.state) && ["working", "blocked"].includes(run.observation?.state ?? "")) {
    issues.push("terminal_run_observed_active");
  }
  if (ACTIVE_STATES.has(run.state) && run.resourceDisposition === "missing") {
    issues.push("active_run_resource_missing");
  }
  if (run.health.reconciliationRequired && run.health.status === "healthy") {
    issues.push("healthy_run_requires_reconciliation");
  }
  return Object.freeze(issues);
}

export class LifecycleService {
  readonly store: DurableStateStore;
  readonly limits: EffectiveConfiguration["limits"];

  constructor(store: DurableStateStore, limits: EffectiveConfiguration["limits"]) {
    this.store = store;
    this.limits = Object.freeze({ ...limits });
  }

  async admitBatch(request: AdmitBatchRequest): Promise<AdmissionReceipt> {
    if (request.candidates.length < 1 || request.candidates.length > LIMITS.stateBatchTransactions) {
      throw stateError("oversized");
    }
    if (request.mode === "queue" && request.explicitQueueAuthorization !== true) {
      throw stateError("invalid_actor");
    }
    const evidenceRefs = validateEvidence(request.evidenceRefs);
    request.candidates.forEach(validateAdmissionCandidate);
    const scope = request.candidates[0]!.binding;
    if (request.candidates.some((candidate) => !sameCrewScope(candidate.binding, scope))) {
      throw stateError("invalid_binding");
    }
    if (new Set(request.candidates.map((candidate) => candidate.runId)).size !== request.candidates.length) {
      throw new LifecycleError("admission_duplicate");
    }

    return this.store.atomicMutateRuns<AdmissionReceipt>((rawRuns) => {
      const runs = rawRuns.map(asRun);
      const scopeRuns = runs.filter((run) => sameCrewScope(run.binding, scope));
      const existing = request.candidates.map((candidate) =>
        runs.find((run) => run.runId === candidate.runId),
      );
      if (
        existing.every(
          (run, index) =>
            run &&
            sameAdmission(
              run,
              request.candidates[index]!,
              request.mode,
              request.actor,
              evidenceRefs,
            ),
        )
      ) {
        return {
          requests: [],
          value: {
            runs: existing as RunRecord[],
            counts: admissionCounts(scopeRuns),
            idempotent: true,
          },
        };
      }
      if (existing.some(Boolean)) throw stateError("idempotency_conflict");

      const duplicateRunIds: string[] = [];
      for (const candidate of request.candidates) {
        if (candidate.allowRedundantIntent) continue;
        const duplicate = scopeRuns.find(
          (run) => !TERMINAL_STATES.has(run.state) && run.intentDigest === candidate.intentDigest,
        );
        if (duplicate) duplicateRunIds.push(duplicate.runId);
        const batchDuplicate = request.candidates.find(
          (other) => other !== candidate && other.intentDigest === candidate.intentDigest,
        );
        if (batchDuplicate) duplicateRunIds.push(batchDuplicate.runId);
      }
      if (duplicateRunIds.length) {
        throw new LifecycleError("admission_duplicate", {
          duplicateRunIds: [...new Set(duplicateRunIds)].sort(),
        });
      }

      const before = admissionCounts(scopeRuns);
      checkCapacity(before, this.limits, request.mode, request.candidates.length);
      let queueSequence = nextQueueSequence(scopeRuns);
      const admitted = request.candidates.map((candidate): RunRecord => {
        const queued = request.mode === "queue";
        const run: RunRecord = {
          schemaVersion: SCHEMA_VERSION,
          admissionId: candidate.admissionId,
          admission: {
            mode: request.mode,
            actor: request.actor,
            evidenceRefs: [...evidenceRefs],
          },
          runId: candidate.runId,
          packetId: candidate.packetId,
          intentDigest: candidate.intentDigest,
          purposeLabel: candidate.purposeLabel,
          role: candidate.role,
          state: queued ? "queued" : "starting",
          revision: 1,
          fencingEpoch: 1,
          binding: structuredClone(candidate.binding),
          resourceDisposition: queued ? "unallocated" : "open",
          ...(candidate.runtimeRequest === undefined
            ? {}
            : { runtimeRequest: structuredClone(candidate.runtimeRequest) }),
          startup: { phase: "admitted" },
          health: {
            status: "healthy",
            reconciliationRequired: false,
            evidenceRefs: [...evidenceRefs],
            updatedAt: candidate.createdAt,
          },
          retentionPolicy: candidate.retentionPolicy,
          createdAt: candidate.createdAt,
          updatedAt: candidate.createdAt,
        };
        if (queued) {
          run.queue = {
            enqueuedAt: candidate.createdAt,
            enqueueSequence: queueSequence++,
          };
        }
        if (!validateContract("run", run).ok) throw stateError("invalid_record");
        return run;
      });
      const commitRequests = admitted.map((run) => {
        const event = operationEvent(
          run,
          run.admissionId,
          request.actor,
          "run_created",
          request.mode === "queue"
            ? "The explicitly authorized delegation was admitted to the durable FIFO queue."
            : "Capacity was atomically reserved before member side effects.",
          evidenceRefs,
          run.createdAt,
          run.state,
        );
        return commitRequest(
          undefined,
          run,
          run.admissionId,
          event,
          request.candidates.find((candidate) => candidate.runId === run.runId)?.packet === undefined
            ? []
            : [{
                kind: "control",
                payload: request.candidates.find((candidate) => candidate.runId === run.runId)!.packet,
              }],
        );
      });
      return {
        requests: commitRequests,
        value: {
          runs: admitted,
          counts: admissionCounts([...scopeRuns, ...admitted]),
          idempotent: false,
        },
      };
    });
  }

  async promoteNext(request: PromotionRequest): Promise<PromotionResult> {
    if (!request.online) return { status: "dormant" };
    validateIdentifier(request.operationId);
    validateTimestamp(request.timestamp);
    const evidenceRefs = validateEvidence(request.evidenceRefs);
    return this.store.atomicMutateRuns((rawRuns) => {
      const runs = rawRuns.map(asRun);
      const expected = runs.find((run) => run.runId === request.expectedRunId);
      if (!expected || expected.state !== "queued") throw stateError("invalid_transition");
      const scopeRuns = runs.filter((run) => sameCrewScope(run.binding, expected.binding));
      const head = sortedQueue(scopeRuns)[0];
      if (!head) return { requests: [], value: { status: "empty" as const } };
      if (request.expectedRunId !== head.runId) throw stateError("invalid_transition");
      if (request.expectedRevision !== head.revision) throw stateError("revision_conflict");
      if (request.expectedFencingEpoch !== head.fencingEpoch) throw stateError("epoch_conflict");

      const counts = admissionCounts(scopeRuns);
      let blockedReason: string | undefined;
      let revalidationEvidence: readonly string[] | undefined;
      let status: "capacity_blocked" | "start_blocked" | undefined;
      if (counts.active + 1 > this.limits.maxActiveMembers) {
        blockedReason = "Active-member capacity is unavailable.";
        status = "capacity_blocked";
      } else if (counts.openResources + 1 > this.limits.maxOpenMemberResources) {
        blockedReason = "Open-resource capacity is unavailable.";
        status = "capacity_blocked";
      } else {
        const revalidation = request.revalidate(Object.freeze(copyRun(head)));
        if (!revalidation.ok) {
          blockedReason = revalidation.reason;
          revalidationEvidence = revalidation.evidenceRefs;
          status = "start_blocked";
        }
      }

      const next = copyRun(head);
      next.revision += 1;
      next.updatedAt = request.timestamp;
      let reason: string;
      let eventEvidence = evidenceRefs;
      if (status && blockedReason) {
        if (Buffer.byteLength(blockedReason, "utf8") > LIMITS.diagnosticLength) {
          throw stateError("oversized");
        }
        if (next.queue?.startBlockedReason === blockedReason) {
          return { requests: [], value: { status, run: head } };
        }
        next.queue = { ...next.queue!, startBlockedReason: blockedReason };
        reason = blockedReason;
        if (status === "start_blocked" && revalidationEvidence) {
          eventEvidence = validateEvidence(revalidationEvidence);
        }
      } else {
        next.state = "starting";
        next.resourceDisposition = "open";
        next.queue = { ...next.queue! };
        delete next.queue.startBlockedReason;
        reason = "The FIFO head was revalidated and capacity was atomically reserved.";
      }
      const event = transitionEvent(
        head,
        next,
        request.operationId,
        request.actor,
        status ? "diagnostic" : "state_transition",
        reason,
        eventEvidence,
        request.timestamp,
      );
      const commit = commitRequest(head, next, request.operationId, event);
      return {
        requests: [commit],
        value: { status: status ?? "promoted", run: next } as PromotionResult,
      };
    });
  }

  async transition(request: TransitionRequest): Promise<RunRecord> {
    validateIdentifier(request.operationId);
    validateTimestamp(request.timestamp);
    const evidenceRefs = validateEvidence(request.evidenceRefs);
    return this.store.atomicMutateRuns((runs) => {
      const current = requireCurrent(
        runs,
        request.runId,
        request.expectedRevision,
        request.expectedFencingEpoch,
      );
      if (TERMINAL_STATES.has(current.state)) throw stateError("terminal_immutable");
      if (!isLifecycleTransitionAllowed(current.state, request.targetState)) {
        throw stateError("invalid_transition");
      }
      if (current.state === "queued" && request.targetState !== "cancelled" && request.targetState !== "abandoned") {
        throw stateError("invalid_transition");
      }
      if (request.targetState === "abandoned" && request.actor !== "human") {
        throw stateError("invalid_actor");
      }
      if (request.targetState === "completed" || request.targetState === "failed") {
        if (request.actor !== "companion" || request.result === undefined) throw stateError("invalid_actor");
        validateResultForTransition(current, request.targetState, request.result);
      } else if (request.result !== undefined) {
        throw stateError("invalid_record");
      }
      if (request.targetState === "blocked" && !request.activeBlockerId) {
        throw stateError("invalid_transition");
      }
      if (request.targetState === "working" && request.activeBlockerId) {
        throw stateError("invalid_transition");
      }

      const next = copyRun(current);
      next.state = request.targetState;
      next.revision += 1;
      next.updatedAt = request.timestamp;
      if (request.targetState === "blocked") next.activeBlockerId = request.activeBlockerId;
      if (request.targetState === "working") delete next.activeBlockerId;
      const history: HistoryInput[] = [];
      let eventType: "state_transition" | "result_committed" = "state_transition";
      if (request.targetState === "completed" || request.targetState === "failed") {
        const result = request.result as Record<string, unknown>;
        next.resultId = result.resultId as string;
        next.resultDigest = digestJson(result, LIMITS.resultBytes);
        if (request.targetState === "completed") delete next.activeBlockerId;
        history.push({ kind: "result", payload: result });
        eventType = "result_committed";
      }
      if (["failed", "cancelled", "abandoned"].includes(request.targetState)) {
        if (next.resourceDisposition === "open") next.resourceDisposition = "retained";
      }
      const event = transitionEvent(
        current,
        next,
        request.operationId,
        request.actor,
        eventType,
        request.reason,
        evidenceRefs,
        request.timestamp,
      );
      return {
        requests: [commitRequest(current, next, request.operationId, event, history)],
        value: next,
      };
    });
  }

  async recordObservation(request: ObservationRequest): Promise<RunRecord> {
    if (request.actor !== "crewlead" && request.actor !== "recovery") throw stateError("invalid_actor");
    validateTimestamp(request.observation.observedAt);
    return this.updateDimension(
      request,
      "diagnostic",
      (current, next) => {
        const previousSequence = current.observation?.sourceSequence;
        const nextSequence = request.observation.sourceSequence;
        if (nextSequence !== undefined && previousSequence !== undefined && nextSequence <= previousSequence) {
          throw stateError("stale_sequence");
        }
        next.observation = structuredClone(request.observation);
      },
    );
  }

  async recordResourceDisposition(request: ResourceDispositionRequest): Promise<RunRecord> {
    return this.updateDimension(
      request,
      "cleanup_changed",
      (current, next) => {
        if (current.state === "queued" && request.disposition !== "unallocated") {
          throw stateError("invalid_transition");
        }
        if (current.state !== "queued" && request.disposition === "unallocated") {
          throw stateError("invalid_transition");
        }
        if (ACTIVE_STATES.has(current.state) && ["retained", "closed"].includes(request.disposition)) {
          throw stateError("invalid_transition");
        }
        if (current.resourceDisposition === "closed" && request.disposition === "open" && request.actor !== "recovery") {
          throw stateError("invalid_actor");
        }
        next.resourceDisposition = request.disposition;
        if (request.resources) next.resources = structuredClone(request.resources);
      },
    );
  }

  async recordHealth(request: HealthRequest): Promise<RunRecord> {
    if (request.status === "healthy" && request.reconciliationRequired) {
      throw stateError("invalid_record");
    }
    if (request.status !== "healthy" && !request.reason) throw stateError("invalid_record");
    return this.updateDimension(
      request,
      "diagnostic",
      (_current, next, evidenceRefs) => {
        next.health = {
          status: request.status,
          reconciliationRequired: request.reconciliationRequired,
          reason: request.reason,
          evidenceRefs,
          updatedAt: request.timestamp,
        };
      },
    );
  }

  private async updateDimension(
    request: ObservationRequest | ResourceDispositionRequest | HealthRequest,
    eventType: "cleanup_changed" | "diagnostic",
    mutate: (current: RunRecord, next: RunRecord, evidenceRefs: string[]) => void,
  ): Promise<RunRecord> {
    validateIdentifier(request.operationId);
    validateTimestamp(request.timestamp);
    const evidenceRefs = validateEvidence(request.evidenceRefs);
    return this.store.atomicMutateRuns((runs) => {
      const current = requireCurrent(
        runs,
        request.runId,
        request.expectedRevision,
        request.expectedFencingEpoch,
      );
      if (current.runtimeCleanup?.intent?.status === "prepared") throw stateError("invalid_transition");
      const next = copyRun(current);
      next.revision += 1;
      next.updatedAt = request.timestamp;
      mutate(current, next, evidenceRefs);
      const event = transitionEvent(
        current,
        next,
        request.operationId,
        request.actor,
        eventType,
        request.reason ?? "Run health metadata was explicitly reconciled.",
        evidenceRefs,
        request.timestamp,
      );
      return {
        requests: [commitRequest(current, next, request.operationId, event)],
        value: next,
      };
    });
  }
}
