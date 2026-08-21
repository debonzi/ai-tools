import { randomUUID } from "node:crypto";

import type { HerdrAdapter, HerdrSnapshot } from "../adapters/herdr/contracts.ts";
import {
  GitDispositionAdapter,
  type BuilderRepositoryResource,
  type ReadRepositoryResource,
} from "../adapters/git/disposition.ts";
import { LIMITS, SCHEMA_VERSION } from "../protocol/limits.ts";
import { validateContract } from "../protocol/validate.ts";
import { digestJson } from "../security/json.ts";
import { redactDiagnostic } from "../security/redaction.ts";
import { stateError } from "../security/errors.ts";
import { DurableDeliveryClaims } from "../state/claims.ts";
import type { DurableStateStore } from "../state/store.ts";
import { matchManagedMember } from "./recovery.ts";
import type {
  IntegrationMetadata,
  RepositoryCleanupMetadata,
  RepositoryResource,
  RunRecord,
  RuntimeCleanupMetadata,
} from "./lifecycle.ts";

export interface DispositionIdentity {
  crewleadSessionId: string;
  herdrWorkspaceId: string;
  canonicalProjectPath: string;
}

export interface RuntimeCleanupAssessment {
  runId: string;
  eligible: boolean;
  eligibleAt?: string;
  reasons: readonly string[];
}

export interface RuntimeCleanupResult {
  run: RunRecord;
  closed: boolean;
  idempotent: boolean;
}

export interface RuntimeCleanupOptions {
  now?: () => number;
  id?: (prefix: string) => string;
  inspectionGraceMilliseconds: number;
}

export interface RepositoryCleanupRequest {
  requestId: string;
  runId: string;
  expectedRevision: number;
  authorization: "integrated" | "superseded" | "discard" | "read_snapshot";
  evidenceRefs: readonly string[];
  replacementRunId?: string;
  confirmation?: "discard_exact_unmerged_artifacts";
  acknowledgedArtifacts?: readonly string[];
}

const TERMINAL = new Set<RunRecord["state"]>(["completed", "failed", "cancelled", "abandoned"]);

function asRun(value: Readonly<Record<string, unknown>>): RunRecord {
  if (!validateContract("run", value).ok) throw stateError("invalid_record");
  return structuredClone(value) as RunRecord;
}

function owns(run: RunRecord, identity: DispositionIdentity): boolean {
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

function timestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function safeDiagnostic(error: unknown): string {
  return redactDiagnostic(error).slice(0, LIMITS.diagnosticLength) || "The exact disposition operation failed.";
}

function sameDurableValue(left: unknown, right: unknown): boolean {
  return digestJson(left, LIMITS.runBytes) === digestJson(right, LIMITS.runBytes);
}

function integrationIntentMatches(actual: IntegrationMetadata | undefined, expected: IntegrationMetadata): boolean {
  return actual !== undefined && sameDurableValue(actual, expected);
}

function cleanupIntentMatches(actual: RepositoryCleanupMetadata | undefined, expected: RepositoryCleanupMetadata): boolean {
  return actual !== undefined && sameDurableValue(actual, expected);
}

function eventFor(
  previous: RunRecord,
  next: RunRecord,
  operationId: string,
  type: "cleanup_changed" | "diagnostic",
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

async function commitMetadata(
  store: DurableStateStore,
  current: RunRecord,
  operationId: string,
  type: "cleanup_changed" | "diagnostic",
  reason: string,
  evidenceRefs: readonly string[],
  at: string,
  mutate: (next: RunRecord) => void,
): Promise<RunRecord> {
  const next = structuredClone(current);
  next.revision += 1;
  next.updatedAt = at;
  mutate(next);
  const result = await store.commitRun({
    operationId,
    expectedRevision: current.revision,
    expectedFencingEpoch: current.fencingEpoch,
    run: next,
    history: [{ kind: "lifecycle", payload: eventFor(current, next, operationId, type, reason, evidenceRefs) }],
  });
  return asRun(result.run);
}

async function resultFor(store: DurableStateStore, run: RunRecord): Promise<Record<string, unknown>> {
  if (!run.resultId || !run.resultDigest) throw stateError("invalid_transition");
  const records = await store.readHistory(run.runId);
  const record = [...records].reverse().find((candidate) => candidate.kind === "result" &&
    (candidate.payload as { resultId?: unknown }).resultId === run.resultId);
  if (!record || digestJson(record.payload, LIMITS.resultBytes) !== run.resultDigest) throw stateError("foreign_state");
  return structuredClone(record.payload as Record<string, unknown>);
}

function exactTopology(snapshot: HerdrSnapshot, run: RunRecord): string[] {
  const reasons: string[] = [];
  const match = matchManagedMember(snapshot, run);
  if (match.status !== "exact") reasons.push(`identity_${match.status}`);
  const resources = run.resources;
  if (!resources) return [...reasons, "resources_missing"];
  const tab = snapshot.tabs.find((candidate) => candidate.tabId === resources.tabId);
  const panes = snapshot.panes.filter((candidate) => candidate.tabId === resources.tabId);
  if (!tab || tab.workspaceId !== run.binding.herdrWorkspaceId) reasons.push("tab_mismatch");
  if (tab && (tab.paneCount !== 1 || panes.length !== 1 || panes[0]?.paneId !== resources.paneId)) {
    reasons.push("unowned_user_pane");
  }
  const workspaceTabs = snapshot.tabs.filter((candidate) => candidate.workspaceId === run.binding.herdrWorkspaceId);
  if (workspaceTabs.length <= 1) reasons.push("last_workspace_tab");
  if (match.status === "exact" && !["idle", "done"].includes(match.agent.agentState)) {
    reasons.push("companion_not_settled");
  }
  return reasons;
}

export class RuntimeCleanupService {
  readonly identity: Readonly<DispositionIdentity>;
  readonly store: DurableStateStore;
  readonly herdr: HerdrAdapter;
  readonly graceMilliseconds: number;
  readonly claims: DurableDeliveryClaims;
  readonly #now: () => number;
  readonly #id: (prefix: string) => string;

  constructor(
    identity: DispositionIdentity,
    dependencies: { store: DurableStateStore; herdr: HerdrAdapter },
    options: RuntimeCleanupOptions,
  ) {
    if (
      !Number.isInteger(options.inspectionGraceMilliseconds) ||
      options.inspectionGraceMilliseconds < LIMITS.inspectionGraceMinimumMilliseconds ||
      options.inspectionGraceMilliseconds > LIMITS.inspectionGraceMaximumMilliseconds
    ) throw stateError("invalid_record");
    this.identity = Object.freeze(structuredClone(identity));
    this.store = dependencies.store;
    this.herdr = dependencies.herdr;
    this.graceMilliseconds = options.inspectionGraceMilliseconds;
    this.#now = options.now ?? Date.now;
    this.claims = new DurableDeliveryClaims(this.store.root, { now: this.#now });
    this.#id = options.id ?? ((prefix) => `${prefix}-${randomUUID()}`);
  }

  async #owned(runId: string): Promise<RunRecord> {
    const run = asRun(await this.store.readRun(runId));
    if (!owns(run, this.identity)) throw stateError("invalid_binding");
    return run;
  }

  async assess(runId: string, snapshotValue?: HerdrSnapshot): Promise<RuntimeCleanupAssessment> {
    const run = await this.#owned(runId);
    const reasons: string[] = [];
    if (run.retentionPolicy !== "auto_close") reasons.push("retained_or_pinned");
    if (run.state !== "completed") reasons.push("outcome_not_clean_completed");
    if (!run.resultId || !run.resultDigest) reasons.push("result_not_durable");
    if (!["open", "retained"].includes(run.resourceDisposition)) reasons.push("runtime_not_open");
    if (run.health.status !== "healthy" || run.health.reconciliationRequired) reasons.push("health_requires_review");
    if (run.activeBlockerId) reasons.push("blocker_open");
    if (run.runtimeCleanup?.intent?.status === "failed") reasons.push("prior_cleanup_failed");

    const history = await this.store.readHistory(run.runId);
    const acknowledgement = [...history].reverse().find((record) => record.kind === "control" &&
      (record.payload as { type?: unknown }).type === "result_acknowledged");
    const deliveredAt = await this.claims.deliveredAtForRun({
      crewleadSessionId: this.identity.crewleadSessionId,
      herdrWorkspaceId: this.identity.herdrWorkspaceId,
    }, run.runId);
    if (!acknowledgement && !deliveredAt) reasons.push("delivery_not_acknowledged");
    const starts = [
      deliveredAt,
      acknowledgement?.timestamp,
      run.runtimeCleanup?.graceStartedAt,
      run.runtimeCleanup?.unpinnedAt,
      run.runtimeCleanup?.lastInteractionAt,
    ].filter((value): value is string => typeof value === "string");
    const graceStart = starts.length ? Math.max(...starts.map((value) => Date.parse(value))) : Number.NaN;
    const eligibleAt = Number.isFinite(graceStart) ? graceStart + this.graceMilliseconds : undefined;
    if (eligibleAt === undefined || this.#now() < eligibleAt) reasons.push("inspection_grace_active");
    const leaseExpiry = run.runtimeCleanup?.inspectionLease?.expiresAt;
    if (leaseExpiry && Date.parse(leaseExpiry) > this.#now()) reasons.push("inspection_lease_active");

    if (run.state === "completed" && run.resultId && run.resultDigest) {
      const result = await resultFor(this.store, run).catch(() => undefined);
      const value = result as { validation?: Array<{ status?: unknown }>; unresolvedBlockerIds?: unknown[]; unresolvedDecisions?: unknown[] } | undefined;
      if (!value || value.validation?.some((item) => item.status === "failed") ||
        value.unresolvedBlockerIds?.length || value.unresolvedDecisions?.length) reasons.push("result_requires_review");
    }
    const snapshot = snapshotValue ?? await this.herdr.snapshot();
    reasons.push(...exactTopology(snapshot, run));
    return Object.freeze({
      runId,
      eligible: reasons.length === 0,
      ...(eligibleAt === undefined ? {} : { eligibleAt: timestamp(eligibleAt) }),
      reasons: Object.freeze([...new Set(reasons)]),
    });
  }

  async pin(input: { runId: string; expectedRevision: number; evidenceRefs: readonly string[] }): Promise<RunRecord> {
    const current = await this.#owned(input.runId);
    if (current.revision !== input.expectedRevision) throw stateError("revision_conflict");
    if (!TERMINAL.has(current.state) || !["open", "retained"].includes(current.resourceDisposition) || current.runtimeCleanup?.intent?.status === "prepared") throw stateError("invalid_transition");
    const at = timestamp(this.#now());
    return commitMetadata(this.store, current, this.#id("runtime-pin"), "cleanup_changed",
      "A responsible human pinned the terminal runtime for retention.", evidence(input.evidenceRefs), at, (next) => {
        next.retentionPolicy = "retain";
        next.runtimeCleanup = { ...next.runtimeCleanup, pinnedAt: at };
      });
  }

  async unpin(input: { runId: string; expectedRevision: number; evidenceRefs: readonly string[] }): Promise<RunRecord> {
    const current = await this.#owned(input.runId);
    if (current.revision !== input.expectedRevision) throw stateError("revision_conflict");
    if (!TERMINAL.has(current.state) || !["open", "retained"].includes(current.resourceDisposition) || current.runtimeCleanup?.intent?.status === "prepared") throw stateError("invalid_transition");
    const at = timestamp(this.#now());
    return commitMetadata(this.store, current, this.#id("runtime-unpin"), "cleanup_changed",
      "A responsible human restored automatic cleanup; a new inspection grace interval started.", evidence(input.evidenceRefs), at, (next) => {
        next.retentionPolicy = "auto_close";
        next.runtimeCleanup = { ...next.runtimeCleanup, unpinnedAt: at, graceStartedAt: at };
      });
  }

  async inspect(input: { runId: string; expectedRevision: number; leaseMilliseconds: number; evidenceRefs: readonly string[] }): Promise<RunRecord> {
    const current = await this.#owned(input.runId);
    if (current.revision !== input.expectedRevision) throw stateError("revision_conflict");
    if (!TERMINAL.has(current.state) || !["open", "retained"].includes(current.resourceDisposition) || current.runtimeCleanup?.intent?.status === "prepared" || !Number.isInteger(input.leaseMilliseconds) ||
      input.leaseMilliseconds < LIMITS.inspectionGraceMinimumMilliseconds ||
      input.leaseMilliseconds > LIMITS.inspectionGraceMaximumMilliseconds) throw stateError("invalid_transition");
    const now = this.#now();
    const at = timestamp(now);
    return commitMetadata(this.store, current, this.#id("runtime-inspect"), "cleanup_changed",
      "A responsible human acquired a bounded terminal-runtime inspection lease.", evidence(input.evidenceRefs), at, (next) => {
        next.runtimeCleanup = {
          ...next.runtimeCleanup,
          lastInteractionAt: at,
          graceStartedAt: at,
          inspectionLease: {
            leaseId: this.#id("inspection-lease"), actor: "human", acquiredAt: at,
            expiresAt: timestamp(now + input.leaseMilliseconds),
          },
        };
      });
  }

  async close(input: {
    requestId: string;
    runId: string;
    expectedRevision: number;
    source: "automatic" | "capacity" | "human";
    evidenceRefs: readonly string[];
    explicitTerminalReview?: boolean;
  }): Promise<RuntimeCleanupResult> {
    let current = await this.#owned(input.runId);
    if (current.revision !== input.expectedRevision) throw stateError("revision_conflict");
    if (current.resourceDisposition === "closed") return { run: current, closed: true, idempotent: true };
    if (!TERMINAL.has(current.state) || !current.resources) throw stateError("invalid_transition");
    if (current.runtimeCleanup?.intent?.requestId === input.requestId) {
      if (current.runtimeCleanup.intent.status === "completed") return { run: current, closed: true, idempotent: true };
      if (current.runtimeCleanup.intent.status === "failed") throw stateError("invalid_transition");
    }
    const snapshot = await this.herdr.snapshot();
    if (input.source === "human") {
      if (input.explicitTerminalReview !== true || exactTopology(snapshot, current).length) throw stateError("invalid_transition");
    } else {
      const assessment = await this.assess(input.runId, snapshot);
      if (!assessment.eligible) throw stateError("invalid_transition");
    }
    const resources = current.resources;
    const evidenceRefs = evidence(input.evidenceRefs);
    const preparedAt = timestamp(this.#now());
    const intent: RuntimeCleanupMetadata["intent"] = {
      requestId: input.requestId,
      source: input.source,
      status: "prepared",
      expectedTabId: resources.tabId,
      expectedPaneId: resources.paneId,
      preparedAt,
      updatedAt: preparedAt,
    };
    current = await commitMetadata(this.store, current, this.#id("runtime-cleanup-intent"), "cleanup_changed",
      "An exact, revision-checked runtime cleanup intent was persisted before closing Herdr resources.", evidenceRefs, preparedAt,
      (next) => { next.runtimeCleanup = { ...next.runtimeCleanup, intent }; });
    try {
      const fresh = await this.herdr.snapshot();
      const latest = await this.#owned(current.runId);
      if (
        latest.revision !== current.revision || latest.runtimeCleanup?.intent?.requestId !== input.requestId ||
        latest.runtimeCleanup.intent.status !== "prepared"
      ) throw stateError("revision_conflict");
      current = latest;
      if (input.source === "human") {
        if (exactTopology(fresh, current).length) throw stateError("invalid_binding");
      } else if (!(await this.assess(current.runId, fresh)).eligible) {
        throw stateError("invalid_transition");
      }
      await this.herdr.closeTabExact({
        workspaceId: current.binding.herdrWorkspaceId,
        tabId: resources.tabId,
        paneId: resources.paneId,
      });
      const after = await this.herdr.snapshot();
      if (after.tabs.some((tab) => tab.tabId === resources.tabId) ||
        after.panes.some((pane) => pane.paneId === resources.paneId)) throw stateError("invalid_transition");
      const closedAt = timestamp(this.#now());
      current = await commitMetadata(this.store, current, this.#id("runtime-cleanup-complete"), "cleanup_changed",
        "The exact Herdr member runtime close was confirmed by a fresh snapshot.",
        [...evidenceRefs, `herdr:absent:${resources.paneId}`], closedAt, (next) => {
          next.resourceDisposition = "closed";
          next.runtimeCleanup = {
            ...next.runtimeCleanup,
            closedAt,
            closeProvenance: input.source,
            intent: { ...intent, status: "completed", updatedAt: closedAt },
          };
        });
      return { run: current, closed: true, idempotent: false };
    } catch (error) {
      const failedAt = timestamp(this.#now());
      current = asRun(await this.store.readRun(current.runId));
      current = await commitMetadata(this.store, current, this.#id("runtime-cleanup-failed"), "diagnostic",
        "Runtime cleanup stopped after one bounded exact-close failure; no blind retry was attempted.", evidenceRefs, failedAt,
        (next) => {
          next.resourceDisposition = "retained";
          next.runtimeCleanup = {
            ...next.runtimeCleanup,
            intent: { ...intent, status: "failed", updatedAt: failedAt, diagnostic: safeDiagnostic(error) },
          };
        });
      return { run: current, closed: false, idempotent: false };
    }
  }

  async sweep(): Promise<readonly RuntimeCleanupResult[]> {
    const snapshot = await this.herdr.snapshot();
    const candidates: Array<{ run: RunRecord; assessment: RuntimeCleanupAssessment }> = [];
    for (const raw of await this.store.listRuns()) {
      const run = asRun(raw);
      if (!owns(run, this.identity)) continue;
      const assessment = await this.assess(run.runId, snapshot);
      if (assessment.eligible) candidates.push({ run, assessment });
    }
    candidates.sort((left, right) =>
      String(left.assessment.eligibleAt).localeCompare(String(right.assessment.eligibleAt)) ||
      left.run.runId.localeCompare(right.run.runId));
    const results: RuntimeCleanupResult[] = [];
    for (const candidate of candidates) {
      results.push(await this.close({
        requestId: this.#id("automatic-cleanup"), runId: candidate.run.runId,
        expectedRevision: candidate.run.revision, source: "automatic",
        evidenceRefs: ["policy:auto-close"],
      }));
    }
    return Object.freeze(results);
  }

  async reclaim(count: number): Promise<readonly RuntimeCleanupResult[]> {
    if (!Number.isInteger(count) || count < 1 || count > LIMITS.maxOpenMemberResources) throw stateError("invalid_record");
    const snapshot = await this.herdr.snapshot();
    const candidates: Array<{ run: RunRecord; assessment: RuntimeCleanupAssessment }> = [];
    for (const raw of await this.store.listRuns()) {
      const run = asRun(raw);
      if (!owns(run, this.identity)) continue;
      const assessment = await this.assess(run.runId, snapshot);
      if (assessment.eligible) candidates.push({ run, assessment });
    }
    candidates.sort((left, right) =>
      String(left.assessment.eligibleAt).localeCompare(String(right.assessment.eligibleAt)) ||
      left.run.runId.localeCompare(right.run.runId));
    const results: RuntimeCleanupResult[] = [];
    for (const candidate of candidates.slice(0, count)) {
      results.push(await this.close({
        requestId: this.#id("capacity-cleanup"), runId: candidate.run.runId,
        expectedRevision: candidate.run.revision, source: "capacity",
        evidenceRefs: ["capacity:open-member-resources"],
      }));
    }
    return Object.freeze(results);
  }

  async reconcileExternalClose(input: {
    runId: string;
    expectedRevision: number;
    evidenceRef: string;
    confirmedByHuman: boolean;
  }): Promise<RunRecord> {
    const current = await this.#owned(input.runId);
    if (current.revision !== input.expectedRevision) throw stateError("revision_conflict");
    if (!TERMINAL.has(current.state) || !current.resources || !input.confirmedByHuman || current.runtimeCleanup?.intent?.status === "prepared") throw stateError("invalid_transition");
    const snapshot = await this.herdr.snapshot();
    if (snapshot.tabs.some((tab) => tab.tabId === current.resources!.tabId) ||
      snapshot.panes.some((pane) => pane.paneId === current.resources!.paneId) ||
      snapshot.panes.some((pane) => pane.managedRunId === current.runId)) throw stateError("invalid_binding");
    const at = timestamp(this.#now());
    return commitMetadata(this.store, current, this.#id("runtime-external-close"), "cleanup_changed",
      "A responsible-human external terminal close was recorded after exact absence confirmation.",
      [input.evidenceRef], at, (next) => {
        next.resourceDisposition = "closed";
        next.runtimeCleanup = {
          ...next.runtimeCleanup, closedAt: at, closeProvenance: "external", externalEvidenceRef: input.evidenceRef,
        };
      });
  }
}

export class BuilderIntegrationService {
  readonly identity: Readonly<DispositionIdentity>;
  readonly store: DurableStateStore;
  readonly git: GitDispositionAdapter;
  readonly #now: () => number;
  readonly #id: (prefix: string) => string;
  #serial: Promise<void> = Promise.resolve();

  constructor(identity: DispositionIdentity, dependencies: { store: DurableStateStore; git: GitDispositionAdapter }, options: { now?: () => number; id?: (prefix: string) => string } = {}) {
    this.identity = Object.freeze(structuredClone(identity));
    this.store = dependencies.store;
    this.git = dependencies.git;
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? ((prefix) => `${prefix}-${randomUUID()}`);
  }

  integrate(input: { requestId: string; runId: string; expectedRevision: number; evidenceRefs: readonly string[]; confirmation: "integrate_exact_builder_ff_only" }): Promise<{ run: RunRecord; integrated: boolean; idempotent: boolean }> {
    const operation = this.#serial.then(() => this.#integrate(input));
    this.#serial = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #integrate(input: { requestId: string; runId: string; expectedRevision: number; evidenceRefs: readonly string[]; confirmation: "integrate_exact_builder_ff_only" }): Promise<{ run: RunRecord; integrated: boolean; idempotent: boolean }> {
    let current = asRun(await this.store.readRun(input.runId));
    if (!owns(current, this.identity)) throw stateError("invalid_binding");
    if (current.revision !== input.expectedRevision) throw stateError("revision_conflict");
    if (input.confirmation !== "integrate_exact_builder_ff_only" || current.state !== "completed" || current.role !== "builder" || current.repositoryResource?.kind !== "builder_worktree" || current.runtimeCleanup?.intent?.status === "prepared") throw stateError("invalid_transition");
    if (current.integration?.requestId === input.requestId) {
      if (current.integration.status === "completed") return { run: current, integrated: true, idempotent: true };
      if (current.integration.status === "failed") throw stateError("invalid_transition");
    }
    if (current.integration?.status === "completed") throw stateError("idempotency_conflict");
    const result = await resultFor(this.store, current);
    const details = result.roleDetails as { role?: unknown; repository?: { rootDigest?: unknown; baseCommit?: unknown; headCommit?: unknown }; worktreeClean?: unknown };
    const resource = structuredClone(current.repositoryResource) as BuilderRepositoryResource;
    if (resource.runId !== current.runId || resource.source.canonicalRoot !== current.binding.canonicalProjectPath) throw stateError("invalid_binding");
    const expectedHead = details.repository?.headCommit;
    if (
      details.role !== "builder" || typeof expectedHead !== "string" ||
      details.repository?.rootDigest !== resource.source.canonicalRootDigest ||
      details.repository?.baseCommit !== resource.baseCommit || details.worktreeClean !== true
    ) throw stateError("invalid_record");
    const evidenceRefs = evidence(input.evidenceRefs);

    const alreadyApplied = await this.git.integrationAlreadyApplied(resource, expectedHead);
    if (!alreadyApplied) await this.git.integrationPreflight(resource, expectedHead);

    const prior = current.integration?.requestId === input.requestId ? current.integration : undefined;
    const preparedAt = prior?.preparedAt ?? timestamp(this.#now());
    const intent: IntegrationMetadata = prior ? structuredClone(prior) : {
      requestId: input.requestId, mode: "ff_only", status: "prepared", targetRef: resource.targetRef,
      expectedBase: resource.baseCommit, expectedHead, preparedAt, updatedAt: preparedAt, evidenceRefs,
    };
    if (!integrationIntentMatches(intent, {
      ...intent, requestId: input.requestId, targetRef: resource.targetRef,
      expectedBase: resource.baseCommit, expectedHead, evidenceRefs,
    })) throw stateError("idempotency_conflict");
    if (!prior) {
      current = await commitMetadata(this.store, current, this.#id("integration-intent"), "diagnostic",
        "A responsible-human-authorized local fast-forward-only integration intent was persisted after exact live preflight.", evidenceRefs, preparedAt,
        (next) => { next.integration = intent; });
    }

    try {
      let latest = asRun(await this.store.readRun(current.runId));
      if (
        !owns(latest, this.identity) || latest.revision !== current.revision ||
        !sameDurableValue(latest.repositoryResource, resource) || !integrationIntentMatches(latest.integration, intent)
      ) throw stateError("revision_conflict");
      let commandExitCode = 0;
      let diagnostic: string | undefined;
      if (!await this.git.integrationAlreadyApplied(resource, expectedHead)) {
        latest = asRun(await this.store.readRun(current.runId));
        if (
          !owns(latest, this.identity) || latest.revision !== current.revision ||
          !sameDurableValue(latest.repositoryResource, resource) || !integrationIntentMatches(latest.integration, intent)
        ) throw stateError("revision_conflict");
        const applied = await this.git.integrateFastForward(resource, expectedHead, async () => {
          const beforeEffect = asRun(await this.store.readRun(current.runId));
          if (
            !owns(beforeEffect, this.identity) || beforeEffect.revision !== current.revision ||
            !sameDurableValue(beforeEffect.repositoryResource, resource) ||
            !integrationIntentMatches(beforeEffect.integration, intent)
          ) throw stateError("revision_conflict");
        });
        commandExitCode = applied.commandExitCode;
        diagnostic = applied.commandDiagnostic;
      }
      const integratedAt = timestamp(this.#now());
      latest = asRun(await this.store.readRun(current.runId));
      if (!owns(latest, this.identity) || !sameDurableValue(latest.repositoryResource, resource) || !integrationIntentMatches(latest.integration, intent)) {
        throw stateError("revision_conflict");
      }
      current = await commitMetadata(this.store, latest, this.#id("integration-complete"), "diagnostic",
        "The exact target ref and worktree were verified at the immutable recorded Builder head after local fast-forward integration.",
        [...evidenceRefs, `git:target:${expectedHead}`], integratedAt, (next) => {
          next.integration = { ...intent, status: "completed", updatedAt: integratedAt, integratedAt, commandExitCode, ...(diagnostic ? { diagnostic } : {}) };
        });
      return { run: current, integrated: true, idempotent: false };
    } catch (error) {
      if (await this.git.integrationAlreadyApplied(resource, expectedHead).catch(() => false)) {
        const integratedAt = timestamp(this.#now());
        const latest = asRun(await this.store.readRun(current.runId));
        if (!owns(latest, this.identity) || !sameDurableValue(latest.repositoryResource, resource) || !integrationIntentMatches(latest.integration, intent)) {
          throw stateError("revision_conflict");
        }
        current = await commitMetadata(this.store, latest, this.#id("integration-reconciled"), "diagnostic",
          "A Git command or hook failed, but the immutable exact fast-forward result was independently verified.",
          [...evidenceRefs, `git:target:${expectedHead}`], integratedAt, (next) => {
            next.integration = { ...intent, status: "completed", updatedAt: integratedAt, integratedAt, commandExitCode: 1, diagnostic: safeDiagnostic(error) };
          });
        return { run: current, integrated: true, idempotent: false };
      }
      const failedAt = timestamp(this.#now());
      const latest = asRun(await this.store.readRun(current.runId));
      if (!owns(latest, this.identity) || !sameDurableValue(latest.repositoryResource, resource) || !integrationIntentMatches(latest.integration, intent)) {
        throw stateError("revision_conflict");
      }
      current = await commitMetadata(this.store, latest, this.#id("integration-failed"), "diagnostic",
        "Local integration stopped without retry, rebase, merge commit, or remote mutation.", evidenceRefs, failedAt,
        (next) => { next.integration = { ...intent, status: "failed", updatedAt: failedAt, diagnostic: safeDiagnostic(error) }; });
      return { run: current, integrated: false, idempotent: false };
    }
  }
}

export class RepositoryCleanupService {
  readonly identity: Readonly<DispositionIdentity>;
  readonly store: DurableStateStore;
  readonly git: GitDispositionAdapter;
  readonly #now: () => number;
  readonly #id: (prefix: string) => string;

  constructor(identity: DispositionIdentity, dependencies: { store: DurableStateStore; git: GitDispositionAdapter }, options: { now?: () => number; id?: (prefix: string) => string } = {}) {
    this.identity = Object.freeze(structuredClone(identity));
    this.store = dependencies.store;
    this.git = dependencies.git;
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? ((prefix) => `${prefix}-${randomUUID()}`);
  }

  async #assertBuilderAuthorization(
    current: RunRecord,
    input: RepositoryCleanupRequest,
    resource: BuilderRepositoryResource,
    expectedHead: string,
  ): Promise<void> {
    if (input.authorization === "integrated") {
      if (
        current.integration?.status !== "completed" || current.integration.expectedHead !== expectedHead ||
        current.integration.expectedBase !== resource.baseCommit || current.integration.targetRef !== resource.targetRef
      ) {
        throw stateError("invalid_transition");
      }
      await this.git.assertHeadReachableFromTarget(resource, expectedHead);
      return;
    }
    if (input.authorization === "superseded") {
      if (!input.replacementRunId) throw stateError("invalid_record");
      const replacement = asRun(await this.store.readRun(input.replacementRunId));
      const replacementResource = replacement.repositoryResource;
      if (
        !owns(replacement, this.identity) || replacement.state !== "completed" || replacement.role !== "builder" ||
        replacementResource?.kind !== "builder_worktree" || replacementResource.runId !== replacement.runId ||
        replacementResource.source.canonicalRoot !== replacement.binding.canonicalProjectPath ||
        replacementResource.source.commonGitDirectoryDigest !== resource.source.commonGitDirectoryDigest ||
        replacementResource.targetRef !== resource.targetRef || replacement.integration?.status !== "completed" ||
        replacement.integration.targetRef !== replacementResource.targetRef ||
        replacement.integration.expectedBase !== replacementResource.baseCommit
      ) throw stateError("invalid_transition");
      await this.git.assertHeadReachableFromTarget(replacementResource, replacement.integration.expectedHead);
      return;
    }
    if (input.authorization !== "discard" || input.confirmation !== "discard_exact_unmerged_artifacts" || !input.acknowledgedArtifacts?.length) {
      throw stateError("invalid_transition");
    }
  }

  #assertPreparedRun(
    current: RunRecord,
    resource: RepositoryResource,
    intent: RepositoryCleanupMetadata,
    expectedRevision?: number,
  ): void {
    if (
      !owns(current, this.identity) ||
      (expectedRevision !== undefined && current.revision !== expectedRevision) ||
      !sameDurableValue(current.repositoryResource, resource) ||
      !cleanupIntentMatches(current.repositoryCleanup, intent)
    ) throw stateError("revision_conflict");
  }

  async cleanup(input: RepositoryCleanupRequest): Promise<{ run: RunRecord; completed: boolean; idempotent: boolean }> {
    let current = asRun(await this.store.readRun(input.runId));
    if (!owns(current, this.identity)) throw stateError("invalid_binding");
    if (current.revision !== input.expectedRevision) throw stateError("revision_conflict");
    if (!TERMINAL.has(current.state) || current.resourceDisposition !== "closed" || !current.repositoryResource) throw stateError("invalid_transition");
    if (current.repositoryCleanup?.requestId === input.requestId && current.repositoryCleanup.status === "completed") {
      return { run: current, completed: true, idempotent: true };
    }
    let evidenceRefs = evidence(input.evidenceRefs);
    const result = await resultFor(this.store, current);
    const resource = structuredClone(current.repositoryResource);
    if (resource.runId !== current.runId || resource.source.canonicalRoot !== current.binding.canonicalProjectPath) throw stateError("invalid_binding");
    let expectedHead: string;
    let observedTargetHead: string | undefined;
    if (resource.kind === "read_snapshot") {
      if (input.authorization !== "read_snapshot" || current.state !== "completed") throw stateError("invalid_transition");
      expectedHead = resource.sourceHead;
      await this.git.readSnapshotState(resource);
    } else {
      const details = result.roleDetails as { role?: unknown; repository?: { headCommit?: unknown; baseCommit?: unknown; rootDigest?: unknown } };
      if (
        details.role !== "builder" || typeof details.repository?.headCommit !== "string" ||
        details.repository.baseCommit !== resource.baseCommit ||
        details.repository.rootDigest !== resource.source.canonicalRootDigest
      ) throw stateError("invalid_record");
      expectedHead = details.repository.headCommit;
      if (input.authorization === "discard") {
        if (input.confirmation !== "discard_exact_unmerged_artifacts" || !input.acknowledgedArtifacts?.length) throw stateError("invalid_transition");
        evidenceRefs = evidence([...evidenceRefs, ...evidence(input.acknowledgedArtifacts)]);
      }
      await this.git.builderResourceState(resource, expectedHead, input.authorization === "discard");
      observedTargetHead = await this.git.targetHead(resource);
      await this.#assertBuilderAuthorization(current, input, resource, expectedHead);
    }

    const prior = current.repositoryCleanup?.requestId === input.requestId ? current.repositoryCleanup : undefined;
    const preparedAt = prior?.preparedAt ?? timestamp(this.#now());
    let intent: RepositoryCleanupMetadata = prior ? structuredClone(prior) : {
      requestId: input.requestId, authorization: input.authorization, status: "prepared", expectedHead,
      ...(input.replacementRunId ? { replacementRunId: input.replacementRunId } : {}),
      preparedAt, updatedAt: preparedAt, worktreeRemoved: false, branchRemoved: resource.kind === "read_snapshot", evidenceRefs,
    };
    if (
      intent.authorization !== input.authorization || intent.expectedHead !== expectedHead ||
      intent.replacementRunId !== input.replacementRunId || !sameDurableValue(intent.evidenceRefs, evidenceRefs)
    ) throw stateError("idempotency_conflict");
    if (!prior) {
      current = await commitMetadata(this.store, current, this.#id("repository-cleanup-intent"), "cleanup_changed",
        "An exact repository-resource cleanup intent was persisted after operation-specific live preflight.", evidenceRefs, preparedAt,
        (next) => { next.repositoryCleanup = intent; });
    }

    try {
      let latest = asRun(await this.store.readRun(current.runId));
      this.#assertPreparedRun(latest, resource, intent, current.revision);
      if (resource.kind === "read_snapshot") {
        const state = await this.git.readSnapshotState(resource);
        latest = asRun(await this.store.readRun(current.runId));
        this.#assertPreparedRun(latest, resource, intent, current.revision);
        if (state.present) await this.git.removeReadSnapshot(resource, async () => {
          const beforeEffect = asRun(await this.store.readRun(current.runId));
          this.#assertPreparedRun(beforeEffect, resource, intent, current.revision);
        });
        if ((await this.git.readSnapshotState(resource)).present) throw stateError("invalid_transition");
        const completedAt = timestamp(this.#now());
        latest = asRun(await this.store.readRun(current.runId));
        this.#assertPreparedRun(latest, resource, intent);
        current = await commitMetadata(this.store, latest, this.#id("repository-cleanup-complete"), "cleanup_changed",
          "The exact unchanged detached read snapshot was confirmed absent without touching foreign resources.", evidenceRefs, completedAt,
          (next) => { next.repositoryCleanup = { ...intent, status: "completed", updatedAt: completedAt, worktreeRemoved: true, branchRemoved: true }; });
        return { run: current, completed: true, idempotent: false };
      }

      const builder = resource;
      const destructiveDiscard = input.authorization === "discard";
      let state = await this.git.builderResourceState(builder, expectedHead, destructiveDiscard);
      if (await this.git.targetHead(builder) !== observedTargetHead) throw stateError("invalid_transition");
      await this.#assertBuilderAuthorization(latest, input, builder, expectedHead);
      latest = asRun(await this.store.readRun(current.runId));
      this.#assertPreparedRun(latest, resource, intent, current.revision);
      if (state.worktreePresent && intent.worktreeRemoved) throw stateError("invalid_transition");
      if (state.worktreePresent) await this.git.removeBuilderWorktree(builder, expectedHead, destructiveDiscard, async () => {
        const beforeEffect = asRun(await this.store.readRun(current.runId));
        this.#assertPreparedRun(beforeEffect, resource, intent, current.revision);
        if (await this.git.targetHead(builder) !== observedTargetHead) throw stateError("invalid_transition");
        await this.#assertBuilderAuthorization(beforeEffect, input, builder, expectedHead);
      });
      state = await this.git.builderResourceState(builder, expectedHead, destructiveDiscard);
      if (state.worktreePresent) throw stateError("invalid_transition");
      if (!intent.worktreeRemoved) {
        const phaseAt = timestamp(this.#now());
        latest = asRun(await this.store.readRun(current.runId));
        this.#assertPreparedRun(latest, resource, intent);
        intent = { ...intent, status: "worktree_removed", updatedAt: phaseAt, worktreeRemoved: true };
        current = await commitMetadata(this.store, latest, this.#id("repository-worktree-removed"), "cleanup_changed",
          "The exact owned Builder worktree absence was reconciled and the completed destructive phase was persisted.", evidenceRefs, phaseAt,
          (next) => { next.repositoryCleanup = intent; });
      }

      latest = asRun(await this.store.readRun(current.runId));
      this.#assertPreparedRun(latest, resource, intent, current.revision);
      state = await this.git.builderResourceState(builder, expectedHead, destructiveDiscard);
      if (await this.git.targetHead(builder) !== observedTargetHead) throw stateError("invalid_transition");
      await this.#assertBuilderAuthorization(latest, input, builder, expectedHead);
      let retainSupersededBranch = false;
      if (state.branchPresent && input.authorization === "superseded") {
        retainSupersededBranch = !await this.git.assertHeadReachableFromTarget(builder, expectedHead)
          .then(() => true, () => false);
      }
      latest = asRun(await this.store.readRun(current.runId));
      this.#assertPreparedRun(latest, resource, intent, current.revision);
      if (state.branchPresent && intent.branchRemoved) throw stateError("invalid_transition");
      if (state.branchPresent && !retainSupersededBranch) {
        await this.git.removeBuilderBranch(builder, expectedHead, destructiveDiscard, async () => {
          const beforeEffect = asRun(await this.store.readRun(current.runId));
          this.#assertPreparedRun(beforeEffect, resource, intent, current.revision);
          if (await this.git.targetHead(builder) !== observedTargetHead) throw stateError("invalid_transition");
          await this.#assertBuilderAuthorization(beforeEffect, input, builder, expectedHead);
        });
      }
      state = await this.git.builderResourceState(builder, expectedHead, destructiveDiscard);
      if (await this.git.targetHead(builder) !== observedTargetHead) throw stateError("invalid_transition");
      if (state.worktreePresent || (state.branchPresent && !retainSupersededBranch)) throw stateError("invalid_transition");
      const completedAt = timestamp(this.#now());
      latest = asRun(await this.store.readRun(current.runId));
      this.#assertPreparedRun(latest, resource, intent);
      const completionReason = retainSupersededBranch
        ? "The exact superseded Builder worktree was removed; its unmerged branch was safely retained pending separately confirmed discard."
        : "The exact owned Builder worktree and expected-old-object branch were confirmed absent; foreign repository resources were untouched.";
      current = await commitMetadata(this.store, latest, this.#id("repository-cleanup-complete"), "cleanup_changed",
        completionReason, evidenceRefs, completedAt,
        (next) => { next.repositoryCleanup = {
          ...intent, status: "completed", updatedAt: completedAt, worktreeRemoved: true,
          branchRemoved: !state.branchPresent,
          ...(retainSupersededBranch ? { diagnostic: "The superseded unmerged branch remains; exact confirmed discard is required to remove it." } : {}),
        }; });
      return { run: current, completed: true, idempotent: false };
    } catch (error) {
      const failedAt = timestamp(this.#now());
      const latest = asRun(await this.store.readRun(current.runId));
      this.#assertPreparedRun(latest, resource, intent);
      current = await commitMetadata(this.store, latest, this.#id("repository-cleanup-failed"), "diagnostic",
        "Repository cleanup stopped at an exact persisted phase; successful destructive steps will be reconciled rather than repeated.", evidenceRefs, failedAt,
        (next) => { next.repositoryCleanup = { ...intent, status: "failed", updatedAt: failedAt, diagnostic: safeDiagnostic(error) }; });
      return { run: current, completed: false, idempotent: false };
    }
  }
}
