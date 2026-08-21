import assert from "node:assert/strict";
import test from "node:test";

import { LIMITS } from "../../src/protocol/limits.ts";
import { StateSecurityError } from "../../src/security/errors.ts";
import { digestJson } from "../../src/security/json.ts";
import { DurableStateStore } from "../../src/state/store.ts";
import { eventValue, runValue, temporaryAccountHome, timestamp, deliveryEnvelope } from "./helpers.ts";

function transitionEvent(
  eventId: string,
  sequence: number,
  expectedRevision: number,
  resultingRevision: number,
  state: string,
  type = "state_transition",
): Record<string, unknown> {
  return eventValue({
    eventId,
    sequence,
    type,
    expectedPriorState: state === "working" && expectedRevision === 1 ? "starting" : state,
    resultingState: state,
    expectedRevision,
    resultingRevision,
  });
}

test("revisioned commits derive snapshots and retain all append-only history planes", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const store = await DurableStateStore.openAtAccountHome(home.path);

  const created = {
    operationId: "operation-create",
    expectedRevision: 0,
    expectedFencingEpoch: 0,
    run: runValue(),
    history: [{ kind: "lifecycle" as const, payload: eventValue() }],
  };
  assert.equal((await store.commitRun(created)).idempotent, false);
  assert.equal((await store.commitRun(created)).idempotent, true);

  const workingRun = runValue({ state: "working", revision: 2 });
  const amendment = {
    schemaVersion: 1,
    amendmentId: "amendment-1",
    runId: "run-1",
    sequence: 1,
    expectedRevision: 1,
    author: "crewlead",
    timestamp,
    kind: "clarification",
    summary: "Use the package-owned state contracts.",
    constraints: ["Keep state private."],
  };
  await store.commitRun({
    operationId: "operation-working",
    expectedRevision: 1,
    expectedFencingEpoch: 1,
    run: workingRun,
    history: [
      { kind: "lifecycle", payload: transitionEvent("event-working", 2, 1, 2, "working") },
      { kind: "control", payload: amendment },
    ],
  });

  const deliveryRun = runValue({ state: "working", revision: 3 });
  await store.commitRun({
    operationId: "operation-delivery",
    expectedRevision: 2,
    expectedFencingEpoch: 1,
    run: deliveryRun,
    history: [
      {
        kind: "lifecycle",
        payload: transitionEvent("event-delivery", 3, 2, 3, "working", "delivery_changed"),
      },
      { kind: "delivery", payload: deliveryEnvelope() },
    ],
  });

  const result = {
    schemaVersion: 1,
    resultContractVersion: 1,
    resultId: "result-1",
    runId: "run-1",
    packetId: "packet-1",
    role: "scout",
    profileVersion: 2,
    outcome: "completed",
    summary: "The private state implementation was inspected.",
    deliverables: [{ id: "state", status: "produced", references: ["evidence:state"] }],
    completionCriteria: [{ id: "complete", status: "passed", evidenceRefs: ["evidence:state"] }],
    validation: [{ id: "tests", status: "passed", evidenceRefs: ["evidence:tests"], summary: "Tests passed." }],
    unresolvedBlockerIds: [],
    unresolvedDecisions: [],
    stateChanges: ["Private state committed."],
    durableReferences: ["evidence:state"],
    recommendedNextSteps: [],
    roleDetails: {
      role: "scout",
      repositoryManifestDigest: "a".repeat(64),
      evidenceRefs: ["evidence:state"],
    },
  };
  const resultDigest = digestJson(result, LIMITS.resultBytes);
  const completedRun = runValue({
    state: "completed",
    revision: 4,
    resultId: "result-1",
    resultDigest,
  });
  await store.commitRun({
    operationId: "operation-result",
    expectedRevision: 3,
    expectedFencingEpoch: 1,
    run: completedRun,
    history: [
      {
        kind: "lifecycle",
        payload: transitionEvent("event-result", 4, 3, 4, "completed", "result_committed"),
      },
      { kind: "result", payload: result },
    ],
  });

  assert.deepEqual(await store.readRun("run-1"), completedRun);
  const lateRetry = await store.commitRun(created);
  assert.equal(lateRetry.idempotent, true);
  assert.deepEqual(lateRetry.run, completedRun);
  const history = await store.readHistory("run-1");
  assert.deepEqual(
    history.map((record) => record.kind),
    ["lifecycle", "lifecycle", "control", "lifecycle", "delivery", "lifecycle", "result"],
  );
  assert.deepEqual(history.map((record) => record.sequence), [1, 2, 3, 4, 5, 6, 7]);

  await assert.rejects(
    store.commitRun({
      operationId: "operation-stale",
      expectedRevision: 1,
      expectedFencingEpoch: 1,
      run: workingRun,
      history: [
        { kind: "lifecycle", payload: transitionEvent("event-stale", 5, 1, 2, "working") },
      ],
    }),
    (error) => error instanceof StateSecurityError && error.code === "revision_conflict",
  );
});

test("prepared transactions recover idempotently after partial record writes", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const interrupted = await DurableStateStore.openAtAccountHome(home.path, {
    faultInjector(phase, detail) {
      if (phase === "after_history_record" && detail === 1) throw new Error("simulated crash");
    },
  });
  const control = {
    schemaVersion: 1,
    controlId: "control-recovery",
    runId: "run-1",
    type: "recovery_requested",
    actor: "recovery",
    reason: "Record deterministic transaction recovery evidence.",
    expectedRevision: 0,
    fencingEpoch: 1,
    timestamp,
    evidenceRefs: [],
  };
  await assert.rejects(
    interrupted.commitRun({
      operationId: "operation-interrupted",
      expectedRevision: 0,
      expectedFencingEpoch: 0,
      run: runValue(),
      history: [
        { kind: "lifecycle", payload: eventValue() },
        { kind: "control", payload: control },
      ],
    }),
    /simulated crash/,
  );

  const recovered = await DurableStateStore.openAtAccountHome(home.path);
  assert.equal((await recovered.readRun("run-1")).revision, 1);
  assert.equal((await recovered.readHistory("run-1")).length, 2);
  assert.equal(await recovered.recoverTransactions(), 0);
});

test("concurrent compare-and-set commits permit exactly one revision winner", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const first = await DurableStateStore.openAtAccountHome(home.path);
  await first.commitRun({
    operationId: "operation-create",
    expectedRevision: 0,
    expectedFencingEpoch: 0,
    run: runValue(),
    history: [{ kind: "lifecycle", payload: eventValue() }],
  });
  const second = await DurableStateStore.openAtAccountHome(home.path);
  const nextRun = runValue({ state: "working", revision: 2 });
  const commit = (store: DurableStateStore, suffix: string) =>
    store.commitRun({
      operationId: `operation-race-${suffix}`,
      expectedRevision: 1,
      expectedFencingEpoch: 1,
      run: nextRun,
      history: [
        {
          kind: "lifecycle",
          payload: transitionEvent(`event-race-${suffix}`, 2, 1, 2, "working"),
        },
      ],
    });
  const outcomes = await Promise.allSettled([commit(first, "a"), commit(second, "b")]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.ok(rejected.reason instanceof StateSecurityError);
  assert.equal(rejected.reason.code, "revision_conflict");
  assert.equal((await first.readRun("run-1")).revision, 2);
});
