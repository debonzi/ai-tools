import type {
  HerdrAdapter,
  HerdrAgent,
  HerdrSnapshot,
} from "../adapters/herdr/contracts.ts";
import { AmendmentSchema } from "../protocol/contracts.ts";
import { LIMITS, SCHEMA_VERSION } from "../protocol/limits.ts";
import { validateContract } from "../protocol/validate.ts";
import { redactDiagnostic } from "../security/redaction.ts";
import { stateError } from "../security/errors.ts";
import type { DurableStateStore, HistoryInput } from "../state/store.ts";
import {
  LifecycleService,
  type RunHealthStatus,
  type RunRecord,
} from "./lifecycle.ts";

export interface RecoveryIdentity {
  crewleadSessionId: string;
  herdrWorkspaceId: string;
  canonicalProjectPath: string;
}

export type ManagedMemberMatch =
  | { status: "exact"; agent: HerdrAgent }
  | { status: "missing" | "unbound" | "mismatched"; reason: string };

export interface ReconciledRun {
  runId: string;
  status:
    | "queued"
    | "exact"
    | "recovery_required"
    | "missing"
    | "unbound"
    | "mismatched"
    | "terminal"
    | "force_cancelled";
  semanticState: RunRecord["state"];
  diagnostic?: string;
}

export interface OrphanDiagnostic {
  paneId: string;
  tabId: string;
  reason: "unbound_managed_resource" | "identity_collision";
}

export interface ReconciliationReport {
  generation: number;
  snapshotVersion: string;
  reconciledAt: string;
  runs: readonly ReconciledRun[];
  orphanResources: readonly OrphanDiagnostic[];
  omittedOrphanResources: number;
}

export interface ExplicitRecoveryRequest {
  runId: string;
  expectedRevision: number;
  effectAssessment: "none_found" | "reviewed_bounded" | "unknown";
  reviewedByHuman: boolean;
  summary: string;
  evidenceRefs: readonly string[];
}

export type ExplicitRecoveryResult =
  | {
      status: "continued";
      run: RunRecord;
      amendmentId: string;
      promptAcknowledged: boolean;
      warning?: string;
    }
  | {
      status: "new_run_required";
      run: RunRecord;
      reason: string;
    };

export type MemberReadinessCode =
  | "ready"
  | "inactive_run"
  | "startup_incomplete"
  | "resource_binding_invalid"
  | "path_binding_invalid"
  | "builder_resource_invalid"
  | "role_readiness_failed"
  | "companion_provenance_failed"
  | `capability_${"missing" | "binding_mismatch" | "unclaimed" | "revoked" | "expired" | "conflicting" | "malformed" | "foreign_state"}`
  | `lease_${"missing" | "released" | "expired" | "epoch_mismatch" | "malformed" | "foreign_state"}`
  | "verification_error";

/** Bounded, non-secret result of the package-owned recovery readiness policy. */
export interface MemberReadinessResult {
  ready: boolean;
  code: MemberReadinessCode;
  evidenceRefs: readonly string[];
}

export interface RecoveryServiceOptions {
  now?: () => number;
  id?: (prefix: string) => string;
  isStartupInFlight?: (runId: string) => boolean;
  verifyMemberReadiness: (run: Readonly<RunRecord>) => Promise<MemberReadinessResult>;
}

const ACTIVE = new Set<RunRecord["state"]>(["starting", "working", "blocked"]);
const TERMINAL = new Set<RunRecord["state"]>(["completed", "failed", "cancelled", "abandoned"]);

function asRun(value: Readonly<Record<string, unknown>>): RunRecord {
  const validation = validateContract("run", value);
  if (!validation.ok) throw stateError("invalid_record");
  return structuredClone(value) as RunRecord;
}

function owns(run: RunRecord, identity: RecoveryIdentity): boolean {
  return run.binding.crewleadSessionId === identity.crewleadSessionId &&
    run.binding.herdrWorkspaceId === identity.herdrWorkspaceId &&
    run.binding.canonicalProjectPath === identity.canonicalProjectPath;
}

function evidence(values: readonly string[]): string[] {
  if (values.length < 1 || values.length > LIMITS.listItems || new Set(values).size !== values.length) {
    throw stateError("invalid_record");
  }
  return [...values];
}

function safeSummary(value: string): string {
  if (!value || Buffer.byteLength(value, "utf8") > LIMITS.amendmentTextLength) {
    throw stateError("oversized");
  }
  return value;
}

function eventFor(
  previous: RunRecord,
  next: RunRecord,
  operationId: string,
  type: "amendment_appended",
  reason: string,
  evidenceRefs: readonly string[],
): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: operationId,
    runId: next.runId,
    sequence: next.revision,
    timestamp: next.updatedAt,
    actor: "recovery",
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

function recoveryPrompt(amendment: {
  amendmentId: string;
  sequence: number;
  summary: string;
}): string {
  return [
    `DB11 Crew authenticated amendment ${amendment.amendmentId} (sequence ${amendment.sequence}).`,
    "Apply it only within the immutable task objective, role, permissions, and scope. Block if it would widen them.",
    "",
    amendment.summary,
  ].join("\n");
}

function sameHealth(
  run: RunRecord,
  status: RunHealthStatus,
  reconciliationRequired: boolean,
  reason: string | undefined,
): boolean {
  return run.health.status === status &&
    run.health.reconciliationRequired === reconciliationRequired &&
    run.health.reason === reason;
}

function managedPanes(snapshot: HerdrSnapshot, runId: string) {
  return snapshot.panes.filter((pane) => pane.managedRunId === runId);
}

/**
 * Match only durable IDs plus Herdr's official native Pi session reference.
 * Labels, focus, recency, process names, and apparent idle state are never authority.
 */
export function matchManagedMember(snapshot: HerdrSnapshot, run: Readonly<RunRecord>): ManagedMemberMatch {
  const resources = run.resources;
  if (!resources) {
    return { status: "missing", reason: "The durable run has no complete member resource identity." };
  }
  const tab = snapshot.tabs.find((candidate) => candidate.tabId === resources.tabId);
  const pane = snapshot.panes.find((candidate) => candidate.paneId === resources.paneId);
  if (!tab || !pane) {
    return { status: "missing", reason: "The fresh Herdr snapshot does not contain the recorded member tab and pane." };
  }
  if (
    tab.workspaceId !== run.binding.herdrWorkspaceId ||
    pane.workspaceId !== run.binding.herdrWorkspaceId ||
    pane.tabId !== tab.tabId ||
    resources.agentId !== pane.paneId
  ) {
    return { status: "mismatched", reason: "The recorded Herdr resource IDs resolve to a different topology." };
  }
  const collisions = managedPanes(snapshot, run.runId);
  if (
    (pane.managedRunId !== undefined && pane.managedRunId !== run.runId) ||
    collisions.some((candidate) => candidate.paneId !== pane.paneId)
  ) {
    return { status: "mismatched", reason: "A DB11 run marker collides with the durable resource binding." };
  }
  if (run.startup?.assignedRoot && pane.cwd && pane.cwd !== run.startup.assignedRoot) {
    return { status: "mismatched", reason: "The authoritative pane is attached to a different assigned workspace." };
  }
  const agent = snapshot.agents.find((candidate) => candidate.paneId === pane.paneId);
  if (!agent || !agent.agentSession) {
    return { status: "unbound", reason: "The recorded pane has no official native Pi session binding." };
  }
  if (
    agent.workspaceId !== pane.workspaceId ||
    agent.tabId !== pane.tabId ||
    agent.agentSession.kind !== "id" ||
    agent.agentSession.value !== run.binding.memberSessionId
  ) {
    return { status: "mismatched", reason: "The live pane is bound to a different native Pi session." };
  }
  return { status: "exact", agent };
}

/** Durable-state-first reconciliation. It never creates, adopts, prompts, closes, or retries a member. */
export class RecoveryService {
  readonly identity: Readonly<RecoveryIdentity>;
  readonly store: DurableStateStore;
  readonly lifecycle: LifecycleService;
  readonly herdr: HerdrAdapter;
  private readonly now: () => number;
  private readonly makeId: (prefix: string) => string;
  private readonly isStartupInFlight: (runId: string) => boolean;
  private readonly verifyMemberReadiness: (run: Readonly<RunRecord>) => Promise<MemberReadinessResult>;
  private last?: ReconciliationReport;

  constructor(
    identity: RecoveryIdentity,
    dependencies: {
      store: DurableStateStore;
      lifecycle: LifecycleService;
      herdr: HerdrAdapter;
    },
    options: RecoveryServiceOptions,
  ) {
    this.identity = Object.freeze(structuredClone(identity));
    this.store = dependencies.store;
    this.lifecycle = dependencies.lifecycle;
    this.herdr = dependencies.herdr;
    this.now = options.now ?? Date.now;
    this.makeId = options.id ?? ((prefix) => `${prefix}-${this.now()}`);
    this.isStartupInFlight = options.isStartupInFlight ?? (() => false);
    this.verifyMemberReadiness = options.verifyMemberReadiness;
  }

  report(): ReconciliationReport | undefined {
    return this.last && structuredClone(this.last);
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private async memberReadiness(run: RunRecord): Promise<MemberReadinessResult> {
    try {
      const result = await this.verifyMemberReadiness(Object.freeze(structuredClone(run)));
      if (
        result.ready !== (result.code === "ready") ||
        result.evidenceRefs.length < 1 ||
        result.evidenceRefs.length > LIMITS.listItems ||
        new Set(result.evidenceRefs).size !== result.evidenceRefs.length ||
        result.evidenceRefs.some((value) =>
          !value || Buffer.byteLength(value, "utf8") > LIMITS.referenceLength || /[\u0000-\u001f\u007f]/u.test(value))
      ) {
        throw stateError("invalid_record");
      }
      return { ...result, evidenceRefs: [...result.evidenceRefs] };
    } catch {
      return {
        ready: false,
        code: "verification_error",
        evidenceRefs: ["member-readiness:verification_error"],
      };
    }
  }

  private async health(
    run: RunRecord,
    status: RunHealthStatus,
    reconciliationRequired: boolean,
    reason: string | undefined,
    evidenceRefs: readonly string[],
  ): Promise<RunRecord> {
    if (sameHealth(run, status, reconciliationRequired, reason)) return run;
    return this.lifecycle.recordHealth({
      operationId: this.makeId("reconcile-health"),
      runId: run.runId,
      expectedRevision: run.revision,
      expectedFencingEpoch: run.fencingEpoch,
      actor: "recovery",
      status,
      reconciliationRequired,
      ...(reason ? { reason } : {}),
      evidenceRefs,
      timestamp: this.timestamp(),
    });
  }

  private async forceRequest(runId: string): Promise<Record<string, unknown> | undefined> {
    return [...await this.store.readHistory(runId)].reverse().find((record) =>
      record.kind === "control" &&
      (record.payload as { type?: unknown }).type === "force_requested",
    )?.payload as Record<string, unknown> | undefined;
  }

  private async confirmInterruptedForce(run: RunRecord, snapshot: HerdrSnapshot): Promise<RunRecord | undefined> {
    if (!await this.forceRequest(run.runId) || !run.resources) return undefined;
    const tabPresent = snapshot.tabs.some((tab) => tab.tabId === run.resources!.tabId);
    const panePresent = snapshot.panes.some((pane) => pane.paneId === run.resources!.paneId);
    if (tabPresent || panePresent) return undefined;
    let next = await this.lifecycle.transition({
      operationId: this.makeId("reconcile-force-cancel"),
      runId: run.runId,
      expectedRevision: run.revision,
      expectedFencingEpoch: run.fencingEpoch,
      actor: "recovery",
      targetState: "cancelled",
      reason: "A persisted explicit force request was reconciled with confirmed absence of the exact targeted runtime.",
      evidenceRefs: [`herdr:absent:${run.resources.paneId}`],
      timestamp: this.timestamp(),
    });
    next = await this.lifecycle.recordResourceDisposition({
      operationId: this.makeId("reconcile-force-closed"),
      runId: next.runId,
      expectedRevision: next.revision,
      expectedFencingEpoch: next.fencingEpoch,
      actor: "recovery",
      disposition: "closed",
      reason: "The exact force-targeted member runtime is absent in the fresh Herdr snapshot.",
      evidenceRefs: [`herdr:absent:${run.resources.paneId}`],
      timestamp: this.timestamp(),
    });
    return next;
  }

  async markConnectionGap(reason: string): Promise<void> {
    const diagnostic = "Herdr event continuity was lost; a fresh exact-identity snapshot is required.";
    for (const raw of await this.store.listRuns()) {
      let run = asRun(raw);
      if (!owns(run, this.identity) || !ACTIVE.has(run.state) || this.isStartupInFlight(run.runId)) continue;
      run = await this.health(
        run,
        "unreachable",
        true,
        diagnostic,
        [`herdr:gap:${redactDiagnostic(reason, { maximumLength: 64 }).replace(/[^A-Za-z0-9._:-]/gu, "-") || "unknown"}`],
      );
    }
  }

  async reconcile(snapshot: HerdrSnapshot, generation: number): Promise<ReconciliationReport> {
    if (!Number.isSafeInteger(generation) || generation < 1) throw stateError("invalid_record");
    const allRuns = (await this.store.listRuns()).map(asRun);
    const owned = allRuns.filter((run) => owns(run, this.identity));
    const durableIds = new Set(allRuns.map((run) => run.runId));
    const outcomes: ReconciledRun[] = [];
    const snapshotEvidence = [`herdr:snapshot:${generation}`];
    const workspacePresent = snapshot.workspaces.some(
      (workspace) => workspace.workspaceId === this.identity.herdrWorkspaceId,
    );

    for (let run of owned) {
      if (run.state === "queued") {
        outcomes.push({ runId: run.runId, status: "queued", semanticState: run.state });
        continue;
      }
      if (this.isStartupInFlight(run.runId)) continue;
      if (!workspacePresent && ACTIVE.has(run.state)) {
        const reason = "The bound Crewlead workspace is unavailable in the fresh Herdr snapshot.";
        run = await this.health(run, "unreachable", true, reason, snapshotEvidence);
        outcomes.push({ runId: run.runId, status: "missing", semanticState: run.state, diagnostic: reason });
        continue;
      }
      const match = matchManagedMember(snapshot, run);
      if (TERMINAL.has(run.state)) {
        if (match.status === "exact" && ["working", "blocked"].includes(match.agent.agentState)) {
          const reason = "A terminal run still has an actively observed member runtime.";
          run = await this.health(run, "inconsistent", true, reason, snapshotEvidence);
          outcomes.push({ runId: run.runId, status: "terminal", semanticState: run.state, diagnostic: reason });
        } else {
          outcomes.push({ runId: run.runId, status: "terminal", semanticState: run.state });
        }
        continue;
      }
      if (match.status !== "exact") {
        const forceCancelled = match.status === "missing"
          ? await this.confirmInterruptedForce(run, snapshot)
          : undefined;
        if (forceCancelled) {
          outcomes.push({ runId: run.runId, status: "force_cancelled", semanticState: forceCancelled.state });
          continue;
        }
        if (match.status === "missing" && run.resourceDisposition !== "missing") {
          run = await this.lifecycle.recordResourceDisposition({
            operationId: this.makeId("reconcile-missing"),
            runId: run.runId,
            expectedRevision: run.revision,
            expectedFencingEpoch: run.fencingEpoch,
            actor: "recovery",
            disposition: "missing",
            reason: match.reason,
            evidenceRefs: snapshotEvidence,
            timestamp: this.timestamp(),
          });
        }
        const healthStatus = match.status === "mismatched" ? "inconsistent" : "orphan_suspected";
        run = await this.health(run, healthStatus, true, match.reason, snapshotEvidence);
        outcomes.push({
          runId: run.runId,
          status: match.status,
          semanticState: run.state,
          diagnostic: match.reason,
        });
        continue;
      }

      if (run.resourceDisposition === "missing") {
        run = await this.lifecycle.recordResourceDisposition({
          operationId: this.makeId("reconcile-restored"),
          runId: run.runId,
          expectedRevision: run.revision,
          expectedFencingEpoch: run.fencingEpoch,
          actor: "recovery",
          disposition: "open",
          resources: run.resources,
          reason: "The exact recorded runtime and native Pi session are present again.",
          evidenceRefs: snapshotEvidence,
          timestamp: this.timestamp(),
        });
      }
      if (
        run.observation?.state !== match.agent.agentState ||
        run.observation?.sourceSequence !== match.agent.stateChangeSequence
      ) {
        run = await this.lifecycle.recordObservation({
          operationId: this.makeId("reconcile-observation"),
          runId: run.runId,
          expectedRevision: run.revision,
          expectedFencingEpoch: run.fencingEpoch,
          actor: "recovery",
          observation: {
            state: match.agent.agentState,
            observedAt: this.timestamp(),
            sourceSequence: match.agent.stateChangeSequence,
          },
          reason: "A fresh exact-session Herdr snapshot refreshed transient observation only.",
          evidenceRefs: snapshotEvidence,
          timestamp: this.timestamp(),
        });
      }
      const readiness = await this.memberReadiness(run);
      const completeEvidence = [...snapshotEvidence, ...readiness.evidenceRefs].slice(0, LIMITS.listItems);
      if (!readiness.ready) {
        const reason = `Member readiness gate failed (${readiness.code}).`;
        run = await this.health(run, "recovery_required", true, reason, completeEvidence);
        outcomes.push({ runId: run.runId, status: "recovery_required", semanticState: run.state, diagnostic: reason });
      } else if (run.health.reconciliationRequired) {
        const reason = "The exact native Pi session was found; explicit side-effect-aware recovery is still required.";
        run = await this.health(run, "recovery_required", true, reason, completeEvidence);
        outcomes.push({ runId: run.runId, status: "recovery_required", semanticState: run.state, diagnostic: reason });
      } else {
        run = await this.health(run, "healthy", false, undefined, completeEvidence);
        outcomes.push({ runId: run.runId, status: "exact", semanticState: run.state });
      }
    }

    const orphanCandidates: OrphanDiagnostic[] = [];
    const seenRunMarkers = new Map<string, string>();
    for (const pane of snapshot.panes) {
      if (pane.workspaceId !== this.identity.herdrWorkspaceId || !pane.managedRunId) continue;
      const previous = seenRunMarkers.get(pane.managedRunId);
      if (previous && previous !== pane.paneId) {
        orphanCandidates.push({ paneId: pane.paneId, tabId: pane.tabId, reason: "identity_collision" });
      } else {
        seenRunMarkers.set(pane.managedRunId, pane.paneId);
      }
      if (!durableIds.has(pane.managedRunId)) {
        orphanCandidates.push({ paneId: pane.paneId, tabId: pane.tabId, reason: "unbound_managed_resource" });
      }
    }
    const uniqueOrphans = [...new Map(
      orphanCandidates.map((item) => [`${item.paneId}\0${item.reason}`, item]),
    ).values()];
    const bounded = uniqueOrphans.slice(0, LIMITS.listItems);
    const report: ReconciliationReport = Object.freeze({
      generation,
      snapshotVersion: snapshot.version,
      reconciledAt: this.timestamp(),
      runs: Object.freeze(outcomes.slice(0, LIMITS.stateDirectoryEntries)),
      orphanResources: Object.freeze(bounded),
      omittedOrphanResources: Math.max(0, uniqueOrphans.length - bounded.length),
    });
    this.last = report;
    return structuredClone(report);
  }

  private async nextAmendmentSequence(runId: string): Promise<number> {
    const values = (await this.store.readHistory(runId))
      .filter((record) => record.kind === "control" && validateContract("amendment", record.payload).ok)
      .map((record) => Number((record.payload as { sequence: number }).sequence));
    return (values.length ? Math.max(...values) : 0) + 1;
  }

  async recover(request: ExplicitRecoveryRequest): Promise<ExplicitRecoveryResult> {
    let run = asRun(await this.store.readRun(request.runId));
    if (!owns(run, this.identity)) throw stateError("invalid_binding");
    if (run.revision !== request.expectedRevision) throw stateError("revision_conflict");
    if (!ACTIVE.has(run.state)) throw stateError(TERMINAL.has(run.state) ? "terminal_immutable" : "invalid_transition");
    if (request.effectAssessment === "unknown") {
      return {
        status: "new_run_required",
        run,
        reason: "Unknown side effects forbid same-run continuation. Keep investigating or explicitly disposition the old run before a separately authorized new run.",
      };
    }
    if (!request.reviewedByHuman || !run.health.reconciliationRequired) throw stateError("invalid_transition");
    const evidenceRefs = evidence(request.evidenceRefs);
    const effectText = request.effectAssessment === "none_found"
      ? "A responsible human reviewed the interruption and found no side effects requiring repetition."
      : "A responsible human reviewed and bounded the discovered side effects; no unknown operation may be repeated.";
    const summary = safeSummary(`${effectText} ${request.summary}`);
    const sequence = await this.nextAmendmentSequence(run.runId);

    // This is the final external-state gate before amendment construction. The
    // following durable re-read rejects a revision or fencing race without writing.
    const snapshot = await this.herdr.snapshot();
    run = asRun(await this.store.readRun(request.runId));
    if (
      !owns(run, this.identity) ||
      run.revision !== request.expectedRevision ||
      !ACTIVE.has(run.state) ||
      !run.health.reconciliationRequired
    ) {
      throw stateError(run.revision !== request.expectedRevision ? "revision_conflict" : "invalid_transition");
    }
    const match = matchManagedMember(snapshot, run);
    if (match.status !== "exact") throw stateError("invalid_binding");
    const readiness = await this.memberReadiness(run);
    if (!readiness.ready) throw stateError("invalid_binding");
    const current = asRun(await this.store.readRun(request.runId));
    if (
      !owns(current, this.identity) ||
      current.revision !== run.revision ||
      current.fencingEpoch !== run.fencingEpoch ||
      !ACTIVE.has(current.state) ||
      !current.health.reconciliationRequired
    ) {
      throw stateError(current.revision !== run.revision ? "revision_conflict" : "invalid_transition");
    }
    run = current;
    const amendment = {
      schemaVersion: SCHEMA_VERSION,
      amendmentId: this.makeId("recovery-amendment"),
      runId: run.runId,
      sequence,
      expectedRevision: run.revision,
      author: "recovery",
      timestamp: this.timestamp(),
      kind: "recovery",
      summary,
    };
    if (!validateContract("amendment", amendment).ok) throw stateError("invalid_record");
    const next = structuredClone(run);
    next.revision += 1;
    next.updatedAt = amendment.timestamp;
    next.resourceDisposition = "open";
    next.observation = {
      state: match.agent.agentState,
      observedAt: amendment.timestamp,
      sourceSequence: match.agent.stateChangeSequence,
    };
    next.health = {
      status: "healthy",
      reconciliationRequired: false,
      evidenceRefs,
      updatedAt: amendment.timestamp,
    };
    const operationId = this.makeId("recover");
    const history: HistoryInput[] = [
      {
        kind: "lifecycle",
        payload: eventFor(
          run,
          next,
          operationId,
          "amendment_appended",
          "An explicit exact-session, side-effect-reviewed recovery amendment was committed.",
          evidenceRefs,
        ),
      },
      { kind: "control", payload: amendment },
    ];
    const committed = await this.store.commitRun({
      operationId,
      expectedRevision: run.revision,
      expectedFencingEpoch: run.fencingEpoch,
      run: next,
      history,
    });
    run = asRun(committed.run);
    try {
      await this.herdr.prompt(run.resources!.paneId, recoveryPrompt(amendment));
      return { status: "continued", run, amendmentId: amendment.amendmentId, promptAcknowledged: true };
    } catch (error) {
      return {
        status: "continued",
        run,
        amendmentId: amendment.amendmentId,
        promptAcknowledged: false,
        warning: `${redactDiagnostic(error)} The durable recovery amendment was not retried.`,
      };
    }
  }
}
