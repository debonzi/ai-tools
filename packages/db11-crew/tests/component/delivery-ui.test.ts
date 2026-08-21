import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  FakeHerdrAdapter,
  type HerdrSnapshot,
} from "../../src/adapters/herdr/contracts.ts";
import {
  buildDeliveryBatch,
  TerminalDeliveryService,
  type DeliveryBatch,
  type DeliveryEnvelope,
  type DeliveryIdentity,
  type HumanNotification,
} from "../../src/delivery/service.ts";
import { TransientProgressQueue } from "../../src/delivery/transient.ts";
import { selectResultSection } from "../../src/crewlead/runtime.ts";
import { LifecycleService, type RunRecord } from "../../src/orchestration/lifecycle.ts";
import { LIMITS } from "../../src/protocol/limits.ts";
import { digestJson } from "../../src/security/json.ts";
import {
  DurableDeliveryClaims,
  DurableNotificationReceipts,
} from "../../src/state/claims.ts";
import { DurableStateStore } from "../../src/state/store.ts";
import { SecureStateRoot } from "../../src/state/filesystem.ts";
import {
  CrewObservabilityService,
  CrewleadUIController,
} from "../../src/ui/observability.ts";
import { temporaryAccountHome } from "../security/helpers.ts";

const createdAt = "2026-08-18T12:00:00.000Z";
const workingAt = "2026-08-18T12:00:01.000Z";
const terminalAt = "2026-08-18T12:00:02.000Z";

function herdrSnapshot(project: string): HerdrSnapshot {
  return {
    version: "0.7.5",
    protocol: 17,
    apiSchema: 1,
    focusedWorkspaceId: "workspace-1",
    focusedTabId: "tab-crewlead",
    focusedPaneId: "pane-crewlead",
    workspaces: [{
      workspaceId: "workspace-1",
      label: "Crewlead",
      focused: true,
      activeTabId: "tab-crewlead",
      tabCount: 1,
      paneCount: 1,
      agentState: "idle",
    }],
    tabs: [{
      tabId: "tab-crewlead",
      workspaceId: "workspace-1",
      label: "Crewlead",
      focused: true,
      paneCount: 1,
      agentState: "idle",
    }],
    panes: [{
      paneId: "pane-crewlead",
      terminalId: "terminal-crewlead",
      workspaceId: "workspace-1",
      tabId: "tab-crewlead",
      focused: true,
      agentState: "idle",
      revision: 1,
      cwd: project,
    }],
    agents: [],
  };
}

function resultFor(run: RunRecord, outcome: "completed" | "failed" = "completed") {
  return {
    schemaVersion: 1,
    resultContractVersion: 1,
    resultId: `result-${run.runId}`,
    runId: run.runId,
    packetId: run.packetId,
    role: "scout",
    profileVersion: 2,
    outcome,
    summary: outcome === "completed" ? "The bounded task completed." : "The bounded task failed.",
    ...(outcome === "failed" ? {
      failure: { classification: "validation", summary: "Focused validation failed.", evidenceRefs: ["evidence:failure"] },
    } : {}),
    deliverables: [{
      id: "report",
      status: outcome === "completed" ? "produced" : "not_produced",
      references: outcome === "completed" ? ["evidence:report"] : [],
      ...(outcome === "failed" ? { note: "No report was produced." } : {}),
    }],
    completionCriteria: [{
      id: "done",
      status: outcome === "completed" ? "passed" : "not_met",
      evidenceRefs: outcome === "completed" ? ["evidence:done"] : [],
      ...(outcome === "failed" ? { note: "The task did not complete." } : {}),
    }],
    validation: [{
      id: "focused",
      status: outcome === "completed" ? "passed" : "failed",
      evidenceRefs: [outcome === "completed" ? "evidence:tests" : "evidence:failure"],
      summary: outcome === "completed" ? "Focused validation passed." : "Focused validation failed.",
    }],
    unresolvedBlockerIds: [],
    unresolvedDecisions: outcome === "completed" ? [] : ["A responsible human must decide whether to retry."],
    stateChanges: ["RAW_DIFF_MUST_NOT_BE_AUTOMATIC_CONTEXT"],
    durableReferences: ["evidence:report"],
    recommendedNextSteps: ["Wait for requester direction."],
    roleDetails: {
      role: "scout",
      repositoryManifestDigest: "b".repeat(64),
      evidenceRefs: ["PRIVATE_FULL_EVIDENCE_MUST_REQUIRE_RETRIEVAL"],
    },
  };
}

async function fixture() {
  const home = await temporaryAccountHome();
  const project = join(home.path, "project");
  await mkdir(project, { mode: 0o700 });
  let now = Date.parse("2026-08-18T12:00:10.000Z");
  const root = await SecureStateRoot.openAtAccountHome(home.path, { now: () => now });
  const store = await DurableStateStore.openAtAccountHome(home.path, { now: () => now });
  const lifecycle = new LifecycleService(store, {
    maxActiveMembers: 6,
    maxOpenMemberResources: 6,
    maxQueuedDelegations: 6,
  });
  const identity: DeliveryIdentity = {
    crewleadSessionId: "crewlead-session",
    herdrWorkspaceId: "workspace-1",
    canonicalProjectPath: project,
  };
  const claims = new DurableDeliveryClaims(root);
  const notifications = new DurableNotificationReceipts(root);
  const progressQueue = new TransientProgressQueue(root, { now: () => now });
  const herdr = new FakeHerdrAdapter(herdrSnapshot(project));
  let sequence = 0;

  const start = async (label: string): Promise<RunRecord> => {
    sequence += 1;
    const admitted = (await lifecycle.admitBatch({
      candidates: [{
        admissionId: `admission-${sequence}`,
        runId: `run-${sequence}`,
        packetId: `packet-${sequence}`,
        intentDigest: String(sequence).padStart(64, "0"),
        purposeLabel: label,
        role: "scout",
        binding: {
          ...identity,
          memberSessionId: `member-${sequence}`,
        },
        retentionPolicy: "retain",
        createdAt,
      }],
      mode: "start",
      actor: "crewlead",
      evidenceRefs: ["request:authorized"],
    })).runs[0]!;
    return lifecycle.transition({
      operationId: `working-${sequence}`,
      runId: admitted.runId,
      expectedRevision: admitted.revision,
      expectedFencingEpoch: admitted.fencingEpoch,
      actor: "crewlead",
      targetState: "working",
      reason: "The member prompt was acknowledged.",
      evidenceRefs: ["prompt:ack"],
      timestamp: workingAt,
    });
  };

  const finish = async (run: RunRecord, outcome: "completed" | "failed" = "completed") => {
    const result = resultFor(run, outcome);
    const terminal = await lifecycle.transition({
      operationId: `finish-${run.runId}`,
      runId: run.runId,
      expectedRevision: run.revision,
      expectedFencingEpoch: run.fencingEpoch,
      actor: "companion",
      targetState: outcome,
      reason: "The authenticated companion committed the immutable result.",
      evidenceRefs: ["evidence:result"],
      timestamp: terminalAt,
      result,
    });
    return { run: terminal, result };
  };

  return {
    home,
    project,
    root,
    store,
    lifecycle,
    identity,
    claims,
    notifications,
    progressQueue,
    herdr,
    start,
    finish,
    setNow(value: number) { now = value; },
  };
}

function deliveryHarness(value: Awaited<ReturnType<typeof fixture>>, options: {
  failSend?: boolean;
  inserted?: Set<string>;
  now?: () => number;
} = {}) {
  const notifications: HumanNotification[] = [];
  const batches: DeliveryBatch[] = [];
  const service = new TerminalDeliveryService(value.identity, {
    store: value.store,
    claims: value.claims,
    notifications: value.notifications,
    now: options.now ?? (() => Date.parse("2026-08-18T12:00:10.000Z")),
    hooks: {
      notify(notification) {
        notifications.push(notification);
        return true;
      },
      sendBatch(batch) {
        batches.push(batch);
        for (const id of batch.deliveryIds) options.inserted?.add(id);
        if (options.failSend) throw new Error("simulated post-insert crash window");
      },
    },
  });
  return { service, notifications, batches };
}

test("busy and offline terminal delivery remains pending, then exact-session restart sends one follow-up", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  await value.finish(await value.start("busy result"));
  const first = deliveryHarness(value);
  const busy = await first.service.reconcile({ idle: false, hasPendingMessages: false });
  assert.equal(busy.pending, 1);
  assert.equal(first.batches.length, 0);
  assert.equal(first.notifications.filter((item) => item.kind === "terminal").length, 1);
  await first.service.reconcile({ idle: true, hasPendingMessages: true });
  assert.equal(first.batches.length, 0, "queued Crewlead messages remain ahead of automatic reporting");

  const restarted = deliveryHarness(value);
  const delivered = await restarted.service.reconcile({ idle: true, hasPendingMessages: false });
  assert.equal(delivered.sent?.deliveryIds.length, 1);
  assert.equal(restarted.batches.length, 1);
  assert.equal(restarted.batches[0]!.context.includes("RAW_DIFF_MUST_NOT_BE_AUTOMATIC_CONTEXT"), false);
  assert.equal(restarted.batches[0]!.context.includes("PRIVATE_FULL_EVIDENCE_MUST_REQUIRE_RETRIEVAL"), false);
  assert.equal(restarted.notifications.length, 0, "durable notification suppression survives restart");
  await restarted.service.reconcile({ idle: true, hasPendingMessages: false });
  assert.equal(restarted.batches.length, 1, "delivered IDs suppress normal duplicate windows");
});

test("simultaneous terminal outcomes coalesce for the bounded delay into one reporting batch", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  await value.finish(await value.start("coalesced one"));
  await value.finish(await value.start("coalesced two"));
  let now = Date.parse(terminalAt) + LIMITS.deliveryBatchDelayMilliseconds - 1;
  const harness = deliveryHarness(value, { now: () => now });
  const waiting = await harness.service.reconcile({ idle: true, hasPendingMessages: false });
  assert.equal(waiting.pending, 2);
  assert.equal(harness.batches.length, 0);
  now += 1;
  const sent = await harness.service.reconcile({ idle: true, hasPendingMessages: false });
  assert.equal(sent.sent?.deliveryIds.length, 2);
  assert.equal(harness.batches.length, 1);
});

test("post-insert crash recovery uses session delivery IDs and never creates a duplicate model turn", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  await value.finish(await value.start("duplicate window"));
  const inserted = new Set<string>();
  const crashing = deliveryHarness(value, { failSend: true, inserted });
  await assert.rejects(
    crashing.service.reconcile({ idle: true, hasPendingMessages: false }),
    /simulated post-insert/u,
  );
  assert.equal(crashing.batches.length, 1);

  const restarted = deliveryHarness(value);
  const recovered = await restarted.service.reconcile({
    idle: true,
    hasPendingMessages: false,
    insertedDeliveryIds: inserted,
  });
  assert.equal(recovered.suppressedInserted, 1);
  assert.equal(restarted.batches.length, 0);
  assert.equal(recovered.pending, 0);
});

test("failed and asynchronously cancelled outcomes report, while a synchronous Crewlead cancellation does not report twice", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  await value.finish(await value.start("failed result"), "failed");
  const asynchronous = await value.start("asynchronous cancellation");
  await value.lifecycle.transition({
    operationId: "cancel-asynchronous",
    runId: asynchronous.runId,
    expectedRevision: asynchronous.revision,
    expectedFencingEpoch: asynchronous.fencingEpoch,
    actor: "companion",
    targetState: "cancelled",
    reason: "The companion acknowledged cancellation after the initiating action returned.",
    evidenceRefs: ["checkpoint:cancelled"],
    timestamp: terminalAt,
  });
  const synchronous = await value.start("synchronous cancellation");
  await value.lifecycle.transition({
    operationId: "cancel-synchronous",
    runId: synchronous.runId,
    expectedRevision: synchronous.revision,
    expectedFencingEpoch: synchronous.fencingEpoch,
    actor: "crewlead",
    targetState: "cancelled",
    reason: "The Crewlead action reported this terminal transition synchronously.",
    evidenceRefs: ["action:reported"],
    timestamp: terminalAt,
  });
  const harness = deliveryHarness(value);
  const reconciliation = await harness.service.reconcile({ idle: true, hasPendingMessages: false });
  assert.deepEqual(
    reconciliation.sent?.context.match(/"outcome":"(failed|cancelled)"/gu)?.sort(),
    ["\"outcome\":\"cancelled\"", "\"outcome\":\"failed\""],
  );
  assert.equal(reconciliation.sent?.deliveryIds.length, 2);
  assert.equal(harness.notifications.filter((item) => item.kind === "terminal").length, 2);
});

test("destination mismatches stay private and never block exact destination delivery", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  await value.claims.enqueue({
    schemaVersion: 1,
    deliveryId: "delivery-other-session",
    resultId: "result-other",
    resultDigest: "a".repeat(64),
    runId: "run-other",
    role: "scout",
    purpose: "other session",
    destination: { crewleadSessionId: "other-session", herdrWorkspaceId: "workspace-1" },
    outcome: "completed",
    summary: "Private to another session.",
    validation: { passed: 0, failed: 0, notApplicable: 0 },
    deliverableRefs: [],
    unresolvedItems: [],
    omittedDeliverables: 0,
    omittedUnresolvedItems: 0,
    createdAt: terminalAt,
  });
  await value.finish(await value.start("exact destination"));
  const exact = deliveryHarness(value);
  const result = await exact.service.reconcile({ idle: true, hasPendingMessages: false });
  assert.equal(result.sent?.deliveryIds.length, 1);
  assert.equal(result.sent?.context.includes("other-session"), false);
  assert.equal((await value.claims.listPending(
    { crewleadSessionId: "other-session", herdrWorkspaceId: "workspace-1" },
  )).length, 1);
});

test("delivery batching is count- and byte-capped with stable overflow markers and no raw payload", () => {
  const envelopes = Array.from({ length: LIMITS.deliveryBatchEnvelopes }, (_, index): DeliveryEnvelope => ({
    schemaVersion: 1,
    deliveryId: `delivery-${index + 1}`,
    resultId: `result-${index + 1}`,
    resultDigest: index.toString(16).padStart(64, "0"),
    runId: `run-${index + 1}`,
    role: "builder",
    purpose: `bounded result ${index + 1}`,
    destination: { crewleadSessionId: "crewlead-session", herdrWorkspaceId: "workspace-1" },
    outcome: "completed",
    summary: "x".repeat(2_000),
    validation: { passed: 64, failed: 0, notApplicable: 0 },
    deliverableRefs: Array.from({ length: 6 }, (_, ref) => `reference-${index}-${ref}-${"r".repeat(900)}`),
    unresolvedItems: Array.from({ length: 6 }, (_, item) => `unresolved-${index}-${item}-${"u".repeat(1_900)}`),
    recommendedNextAction: `Wait for explicit requester direction. ${"n".repeat(1_900)}`,
    omittedDeliverables: 58,
    omittedUnresolvedItems: 0,
    createdAt: terminalAt,
  }));
  const batch = buildDeliveryBatch(envelopes, 40);
  assert.equal(batch.detailedCount, LIMITS.deliveryBatchResults);
  assert.equal(batch.overflowIds.length, LIMITS.deliveryOverflowIds);
  assert.equal(batch.omittedCount, 8);
  assert.ok(Buffer.byteLength(batch.context, "utf8") <= LIMITS.deliveryContextBytes);
  assert.equal(batch.context.includes("RAW_DIFF_MUST_NOT_BE_AUTOMATIC_CONTEXT"), false);
  assert.match(batch.context, /does not authorize acceptance, integration, cleanup, retry, delegation/u);
});

test("blockers notify passively once and never inject or trigger a model turn", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const run = await value.start("needs a decision");
  const next = { ...structuredClone(run), state: "blocked" as const, activeBlockerId: "blocker-1", revision: run.revision + 1, updatedAt: terminalAt };
  const blocker = {
    schemaVersion: 1,
    blockerId: "blocker-1",
    blockerRevision: 1,
    runId: run.runId,
    expectedRevision: run.revision,
    status: "open",
    category: "material_decision",
    summary: "A bounded requester decision is required.",
    requiredDecision: "Choose one bounded option.",
    options: [],
    evidenceRefs: ["evidence:blocker"],
    decisionOwner: "human",
  };
  await value.store.commitRun({
    operationId: "blocker-open",
    expectedRevision: run.revision,
    expectedFencingEpoch: run.fencingEpoch,
    run: next,
    history: [{
      kind: "lifecycle",
      payload: {
        schemaVersion: 1,
        eventId: "blocker-open",
        runId: run.runId,
        sequence: next.revision,
        timestamp: terminalAt,
        actor: "companion",
        type: "blocker_opened",
        reason: "The member opened a durable blocker.",
        evidenceRefs: ["evidence:blocker"],
        expectedPriorState: "working",
        resultingState: "blocked",
        expectedRevision: run.revision,
        resultingRevision: next.revision,
        fencingEpoch: run.fencingEpoch,
      },
    }, { kind: "control", payload: blocker }],
  });
  const first = deliveryHarness(value);
  const reconciliation = await first.service.reconcile({ idle: true, hasPendingMessages: false });
  assert.equal(reconciliation.blockersNotified, 1);
  assert.equal(first.batches.length, 0);
  const restarted = deliveryHarness(value);
  await restarted.service.reconcile({ idle: true, hasPendingMessages: false });
  assert.equal(restarted.notifications.length, 0);
  assert.equal(restarted.batches.length, 0);
});

test("UI loss is transient and fallback remains durable state plus Herdr without unintended turns", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const run = await value.start("observe progress");
  await value.progressQueue.enqueue({
    protocolVersion: 1,
    crewleadSessionId: value.identity.crewleadSessionId,
    herdrWorkspaceId: value.identity.herdrWorkspaceId,
    canonicalProjectPath: value.identity.canonicalProjectPath,
    runId: run.runId,
    memberSessionId: run.binding.memberSessionId!,
    role: run.role,
    fencingEpoch: run.fencingEpoch,
  }, {
    schemaVersion: 1,
    progressId: "progress-ui-1",
    runId: run.runId,
    sequence: 1,
    fencingEpoch: run.fencingEpoch,
    kind: "phase",
    phase: "focused validation",
    timestamp: workingAt,
  });
  value.herdr.failNext("snapshot", new Error("transient UI observation loss"));
  const observability = new CrewObservabilityService(value.identity, {
    store: value.store,
    herdr: value.herdr,
    claims: value.claims,
    progressQueue: value.progressQueue,
  });
  const snapshot = await observability.snapshot();
  assert.equal(snapshot.fallback, true);
  assert.match(snapshot.rows[0]?.text ?? "", /focused validation/u);

  let widgetAttempts = 0;
  const statuses: Array<string | undefined> = [];
  const widgets: Array<string[] | undefined> = [];
  const ui = new CrewleadUIController({
    setStatus(_key, text) { statuses.push(text); },
    setWidget(_key, lines) {
      widgetAttempts += 1;
      if (widgetAttempts === 1) throw new Error("simulated TUI loss");
      widgets.push(lines as string[] | undefined);
    },
  });
  assert.equal(ui.render(snapshot), false);
  assert.equal(ui.render(await observability.snapshot()), true);
  assert.ok(statuses.length >= 2);
  assert.equal(widgets.length, 1);
  assert.match(widgets[0]?.[0] ?? "", /focused validation/u, "a transient TUI failure does not discard current in-memory progress");

  const restarted = new CrewObservabilityService(value.identity, {
    store: value.store,
    herdr: value.herdr,
    claims: value.claims,
    progressQueue: value.progressQueue,
  });
  const rebuilt = await restarted.snapshot();
  assert.match(rebuilt.rows[0]?.text ?? "", /details unavailable/u, "restart falls back to Herdr plus durable state instead of replaying progress history");
});

test("aggregate UI rows stay bounded at the hard active-plus-queue pressure limit", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  for (let index = 0; index < 6; index += 1) await value.start(`active ${index + 1}`);
  await value.lifecycle.admitBatch({
    candidates: Array.from({ length: 6 }, (_, index) => ({
      admissionId: `queued-admission-${index + 1}`,
      runId: `queued-run-${index + 1}`,
      packetId: `queued-packet-${index + 1}`,
      intentDigest: (index + 10).toString(16).padStart(64, "0"),
      purposeLabel: `queued ${index + 1}`,
      role: "scout" as const,
      binding: {
        ...value.identity,
        memberSessionId: `queued-member-${index + 1}`,
      },
      retentionPolicy: "retain" as const,
      createdAt,
    })),
    mode: "queue",
    explicitQueueAuthorization: true,
    actor: "crewlead",
    evidenceRefs: ["request:queue"],
  });
  const observability = new CrewObservabilityService(value.identity, {
    store: value.store,
    herdr: value.herdr,
    claims: value.claims,
    progressQueue: value.progressQueue,
  });
  const snapshot = await observability.snapshot();
  assert.equal(snapshot.rows.length, LIMITS.uiRows);
  assert.equal(snapshot.omittedRows, 6);
  assert.equal(snapshot.counts.queued, 6);
  assert.equal(snapshot.counts.working, 6);
  assert.ok(snapshot.rows.every((row) => row.text.length <= LIMITS.uiLineCharacters));
});

test("structured result retrieval exposes only the requested section when full content is unnecessary", async () => {
  const run = {
    runId: "run-1",
    packetId: "packet-1",
  } as RunRecord;
  const result = resultFor(run);
  const summary = selectResultSection(result, "summary");
  assert.deepEqual(Object.keys(summary).sort(), ["failure", "outcome", "resultId", "role", "runId", "summary"]);
  assert.equal(JSON.stringify(summary).includes("RAW_DIFF_MUST_NOT_BE_AUTOMATIC_CONTEXT"), false);
  const stateChanges = selectResultSection(result, "state_changes");
  assert.deepEqual(stateChanges.stateChanges, ["RAW_DIFF_MUST_NOT_BE_AUTOMATIC_CONTEXT"]);
  const full = selectResultSection(result, "full");
  assert.equal(digestJson(full, LIMITS.resultBytes), digestJson(result, LIMITS.resultBytes));
});
