import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { GitDispositionAdapter } from "../../src/adapters/git/disposition.ts";
import { GitIsolationService, type BuilderWorktreeRecord } from "../../src/adapters/git/isolation.ts";
import { FakeHerdrAdapter, type HerdrPane, type HerdrSnapshot, type HerdrTab } from "../../src/adapters/herdr/contracts.ts";
import { DEFAULT_CONFIGURATION } from "../../src/config/config.ts";
import {
  BuilderIntegrationService,
  RepositoryCleanupService,
  RuntimeCleanupService,
  type DispositionIdentity,
} from "../../src/orchestration/disposition.ts";
import { LifecycleService, type RepositoryResource, type RunRecord } from "../../src/orchestration/lifecycle.ts";
import { SCHEMA_VERSION } from "../../src/protocol/limits.ts";
import { DurableStateStore, type HistoryInput } from "../../src/state/store.ts";
import { deliveryEnvelope, temporaryAccountHome } from "../security/helpers.ts";

const execute = promisify(execFile);
const baseTime = Date.parse("2026-08-20T12:00:00Z");
const identity: DispositionIdentity = {
  crewleadSessionId: "crewlead-session",
  herdrWorkspaceId: "workspace-1",
  canonicalProjectPath: "/work/project",
};
let operationSequence = 0;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
  })).stdout.trim();
}

async function initializeRepository(root: string): Promise<void> {
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "DB11 Test");
  await git(root, "config", "user.email", "db11@example.invalid");
  await writeFile(join(root, ".gitignore"), "generated/\n");
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git(root, "add", ".gitignore", "tracked.txt");
  await git(root, "commit", "-m", "test: create fixture");
}

function event(previous: RunRecord, next: RunRecord, operationId: string, reason: string) {
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: operationId,
    runId: next.runId,
    sequence: next.revision,
    timestamp: next.updatedAt,
    actor: "crewlead",
    type: "diagnostic",
    reason,
    evidenceRefs: ["test:fixture"],
    expectedPriorState: previous.state,
    resultingState: next.state,
    expectedRevision: previous.revision,
    resultingRevision: next.revision,
    fencingEpoch: next.fencingEpoch,
  };
}

async function mutate(
  store: DurableStateStore,
  current: RunRecord,
  at: string,
  change: (next: RunRecord) => void,
  extra: readonly HistoryInput[] = [],
): Promise<RunRecord> {
  const next = structuredClone(current);
  next.revision += 1;
  next.updatedAt = at;
  change(next);
  const operationId = `test-mutate-${++operationSequence}`;
  return (await store.commitRun({
    operationId,
    expectedRevision: current.revision,
    expectedFencingEpoch: current.fencingEpoch,
    run: next,
    history: [{ kind: "lifecycle", payload: event(current, next, operationId, "A deterministic disposable fixture revision was committed.") }, ...extra],
  })).run as RunRecord;
}

function roleResult(run: RunRecord, repository?: { rootDigest: string; baseCommit: string; headCommit: string }) {
  return {
    schemaVersion: 1,
    resultContractVersion: 1,
    resultId: `result-${run.runId}`,
    runId: run.runId,
    packetId: run.packetId,
    role: run.role,
    profileVersion: 2,
    outcome: "completed",
    summary: "The bounded task completed with verified evidence.",
    deliverables: [{ id: "deliverable", status: "produced", references: ["test:deliverable"] }],
    completionCriteria: [{ id: "criterion", status: "passed", evidenceRefs: ["test:criterion"] }],
    validation: [{ id: "tests", status: "passed", evidenceRefs: ["test:tests"], summary: "Focused tests passed." }],
    unresolvedBlockerIds: [],
    unresolvedDecisions: [],
    stateChanges: [],
    durableReferences: ["test:result"],
    recommendedNextSteps: [],
    roleDetails: repository ? {
      role: "builder",
      repository,
      commits: repository.baseCommit === repository.headCommit ? [] : [repository.headCommit],
      changedPaths: repository.baseCommit === repository.headCommit ? [] : ["tracked.txt"],
      noChange: repository.baseCommit === repository.headCommit,
      worktreeClean: true,
    } : {
      role: "scout",
      repositoryManifestDigest: "a".repeat(64),
      evidenceRefs: ["test:result"],
    },
  };
}

async function seedCompleted(
  store: DurableStateStore,
  lifecycle: LifecycleService,
  input: {
    runId: string;
    createdAt: string;
    resource?: RepositoryResource;
    repositoryResult?: { rootDigest: string; baseCommit: string; headCommit: string };
    withRuntime?: boolean;
    acknowledgeAt?: string;
    projectPath?: string;
  },
): Promise<RunRecord> {
  const role = input.repositoryResult ? "builder" : "scout";
  let run = (await lifecycle.admitBatch({
    candidates: [{
      admissionId: `admit-${input.runId}`,
      runId: input.runId,
      packetId: `packet-${input.runId}`,
      intentDigest: Buffer.from(input.runId).toString("hex").padEnd(64, "0").slice(0, 64),
      purposeLabel: input.runId,
      role,
      binding: { ...identity, canonicalProjectPath: input.projectPath ?? identity.canonicalProjectPath, memberSessionId: `member-${input.runId}` },
      retentionPolicy: "auto_close",
      createdAt: input.createdAt,
    }],
    mode: "start",
    actor: "crewlead",
    evidenceRefs: ["test:authorized"],
  })).runs[0]!;
  run = await mutate(store, run, input.createdAt, (next) => {
    if (input.withRuntime !== false) {
      next.resources = { tabId: `tab-${input.runId}`, paneId: `pane-${input.runId}`, agentId: `pane-${input.runId}` };
    }
    if (input.resource) next.repositoryResource = structuredClone(input.resource);
  });
  run = await lifecycle.transition({
    operationId: `working-${input.runId}`,
    runId: run.runId,
    expectedRevision: run.revision,
    expectedFencingEpoch: run.fencingEpoch,
    actor: "crewlead",
    targetState: "working",
    reason: "The disposable member reached the bounded working gate.",
    evidenceRefs: ["test:working"],
    timestamp: input.createdAt,
  });
  const result = roleResult(run, input.repositoryResult);
  run = await lifecycle.transition({
    operationId: `completed-${input.runId}`,
    runId: run.runId,
    expectedRevision: run.revision,
    expectedFencingEpoch: run.fencingEpoch,
    actor: "companion",
    targetState: "completed",
    reason: "The disposable member committed an authoritative successful result.",
    evidenceRefs: ["test:completed"],
    timestamp: input.createdAt,
    result,
  });
  if (input.acknowledgeAt) {
    const at = input.acknowledgeAt;
    const control = {
      schemaVersion: 1,
      controlId: `ack-${input.runId}`,
      runId: run.runId,
      type: "result_acknowledged",
      actor: "crewlead",
      reason: "The exact Crewlead session acknowledged durable result delivery.",
      expectedRevision: run.revision,
      fencingEpoch: run.fencingEpoch,
      timestamp: at,
      evidenceRefs: ["test:delivery"],
    };
    run = await mutate(store, run, at, () => {}, [{ kind: "control", payload: control }]);
  }
  return run;
}

function runtimeSnapshot(runIds: readonly string[], userPaneRunId?: string): HerdrSnapshot {
  const tabs: HerdrTab[] = [{ tabId: "tab-crewlead", workspaceId: "workspace-1", label: "Crewlead", focused: true, paneCount: 1, agentState: "idle" }];
  const panes: HerdrPane[] = [{ paneId: "pane-crewlead", terminalId: "terminal-crewlead", workspaceId: "workspace-1", tabId: "tab-crewlead", focused: true, agentState: "idle", revision: 1, cwd: identity.canonicalProjectPath }];
  const agents: HerdrSnapshot["agents"][number][] = [];
  for (const runId of runIds) {
    tabs.push({ tabId: `tab-${runId}`, workspaceId: "workspace-1", label: runId, focused: false, paneCount: runId === userPaneRunId ? 2 : 1, agentState: "done" });
    panes.push({ paneId: `pane-${runId}`, terminalId: `terminal-${runId}`, workspaceId: "workspace-1", tabId: `tab-${runId}`, focused: false, agentState: "done", revision: 1, cwd: identity.canonicalProjectPath, managedRunId: runId });
    agents.push({ ...panes.at(-1)!, name: `agent-${runId}`, interactiveReady: true, launchPending: false, stateChangeSequence: 1, agentSession: { source: "pi", agent: "pi", kind: "id", value: `member-${runId}` } });
    if (runId === userPaneRunId) panes.push({ paneId: `user-${runId}`, terminalId: `terminal-user-${runId}`, workspaceId: "workspace-1", tabId: `tab-${runId}`, focused: false, agentState: "idle", revision: 1, cwd: identity.canonicalProjectPath });
  }
  return {
    version: "0.7.5", protocol: 17, apiSchema: 1,
    focusedWorkspaceId: "workspace-1", focusedTabId: "tab-crewlead", focusedPaneId: "pane-crewlead",
    workspaces: [{ workspaceId: "workspace-1", label: "Crewlead", focused: true, activeTabId: "tab-crewlead", tabCount: tabs.length, paneCount: panes.length, agentState: "done" }],
    tabs, panes, agents,
  };
}

async function stateFixture() {
  const home = await temporaryAccountHome();
  const store = await DurableStateStore.openAtAccountHome(home.path);
  const lifecycle = new LifecycleService(store, DEFAULT_CONFIGURATION.limits);
  return { home, store, lifecycle };
}

function compact(record: BuilderWorktreeRecord): Extract<RepositoryResource, { kind: "builder_worktree" }> {
  return {
    kind: "builder_worktree",
    runId: record.runId,
    source: structuredClone(record.source),
    path: record.path,
    branch: record.branch,
    branchRef: record.branchRef,
    baseCommit: record.baseCommit,
    targetBranch: record.targetBranch,
    targetRef: record.targetRef,
    targetCommit: record.targetCommit,
    automaticIntegrationEligible: record.automaticIntegrationEligible,
  };
}

async function repositoryFixture(prefix: string, runId: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const repository = join(root, "repository");
  await mkdir(repository);
  await initializeRepository(repository);
  const isolation = new GitIsolationService();
  const plan = await isolation.planBuilderAllocation({
    runId,
    sourcePath: repository,
    destinationPath: join(root, runId),
    sessionDirectory: join(root, `${runId}-session`),
    targetBranch: "main",
    mutablePaths: ["tracked.txt"],
  });
  const record = await isolation.createBuilderWorktree(plan);
  await writeFile(join(record.path, "tracked.txt"), `${runId}\n`);
  await git(record.path, "add", "tracked.txt");
  await git(record.path, "commit", "-m", `feat: implement ${runId}`);
  const head = await git(record.path, "rev-parse", "HEAD");
  return { root, repository, record, head };
}

test("runtime cleanup enforces grace, pins, inspection leases, user panes, failure retention, and external-close provenance", async (context) => {
  const fixture = await stateFixture();
  context.after(fixture.home.cleanup);
  let now = baseTime - 120_000;
  const old = new Date(now).toISOString();
  let eligible = await seedCompleted(fixture.store, fixture.lifecycle, { runId: "eligible", createdAt: old });
  let pinned = await seedCompleted(fixture.store, fixture.lifecycle, { runId: "pinned", createdAt: old, acknowledgeAt: old });
  let leased = await seedCompleted(fixture.store, fixture.lifecycle, { runId: "leased", createdAt: old, acknowledgeAt: old });
  const userPane = await seedCompleted(fixture.store, fixture.lifecycle, { runId: "user-pane", createdAt: old, acknowledgeAt: old });
  let failedClose = await seedCompleted(fixture.store, fixture.lifecycle, { runId: "close-failure", createdAt: old, acknowledgeAt: old });
  let external = await seedCompleted(fixture.store, fixture.lifecycle, { runId: "external", createdAt: old, acknowledgeAt: old });
  const herdr = new FakeHerdrAdapter(runtimeSnapshot(["eligible", "pinned", "leased", "user-pane", "close-failure", "external"], "user-pane"));
  let ids = 0;
  const cleanup = new RuntimeCleanupService(identity, { store: fixture.store, herdr }, {
    inspectionGraceMilliseconds: 30_000,
    now: () => now,
    id: (prefix) => `${prefix}-${++ids}`,
  });
  const envelope = deliveryEnvelope({
    deliveryId: "delivery-eligible",
    runId: eligible.runId,
    destination: { crewleadSessionId: identity.crewleadSessionId, herdrWorkspaceId: identity.herdrWorkspaceId },
    createdAt: old,
  });
  await cleanup.claims.enqueue(envelope);
  const deliveryClaim = await cleanup.claims.claim("delivery-eligible", {
    crewleadSessionId: identity.crewleadSessionId,
    herdrWorkspaceId: identity.herdrWorkspaceId,
  });
  await cleanup.claims.acknowledge("delivery-eligible", deliveryClaim.claimId, {
    crewleadSessionId: identity.crewleadSessionId,
    herdrWorkspaceId: identity.herdrWorkspaceId,
  });
  now = baseTime;

  assert.equal((await cleanup.assess(eligible.runId)).eligible, true);
  pinned = await cleanup.pin({ runId: pinned.runId, expectedRevision: pinned.revision, evidenceRefs: ["human:pin"] });
  assert.equal((await cleanup.assess(pinned.runId)).reasons.includes("retained_or_pinned"), true);
  pinned = await cleanup.unpin({ runId: pinned.runId, expectedRevision: pinned.revision, evidenceRefs: ["human:unpin"] });
  assert.equal((await cleanup.assess(pinned.runId)).reasons.includes("inspection_grace_active"), true);
  leased = await cleanup.inspect({ runId: leased.runId, expectedRevision: leased.revision, leaseMilliseconds: 60_000, evidenceRefs: ["human:inspect"] });
  assert.equal((await cleanup.assess(leased.runId)).reasons.includes("inspection_lease_active"), true);
  assert.equal((await cleanup.assess(userPane.runId)).reasons.includes("unowned_user_pane"), true);

  herdr.failNext("closeTabExact");
  const failure = await cleanup.close({ requestId: "close-failure-request", runId: failedClose.runId, expectedRevision: failedClose.revision, source: "automatic", evidenceRefs: ["policy:auto-close"] });
  failedClose = failure.run;
  assert.equal(failure.closed, false);
  assert.equal(failedClose.resourceDisposition, "retained");
  assert.equal(failedClose.runtimeCleanup?.intent?.status, "failed");
  await assert.rejects(cleanup.close({ requestId: "close-failure-request", runId: failedClose.runId, expectedRevision: failedClose.revision, source: "automatic", evidenceRefs: ["policy:auto-close"] }));

  herdr.snapshotValue = {
    ...herdr.snapshotValue,
    tabs: herdr.snapshotValue.tabs.filter((tab) => tab.tabId !== external.resources!.tabId),
    panes: herdr.snapshotValue.panes.filter((pane) => pane.paneId !== external.resources!.paneId),
    agents: herdr.snapshotValue.agents.filter((agent) => agent.paneId !== external.resources!.paneId),
  };
  external = await cleanup.reconcileExternalClose({ runId: external.runId, expectedRevision: external.revision, evidenceRef: "human:closed-tab", confirmedByHuman: true });
  assert.equal(external.resourceDisposition, "closed");
  assert.equal(external.runtimeCleanup?.closeProvenance, "external");

  now += 61_000;
  assert.equal((await cleanup.assess(pinned.runId)).eligible, true);
  assert.equal((await cleanup.assess(leased.runId)).eligible, true);
});

test("capacity reclamation closes only already eligible runtimes oldest-first and preserves blocked capacity", async (context) => {
  const fixture = await stateFixture();
  context.after(fixture.home.cleanup);
  const firstAck = new Date(baseTime - 180_000).toISOString();
  const secondAck = new Date(baseTime - 120_000).toISOString();
  const freshAck = new Date(baseTime - 5_000).toISOString();
  const first = await seedCompleted(fixture.store, fixture.lifecycle, { runId: "first", createdAt: firstAck, acknowledgeAt: firstAck });
  await seedCompleted(fixture.store, fixture.lifecycle, { runId: "second", createdAt: secondAck, acknowledgeAt: secondAck });
  await seedCompleted(fixture.store, fixture.lifecycle, { runId: "fresh", createdAt: freshAck, acknowledgeAt: freshAck });
  const herdr = new FakeHerdrAdapter(runtimeSnapshot(["first", "second", "fresh"]));
  const cleanup = new RuntimeCleanupService(identity, { store: fixture.store, herdr }, {
    inspectionGraceMilliseconds: 30_000, now: () => baseTime, id: (prefix) => `${prefix}-${++operationSequence}`,
  });
  const reclaimed = await cleanup.reclaim(1);
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0]!.run.runId, first.runId);
  assert.equal(reclaimed[0]!.run.runtimeCleanup?.closeProvenance, "capacity");
  assert.equal((await cleanup.assess("fresh")).eligible, false);
  assert.deepEqual(herdr.calls.filter((call) => call.operation === "closeTabExact").map((call) => (call.input as { tabId: string }).tabId), ["tab-first"]);
});

test("local integration rejects stale targets without modification and verifies exact fast-forward despite hook failure", async (context) => {
  const staleRepository = await repositoryFixture("db11-stale-", "stale-run");
  const exactRepository = await repositoryFixture("db11-exact-", "exact-run");
  context.after(() => rm(staleRepository.root, { recursive: true, force: true }));
  context.after(() => rm(exactRepository.root, { recursive: true, force: true }));
  const fixture = await stateFixture();
  context.after(fixture.home.cleanup);
  const staleRun = await seedCompleted(fixture.store, fixture.lifecycle, {
    runId: "stale-run", createdAt: new Date(baseTime).toISOString(), projectPath: staleRepository.repository, resource: compact(staleRepository.record),
    repositoryResult: { rootDigest: staleRepository.record.source.canonicalRootDigest, baseCommit: staleRepository.record.baseCommit, headCommit: staleRepository.head }, withRuntime: false,
  });
  await writeFile(join(staleRepository.repository, "advanced.txt"), "advanced\n");
  await git(staleRepository.repository, "add", "advanced.txt");
  await git(staleRepository.repository, "commit", "-m", "test: advance target");
  const advanced = await git(staleRepository.repository, "rev-parse", "HEAD");
  const adapter = new GitDispositionAdapter();
  const noncanonical = {
    ...compact(staleRepository.record),
    branch: "db11-crew-v2/stale-run",
    branchRef: "refs/heads/db11-crew-v2/stale-run",
  };
  await assert.rejects(
    adapter.builderResourceState(noncanonical, staleRepository.head),
    (error: unknown) => (error as { code?: unknown }).code === "invalid_argument",
  );
  assert.equal(
    await git(staleRepository.repository, "rev-parse", "--verify", staleRepository.record.branchRef),
    staleRepository.head,
  );
  const staleIntegration = new BuilderIntegrationService({ ...identity, canonicalProjectPath: staleRepository.repository }, { store: fixture.store, git: adapter }, { now: () => baseTime, id: (prefix) => `${prefix}-${++operationSequence}` });
  await assert.rejects(
    staleIntegration.integrate({ requestId: "integrate-stale", runId: staleRun.runId, expectedRevision: staleRun.revision, evidenceRefs: ["human:integrate"], confirmation: "integrate_exact_builder_ff_only" }),
    (error: unknown) => (error as { code?: unknown }).code === "repository_state",
  );
  const unchangedStale = await fixture.store.readRun(staleRun.runId) as RunRecord;
  assert.equal(unchangedStale.integration, undefined, "failed live preflight must not persist durable intent");
  assert.equal(await git(staleRepository.repository, "rev-parse", "HEAD"), advanced);

  const exactRun = await seedCompleted(fixture.store, fixture.lifecycle, {
    runId: "exact-run", createdAt: new Date(baseTime).toISOString(), projectPath: exactRepository.repository, resource: compact(exactRepository.record),
    repositoryResult: { rootDigest: exactRepository.record.source.canonicalRootDigest, baseCommit: exactRepository.record.baseCommit, headCommit: exactRepository.head }, withRuntime: false,
  });
  const marker = join(exactRepository.root, "post-merge-ran");
  const hook = join(exactRepository.repository, ".git", "hooks", "post-merge");
  await writeFile(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 9\n`);
  await chmod(hook, 0o755);
  const commandLog = join(exactRepository.root, "git-command.log");
  const gitWrapper = join(exactRepository.root, "git-wrapper.sh");
  await writeFile(gitWrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(commandLog)}\nexec git "$@"\n`);
  await chmod(gitWrapper, 0o755);
  const exactAdapter = new GitDispositionAdapter({ gitExecutable: gitWrapper });
  const preflightIntentStatuses: Array<string | undefined> = [];
  const exactPreflight = exactAdapter.integrationPreflight.bind(exactAdapter);
  exactAdapter.integrationPreflight = async (...args) => {
    const observed = await fixture.store.readRun(exactRun.runId) as RunRecord;
    preflightIntentStatuses.push(observed.integration?.status);
    return exactPreflight(...args);
  };
  const exactIntegration = new BuilderIntegrationService({ ...identity, canonicalProjectPath: exactRepository.repository }, { store: fixture.store, git: exactAdapter }, { now: () => baseTime, id: (prefix) => `${prefix}-${++operationSequence}` });
  const exact = await exactIntegration.integrate({ requestId: "integrate-exact", runId: exactRun.runId, expectedRevision: exactRun.revision, evidenceRefs: ["human:integrate"], confirmation: "integrate_exact_builder_ff_only" });
  assert.equal(exact.integrated, true);
  assert.equal(exact.run.integration?.status, "completed");
  const exactReplay = await exactIntegration.integrate({ requestId: "integrate-exact", runId: exactRun.runId, expectedRevision: exact.run.revision, evidenceRefs: ["human:integrate"], confirmation: "integrate_exact_builder_ff_only" });
  assert.equal(exactReplay.idempotent, true);
  assert.equal(await git(exactRepository.repository, "rev-parse", "HEAD"), exactRepository.head);
  assert.equal(await readFile(marker, "utf8"), "ran");
  assert.deepEqual(preflightIntentStatuses, [undefined, "prepared"], "live preflight must run before intent and again before the effect");
  const commands = await readFile(commandLog, "utf8");
  assert.match(commands, new RegExp(`^merge --ff-only ${exactRepository.head}$`, "mu"));
  assert.doesNotMatch(commands, new RegExp(`^merge --ff-only ${exactRepository.record.branchRef}$`, "mu"));
});

test("integration rejects missing or foreign records and repository or worktree replacement before intent", async (context) => {
  const replacedRepository = await repositoryFixture("db11-repository-replaced-", "repository-replaced-run");
  const replacedWorktree = await repositoryFixture("db11-worktree-replaced-", "worktree-replaced-run");
  context.after(() => rm(replacedRepository.root, { recursive: true, force: true }));
  context.after(() => rm(replacedWorktree.root, { recursive: true, force: true }));
  const fixture = await stateFixture();
  context.after(fixture.home.cleanup);
  const repositoryRun = await seedCompleted(fixture.store, fixture.lifecycle, {
    runId: "repository-replaced-run", createdAt: new Date(baseTime).toISOString(), projectPath: replacedRepository.repository,
    resource: compact(replacedRepository.record),
    repositoryResult: { rootDigest: replacedRepository.record.source.canonicalRootDigest, baseCommit: replacedRepository.record.baseCommit, headCommit: replacedRepository.head },
    withRuntime: false,
  });
  const worktreeRun = await seedCompleted(fixture.store, fixture.lifecycle, {
    runId: "worktree-replaced-run", createdAt: new Date(baseTime).toISOString(), projectPath: replacedWorktree.repository,
    resource: compact(replacedWorktree.record),
    repositoryResult: { rootDigest: replacedWorktree.record.source.canonicalRootDigest, baseCommit: replacedWorktree.record.baseCommit, headCommit: replacedWorktree.head },
    withRuntime: false,
  });
  const adapter = new GitDispositionAdapter();
  const repositoryIntegration = new BuilderIntegrationService(
    { ...identity, canonicalProjectPath: replacedRepository.repository }, { store: fixture.store, git: adapter },
  );
  await assert.rejects(repositoryIntegration.integrate({
    requestId: "missing-run", runId: "missing-run", expectedRevision: 1,
    evidenceRefs: ["human:integrate"], confirmation: "integrate_exact_builder_ff_only",
  }));
  const foreignIntegration = new BuilderIntegrationService(
    { ...identity, canonicalProjectPath: `${replacedRepository.repository}-foreign` }, { store: fixture.store, git: adapter },
  );
  await assert.rejects(
    foreignIntegration.integrate({
      requestId: "foreign-run", runId: repositoryRun.runId, expectedRevision: repositoryRun.revision,
      evidenceRefs: ["human:integrate"], confirmation: "integrate_exact_builder_ff_only",
    }),
    (error: unknown) => (error as { code?: unknown }).code === "invalid_binding",
  );

  const movedRepository = join(replacedRepository.root, "original-repository");
  await rename(replacedRepository.repository, movedRepository);
  await mkdir(replacedRepository.repository);
  await initializeRepository(replacedRepository.repository);
  await assert.rejects(
    repositoryIntegration.integrate({
      requestId: "repository-replaced", runId: repositoryRun.runId, expectedRevision: repositoryRun.revision,
      evidenceRefs: ["human:integrate"], confirmation: "integrate_exact_builder_ff_only",
    }),
    (error: unknown) => (error as { code?: unknown }).code === "repository_identity",
  );
  assert.equal((await fixture.store.readRun(repositoryRun.runId) as RunRecord).integration, undefined);

  await git(replacedWorktree.repository, "worktree", "remove", "--force", "--", replacedWorktree.record.path);
  await mkdir(replacedWorktree.record.path);
  await initializeRepository(replacedWorktree.record.path);
  const worktreeIntegration = new BuilderIntegrationService(
    { ...identity, canonicalProjectPath: replacedWorktree.repository }, { store: fixture.store, git: adapter },
  );
  await assert.rejects(
    worktreeIntegration.integrate({
      requestId: "worktree-replaced", runId: worktreeRun.runId, expectedRevision: worktreeRun.revision,
      evidenceRefs: ["human:integrate"], confirmation: "integrate_exact_builder_ff_only",
    }),
    (error: unknown) => (error as { code?: unknown }).code === "repository_state",
  );
  assert.equal((await fixture.store.readRun(worktreeRun.runId) as RunRecord).integration, undefined);
  assert.equal(await git(replacedWorktree.repository, "rev-parse", "--verify", replacedWorktree.record.branchRef), replacedWorktree.head);
});

test("integration stops before Git mutation when the durable revision races after repeated preflight", async (context) => {
  const repository = await repositoryFixture("db11-integration-revision-race-", "revision-race-run");
  context.after(() => rm(repository.root, { recursive: true, force: true }));
  const fixture = await stateFixture();
  context.after(fixture.home.cleanup);
  const run = await seedCompleted(fixture.store, fixture.lifecycle, {
    runId: "revision-race-run", createdAt: new Date(baseTime).toISOString(), projectPath: repository.repository,
    resource: compact(repository.record),
    repositoryResult: { rootDigest: repository.record.source.canonicalRootDigest, baseCommit: repository.record.baseCommit, headCommit: repository.head },
    withRuntime: false,
  });
  const adapter = new GitDispositionAdapter();
  const integrationPreflight = adapter.integrationPreflight.bind(adapter);
  let preflights = 0;
  adapter.integrationPreflight = async (...args) => {
    const result = await integrationPreflight(...args);
    preflights += 1;
    if (preflights === 2) {
      const current = await fixture.store.readRun(run.runId) as RunRecord;
      await mutate(fixture.store, current, new Date(baseTime).toISOString(), () => {});
    }
    return result;
  };
  const integration = new BuilderIntegrationService(
    { ...identity, canonicalProjectPath: repository.repository }, { store: fixture.store, git: adapter },
    { now: () => baseTime, id: (prefix) => `${prefix}-${++operationSequence}` },
  );
  const stopped = await integration.integrate({
    requestId: "integration-revision-race", runId: run.runId, expectedRevision: run.revision,
    evidenceRefs: ["human:integrate"], confirmation: "integrate_exact_builder_ff_only",
  });
  assert.equal(stopped.integrated, false);
  assert.equal(stopped.run.integration?.status, "failed");
  assert.equal(await git(repository.repository, "rev-parse", "HEAD"), repository.record.baseCommit);
  assert.equal(await git(repository.repository, "rev-parse", "--verify", repository.record.branchRef), repository.head);
});

test("unchanged detached snapshot cleanup removes only the exact closed run resource", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "db11-read-cleanup-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  await mkdir(repository);
  await initializeRepository(repository);
  await git(repository, "branch", "foreign/keep");
  const isolation = new GitIsolationService();
  const snapshot = await isolation.createReadSnapshot({ runId: "read-run", sourcePath: repository, destinationPath: join(root, "read-run") });
  const resource: RepositoryResource = {
    kind: "read_snapshot", runId: snapshot.runId, source: structuredClone(snapshot.source), path: snapshot.path,
    sourceHead: snapshot.sourceHead, baselineManifestDigest: snapshot.baselineManifest.digest,
  };
  const fixture = await stateFixture();
  context.after(fixture.home.cleanup);
  let run = await seedCompleted(fixture.store, fixture.lifecycle, {
    runId: "read-run", createdAt: new Date(baseTime).toISOString(), projectPath: repository, resource, withRuntime: false,
  });
  run = await mutate(fixture.store, run, new Date(baseTime).toISOString(), (next) => { next.resourceDisposition = "closed"; });
  const cleanup = new RepositoryCleanupService({ ...identity, canonicalProjectPath: repository }, { store: fixture.store, git: new GitDispositionAdapter() }, { now: () => baseTime, id: (prefix) => `${prefix}-${++operationSequence}` });
  const result = await cleanup.cleanup({ requestId: "cleanup-read", runId: run.runId, expectedRevision: run.revision, authorization: "read_snapshot", evidenceRefs: ["human:cleanup"] });
  assert.equal(result.completed, true);
  await assert.rejects(realpath(snapshot.path), { code: "ENOENT" });
  assert.equal(await git(repository, "rev-parse", "--verify", "refs/heads/foreign/keep"), snapshot.sourceHead);
});

test("merged cleanup, confirmed discard, partial reconciliation, and foreign-resource preservation are exact", async (context) => {
  const mergedRepository = await repositoryFixture("db11-merged-cleanup-", "merged-run");
  const discardRepository = await repositoryFixture("db11-discard-cleanup-", "discard-run");
  context.after(() => rm(mergedRepository.root, { recursive: true, force: true }));
  context.after(() => rm(discardRepository.root, { recursive: true, force: true }));
  const fixture = await stateFixture();
  context.after(fixture.home.cleanup);
  const adapter = new GitDispositionAdapter();
  const mergedIdentity = { ...identity, canonicalProjectPath: mergedRepository.repository };
  const mergedIntegration = new BuilderIntegrationService(mergedIdentity, { store: fixture.store, git: adapter }, { now: () => baseTime, id: (prefix) => `${prefix}-${++operationSequence}` });
  const mergedCleanup = new RepositoryCleanupService(mergedIdentity, { store: fixture.store, git: adapter }, { now: () => baseTime, id: (prefix) => `${prefix}-${++operationSequence}` });

  let merged = await seedCompleted(fixture.store, fixture.lifecycle, {
    runId: "merged-run", createdAt: new Date(baseTime).toISOString(), projectPath: mergedRepository.repository, resource: compact(mergedRepository.record),
    repositoryResult: { rootDigest: mergedRepository.record.source.canonicalRootDigest, baseCommit: mergedRepository.record.baseCommit, headCommit: mergedRepository.head }, withRuntime: false,
  });
  const foreignWorktree = join(mergedRepository.root, "foreign-worktree");
  await git(mergedRepository.repository, "worktree", "add", "-b", "foreign/keep", foreignWorktree, "HEAD");
  merged = (await mergedIntegration.integrate({ requestId: "merge-before-cleanup", runId: merged.runId, expectedRevision: merged.revision, evidenceRefs: ["human:integrate"], confirmation: "integrate_exact_builder_ff_only" })).run;
  merged = await mutate(fixture.store, merged, new Date(baseTime).toISOString(), (next) => { next.resourceDisposition = "closed"; });

  const originalRemoveWorktree = adapter.removeBuilderWorktree.bind(adapter);
  const originalRemoveBranch = adapter.removeBuilderBranch.bind(adapter);
  let worktreeRemovals = 0;
  let failBranchOnce = true;
  adapter.removeBuilderWorktree = async (...args) => { worktreeRemovals += 1; await originalRemoveWorktree(...args); };
  adapter.removeBuilderBranch = async (...args) => {
    if (failBranchOnce) { failBranchOnce = false; throw new Error("deterministic branch failure"); }
    await originalRemoveBranch(...args);
  };
  let partial = await mergedCleanup.cleanup({ requestId: "cleanup-merged", runId: merged.runId, expectedRevision: merged.revision, authorization: "integrated", evidenceRefs: ["human:cleanup"] });
  assert.equal(partial.completed, false);
  assert.equal(partial.run.repositoryCleanup?.worktreeRemoved, true);
  partial = await mergedCleanup.cleanup({ requestId: "cleanup-merged", runId: merged.runId, expectedRevision: partial.run.revision, authorization: "integrated", evidenceRefs: ["human:cleanup"] });
  assert.equal(partial.completed, true, JSON.stringify(partial.run.repositoryCleanup));
  const cleanupReplay = await mergedCleanup.cleanup({ requestId: "cleanup-merged", runId: merged.runId, expectedRevision: partial.run.revision, authorization: "integrated", evidenceRefs: ["human:cleanup"] });
  assert.equal(cleanupReplay.idempotent, true);
  assert.equal(worktreeRemovals, 1, "the successful destructive worktree phase must not repeat");
  assert.equal(await git(mergedRepository.repository, "rev-parse", "--verify", "refs/heads/foreign/keep"), mergedRepository.record.baseCommit);
  assert.equal(await git(foreignWorktree, "rev-parse", "--show-toplevel"), foreignWorktree);

  let discard = await seedCompleted(fixture.store, fixture.lifecycle, {
    runId: "discard-run", createdAt: new Date(baseTime).toISOString(), projectPath: discardRepository.repository, resource: compact(discardRepository.record),
    repositoryResult: { rootDigest: discardRepository.record.source.canonicalRootDigest, baseCommit: discardRepository.record.baseCommit, headCommit: discardRepository.head }, withRuntime: false,
  });
  discard = await mutate(fixture.store, discard, new Date(baseTime).toISOString(), (next) => { next.resourceDisposition = "closed"; });
  await writeFile(join(discardRepository.record.path, "untracked-artifact.txt"), "acknowledged disposable artifact\n");
  const discardCleanup = new RepositoryCleanupService({ ...identity, canonicalProjectPath: discardRepository.repository }, { store: fixture.store, git: adapter }, { now: () => baseTime, id: (prefix) => `${prefix}-${++operationSequence}` });
  const discarded = await discardCleanup.cleanup({
    requestId: "cleanup-discard", runId: discard.runId, expectedRevision: discard.revision,
    authorization: "discard", evidenceRefs: ["human:cleanup"], confirmation: "discard_exact_unmerged_artifacts",
    acknowledgedArtifacts: ["artifact:untracked-artifact.txt"],
  });
  assert.equal(discarded.completed, true);
  await assert.rejects(git(discardRepository.repository, "rev-parse", "--verify", discardRepository.record.branchRef));
});

test("superseded cleanup retains an unmerged exact branch and preserves replacement resources", async (context) => {
  const original = await repositoryFixture("db11-superseded-", "superseded-run");
  context.after(() => rm(original.root, { recursive: true, force: true }));
  const isolation = new GitIsolationService();
  const replacementPlan = await isolation.planBuilderAllocation({
    runId: "replacement-run", sourcePath: original.repository,
    destinationPath: join(original.root, "replacement-run"),
    sessionDirectory: join(original.root, "replacement-run-session"),
    targetBranch: "main", mutablePaths: ["tracked.txt"],
  });
  const replacementRecord = await isolation.createBuilderWorktree(replacementPlan);
  await writeFile(join(replacementRecord.path, "tracked.txt"), "replacement\n");
  await git(replacementRecord.path, "add", "tracked.txt");
  await git(replacementRecord.path, "commit", "-m", "feat: implement replacement");
  const replacementHead = await git(replacementRecord.path, "rev-parse", "HEAD");

  const fixture = await stateFixture();
  context.after(fixture.home.cleanup);
  let superseded = await seedCompleted(fixture.store, fixture.lifecycle, {
    runId: "superseded-run", createdAt: new Date(baseTime).toISOString(), projectPath: original.repository,
    resource: compact(original.record),
    repositoryResult: { rootDigest: original.record.source.canonicalRootDigest, baseCommit: original.record.baseCommit, headCommit: original.head },
    withRuntime: false,
  });
  let replacement = await seedCompleted(fixture.store, fixture.lifecycle, {
    runId: "replacement-run", createdAt: new Date(baseTime).toISOString(), projectPath: original.repository,
    resource: compact(replacementRecord),
    repositoryResult: { rootDigest: replacementRecord.source.canonicalRootDigest, baseCommit: replacementRecord.baseCommit, headCommit: replacementHead },
    withRuntime: false,
  });
  const adapter = new GitDispositionAdapter();
  const integration = new BuilderIntegrationService(
    { ...identity, canonicalProjectPath: original.repository }, { store: fixture.store, git: adapter },
    { now: () => baseTime, id: (prefix) => `${prefix}-${++operationSequence}` },
  );
  replacement = (await integration.integrate({
    requestId: "integrate-replacement", runId: replacement.runId, expectedRevision: replacement.revision,
    evidenceRefs: ["human:integrate"], confirmation: "integrate_exact_builder_ff_only",
  })).run;
  superseded = await mutate(fixture.store, superseded, new Date(baseTime).toISOString(), (next) => { next.resourceDisposition = "closed"; });
  const cleanup = new RepositoryCleanupService(
    { ...identity, canonicalProjectPath: original.repository }, { store: fixture.store, git: adapter },
    { now: () => baseTime, id: (prefix) => `${prefix}-${++operationSequence}` },
  );
  const result = await cleanup.cleanup({
    requestId: "cleanup-superseded", runId: superseded.runId, expectedRevision: superseded.revision,
    authorization: "superseded", replacementRunId: replacement.runId, evidenceRefs: ["human:cleanup"],
  });
  assert.equal(result.completed, true);
  assert.equal(result.run.repositoryCleanup?.branchRemoved, false);
  assert.match(result.run.repositoryCleanup?.diagnostic ?? "", /superseded unmerged branch remains/u);
  await assert.rejects(realpath(original.record.path), { code: "ENOENT" });
  assert.equal(await git(original.repository, "rev-parse", "--verify", original.record.branchRef), original.head);
  assert.equal(await realpath(replacementRecord.path), replacementRecord.path);
  assert.equal(await git(original.repository, "rev-parse", "--verify", replacementRecord.branchRef), replacementHead);
});

test("cleanup repeats target checks after intent and preserves resources on a target race", async (context) => {
  const repository = await repositoryFixture("db11-target-race-", "target-race-run");
  context.after(() => rm(repository.root, { recursive: true, force: true }));
  const fixture = await stateFixture();
  context.after(fixture.home.cleanup);
  let run = await seedCompleted(fixture.store, fixture.lifecycle, {
    runId: "target-race-run", createdAt: new Date(baseTime).toISOString(), projectPath: repository.repository,
    resource: compact(repository.record),
    repositoryResult: { rootDigest: repository.record.source.canonicalRootDigest, baseCommit: repository.record.baseCommit, headCommit: repository.head },
    withRuntime: false,
  });
  run = await mutate(fixture.store, run, new Date(baseTime).toISOString(), (next) => { next.resourceDisposition = "closed"; });
  const adapter = new GitDispositionAdapter();
  const targetHead = adapter.targetHead.bind(adapter);
  let targetObservations = 0;
  adapter.targetHead = async (...args) => {
    targetObservations += 1;
    if (targetObservations === 2) {
      await writeFile(join(repository.repository, "target-race.txt"), "raced\n");
      await git(repository.repository, "add", "target-race.txt");
      await git(repository.repository, "commit", "-m", "test: race cleanup target");
    }
    return targetHead(...args);
  };
  const cleanup = new RepositoryCleanupService(
    { ...identity, canonicalProjectPath: repository.repository }, { store: fixture.store, git: adapter },
    { now: () => baseTime, id: (prefix) => `${prefix}-${++operationSequence}` },
  );
  const stopped = await cleanup.cleanup({
    requestId: "cleanup-target-race", runId: run.runId, expectedRevision: run.revision,
    authorization: "discard", evidenceRefs: ["human:cleanup"], confirmation: "discard_exact_unmerged_artifacts",
    acknowledgedArtifacts: ["artifact:target-race"],
  });
  assert.equal(stopped.completed, false);
  assert.equal(stopped.run.repositoryCleanup?.worktreeRemoved, false);
  assert.equal(await realpath(repository.record.path), repository.record.path);
  assert.equal(await git(repository.repository, "rev-parse", "--verify", repository.record.branchRef), repository.head);
});

test("expected-old-object deletion stops on a raced branch and exact absence reconciles safely", async (context) => {
  const racedRepository = await repositoryFixture("db11-raced-cleanup-", "raced-run");
  const absentRepository = await repositoryFixture("db11-absent-cleanup-", "absent-run");
  context.after(() => rm(racedRepository.root, { recursive: true, force: true }));
  context.after(() => rm(absentRepository.root, { recursive: true, force: true }));
  const fixture = await stateFixture();
  context.after(fixture.home.cleanup);

  await git(racedRepository.repository, "branch", "db11-crew/sibling-keep", racedRepository.record.baseCommit);
  let raced = await seedCompleted(fixture.store, fixture.lifecycle, {
    runId: "raced-run", createdAt: new Date(baseTime).toISOString(), projectPath: racedRepository.repository,
    resource: compact(racedRepository.record),
    repositoryResult: { rootDigest: racedRepository.record.source.canonicalRootDigest, baseCommit: racedRepository.record.baseCommit, headCommit: racedRepository.head },
    withRuntime: false,
  });
  raced = await mutate(fixture.store, raced, new Date(baseTime).toISOString(), (next) => { next.resourceDisposition = "closed"; });
  const realGit = (await execute("sh", ["-c", "command -v git"], { encoding: "utf8" })).stdout.trim();
  const racingGit = join(racedRepository.root, "racing-git.sh");
  await writeFile(racingGit, `#!/bin/sh\nif [ "$1" = update-ref ] && [ "$2" = -d ] && [ "$3" = ${JSON.stringify(racedRepository.record.branchRef)} ]; then\n  ${JSON.stringify(realGit)} update-ref "$3" ${racedRepository.record.baseCommit}\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`);
  await chmod(racingGit, 0o755);
  const racedCleanup = new RepositoryCleanupService(
    { ...identity, canonicalProjectPath: racedRepository.repository },
    { store: fixture.store, git: new GitDispositionAdapter({ gitExecutable: racingGit }) },
    { now: () => baseTime, id: (prefix) => `${prefix}-${++operationSequence}` },
  );
  const stopped = await racedCleanup.cleanup({
    requestId: "cleanup-raced", runId: raced.runId, expectedRevision: raced.revision,
    authorization: "discard", evidenceRefs: ["human:cleanup"], confirmation: "discard_exact_unmerged_artifacts",
    acknowledgedArtifacts: ["artifact:raced-branch"],
  });
  assert.equal(stopped.completed, false);
  assert.equal(stopped.run.repositoryCleanup?.worktreeRemoved, true);
  assert.equal(await git(racedRepository.repository, "rev-parse", "--verify", racedRepository.record.branchRef), racedRepository.record.baseCommit);
  assert.equal(await git(racedRepository.repository, "rev-parse", "--verify", "refs/heads/db11-crew/sibling-keep"), racedRepository.record.baseCommit);
  await assert.rejects(realpath(racedRepository.record.path), { code: "ENOENT" });

  await git(absentRepository.repository, "worktree", "remove", "--force", "--", absentRepository.record.path);
  await git(absentRepository.repository, "update-ref", "-d", absentRepository.record.branchRef, absentRepository.head);
  let absent = await seedCompleted(fixture.store, fixture.lifecycle, {
    runId: "absent-run", createdAt: new Date(baseTime).toISOString(), projectPath: absentRepository.repository,
    resource: compact(absentRepository.record),
    repositoryResult: { rootDigest: absentRepository.record.source.canonicalRootDigest, baseCommit: absentRepository.record.baseCommit, headCommit: absentRepository.head },
    withRuntime: false,
  });
  absent = await mutate(fixture.store, absent, new Date(baseTime).toISOString(), (next) => { next.resourceDisposition = "closed"; });
  const absentCleanup = new RepositoryCleanupService(
    { ...identity, canonicalProjectPath: absentRepository.repository },
    { store: fixture.store, git: new GitDispositionAdapter() },
    { now: () => baseTime, id: (prefix) => `${prefix}-${++operationSequence}` },
  );
  const reconciled = await absentCleanup.cleanup({
    requestId: "cleanup-absent", runId: absent.runId, expectedRevision: absent.revision,
    authorization: "discard", evidenceRefs: ["human:cleanup"], confirmation: "discard_exact_unmerged_artifacts",
    acknowledgedArtifacts: ["artifact:already-absent"],
  });
  assert.equal(reconciled.completed, true);
  assert.equal(reconciled.run.repositoryCleanup?.worktreeRemoved, true);
  assert.equal(reconciled.run.repositoryCleanup?.branchRemoved, true);
});
