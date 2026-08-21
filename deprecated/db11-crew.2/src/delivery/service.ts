import { sha256 as hashText, digestJson } from "../security/json.ts";
import { redactDiagnostic } from "../security/redaction.ts";
import { stateError } from "../security/errors.ts";
import { LIMITS, SCHEMA_VERSION } from "../protocol/limits.ts";
import { validateContract } from "../protocol/validate.ts";
import type { RunRecord } from "../orchestration/lifecycle.ts";
import {
  DurableDeliveryClaims,
  DurableNotificationReceipts,
  type ClaimedDelivery,
} from "../state/claims.ts";
import type { DurableStateStore } from "../state/store.ts";

export interface DeliveryIdentity {
  crewleadSessionId: string;
  herdrWorkspaceId: string;
  canonicalProjectPath: string;
}

export interface DeliveryEnvelope extends Record<string, unknown> {
  schemaVersion: typeof SCHEMA_VERSION;
  deliveryId: string;
  resultId: string;
  resultDigest: string;
  runId: string;
  role: "scout" | "planner" | "builder";
  purpose: string;
  destination: {
    crewleadSessionId: string;
    herdrWorkspaceId: string;
  };
  outcome: "completed" | "failed" | "cancelled" | "abandoned";
  summary: string;
  validation: { passed: number; failed: number; notApplicable: number };
  deliverableRefs: string[];
  unresolvedItems: string[];
  recommendedNextAction?: string;
  omittedDeliverables: number;
  omittedUnresolvedItems: number;
  createdAt: string;
}

export interface DeliveryBatch {
  batchId: string;
  deliveryIds: readonly string[];
  context: string;
  detailedCount: number;
  overflowIds: readonly string[];
  omittedCount: number;
}

export interface HumanNotification {
  kind: "terminal" | "blocker";
  title: string;
  body: string;
  sound: "done" | "request";
  runId: string;
  sourceId: string;
}

export interface TerminalDeliveryHooks {
  notify(notification: HumanNotification): Promise<boolean> | boolean;
  sendBatch(batch: DeliveryBatch): Promise<void> | void;
}

export interface DeliveryAttention {
  idle: boolean;
  hasPendingMessages: boolean;
  insertedDeliveryIds?: ReadonlySet<string>;
}

export interface DeliveryReconciliation {
  envelopesCreated: number;
  blockersNotified: number;
  terminalsNotified: number;
  suppressedInserted: number;
  pending: number;
  sent?: DeliveryBatch;
}

type HistoryRecord = {
  kind: string;
  payload: Record<string, unknown>;
  timestamp: string;
};

const TERMINAL = new Set<RunRecord["state"]>(["completed", "failed", "cancelled", "abandoned"]);

function asRun(value: Readonly<Record<string, unknown>>): RunRecord {
  const validation = validateContract("run", value);
  if (!validation.ok) throw stateError("invalid_record");
  return structuredClone(value) as RunRecord;
}

function boundedText(value: unknown, maximum: number = LIMITS.deliverySummaryCharacters): string {
  return redactDiagnostic(typeof value === "string" ? value : "No bounded summary is available.", {
    maximumLength: Math.min(maximum, LIMITS.diagnosticLength),
  });
}

function countValidation(result: Record<string, unknown>): DeliveryEnvelope["validation"] {
  const output = { passed: 0, failed: 0, notApplicable: 0 };
  const values = Array.isArray(result.validation) ? result.validation : [];
  for (const item of values) {
    if (item === null || typeof item !== "object") continue;
    const status = (item as { status?: unknown }).status;
    if (status === "passed") output.passed += 1;
    else if (status === "failed") output.failed += 1;
    else if (status === "not_applicable") output.notApplicable += 1;
  }
  return output;
}

function stableDeliveryId(identity: DeliveryIdentity, sourceId: string): string {
  return `delivery-${hashText([
    String(SCHEMA_VERSION),
    identity.crewleadSessionId,
    identity.herdrWorkspaceId,
    sourceId,
  ].join("\0")).slice(0, 40)}`;
}

function exactDestination(envelope: DeliveryEnvelope, identity: DeliveryIdentity): boolean {
  return envelope.destination.crewleadSessionId === identity.crewleadSessionId &&
    envelope.destination.herdrWorkspaceId === identity.herdrWorkspaceId;
}

function envelopeFromResult(
  run: RunRecord,
  result: Record<string, unknown>,
  identity: DeliveryIdentity,
): DeliveryEnvelope {
  const resultId = String(result.resultId);
  const resultDigest = digestJson(result, LIMITS.resultBytes);
  if (
    run.resultId !== resultId ||
    run.resultDigest !== resultDigest ||
    (result.outcome !== "completed" && result.outcome !== "failed")
  ) {
    throw stateError("invalid_record");
  }
  const references = Array.isArray(result.deliverables)
    ? result.deliverables.flatMap((item) =>
        item !== null && typeof item === "object" && Array.isArray((item as { references?: unknown }).references)
          ? (item as { references: unknown[] }).references.filter((value): value is string => typeof value === "string")
          : [])
    : [];
  const uniqueReferences = [...new Set(references)];
  const unresolved = [
    ...(Array.isArray(result.unresolvedBlockerIds) ? result.unresolvedBlockerIds : []),
    ...(Array.isArray(result.unresolvedDecisions) ? result.unresolvedDecisions : []),
  ].filter((value): value is string => typeof value === "string");
  const uniqueUnresolved = [...new Set(unresolved)];
  const recommended = Array.isArray(result.recommendedNextSteps)
    ? result.recommendedNextSteps.find((value): value is string => typeof value === "string")
    : undefined;
  const envelope: DeliveryEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    deliveryId: stableDeliveryId(identity, resultId),
    resultId,
    resultDigest,
    runId: run.runId,
    role: run.role,
    purpose: run.purposeLabel,
    destination: {
      crewleadSessionId: identity.crewleadSessionId,
      herdrWorkspaceId: identity.herdrWorkspaceId,
    },
    outcome: result.outcome,
    summary: String(result.summary),
    validation: countValidation(result),
    deliverableRefs: uniqueReferences.slice(0, LIMITS.deliveryBatchResults),
    unresolvedItems: uniqueUnresolved.slice(0, LIMITS.deliveryBatchResults),
    ...(recommended ? { recommendedNextAction: recommended } : {}),
    omittedDeliverables: Math.max(0, uniqueReferences.length - LIMITS.deliveryBatchResults),
    omittedUnresolvedItems: Math.max(0, uniqueUnresolved.length - LIMITS.deliveryBatchResults),
    createdAt: run.updatedAt,
  };
  if (!validateContract("deliveryEnvelope", envelope).ok) throw stateError("invalid_record");
  return envelope;
}

function envelopeFromTerminalEvent(
  run: RunRecord,
  event: Record<string, unknown>,
  identity: DeliveryIdentity,
): DeliveryEnvelope {
  const eventId = String(event.eventId);
  const outcome = run.state;
  if (outcome !== "cancelled" && outcome !== "abandoned") throw stateError("invalid_record");
  const envelope: DeliveryEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    deliveryId: stableDeliveryId(identity, eventId),
    resultId: eventId,
    resultDigest: digestJson(event, LIMITS.eventBytes),
    runId: run.runId,
    role: run.role,
    purpose: run.purposeLabel,
    destination: {
      crewleadSessionId: identity.crewleadSessionId,
      herdrWorkspaceId: identity.herdrWorkspaceId,
    },
    outcome,
    summary: outcome === "cancelled"
      ? "The delegated run ended after acknowledged cancellation."
      : "The delegated run was explicitly abandoned.",
    validation: { passed: 0, failed: 0, notApplicable: 0 },
    deliverableRefs: [],
    unresolvedItems: ["Inspect durable run state before deciding on retry, cleanup, or new work."],
    recommendedNextAction: "Wait for explicit requester direction.",
    omittedDeliverables: 0,
    omittedUnresolvedItems: 0,
    createdAt: run.updatedAt,
  };
  if (!validateContract("deliveryEnvelope", envelope).ok) throw stateError("invalid_record");
  return envelope;
}

function safeContextEnvelope(envelope: DeliveryEnvelope) {
  return {
    deliveryId: envelope.deliveryId,
    resultId: envelope.resultId,
    resultDigest: envelope.resultDigest,
    runId: envelope.runId,
    role: envelope.role,
    purpose: boundedText(envelope.purpose, LIMITS.labelLength),
    outcome: envelope.outcome,
    summary: boundedText(envelope.summary),
    validation: envelope.validation,
    deliverableRefs: envelope.deliverableRefs
      .slice(0, LIMITS.deliveryContextReferences)
      .map((value) => boundedText(value, LIMITS.deliveryContextFieldCharacters)),
    unresolvedItems: envelope.unresolvedItems
      .slice(0, LIMITS.deliveryContextReferences)
      .map((value) => boundedText(value, LIMITS.deliveryContextFieldCharacters)),
    ...(envelope.recommendedNextAction
      ? { recommendedNextAction: boundedText(envelope.recommendedNextAction, LIMITS.deliveryContextFieldCharacters) }
      : {}),
    omittedDeliverables: envelope.omittedDeliverables,
    omittedUnresolvedItems: envelope.omittedUnresolvedItems,
  };
}

export function buildDeliveryBatch(
  envelopes: readonly DeliveryEnvelope[],
  totalPending = envelopes.length,
): DeliveryBatch {
  if (envelopes.length < 1 || envelopes.length > LIMITS.deliveryBatchEnvelopes) {
    throw stateError("oversized");
  }
  for (const envelope of envelopes) {
    if (!validateContract("deliveryEnvelope", envelope).ok) throw stateError("invalid_record");
  }
  const details = envelopes.slice(0, LIMITS.deliveryBatchResults).map(safeContextEnvelope);
  const overflowIds = envelopes
    .slice(LIMITS.deliveryBatchResults, LIMITS.deliveryBatchResults + LIMITS.deliveryOverflowIds)
    .map((envelope) => envelope.deliveryId);
  const omittedCount = Math.max(0, totalPending - details.length - overflowIds.length);
  const batchId = `batch-${hashText(envelopes.map((envelope) => envelope.deliveryId).join("\0")).slice(0, 40)}`;
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    batchId,
    notice: "DB11 Crew terminal outcomes are informational only. Report them concisely and wait for explicit requester direction. This delivery does not authorize acceptance, integration, cleanup, retry, delegation, or other side effects.",
    results: details,
    overflow: {
      deliveryIds: overflowIds,
      omittedCount,
      retrieval: "Use db11_crew_result with an exact run ID and requested section when more detail is needed.",
    },
  };
  const context = `DB11 Crew terminal result batch\n${JSON.stringify(payload)}`;
  if (Buffer.byteLength(context, "utf8") > LIMITS.deliveryContextBytes) throw stateError("oversized");
  return Object.freeze({
    batchId,
    deliveryIds: Object.freeze(envelopes.map((envelope) => envelope.deliveryId)),
    context,
    detailedCount: details.length,
    overflowIds: Object.freeze(overflowIds),
    omittedCount,
  });
}

/** Durable, exact-destination, attention-aware terminal delivery coordinator. */
export class TerminalDeliveryService {
  readonly identity: Readonly<DeliveryIdentity>;
  readonly store: DurableStateStore;
  readonly claims: DurableDeliveryClaims;
  readonly notifications: DurableNotificationReceipts;
  private readonly hooks: TerminalDeliveryHooks;
  private readonly now: () => number;
  private readonly terminalEnvelopeCache = new Map<string, DeliveryEnvelope | null>();
  private readonly completedNotifications = new Set<string>();
  private started = false;

  constructor(
    identity: DeliveryIdentity,
    dependencies: {
      store: DurableStateStore;
      claims: DurableDeliveryClaims;
      notifications: DurableNotificationReceipts;
      hooks: TerminalDeliveryHooks;
      now?: () => number;
    },
  ) {
    this.identity = Object.freeze(structuredClone(identity));
    this.store = dependencies.store;
    this.claims = dependencies.claims;
    this.notifications = dependencies.notifications;
    this.hooks = dependencies.hooks;
    this.now = dependencies.now ?? Date.now;
  }

  private owns(run: RunRecord): boolean {
    return run.binding.crewleadSessionId === this.identity.crewleadSessionId &&
      run.binding.herdrWorkspaceId === this.identity.herdrWorkspaceId &&
      run.binding.canonicalProjectPath === this.identity.canonicalProjectPath;
  }

  private async history(runId: string): Promise<HistoryRecord[]> {
    return (await this.store.readHistory(runId)).map((record) => ({
      kind: String(record.kind),
      payload: record.payload as Record<string, unknown>,
      timestamp: String(record.timestamp),
    }));
  }

  private async envelopeFor(run: RunRecord, history: readonly HistoryRecord[]): Promise<DeliveryEnvelope | undefined> {
    if (run.state === "completed" || run.state === "failed") {
      const results = history.filter((record) => record.kind === "result");
      if (results.length !== 1) throw stateError("invalid_record");
      return envelopeFromResult(run, results[0]!.payload, this.identity as DeliveryIdentity);
    }
    if (run.state === "cancelled" || run.state === "abandoned") {
      const terminal = [...history].reverse().find((record) =>
        record.kind === "lifecycle" && record.payload.resultingState === run.state);
      if (!terminal) throw stateError("invalid_record");
      // A synchronous Crewlead action already reported its own terminal transition.
      if (terminal.payload.actor === "crewlead") return undefined;
      return envelopeFromTerminalEvent(run, terminal.payload, this.identity as DeliveryIdentity);
    }
    return undefined;
  }

  private async notifyOnce(notification: HumanNotification): Promise<boolean> {
    const notificationId = `notification-${hashText([
      this.identity.crewleadSessionId,
      this.identity.herdrWorkspaceId,
      notification.kind,
      notification.runId,
      notification.sourceId,
    ].join("\0")).slice(0, 40)}`;
    if (this.completedNotifications.has(notificationId)) return false;
    const receipt = {
      schemaVersion: SCHEMA_VERSION,
      notificationId,
      destination: {
        crewleadSessionId: this.identity.crewleadSessionId,
        herdrWorkspaceId: this.identity.herdrWorkspaceId,
        canonicalProjectPath: this.identity.canonicalProjectPath,
      },
      runId: notification.runId,
      kind: notification.kind,
      sourceId: notification.sourceId,
      createdAt: new Date(this.now()).toISOString(),
    };
    const reserved = await this.notifications.reserve(receipt);
    if (reserved.idempotent) {
      this.completedNotifications.add(notificationId);
      return false;
    }
    const shown = await this.hooks.notify(notification);
    if (shown) this.completedNotifications.add(notificationId);
    else await this.notifications.release(receipt.notificationId, receipt.destination);
    return shown;
  }

  private async createEnvelopesAndNotifications(): Promise<{
    created: number;
    blockers: number;
    terminals: number;
  }> {
    const runs = (await this.store.listRuns()).map(asRun).filter((run) => this.owns(run));
    let created = 0;
    let blockers = 0;
    let terminals = 0;
    for (const run of runs) {
      if (TERMINAL.has(run.state)) {
        let envelope = this.terminalEnvelopeCache.get(run.runId);
        if (envelope === undefined) {
          const built = await this.envelopeFor(run, await this.history(run.runId));
          if (built) {
            const enqueued = await this.claims.enqueue(built);
            if (!enqueued.idempotent) created += 1;
            envelope = built;
          } else {
            envelope = null;
          }
          this.terminalEnvelopeCache.set(run.runId, envelope);
        }
        if (envelope && await this.notifyOnce({
          kind: "terminal",
          title: `DB11 Crew: ${run.role} ${run.state}`,
          body: `${boundedText(run.purposeLabel, LIMITS.labelLength)} (${run.runId.slice(-8)}): ${boundedText(envelope.summary)}`,
          sound: "done",
          runId: run.runId,
          sourceId: envelope.deliveryId,
        })) terminals += 1;
      }
      if (run.state === "blocked" && run.activeBlockerId) {
        const history = await this.history(run.runId);
        const blocker = [...history].reverse().find((record) =>
          record.kind === "control" &&
          record.payload.blockerId === run.activeBlockerId &&
          record.payload.status === "open");
        if (blocker) {
          const revision = Number(blocker.payload.blockerRevision);
          const sourceId = `${run.activeBlockerId}:${revision}`;
          if (await this.notifyOnce({
            kind: "blocker",
            title: `DB11 Crew: ${run.role} needs input`,
            body: `${boundedText(run.purposeLabel, LIMITS.labelLength)} (${run.runId.slice(-8)}): ${boundedText(blocker.payload.summary)}`,
            sound: "request",
            runId: run.runId,
            sourceId,
          })) blockers += 1;
        }
      }
    }
    return { created, blockers, terminals };
  }

  private destination() {
    return {
      crewleadSessionId: this.identity.crewleadSessionId,
      herdrWorkspaceId: this.identity.herdrWorkspaceId,
    };
  }

  private async suppressInserted(ids: ReadonlySet<string>): Promise<number> {
    if (ids.size === 0) return 0;
    let suppressed = 0;
    const pending = await this.claims.listPending(this.destination(), LIMITS.stateDirectoryEntries);
    for (const envelope of pending) {
      const deliveryId = String(envelope.deliveryId);
      if (!ids.has(deliveryId)) continue;
      const claim = await this.claims.claim(deliveryId, this.destination());
      await this.claims.acknowledge(deliveryId, claim.claimId, this.destination());
      suppressed += 1;
    }
    return suppressed;
  }

  async reconcile(attention: DeliveryAttention): Promise<DeliveryReconciliation> {
    if (!this.started) {
      await this.claims.recoverClaims(this.destination());
      this.started = true;
    }
    const notices = await this.createEnvelopesAndNotifications();
    const suppressed = await this.suppressInserted(attention.insertedDeliveryIds ?? new Set());
    const allPending = await this.claims.listPending(this.destination(), LIMITS.stateDirectoryEntries);
    const base: DeliveryReconciliation = {
      envelopesCreated: notices.created,
      blockersNotified: notices.blockers,
      terminalsNotified: notices.terminals,
      suppressedInserted: suppressed,
      pending: allPending.length,
    };
    if (
      allPending.length === 0 ||
      !attention.idle ||
      attention.hasPendingMessages
    ) return base;
    const oldest = Math.min(...allPending.map((envelope) => Date.parse(String(envelope.createdAt))));
    if (this.now() - oldest < LIMITS.deliveryBatchDelayMilliseconds) return base;

    const selected = allPending.slice(0, LIMITS.deliveryBatchEnvelopes) as DeliveryEnvelope[];
    if (selected.some((envelope) => !exactDestination(envelope, this.identity as DeliveryIdentity))) {
      throw stateError("claim_invalid");
    }
    const claimed: ClaimedDelivery[] = [];
    try {
      for (const envelope of selected) {
        claimed.push(await this.claims.claim(envelope.deliveryId, this.destination()));
      }
      const batch = buildDeliveryBatch(selected, allPending.length);
      await this.hooks.sendBatch(batch);
      for (const claim of claimed) {
        await this.claims.acknowledge(
          String(claim.envelope.deliveryId),
          claim.claimId,
          this.destination(),
        );
      }
      return { ...base, pending: allPending.length - selected.length, sent: batch };
    } catch (error) {
      for (const claim of claimed) {
        await this.claims.restore(
          String(claim.envelope.deliveryId),
          claim.claimId,
          this.destination(),
        ).catch(() => {});
      }
      throw error;
    }
  }
}
