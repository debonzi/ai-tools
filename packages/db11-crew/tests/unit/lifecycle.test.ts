import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIGURATION } from "../../src/config/config.ts";
import {
  LifecycleError,
  LifecycleService,
  admissionCounts,
  assessRunDimensions,
  isLifecycleTransitionAllowed,
  type AdmissionCandidate,
  type RunRecord,
  type RunState,
} from "../../src/orchestration/lifecycle.ts";
import { StateSecurityError } from "../../src/security/errors.ts";
import { DurableStateStore } from "../../src/state/store.ts";
import { temporaryAccountHome } from "../security/helpers.ts";

const firstTimestamp = "2026-08-17T12:00:00Z";
const secondTimestamp = "2026-08-17T12:00:01Z";
const evidence = ["request:authorized"] as const;

function candidate(number: number, overrides: Partial<AdmissionCandidate> = {}): AdmissionCandidate {
  const suffix = String(number);
  return {
    admissionId: `admission-${suffix}`,
    runId: `run-${suffix}`,
    packetId: `packet-${suffix}`,
    intentDigest: number.toString(16).padStart(64, "0"),
    purposeLabel: `purpose-${suffix}`,
    role: "scout",
    binding: {
      crewleadSessionId: "crewlead-session",
      herdrWorkspaceId: "workspace-1",
      canonicalProjectPath: "/work/project",
    },
    retentionPolicy: "auto_close",
    createdAt: firstTimestamp,
    ...overrides,
  };
}

function limits(active: number, openResources: number, queued: number) {
  return {
    ...DEFAULT_CONFIGURATION.limits,
    maxActiveMembers: active,
    maxOpenMemberResources: openResources,
    maxQueuedDelegations: queued,
  };
}

async function serviceAt(
  home: string,
  active = 4,
  openResources = 6,
  queued = 6,
): Promise<LifecycleService> {
  return new LifecycleService(
    await DurableStateStore.openAtAccountHome(home),
    limits(active, openResources, queued),
  );
}

function result(run: RunRecord, outcome: "completed" | "failed" = "completed") {
  return {
    schemaVersion: 1,
    resultContractVersion: 1,
    resultId: `result-${run.runId}`,
    runId: run.runId,
    packetId: run.packetId,
    role: run.role,
    profileVersion: 2,
    outcome,
    summary: outcome === "completed" ? "The delegated task completed." : "The delegated task failed.",
    ...(outcome === "failed" ? {
      failure: {
        classification: "task",
        summary: "The delegated task could not be completed.",
        evidenceRefs: ["evidence:failure"],
      },
    } : {}),
    deliverables: [
      {
        id: "deliverable",
        status: outcome === "completed" ? "produced" : "not_produced",
        references: outcome === "completed" ? ["evidence:deliverable"] : [],
        ...(outcome === "failed" ? { note: "The required output could not be produced." } : {}),
      },
    ],
    completionCriteria: [
      {
        id: "criterion",
        status: outcome === "completed" ? "passed" : "not_met",
        evidenceRefs: ["evidence:criterion"],
      },
    ],
    validation: [
      {
        id: "tests",
        status: outcome === "completed" ? "passed" : "failed",
        evidenceRefs: ["evidence:tests"],
        summary: outcome === "completed" ? "Tests passed." : "Tests failed.",
      },
    ],
    unresolvedBlockerIds: [],
    unresolvedDecisions: outcome === "completed" ? [] : ["The failure requires review."],
    stateChanges: [],
    durableReferences: ["evidence:result"],
    recommendedNextSteps: [],
    roleDetails: {
      role: "scout",
      repositoryManifestDigest: "a".repeat(64),
      evidenceRefs: ["evidence:result"],
    },
  };
}

async function transition(
  service: LifecycleService,
  run: RunRecord,
  targetState: "working" | "blocked" | "completed" | "failed" | "cancelled" | "abandoned",
  overrides: Record<string, unknown> = {},
): Promise<RunRecord> {
  return service.transition({
    operationId: `transition-${run.runId}-${run.revision + 1}`,
    runId: run.runId,
    expectedRevision: run.revision,
    expectedFencingEpoch: run.fencingEpoch,
    actor: "companion",
    targetState,
    reason: `Explicitly transition the run to ${targetState}.`,
    evidenceRefs: evidence,
    timestamp: secondTimestamp,
    ...(overrides as object),
  });
}

test("the semantic state graph has exactly the accepted edges and immutable terminals", () => {
  const states: RunState[] = [
    "queued",
    "starting",
    "working",
    "blocked",
    "completed",
    "failed",
    "cancelled",
    "abandoned",
  ];
  const expected = new Set([
    "queued->starting",
    "queued->cancelled",
    "queued->abandoned",
    "starting->working",
    "starting->failed",
    "starting->cancelled",
    "starting->abandoned",
    "working->blocked",
    "working->completed",
    "working->failed",
    "working->cancelled",
    "working->abandoned",
    "blocked->working",
    "blocked->failed",
    "blocked->cancelled",
    "blocked->abandoned",
  ]);
  for (const from of states) {
    for (const to of states) {
      assert.equal(isLifecycleTransitionAllowed(from, to), expected.has(`${from}->${to}`), `${from}->${to}`);
    }
  }
});

test("single and batch admission reserve independent capacities atomically and reject duplicate intent", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const service = await serviceAt(home.path, 2, 2, 2);

  const admitted = await service.admitBatch({
    candidates: [candidate(1), candidate(2)],
    mode: "start",
    actor: "crewlead",
    evidenceRefs: evidence,
  });
  assert.deepEqual(
    admitted.runs.map((run) => run.state),
    ["starting", "starting"],
  );
  assert.deepEqual(
    { active: admitted.counts.active, open: admitted.counts.openResources, queued: admitted.counts.queued },
    { active: 2, open: 2, queued: 0 },
  );

  await assert.rejects(
    service.admitBatch({
      candidates: [candidate(3)],
      mode: "start",
      actor: "crewlead",
      evidenceRefs: evidence,
    }),
    (error) =>
      error instanceof LifecycleError &&
      error.code === "admission_capacity" &&
      error.details.limitingResource === "active" &&
      error.details.counts?.activeRuns.length === 2,
  );
  assert.equal((await service.store.listRuns()).length, 2);

  await assert.rejects(
    service.admitBatch({
      candidates: [candidate(3, { intentDigest: candidate(1).intentDigest })],
      mode: "queue",
      explicitQueueAuthorization: true,
      actor: "human",
      evidenceRefs: evidence,
    }),
    (error) => error instanceof LifecycleError && error.code === "admission_duplicate",
  );
  assert.equal((await service.store.listRuns()).length, 2);

  const retry = await service.admitBatch({
    candidates: [candidate(1), candidate(2)],
    mode: "start",
    actor: "crewlead",
    evidenceRefs: evidence,
  });
  assert.equal(retry.idempotent, true);
});

test("concurrent admissions use one critical section and never oversubscribe", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const first = await serviceAt(home.path, 1, 1, 2);
  const second = await serviceAt(home.path, 1, 1, 2);
  const admit = (service: LifecycleService, value: AdmissionCandidate) =>
    service.admitBatch({ candidates: [value], mode: "start", actor: "crewlead", evidenceRefs: evidence });

  const outcomes = await Promise.allSettled([admit(first, candidate(1)), admit(second, candidate(2))]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejection = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(rejection && rejection.status === "rejected");
  assert.ok(rejection.reason instanceof LifecycleError);
  assert.equal(rejection.reason.code, "admission_capacity");
  assert.equal((await first.store.listRuns()).length, 1);
});

test("admission capacity and FIFO accounting are isolated by exact Crewlead session and workspace scope", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const service = await serviceAt(home.path, 1, 1, 1);
  const first = (await service.admitBatch({
    candidates: [candidate(1)],
    mode: "start",
    actor: "crewlead",
    evidenceRefs: evidence,
  })).runs[0]!;
  const second = (await service.admitBatch({
    candidates: [candidate(2, {
      binding: {
        crewleadSessionId: "other-session",
        herdrWorkspaceId: "workspace-2",
        canonicalProjectPath: "/work/project",
      },
    })],
    mode: "start",
    actor: "crewlead",
    evidenceRefs: evidence,
  })).runs[0]!;
  assert.equal(first.state, "starting");
  assert.equal(second.state, "starting");
  assert.equal((await service.store.listRuns()).length, 2);
});

test("concurrent semantic transitions permit exactly one revision winner", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const first = await serviceAt(home.path);
  const second = await serviceAt(home.path);
  const run = (
    await first.admitBatch({ candidates: [candidate(1)], mode: "start", actor: "crewlead", evidenceRefs: evidence })
  ).runs[0]!;

  const outcomes = await Promise.allSettled([
    transition(first, run, "working", { operationId: "race-working-a" }),
    transition(second, run, "working", { operationId: "race-working-b" }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejection = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(rejection && rejection.status === "rejected");
  assert.ok(rejection.reason instanceof StateSecurityError);
  assert.equal(rejection.reason.code, "revision_conflict");
  assert.equal((await first.store.readRun(run.runId)).revision, 2);
});

test("a recoverable batch journal materializes every admission after an interrupted commit", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const interruptedStore = await DurableStateStore.openAtAccountHome(home.path, {
    faultInjector(phase, detail) {
      if (phase === "after_batch_transaction" && detail === 1) throw new Error("simulated batch crash");
    },
  });
  const service = new LifecycleService(interruptedStore, limits(2, 2, 2));
  await assert.rejects(
    service.admitBatch({
      candidates: [candidate(1), candidate(2)],
      mode: "start",
      actor: "crewlead",
      evidenceRefs: evidence,
    }),
    /simulated batch crash/,
  );

  const recovered = await DurableStateStore.openAtAccountHome(home.path);
  assert.deepEqual(
    (await recovered.listRuns()).map((run) => run.runId),
    ["run-1", "run-2"],
  );
  assert.equal(await recovered.recoverTransactions(), 0);
});

test("explicit queues are resource-free, dormant offline, strict FIFO, and head-blocking", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const service = await serviceAt(home.path, 1, 1, 3);
  let active = (
    await service.admitBatch({ candidates: [candidate(1)], mode: "start", actor: "crewlead", evidenceRefs: evidence })
  ).runs[0]!;
  const queued = await service.admitBatch({
    candidates: [candidate(2), candidate(3)],
    mode: "queue",
    explicitQueueAuthorization: true,
    actor: "human",
    evidenceRefs: evidence,
  });
  assert.deepEqual(
    queued.runs.map((run) => [run.state, run.resourceDisposition, run.queue?.enqueueSequence]),
    [["queued", "unallocated", 1], ["queued", "unallocated", 2]],
  );

  assert.deepEqual(
    await service.promoteNext({
      operationId: "promote-offline",
      actor: "crewlead",
      evidenceRefs: evidence,
      timestamp: secondTimestamp,
      online: false,
      expectedRunId: "run-2",
      expectedRevision: queued.runs[0]!.revision,
      expectedFencingEpoch: queued.runs[0]!.fencingEpoch,
      revalidate: () => ({ ok: true }),
    }),
    { status: "dormant" },
  );
  await assert.rejects(
    service.promoteNext({
      operationId: "promote-out-of-order",
      actor: "crewlead",
      evidenceRefs: evidence,
      timestamp: secondTimestamp,
      online: true,
      expectedRunId: "run-3",
      expectedRevision: queued.runs[0]!.revision,
      expectedFencingEpoch: queued.runs[0]!.fencingEpoch,
      revalidate: () => ({ ok: true }),
    }),
    (error) => error instanceof StateSecurityError && error.code === "invalid_transition",
  );

  const capacityBlocked = await service.promoteNext({
    operationId: "promote-capacity-blocked",
    actor: "crewlead",
    evidenceRefs: evidence,
    timestamp: secondTimestamp,
    online: true,
    expectedRunId: "run-2",
    expectedRevision: queued.runs[0]!.revision,
    expectedFencingEpoch: queued.runs[0]!.fencingEpoch,
    revalidate: () => ({ ok: true }),
  });
  assert.equal(capacityBlocked.status, "capacity_blocked");
  assert.equal(capacityBlocked.run.runId, "run-2");
  assert.match(capacityBlocked.run.queue?.startBlockedReason ?? "", /capacity/i);

  active = await transition(service, active, "cancelled");
  await service.recordResourceDisposition({
    operationId: "close-run-1",
    runId: active.runId,
    expectedRevision: active.revision,
    expectedFencingEpoch: active.fencingEpoch,
    actor: "human",
    disposition: "closed",
    reason: "The explicitly cancelled runtime was confirmed closed.",
    evidenceRefs: evidence,
    timestamp: secondTimestamp,
  });

  let validations = 0;
  const startBlocked = await service.promoteNext({
    operationId: "promote-revalidation-blocked",
    actor: "crewlead",
    evidenceRefs: evidence,
    timestamp: secondTimestamp,
    online: true,
    expectedRunId: "run-2",
    expectedRevision: capacityBlocked.run.revision,
    expectedFencingEpoch: capacityBlocked.run.fencingEpoch,
    revalidate: () => {
      validations += 1;
      return { ok: false, reason: "The immutable packet requires a newly available input.", evidenceRefs: ["input:missing"] };
    },
  });
  assert.equal(validations, 1);
  assert.equal(startBlocked.status, "start_blocked");
  assert.equal((await service.store.readRun("run-3")).revision, 1);

  const promoted = await service.promoteNext({
    operationId: "promote-head",
    actor: "crewlead",
    evidenceRefs: evidence,
    timestamp: secondTimestamp,
    online: true,
    expectedRunId: "run-2",
    expectedRevision: startBlocked.run.revision,
    expectedFencingEpoch: startBlocked.run.fencingEpoch,
    revalidate: () => ({ ok: true }),
  });
  assert.equal(promoted.status, "promoted");
  assert.equal(promoted.run.state, "starting");
  assert.equal(promoted.run.resourceDisposition, "open");
  assert.equal((await service.store.readRun("run-3")).state, "queued");
});

test("lifecycle edges require current revision, epoch, actor, blocker, and result evidence", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const service = await serviceAt(home.path);
  let run = (
    await service.admitBatch({ candidates: [candidate(1)], mode: "start", actor: "crewlead", evidenceRefs: evidence })
  ).runs[0]!;

  await assert.rejects(
    transition(service, run, "completed", { result: result(run) }),
    (error) => error instanceof StateSecurityError && error.code === "invalid_transition",
  );
  run = await transition(service, run, "working");
  await assert.rejects(
    service.transition({
      operationId: "stale-block",
      runId: run.runId,
      expectedRevision: run.revision - 1,
      expectedFencingEpoch: run.fencingEpoch,
      actor: "companion",
      targetState: "blocked",
      activeBlockerId: "blocker-1",
      reason: "Open a structured blocker.",
      evidenceRefs: evidence,
      timestamp: secondTimestamp,
    }),
    (error) => error instanceof StateSecurityError && error.code === "revision_conflict",
  );
  run = await transition(service, run, "blocked", { activeBlockerId: "blocker-1" });
  run = await transition(service, run, "working");
  await assert.rejects(
    transition(service, run, "completed", { actor: "human", result: result(run) }),
    (error) => error instanceof StateSecurityError && error.code === "invalid_actor",
  );
  run = await transition(service, run, "completed", { result: result(run) });
  assert.equal(run.state, "completed");
  assert.ok(run.resultDigest);
  await assert.rejects(
    transition(service, run, "cancelled"),
    (error) => error instanceof StateSecurityError && error.code === "terminal_immutable",
  );

  const queued = (
    await service.admitBatch({
      candidates: [candidate(2)],
      mode: "queue",
      explicitQueueAuthorization: true,
      actor: "human",
      evidenceRefs: evidence,
    })
  ).runs[0]!;
  await assert.rejects(
    transition(service, queued, "abandoned"),
    (error) => error instanceof StateSecurityError && error.code === "invalid_actor",
  );
  const abandoned = await transition(service, queued, "abandoned", { actor: "human" });
  assert.equal(abandoned.state, "abandoned");
  assert.equal(admissionCounts(await service.store.listRuns()).openResources, 1);

  let failed = (
    await service.admitBatch({ candidates: [candidate(3)], mode: "start", actor: "crewlead", evidenceRefs: evidence })
  ).runs[0]!;
  failed = await transition(service, failed, "failed", { result: result(failed, "failed") });
  assert.equal(failed.state, "failed");
  assert.equal(failed.resourceDisposition, "retained");
});

test("Herdr observation, resource disposition, and health remain independent from semantic state", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const service = await serviceAt(home.path);
  let run = (
    await service.admitBatch({ candidates: [candidate(1)], mode: "start", actor: "crewlead", evidenceRefs: evidence })
  ).runs[0]!;
  run = await transition(service, run, "working");
  run = await service.recordObservation({
    operationId: "observe-idle",
    runId: run.runId,
    expectedRevision: run.revision,
    expectedFencingEpoch: run.fencingEpoch,
    actor: "crewlead",
    observation: { state: "idle", observedAt: secondTimestamp, sourceSequence: 10 },
    reason: "Herdr observed a settled Pi turn, not task completion.",
    evidenceRefs: ["herdr:event-10"],
    timestamp: secondTimestamp,
  });
  assert.equal(run.state, "working");
  assert.equal(run.observation?.state, "idle");

  run = await service.recordResourceDisposition({
    operationId: "resource-missing",
    runId: run.runId,
    expectedRevision: run.revision,
    expectedFencingEpoch: run.fencingEpoch,
    actor: "recovery",
    disposition: "missing",
    reason: "A current identity snapshot could not find the recorded runtime.",
    evidenceRefs: ["herdr:snapshot-11"],
    timestamp: secondTimestamp,
  });
  assert.equal(run.state, "working");
  assert.deepEqual(assessRunDimensions(run), ["active_run_resource_missing"]);

  run = await service.recordHealth({
    operationId: "health-recovery-required",
    runId: run.runId,
    expectedRevision: run.revision,
    expectedFencingEpoch: run.fencingEpoch,
    actor: "recovery",
    status: "recovery_required",
    reconciliationRequired: true,
    reason: "Exact-session reconciliation is required before further mutation.",
    evidenceRefs: ["herdr:snapshot-11"],
    timestamp: secondTimestamp,
  });
  assert.equal(run.state, "working");
  assert.equal(run.health.status, "recovery_required");
  assert.equal((await service.store.listRuns()).length, 1);

  await assert.rejects(
    service.recordObservation({
      operationId: "observe-stale",
      runId: run.runId,
      expectedRevision: run.revision,
      expectedFencingEpoch: run.fencingEpoch,
      actor: "crewlead",
      observation: { state: "working", observedAt: secondTimestamp, sourceSequence: 9 },
      reason: "A stale Herdr observation must not overwrite current evidence.",
      evidenceRefs: ["herdr:event-9"],
      timestamp: secondTimestamp,
    }),
    (error) => error instanceof StateSecurityError && error.code === "stale_sequence",
  );
});
