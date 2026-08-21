import type { Static } from "typebox";

import {
  AmendmentSchema,
  BlockerSchema,
  CancellationCheckpointSchema,
  ProgressFrameSchema,
  ResultSchema,
  TaskPacketSchema,
} from "../protocol/contracts.ts";
import { LIMITS, SCHEMA_VERSION } from "../protocol/limits.ts";
import { validateContract } from "../protocol/validate.ts";
import type {
  CapabilityPlane,
  ClaimedRunCapabilities,
  CompanionConfiguration,
  RunCapabilityManager,
} from "../security/capabilities.ts";
import type { RunCapabilityBinding } from "../security/binding.ts";
import { digestJson, sha256 } from "../security/json.ts";
import { redactDiagnostic } from "../security/redaction.ts";
import { stateError } from "../security/errors.ts";
import {
  LifecycleService,
  type RunRecord,
  type RunState,
} from "../orchestration/lifecycle.ts";
import type { HistoryInput } from "../state/store.ts";
import { DurableStateStore } from "../state/store.ts";
import { assertStoredContract } from "../state/contracts.ts";

export type Amendment = Static<typeof AmendmentSchema>;
export type Blocker = Static<typeof BlockerSchema>;
export type CancellationCheckpoint = Static<typeof CancellationCheckpointSchema>;
export type ProgressFrame = Static<typeof ProgressFrameSchema>;
export type RoleResult = Static<typeof ResultSchema>;
export type TaskPacket = Static<typeof TaskPacketSchema>;

export interface CompanionMessageMetadata {
  messageId: string;
  sequence: number;
  expectedRevision: number;
}

export interface CompanionOperationResult {
  run: RunRecord;
  duplicate: boolean;
}

export interface ProgressAcceptance {
  duplicate: boolean;
  rendered: boolean;
  coalesced: boolean;
  frame?: Readonly<ProgressFrame>;
}

export interface AuthoritativeBuilderOutcome {
  repositoryRootDigest: string;
  baseCommit: string;
  headCommit: string;
  commits: readonly string[];
  changedPaths: readonly string[];
  noChange: boolean;
  worktreeClean: boolean;
}

export interface CompanionProtocolOptions {
  now?: () => number;
  onProgress?: (frame: Readonly<ProgressFrame> | undefined) => void;
  onBlocker?: (blocker: Readonly<Blocker>) => void;
  verifyBuilderOutcome?: (
    run: Readonly<RunRecord>,
  ) => Promise<Readonly<AuthoritativeBuilderOutcome>>;
}

const ACTIVE = new Set<RunState>(["starting", "working", "blocked"]);
const TERMINAL = new Set<RunState>(["completed", "failed", "cancelled", "abandoned"]);

type HistoryRecord = {
  operationId: string;
  kind: string;
  payload: Record<string, unknown>;
};

function asRun(value: Record<string, unknown>): RunRecord {
  const validation = validateContract("run", value);
  if (!validation.ok) throw stateError("invalid_record");
  return value as RunRecord;
}

function validateTimestamp(value: string): void {
  if (Number.isNaN(Date.parse(value))) throw stateError("invalid_record");
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function operationId(binding: RunCapabilityBinding, messageId: string): string {
  return `op-${sha256(`${binding.runId}\0${binding.fencingEpoch}\0${messageId}`).slice(0, 40)}`;
}

function eventFor(
  previous: RunRecord,
  next: RunRecord,
  id: string,
  actor: "crewlead" | "companion" | "recovery" | "human",
  type:
    | "state_transition"
    | "amendment_appended"
    | "blocker_opened"
    | "blocker_cleared"
    | "result_committed"
    | "diagnostic",
  reason: string,
  evidenceRefs: readonly string[],
): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: id,
    runId: next.runId,
    sequence: next.revision,
    timestamp: next.updatedAt,
    actor,
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

function evidenceFromResult(result: RoleResult): string[] {
  const values = [
    ...result.durableReferences,
    ...result.deliverables.flatMap((item) => item.references),
    ...result.completionCriteria.flatMap((item) => item.evidenceRefs),
    ...result.validation.flatMap((item) => item.evidenceRefs),
    ...(result.failure?.evidenceRefs ?? []),
  ];
  const bounded = [...new Set(values)].slice(0, LIMITS.listItems);
  return bounded.length > 0 ? bounded : [`result:${result.resultId}`];
}

function exactIds(
  definitions: readonly { id: string; required: boolean }[],
  results: readonly { id: string }[],
): boolean {
  return (
    definitions.length === results.length &&
    unique(results.map((item) => item.id)) &&
    [...definitions.map((item) => item.id)].sort().join("\0") ===
      [...results.map((item) => item.id)].sort().join("\0")
  );
}

function validateResultGates(packet: TaskPacket, result: RoleResult, run: RunRecord): void {
  if (
    result.runId !== run.runId ||
    result.packetId !== packet.packetId ||
    result.role !== run.role ||
    result.roleDetails.role !== result.role ||
    !exactIds(packet.deliverables, result.deliverables) ||
    !exactIds(packet.completionCriteria, result.completionCriteria) ||
    !exactIds(packet.validation, result.validation)
  ) {
    throw stateError("invalid_record");
  }

  for (const definition of packet.deliverables) {
    const item = result.deliverables.find((candidate) => candidate.id === definition.id)!;
    if (result.outcome === "completed" && definition.required && item.status === "not_produced") {
      throw stateError("invalid_transition");
    }
    if (item.status === "produced" && item.references.length === 0) throw stateError("invalid_transition");
    if (item.status !== "produced" && !item.note) throw stateError("invalid_transition");
  }
  for (const definition of packet.completionCriteria) {
    const item = result.completionCriteria.find((candidate) => candidate.id === definition.id)!;
    if (result.outcome === "completed" && definition.required && item.status !== "passed") {
      throw stateError("invalid_transition");
    }
    if (item.status === "passed" && item.evidenceRefs.length === 0) throw stateError("invalid_transition");
    if (item.status !== "passed" && !item.note) throw stateError("invalid_transition");
  }
  for (const definition of packet.validation) {
    const item = result.validation.find((candidate) => candidate.id === definition.id)!;
    if (result.outcome === "completed" && definition.required && item.status !== "passed") {
      throw stateError("invalid_transition");
    }
    if (item.status === "passed" && item.evidenceRefs.length === 0) throw stateError("invalid_transition");
    if (result.outcome === "completed" && item.status === "not_applicable" && definition.required) {
      throw stateError("invalid_transition");
    }
  }

  if (result.outcome === "completed") {
    if (
      run.activeBlockerId !== undefined ||
      result.failure !== undefined ||
      result.unresolvedBlockerIds.length > 0 ||
      result.unresolvedDecisions.length > 0 ||
      result.deliverables.some((item) => item.status === "not_produced") ||
      result.completionCriteria.some((item) => item.status !== "passed") ||
      result.validation.some((item) => item.status === "failed")
    ) {
      throw stateError("invalid_transition");
    }
  } else if (!result.failure || result.failure.evidenceRefs.length === 0) {
    throw stateError("invalid_transition");
  }
}

function progressSafeText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return redactDiagnostic(value).replace(/[^A-Za-z0-9 _.:+-]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, LIMITS.diagnosticLength) || undefined;
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertAuthoritativeBuilderOutcome(
  result: RoleResult,
  evidence: Readonly<AuthoritativeBuilderOutcome>,
): void {
  if (result.role !== "builder" || result.roleDetails.role !== "builder") {
    throw stateError("invalid_record");
  }
  const declared = result.roleDetails;
  if (
    declared.repository.rootDigest !== evidence.repositoryRootDigest ||
    declared.repository.baseCommit !== evidence.baseCommit ||
    declared.repository.headCommit !== evidence.headCommit ||
    !sameOrderedStrings(declared.commits, evidence.commits) ||
    !sameOrderedStrings(declared.changedPaths, evidence.changedPaths) ||
    declared.noChange !== evidence.noChange ||
    declared.worktreeClean !== evidence.worktreeClean ||
    evidence.worktreeClean !== true
  ) {
    throw stateError("invalid_record");
  }
}

export class CompanionProtocol {
  readonly store: DurableStateStore;
  readonly capabilities: RunCapabilityManager;
  readonly binding: Readonly<RunCapabilityBinding>;
  readonly configuration: Readonly<CompanionConfiguration>;

  private readonly tokens: Readonly<ClaimedRunCapabilities>;
  private readonly lifecycle: LifecycleService;
  private readonly now: () => number;
  private readonly onProgress?: CompanionProtocolOptions["onProgress"];
  private readonly onBlocker?: CompanionProtocolOptions["onBlocker"];
  private readonly verifyBuilderOutcome?: CompanionProtocolOptions["verifyBuilderOutcome"];
  private pendingProgress?: Readonly<ProgressFrame>;
  private latestProgress?: Readonly<ProgressFrame>;
  private lastProgressAt = Number.NEGATIVE_INFINITY;

  constructor(
    store: DurableStateStore,
    capabilities: RunCapabilityManager,
    binding: RunCapabilityBinding,
    tokens: ClaimedRunCapabilities,
    configuration: CompanionConfiguration,
    options: CompanionProtocolOptions = {},
  ) {
    const configValidation = validateContract("companionConfiguration", configuration);
    if (!configValidation.ok) throw stateError("invalid_record");
    if (
      configuration.packet.role !== binding.role ||
      configuration.packet.packetId.length < 1 ||
      configuration.sourceCanonicalProjectPath !== binding.canonicalProjectPath
    ) {
      throw stateError("invalid_binding");
    }
    this.store = store;
    this.capabilities = capabilities;
    this.binding = Object.freeze(structuredClone(binding));
    this.tokens = Object.freeze({ ...tokens });
    this.configuration = Object.freeze(structuredClone(configuration));
    this.lifecycle = new LifecycleService(store, {
      maxActiveMembers: LIMITS.maxActiveMembers,
      maxOpenMemberResources: LIMITS.maxOpenMemberResources,
      maxQueuedDelegations: LIMITS.maxQueuedDelegations,
    });
    this.now = options.now ?? Date.now;
    this.onProgress = options.onProgress;
    this.onBlocker = options.onBlocker;
    this.verifyBuilderOutcome = options.verifyBuilderOutcome;
  }

  private async current(): Promise<RunRecord> {
    const run = asRun(await this.store.readRun(this.binding.runId));
    if (
      run.binding.crewleadSessionId !== this.binding.crewleadSessionId ||
      run.binding.memberSessionId !== this.binding.memberSessionId ||
      run.binding.herdrWorkspaceId !== this.binding.herdrWorkspaceId ||
      run.binding.canonicalProjectPath !== this.binding.canonicalProjectPath ||
      run.role !== this.binding.role ||
      run.packetId !== this.configuration.packet.packetId
    ) {
      throw stateError("invalid_binding");
    }
    if (run.fencingEpoch !== this.binding.fencingEpoch) throw stateError("epoch_conflict");
    return run;
  }

  async currentRun(): Promise<RunRecord> {
    return structuredClone(await this.current());
  }

  private async history(): Promise<HistoryRecord[]> {
    return (await this.store.readHistory(this.binding.runId)).map((record) => ({
      operationId: String(record.operationId),
      kind: String(record.kind),
      payload: record.payload as Record<string, unknown>,
    }));
  }

  private async authorize(
    plane: CapabilityPlane,
    meta: CompanionMessageMetadata,
    payload: unknown,
    current: RunRecord,
  ) {
    return this.capabilities.authorizeMessage({
      token: this.tokens[plane],
      plane,
      binding: this.binding as RunCapabilityBinding,
      messageId: meta.messageId,
      sequence: meta.sequence,
      expectedRevision: meta.expectedRevision,
      currentRevision: current.revision,
      payload,
    });
  }

  private async duplicateRun(meta: CompanionMessageMetadata): Promise<RunRecord | undefined> {
    const id = operationId(this.binding as RunCapabilityBinding, meta.messageId);
    return (await this.history()).some((record) => record.operationId === id)
      ? await this.current()
      : undefined;
  }

  private commitSameState(
    current: RunRecord,
    meta: CompanionMessageMetadata,
    actor: "crewlead" | "companion" | "human" | "recovery",
    type: "amendment_appended" | "blocker_opened" | "blocker_cleared" | "diagnostic",
    reason: string,
    timestamp: string,
    extra: readonly HistoryInput[],
    mutate?: (next: RunRecord) => void,
  ) {
    validateTimestamp(timestamp);
    const next = structuredClone(current);
    next.revision += 1;
    next.updatedAt = timestamp;
    mutate?.(next);
    const id = operationId(this.binding as RunCapabilityBinding, meta.messageId);
    return this.store.commitRun({
      operationId: id,
      expectedRevision: current.revision,
      expectedFencingEpoch: current.fencingEpoch,
      run: next,
      history: [
        { kind: "lifecycle", payload: eventFor(current, next, id, actor, type, reason, [],) },
        ...extra,
      ],
    });
  }

  async nextAmendmentSequence(): Promise<number> {
    const values = (await this.history())
      .filter((record) => record.kind === "control" && record.payload.amendmentId !== undefined)
      .map((record) => Number(record.payload.sequence));
    return (values.length === 0 ? 0 : Math.max(...values)) + 1;
  }

  /**
   * Match the non-secret Herdr wake-up prompt to an already committed Crewlead
   * amendment. The prompt carries no authority: only the exact durable record
   * can make it eligible for member context.
   */
  async matchCrewleadAmendmentPrompt(text: string): Promise<Readonly<Amendment> | undefined> {
    if (Buffer.byteLength(text, "utf8") > LIMITS.amendmentTextLength + 512) return undefined;
    const match = /^DB11 Crew authenticated amendment ([A-Za-z0-9][A-Za-z0-9._:-]*) \(sequence ([1-9][0-9]*)\)\.\nApply it only within the immutable task objective, role, permissions, and scope\. Block if it would widen them\.\n\n([\s\S]+)$/u.exec(text);
    if (!match) return undefined;
    const amendment = (await this.history())
      .filter((record) => record.kind === "control")
      .map((record) => record.payload)
      .find((payload) => payload.amendmentId === match[1]) as unknown as Amendment | undefined;
    if (!amendment || !validateContract("amendment", amendment).ok) return undefined;
    if (
      amendment.runId !== this.binding.runId ||
      (amendment.author !== "crewlead" && amendment.author !== "recovery") ||
      amendment.sequence !== Number(match[2]) ||
      amendment.summary !== match[3]
    ) {
      return undefined;
    }
    return Object.freeze(structuredClone(amendment));
  }

  async appendAmendment(meta: CompanionMessageMetadata, amendmentValue: unknown): Promise<CompanionOperationResult> {
    const validation = validateContract("amendment", amendmentValue);
    if (!validation.ok) throw stateError(validation.error.code === "oversized" ? "oversized" : "invalid_record");
    const amendment = validation.value as Amendment;
    const current = await this.current();
    if (!ACTIVE.has(current.state)) throw stateError("terminal_immutable");
    if (amendment.runId !== current.runId || amendment.expectedRevision !== meta.expectedRevision) {
      throw stateError("revision_conflict");
    }
    if (amendment.expectedRevision !== current.revision) {
      const replay = await this.authorize("control", meta, amendment, current);
      if (replay.duplicate) {
        const run = await this.duplicateRun(meta);
        if (run) return { run, duplicate: true };
      }
      throw stateError("revision_conflict");
    }
    if (amendment.sequence !== await this.nextAmendmentSequence()) throw stateError("stale_sequence");
    const authorization = await this.authorize("control", meta, amendment, current);
    if (authorization.duplicate) {
      const run = await this.duplicateRun(meta);
      if (run) return { run, duplicate: true };
    }
    const result = await this.commitSameState(
      current,
      meta,
      amendment.author as "human" | "crewlead" | "recovery",
      "amendment_appended",
      "An ordered same-task amendment was authenticated and appended.",
      amendment.timestamp,
      [{ kind: "control", payload: amendment }],
    );
    return { run: asRun(result.run), duplicate: result.idempotent };
  }

  private async latestBlocker(blockerId?: string): Promise<Blocker | undefined> {
    const blockers = (await this.history())
      .filter((record) => record.kind === "control" && record.payload.blockerId !== undefined)
      .map((record) => record.payload as unknown as Blocker)
      .filter((blocker) => blockerId === undefined || blocker.blockerId === blockerId)
      .sort((left, right) => left.blockerRevision - right.blockerRevision);
    return blockers.at(-1);
  }

  async recordBlocker(meta: CompanionMessageMetadata, blockerValue: unknown): Promise<CompanionOperationResult> {
    const validation = validateContract("blocker", blockerValue);
    if (!validation.ok) throw stateError(validation.error.code === "oversized" ? "oversized" : "invalid_record");
    const blocker = validation.value as Blocker;
    const current = await this.current();
    if (!ACTIVE.has(current.state)) throw stateError("terminal_immutable");
    if (blocker.runId !== current.runId || blocker.expectedRevision !== meta.expectedRevision) {
      throw stateError("revision_conflict");
    }
    if (blocker.recommendedOptionId && !blocker.options.some((option) => option.id === blocker.recommendedOptionId)) {
      throw stateError("invalid_record");
    }
    const prior = await this.latestBlocker(blocker.blockerId);
    if (
      prior &&
      blocker.blockerRevision === prior.blockerRevision &&
      meta.expectedRevision !== current.revision
    ) {
      const replay = await this.authorize("finalization", meta, blocker, current);
      if (replay.duplicate) {
        const run = await this.duplicateRun(meta);
        if (run) return { run, duplicate: true };
      }
      throw stateError("revision_conflict");
    }
    if (meta.expectedRevision !== current.revision) throw stateError("revision_conflict");
    const opening = blocker.status === "open" && prior === undefined;
    const revising = blocker.status === "open" && prior?.status === "open";
    const clearing = blocker.status === "cleared" && prior?.status === "open";
    if (
      (opening && (current.state !== "working" || blocker.blockerRevision !== 1 || current.activeBlockerId !== undefined)) ||
      (revising && (current.state !== "blocked" || current.activeBlockerId !== blocker.blockerId || blocker.blockerRevision !== prior!.blockerRevision + 1)) ||
      (clearing && (current.state !== "blocked" || current.activeBlockerId !== blocker.blockerId || blocker.blockerRevision !== prior!.blockerRevision + 1)) ||
      (!opening && !revising && !clearing)
    ) {
      throw stateError("invalid_transition");
    }
    const authorization = await this.authorize("finalization", meta, blocker, current);
    if (authorization.duplicate) {
      const run = await this.duplicateRun(meta);
      if (run) return { run, duplicate: true };
    }
    const result = await this.commitSameState(
      current,
      meta,
      "companion",
      clearing ? "blocker_cleared" : "blocker_opened",
      clearing
        ? "The authenticated member explicitly cleared the current blocker revision."
        : revising
          ? "The authenticated member revised the current durable blocker."
          : "The authenticated member created a durable blocker before yielding.",
      new Date(this.now()).toISOString(),
      [{ kind: "control", payload: blocker }],
      (next) => {
        if (clearing) {
          next.state = "working";
          delete next.activeBlockerId;
        } else {
          next.state = "blocked";
          next.activeBlockerId = blocker.blockerId;
        }
      },
    );
    if (!clearing) this.onBlocker?.(Object.freeze(structuredClone(blocker)));
    return { run: asRun(result.run), duplicate: result.idempotent };
  }

  private async activeCancellation(): Promise<Record<string, unknown> | undefined> {
    const controls = (await this.history())
      .filter((record) => record.kind === "control" && record.payload.type !== undefined)
      .map((record) => record.payload);
    const request = controls.filter((payload) => payload.type === "cancel_requested").at(-1);
    if (!request) return undefined;
    const acknowledged = controls.some(
      (payload) => payload.type === "cancel_acknowledged" && payload.controlId === request.controlId,
    );
    return acknowledged ? undefined : request;
  }

  async finalize(meta: CompanionMessageMetadata, resultValue: unknown): Promise<CompanionOperationResult> {
    const validation = validateContract("result", resultValue);
    if (!validation.ok) throw stateError(validation.error.code === "oversized" ? "oversized" : "invalid_record");
    const result = validation.value as RoleResult;
    let current = await this.current();
    if (TERMINAL.has(current.state)) {
      const same = current.resultId === result.resultId && current.resultDigest === digestJson(result, LIMITS.resultBytes);
      if (!same) throw stateError(current.resultId === result.resultId ? "idempotency_conflict" : "terminal_immutable");
      const authorization = await this.authorize("finalization", meta, result, current);
      if (!authorization.duplicate) throw stateError("terminal_immutable");
      return { run: current, duplicate: true };
    }
    if (meta.expectedRevision !== current.revision || await this.activeCancellation()) {
      throw stateError("revision_conflict");
    }
    validateResultGates(this.configuration.packet as TaskPacket, result, current);
    const authorization = await this.authorize("finalization", meta, result, current);
    if (authorization.duplicate) {
      const duplicate = await this.duplicateRun(meta);
      if (duplicate) return { run: duplicate, duplicate: true };
      current = await this.current();
    }
    if (result.outcome === "completed" && result.role === "builder") {
      if (!this.verifyBuilderOutcome) throw stateError("invalid_binding");
      const evidence = await this.verifyBuilderOutcome(Object.freeze(structuredClone(current)));
      assertAuthoritativeBuilderOutcome(result, evidence);
      const latest = await this.current();
      if (latest.revision !== current.revision) throw stateError("revision_conflict");
      if (latest.fencingEpoch !== current.fencingEpoch) throw stateError("epoch_conflict");
      if (!ACTIVE.has(latest.state)) throw stateError("invalid_transition");
      current = latest;
    }
    const committed = await this.lifecycle.transition({
      operationId: operationId(this.binding as RunCapabilityBinding, meta.messageId),
      runId: current.runId,
      expectedRevision: current.revision,
      expectedFencingEpoch: current.fencingEpoch,
      actor: "companion",
      targetState: result.outcome as "completed" | "failed",
      reason: result.outcome === "completed"
        ? "The authenticated companion committed the structurally gated immutable result."
        : "The authenticated companion committed the structurally gated member-declared failure.",
      evidenceRefs: evidenceFromResult(result),
      timestamp: new Date(this.now()).toISOString(),
      result,
    });
    this.clearProgress("terminal");
    return { run: committed, duplicate: false };
  }

  async nextSequence(plane: CapabilityPlane): Promise<number> {
    return this.capabilities.nextSequence(
      this.tokens[plane],
      plane,
      this.binding as RunCapabilityBinding,
    );
  }

  async acceptProgress(frameValue: unknown): Promise<ProgressAcceptance> {
    const validation = validateContract("progressFrame", frameValue);
    if (!validation.ok) throw stateError(validation.error.code === "oversized" ? "oversized" : "invalid_record");
    const frame = validation.value as ProgressFrame;
    const current = await this.current();
    if (
      frame.runId !== current.runId ||
      frame.fencingEpoch !== current.fencingEpoch ||
      TERMINAL.has(current.state)
    ) {
      throw stateError(TERMINAL.has(current.state) ? "terminal_immutable" : "epoch_conflict");
    }
    const authorization = await this.authorize(
      "progress",
      { messageId: frame.progressId, sequence: frame.sequence, expectedRevision: current.revision },
      frame,
      current,
    );
    if (authorization.duplicate) return { duplicate: true, rendered: false, coalesced: false };
    const sanitized = Object.freeze({
      ...structuredClone(frame),
      ...(frame.phase === undefined ? {} : { phase: progressSafeText(frame.phase) }),
      ...(frame.summary === undefined ? {} : { summary: progressSafeText(frame.summary) }),
    }) as Readonly<ProgressFrame>;
    const now = this.now();
    if (now - this.lastProgressAt < LIMITS.progressCoalesceMilliseconds) {
      this.pendingProgress = sanitized;
      return { duplicate: false, rendered: false, coalesced: true, frame: sanitized };
    }
    this.latestProgress = sanitized;
    this.lastProgressAt = now;
    this.onProgress?.(sanitized);
    return { duplicate: false, rendered: true, coalesced: false, frame: sanitized };
  }

  flushProgress(): Readonly<ProgressFrame> | undefined {
    if (!this.pendingProgress || this.now() - this.lastProgressAt < LIMITS.progressCoalesceMilliseconds) {
      return undefined;
    }
    this.latestProgress = this.pendingProgress;
    this.pendingProgress = undefined;
    this.lastProgressAt = this.now();
    this.onProgress?.(this.latestProgress);
    return this.latestProgress;
  }

  progressSnapshot(): Readonly<ProgressFrame> | undefined {
    return this.latestProgress;
  }

  clearProgress(_reason: "terminal" | "cancelled" | "invalidated" | "replacement" | "shutdown"): void {
    this.pendingProgress = undefined;
    this.latestProgress = undefined;
    this.lastProgressAt = Number.NEGATIVE_INFINITY;
    this.onProgress?.(undefined);
  }

  async requestCancellation(
    meta: CompanionMessageMetadata,
    input: { controlId: string; reason: string; evidenceRefs: readonly string[]; timestamp: string },
  ): Promise<CompanionOperationResult> {
    const current = await this.current();
    if (!ACTIVE.has(current.state)) throw stateError("terminal_immutable");
    const action = {
      schemaVersion: SCHEMA_VERSION,
      controlId: input.controlId,
      runId: current.runId,
      type: "cancel_requested",
      actor: "crewlead",
      reason: input.reason,
      expectedRevision: meta.expectedRevision,
      fencingEpoch: current.fencingEpoch,
      timestamp: input.timestamp,
      evidenceRefs: [...input.evidenceRefs],
    };
    assertStoredContract("controlAction", action);
    const pending = await this.activeCancellation();
    if (meta.expectedRevision !== current.revision || pending) {
      const replay = await this.authorize("control", meta, action, current);
      if (replay.duplicate && pending?.controlId === input.controlId) {
        const run = await this.duplicateRun(meta);
        if (run) return { run, duplicate: true };
      }
      throw stateError("revision_conflict");
    }
    const authorization = await this.authorize("control", meta, action, current);
    if (authorization.duplicate) {
      const run = await this.duplicateRun(meta);
      if (run) return { run, duplicate: true };
    }
    const committed = await this.commitSameState(
      current,
      meta,
      "crewlead",
      "diagnostic",
      "A graceful single-run cancellation request was durably recorded before action.",
      input.timestamp,
      [{ kind: "control", payload: action }],
    );
    return { run: asRun(committed.run), duplicate: committed.idempotent };
  }

  async pendingCancellation(): Promise<{ controlId: string; revision: number } | undefined> {
    const current = await this.current();
    const request = await this.activeCancellation();
    return request ? { controlId: String(request.controlId), revision: current.revision } : undefined;
  }

  async acknowledgeCancellation(
    meta: CompanionMessageMetadata,
    checkpointValue: unknown,
    control: { abort: () => void | Promise<void>; settled: () => boolean | Promise<boolean> },
  ): Promise<CompanionOperationResult> {
    const validation = validateContract("cancellationCheckpoint", checkpointValue);
    if (!validation.ok) throw stateError(validation.error.code === "oversized" ? "oversized" : "invalid_record");
    const checkpoint = validation.value as CancellationCheckpoint;
    let current = await this.current();
    if (current.state === "cancelled") {
      const authorization = await this.authorize("control", meta, checkpoint, current);
      if (!authorization.duplicate) throw stateError("terminal_immutable");
      return { run: current, duplicate: true };
    }
    if (!ACTIVE.has(current.state) || meta.expectedRevision !== current.revision) throw stateError("revision_conflict");
    const request = await this.activeCancellation();
    if (
      !request ||
      checkpoint.cancelRequestId !== request.controlId ||
      checkpoint.runId !== current.runId ||
      checkpoint.expectedRevision !== current.revision ||
      checkpoint.fencingEpoch !== current.fencingEpoch
    ) {
      throw stateError("invalid_transition");
    }
    const authorization = await this.authorize("control", meta, checkpoint, current);
    await control.abort();
    if (!await control.settled()) throw stateError("invalid_transition");
    if (authorization.duplicate) {
      const duplicate = await this.duplicateRun(meta);
      if (duplicate) return { run: duplicate, duplicate: true };
      current = await this.current();
    }
    const next = structuredClone(current);
    next.state = "cancelled";
    next.revision += 1;
    next.updatedAt = checkpoint.timestamp;
    if (next.resourceDisposition === "open") next.resourceDisposition = "retained";
    const id = operationId(this.binding as RunCapabilityBinding, meta.messageId);
    const committed = await this.store.commitRun({
      operationId: id,
      expectedRevision: current.revision,
      expectedFencingEpoch: current.fencingEpoch,
      run: next,
      history: [
        {
          kind: "lifecycle",
          payload: eventFor(
            current,
            next,
            id,
            "companion",
            "state_transition",
            "The authenticated companion acknowledged graceful cancellation after Pi settled and committed a bounded checkpoint.",
            checkpoint.retainedArtifacts,
          ),
        },
        { kind: "control", payload: checkpoint },
      ],
    });
    this.clearProgress("cancelled");
    return { run: asRun(committed.run), duplicate: committed.idempotent };
  }
}
