import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { installMemberCompanion } from "../../src/companion/extension.ts";
import { CompanionProtocol } from "../../src/companion/protocol.ts";
import { LifecycleService, type RunRecord } from "../../src/orchestration/lifecycle.ts";
import { LIMITS } from "../../src/protocol/limits.ts";
import { parseContractText } from "../../src/protocol/validate.ts";
import { RunCapabilityManager, type CompanionConfiguration } from "../../src/security/capabilities.ts";
import { StateSecurityError } from "../../src/security/errors.ts";
import { FencedLeaseManager } from "../../src/state/leases.ts";
import { DurableStateStore } from "../../src/state/store.ts";
import { SecureStateRoot } from "../../src/state/filesystem.ts";
import { temporaryAccountHome } from "../security/helpers.ts";

const timestamp = "2026-08-17T12:00:00Z";
const later = "2026-08-17T12:00:01Z";

function packet(role: "scout" | "builder" = "scout") {
  return {
    schemaVersion: 1 as const,
    packetId: "packet-1",
    resultContractVersion: 1 as const,
    role,
    objective: "Inspect the bounded repository evidence.",
    scope: {
      readPaths: ["."],
      ...(role === "builder" ? { mutablePaths: ["tracked.txt"] } : {}),
    },
    inputs: [],
    constraints: ["Keep repository content inside the bounded task."],
    nonGoals: ["Do not mutate remote state."],
    deliverables: [{ id: "report", description: "Produce a bounded report.", required: true }],
    validation: [{ id: "tests", description: "Run focused validation.", required: true }],
    completionCriteria: [{ id: "complete", description: "Account for the report.", required: true }],
    escalationConditions: ["Block when required evidence is missing."],
    ...(role === "builder" ? {
      executionGrants: [{ id: "git", executable: "git", argumentPrefixes: [["status"], ["add"], ["commit"]] }],
    } : {}),
  };
}

function configuration(project: string, role: "scout" | "builder" = "scout"): CompanionConfiguration {
  return {
    schemaVersion: 2,
    packageName: "@debonzi/db11-crew",
    packageVersion: "0.2.0",
    memberExtensionPath: "agents/pi/extensions/db11-crew-member/index.ts",
    memberExtensionSha256: "a".repeat(64),
    roleProfileVersion: 2,
    roleProfilePath: `agents/pi/roles/${role}.md`,
    roleProfileSha256: "b".repeat(64),
    assignedRoot: project,
    sourceCanonicalProjectPath: project,
    packet: packet(role),
    progressEnabled: true,
  } as CompanionConfiguration;
}

function result(run: RunRecord, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    resultContractVersion: 1,
    resultId: "result-1",
    runId: run.runId,
    packetId: run.packetId,
    role: "scout",
    profileVersion: 2,
    outcome: "completed",
    summary: "The bounded repository evidence was inspected.",
    deliverables: [{ id: "report", status: "produced", references: ["evidence:report"] }],
    completionCriteria: [{ id: "complete", status: "passed", evidenceRefs: ["evidence:report"] }],
    validation: [{ id: "tests", status: "passed", evidenceRefs: ["evidence:tests"], summary: "Focused validation passed." }],
    unresolvedBlockerIds: [],
    unresolvedDecisions: [],
    stateChanges: [],
    durableReferences: ["evidence:report"],
    recommendedNextSteps: [],
    roleDetails: { role: "scout", repositoryManifestDigest: "b".repeat(64), evidenceRefs: ["evidence:report"] },
    ...overrides,
  };
}

function authoritativeBuilderEvidence(run: Readonly<RunRecord>, overrides: Record<string, unknown> = {}) {
  const resource = run.repositoryResource;
  if (resource?.kind !== "builder_worktree") throw new Error("Builder fixture resource is unavailable.");
  return {
    repositoryRootDigest: resource.source.canonicalRootDigest,
    baseCommit: resource.baseCommit,
    headCommit: resource.baseCommit,
    commits: [],
    changedPaths: [],
    noChange: true,
    worktreeClean: true,
    ...overrides,
  };
}

function builderResult(run: RunRecord, overrides: Record<string, unknown> = {}) {
  const evidence = authoritativeBuilderEvidence(run);
  return result(run, {
    role: "builder",
    roleDetails: {
      role: "builder",
      repository: {
        rootDigest: evidence.repositoryRootDigest,
        baseCommit: evidence.baseCommit,
        headCommit: evidence.headCommit,
      },
      commits: evidence.commits,
      changedPaths: evidence.changedPaths,
      noChange: evidence.noChange,
      worktreeClean: evidence.worktreeClean,
    },
    ...overrides,
  });
}

async function fixture(
  nowValue = 1_000_000,
  role: "scout" | "builder" = "scout",
  verifyBuilderOutcome?: NonNullable<ConstructorParameters<typeof CompanionProtocol>[5]>["verifyBuilderOutcome"],
) {
  const home = await temporaryAccountHome();
  const project = join(home.path, "project");
  await mkdir(project, { mode: 0o700 });
  const root = await SecureStateRoot.openAtAccountHome(home.path, { now: () => nowValue });
  const store = await DurableStateStore.openAtAccountHome(home.path, { now: () => nowValue });
  const lifecycle = new LifecycleService(store, {
    maxActiveMembers: 6,
    maxOpenMemberResources: 6,
    maxQueuedDelegations: 6,
  });
  const admitted = (await lifecycle.admitBatch({
    candidates: [{
      admissionId: "admission-1",
      runId: "run-1",
      packetId: "packet-1",
      intentDigest: "c".repeat(64),
      purposeLabel: "inspect evidence",
      role,
      binding: {
        crewleadSessionId: "crewlead-session",
        memberSessionId: "member-session",
        herdrWorkspaceId: "workspace-1",
        canonicalProjectPath: project,
      },
      retentionPolicy: "retain",
      createdAt: timestamp,
    }],
    mode: "start",
    actor: "crewlead",
    evidenceRefs: ["request:authorized"],
  })).runs[0]!;
  let working = await lifecycle.transition({
    operationId: "startup-working",
    runId: admitted.runId,
    expectedRevision: admitted.revision,
    expectedFencingEpoch: admitted.fencingEpoch,
    actor: "crewlead",
    targetState: "working",
    reason: "The exact member prompt was acknowledged.",
    evidenceRefs: ["prompt:acknowledged"],
    timestamp: later,
  });
  if (role === "builder") {
    const previous = working;
    const next = structuredClone(previous);
    next.revision += 1;
    next.updatedAt = "2026-08-17T12:00:02Z";
    next.resourceDisposition = "open";
    next.startup = {
      phase: "prompt_acknowledged",
      assignedRoot: project,
      sessionDirectory: join(home.path, "builder-session"),
    };
    next.repositoryResource = {
      kind: "builder_worktree",
      runId: next.runId,
      source: {
        canonicalRoot: project,
        canonicalRootDigest: "a".repeat(64),
        commonGitDirectory: join(project, ".git"),
        commonGitDirectoryDigest: "b".repeat(64),
        commonGitDevice: "1",
        commonGitInode: "2",
      },
      path: project,
      branch: `db11-crew/${next.runId}`,
      branchRef: `refs/heads/db11-crew/${next.runId}`,
      baseCommit: "c".repeat(40),
      targetBranch: "main",
      targetRef: "refs/heads/main",
      targetCommit: "c".repeat(40),
      protectedRefDigest: "d".repeat(64),
      automaticIntegrationEligible: true,
    };
    const committed = await store.commitRun({
      operationId: "builder-resource-binding",
      expectedRevision: previous.revision,
      expectedFencingEpoch: previous.fencingEpoch,
      run: next,
      history: [{
        kind: "lifecycle",
        payload: {
          schemaVersion: 1,
          eventId: "builder-resource-binding",
          runId: next.runId,
          sequence: next.revision,
          timestamp: next.updatedAt,
          actor: "crewlead",
          type: "diagnostic",
          reason: "The deterministic fixture bound the exact Builder resource.",
          evidenceRefs: ["test:builder-resource"],
          expectedPriorState: previous.state,
          resultingState: next.state,
          expectedRevision: previous.revision,
          resultingRevision: next.revision,
          fencingEpoch: next.fencingEpoch,
        },
      }],
    });
    working = committed.run as RunRecord;
  }
  const binding = {
    protocolVersion: 1 as const,
    crewleadSessionId: "crewlead-session",
    herdrWorkspaceId: "workspace-1",
    canonicalProjectPath: project,
    runId: "run-1",
    memberSessionId: "member-session",
    role,
    fencingEpoch: 1,
  };
  const manager = new RunCapabilityManager(root, { now: () => nowValue });
  const config = configuration(project, role);
  const locator = await manager.provision(binding, config);
  const claimed = await manager.claimCompanionBootstrap(locator.bootstrapPath, {
    memberSessionId: binding.memberSessionId,
    role: binding.role,
  });
  const rendered: Array<unknown> = [];
  const protocol = new CompanionProtocol(store, manager, binding, claimed.capabilities, config, {
    now: () => nowValue,
    onProgress: (frame) => rendered.push(frame),
    ...(verifyBuilderOutcome === undefined ? {} : { verifyBuilderOutcome }),
  });
  return { home, root, store, lifecycle, working, binding, manager, config, locator, claimed, protocol, rendered };
}

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const memberExtensionPath = join(packageRoot, "agents/pi/extensions/db11-crew-member/index.ts");
const roleProfilePath = join(packageRoot, "agents/pi/roles/scout.md");
const companionToolNames = ["db11_report_blocker", "db11_finalize"] as const;

type CompanionHandler = (...args: never[]) => unknown;

interface CompanionHarness {
  api: ExtensionAPI;
  context: ExtensionContext;
  notifications: string[];
  tools: Map<string, { execute: (...args: never[]) => Promise<unknown> }>;
  timers: Array<{ callback: () => void; cleared: boolean }>;
  activeTools(): string[];
  setSessionId(value: string): void;
  emit(name: string, event?: Record<string, unknown>): Promise<unknown>;
}

function companionHarness(options: {
  cwd: string;
  scheduleFailureAt?: number;
  activeToolFailure?: boolean;
}): CompanionHarness & {
  scheduleInterval: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearScheduledInterval: (timer: NodeJS.Timeout) => void;
} {
  const handlers = new Map<string, CompanionHandler[]>();
  const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
  const notifications: string[] = [];
  const timers: Array<{ callback: () => void; cleared: boolean; handle: NodeJS.Timeout }> = [];
  let activeTools = ["read", "ambient_shell"];
  let sessionId = "member-session";
  const context = {
    hasUI: true,
    cwd: options.cwd,
    isIdle: () => true,
    abort() {},
    isProjectTrusted: () => true,
    sessionManager: {
      getEntries: () => [],
      getSessionId: () => sessionId,
    },
    ui: { notify(message: string) { notifications.push(message); } },
  } as unknown as ExtensionContext;
  const api = {
    registerTool(tool: { name: string; execute: (...args: never[]) => Promise<unknown> }) {
      tools.set(tool.name, tool);
      activeTools.push(tool.name);
    },
    on(name: string, handler: CompanionHandler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools(names: string[]) {
      if (options.activeToolFailure && companionToolNames.every((name) => names.includes(name))) {
        throw new Error("token=activation-secret /private/path");
      }
      activeTools = [...new Set(names)];
    },
    events: { emit() {}, on() {} },
  } as unknown as ExtensionAPI;
  const scheduleInterval = (callback: () => void, _milliseconds: number): NodeJS.Timeout => {
    if (options.scheduleFailureAt === timers.length + 1) {
      throw new Error("token=timer-secret /private/path");
    }
    const handle = { unref() {} } as unknown as NodeJS.Timeout;
    timers.push({ callback, cleared: false, handle });
    return handle;
  };
  const clearScheduledInterval = (handle: NodeJS.Timeout): void => {
    const timer = timers.find((candidate) => candidate.handle === handle);
    if (timer) timer.cleared = true;
  };
  return {
    api,
    context,
    notifications,
    tools,
    timers,
    scheduleInterval,
    clearScheduledInterval,
    activeTools: () => [...activeTools],
    setSessionId(value) { sessionId = value; },
    async emit(name, event = { type: name }) {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) {
        result = await handler(event as never, context as never);
      }
      return result;
    },
  };
}

async function extensionFixture(withRun = true) {
  const home = await temporaryAccountHome();
  const project = join(home.path, "project");
  await mkdir(project, { mode: 0o700 });
  const root = await SecureStateRoot.openAtAccountHome(home.path);
  const store = await DurableStateStore.openAtAccountHome(home.path);
  if (withRun) {
    const lifecycle = new LifecycleService(store, {
      maxActiveMembers: 6,
      maxOpenMemberResources: 6,
      maxQueuedDelegations: 6,
    });
    const admitted = (await lifecycle.admitBatch({
      candidates: [{
        admissionId: "admission-extension",
        runId: "run-extension",
        packetId: "packet-1",
        intentDigest: "e".repeat(64),
        purposeLabel: "exercise companion extension",
        role: "scout",
        binding: {
          crewleadSessionId: "crewlead-session",
          memberSessionId: "member-session",
          herdrWorkspaceId: "workspace-1",
          canonicalProjectPath: project,
        },
        retentionPolicy: "retain",
        createdAt: timestamp,
      }],
      mode: "start",
      actor: "crewlead",
      evidenceRefs: ["request:authorized"],
    })).runs[0]!;
    await lifecycle.transition({
      operationId: "extension-working",
      runId: admitted.runId,
      expectedRevision: admitted.revision,
      expectedFencingEpoch: admitted.fencingEpoch,
      actor: "crewlead",
      targetState: "working",
      reason: "The exact member prompt was acknowledged.",
      evidenceRefs: ["prompt:acknowledged"],
      timestamp: later,
    });
  }
  const manifest = JSON.parse(await readFile(join(packageRoot, "agents/pi/roles/manifest.json"), "utf8")) as {
    resources: Array<{ id: string; resourcePath: string; sha256: string }>;
    roles: Array<{ id: string; profilePath: string; profileSha256: string }>;
  };
  const entry = manifest.resources.find((resource) => resource.id === "member_companion")!;
  const profile = manifest.roles.find((candidate) => candidate.id === "scout")!;
  const config = {
    ...configuration(project),
    memberExtensionPath: entry.resourcePath,
    memberExtensionSha256: entry.sha256,
    roleProfilePath: profile.profilePath,
    roleProfileSha256: profile.profileSha256,
  } as CompanionConfiguration;
  const binding = {
    protocolVersion: 1 as const,
    crewleadSessionId: "crewlead-session",
    herdrWorkspaceId: "workspace-1",
    canonicalProjectPath: project,
    runId: "run-extension",
    memberSessionId: "member-session",
    role: "scout" as const,
    fencingEpoch: 1,
  };
  const manager = new RunCapabilityManager(root);
  const locator = await manager.provision(binding, config);
  const environment = {
    DB11_CREW_ROLE: "scout",
    DB11_CREW_MEMBER_BOOTSTRAP: locator.bootstrapPath,
    DB11_CREW_MEMBER_EXTENSION_PATH: memberExtensionPath,
    DB11_CREW_ROLE_PROFILE_PATH: roleProfilePath,
  };
  return { home, project, root, store, binding, manager, environment };
}

function leaseBinding(value: Awaited<ReturnType<typeof extensionFixture>>) {
  return {
    protocolVersion: 1 as const,
    scope: "companion" as const,
    crewleadSessionId: value.binding.crewleadSessionId,
    herdrWorkspaceId: value.binding.herdrWorkspaceId,
    canonicalProjectPath: value.binding.canonicalProjectPath,
    runId: value.binding.runId,
    memberSessionId: value.binding.memberSessionId,
    role: value.binding.role,
  };
}

async function settleProgress(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("The expected asynchronous companion state was not observed.");
}

async function meta(protocol: CompanionProtocol, plane: "control" | "finalization", messageId: string) {
  const run = await protocol.currentRun();
  return { messageId, sequence: await protocol.nextSequence(plane), expectedRevision: run.revision };
}

function blocker(run: RunRecord, revision = 1, status: "open" | "cleared" = "open") {
  return {
    schemaVersion: 1,
    blockerId: "blocker-1",
    blockerRevision: revision,
    runId: run.runId,
    expectedRevision: run.revision,
    status,
    category: "missing_input",
    summary: status === "open" ? "Required evidence is missing." : "The required evidence was supplied.",
    requiredDecision: "Provide the evidence or narrow the task.",
    options: [],
    evidenceRefs: ["evidence:missing"],
    decisionOwner: "human",
  };
}

test("companion bootstrap is one-time, exact-session bound, and carries strict non-secret readiness", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  await assert.rejects(
    value.manager.claimCompanionBootstrap(value.locator.bootstrapPath, { memberSessionId: "wrong-session", role: "scout" }),
    (error) => error instanceof StateSecurityError && ["bootstrap_invalid", "bootstrap_used", "not_found"].includes(error.code),
  );
  assert.equal(value.claimed.configuration.packet.packetId, "packet-1");
  assert.equal((await value.protocol.currentRun()).binding.memberSessionId, "member-session");

  const secondBinding = { ...value.binding, runId: "run-2", memberSessionId: "member-session-2" };
  const second = await value.manager.provision(secondBinding, value.config);
  await assert.rejects(
    value.manager.claimCompanionBootstrap(second.bootstrapPath, { memberSessionId: "wrong-session", role: "scout" }),
    (error) => error instanceof StateSecurityError && error.code === "bootstrap_invalid",
  );
  const exact = await value.manager.claimCompanionBootstrap(second.bootstrapPath, {
    memberSessionId: "member-session-2",
    role: "scout",
  });
  assert.equal(exact.binding.runId, "run-2");
});

test("the explicitly loaded companion registers only authenticated control-plane tools at inert startup", () => {
  const tools: string[] = [];
  const schemas = new Map<string, unknown>();
  const events: string[] = [];
  const fake = {
    registerTool(tool: { name: string; parameters: unknown }) {
      tools.push(tool.name);
      schemas.set(tool.name, tool.parameters);
    },
    on(name: string) { events.push(name); },
    events: { emit() {}, on() {} },
  } as unknown as ExtensionAPI;
  installMemberCompanion(fake, {
    extensionPath: "/package/agents/pi/extensions/db11-crew-member/index.ts",
    environment: { DB11_CREW_ROLE: "scout" },
  });
  assert.deepEqual(tools.sort(), ["db11_finalize", "db11_report_blocker"]);
  assert.equal(tools.some((name) => name.includes("dispatch") || name.includes("cleanup") || name.includes("integrate")), false);
  for (const name of ["db11_report_blocker", "db11_finalize"]) {
    const serialized = JSON.stringify(schemas.get(name));
    assert.equal(serialized.includes('"anyOf"'), false, `${name}: no provider-incompatible union`);
    assert.equal(serialized.includes('"const"'), false, `${name}: no provider-incompatible literal`);
  }
  assert.equal(events.includes("session_start"), true);
  assert.equal(events.includes("input"), true);
  assert.equal(events.includes("session_shutdown"), true);
});

test("partial companion startup failures revoke only the selected attempt and leave companion tools inactive", async (t) => {
  const cases: ReadonlyArray<{
    name: string;
    withRun: boolean;
    lease: "missing" | "released";
    profileMismatch?: boolean;
    storeFailure?: boolean;
    scheduleFailureAt?: number;
    activeToolFailure?: boolean;
  }> = [
    { name: "after bootstrap claim", withRun: true, profileMismatch: true, lease: "missing" },
    { name: "after provenance verification", withRun: true, storeFailure: true, lease: "missing" },
    { name: "after lease acquisition", withRun: false, lease: "released" },
    { name: "after durable run validation", withRun: true, scheduleFailureAt: 1, lease: "released" },
    { name: "after partial timer setup", withRun: true, scheduleFailureAt: 2, lease: "released" },
    { name: "after timer setup", withRun: true, activeToolFailure: true, lease: "released" },
  ] as const;

  for (const scenario of cases) {
    await t.test(scenario.name, async (nested) => {
      const value = await extensionFixture(scenario.withRun);
      nested.after(value.home.cleanup);
      const harness = companionHarness({
        cwd: value.project,
        scheduleFailureAt: scenario.scheduleFailureAt,
        activeToolFailure: scenario.activeToolFailure,
      });
      const environment = {
        ...value.environment,
        ...(scenario.profileMismatch ? { DB11_CREW_ROLE_PROFILE_PATH: memberExtensionPath } : {}),
      };
      installMemberCompanion(harness.api, {
        extensionPath: memberExtensionPath,
        environment,
        openRoot: async () => value.root,
        openStore: scenario.storeFailure
          ? async () => { throw new Error("token=store-secret /private/path"); }
          : async () => value.store,
        scheduleInterval: harness.scheduleInterval,
        clearScheduledInterval: harness.clearScheduledInterval,
      });
      await harness.emit("session_start", { type: "session_start", reason: "startup" });
      await settleProgress();

      assert.deepEqual(harness.activeTools().sort(), ["ambient_shell", "read"]);
      assert.equal((await value.manager.inspectExactBinding(value.binding)).code, "revoked");
      assert.equal(
        (await new FencedLeaseManager(value.root).inspectExactBinding(leaseBinding(value), 1)).code,
        scenario.lease,
      );
      assert.deepEqual(harness.notifications, ["DB11 Crew member companion readiness failed closed."]);
      assert.equal(harness.notifications.join(" ").includes("secret"), false);
      assert.equal(harness.notifications.join(" ").includes("private"), false);
      assert.equal(harness.timers.every((timer) => timer.cleared), true);

      const timerCount = harness.timers.length;
      await harness.emit("session_start", { type: "session_start", reason: "reload" });
      assert.equal(harness.timers.length, timerCount, "failed initialization is never retried automatically");
    });
  }
});

test("companion reopens canonical state after Crewlead runtime resources are materialized", async (t) => {
  const value = await extensionFixture();
  t.after(value.home.cleanup);
  await value.root.ensurePrivateDirectory("runtime/workspaces/run-extension");
  await value.root.ensurePrivateDirectory("runtime/sessions/run-extension");

  const harness = companionHarness({ cwd: value.project });
  installMemberCompanion(harness.api, {
    extensionPath: memberExtensionPath,
    environment: value.environment,
    openRoot: () => SecureStateRoot.openAtAccountHome(value.home.path),
    openStore: () => DurableStateStore.openAtAccountHome(value.home.path),
    scheduleInterval: harness.scheduleInterval,
    clearScheduledInterval: harness.clearScheduledInterval,
  });
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await settleProgress();

  assert.deepEqual(harness.notifications, []);
  assert.deepEqual(harness.activeTools().sort(), ["ambient_shell", "db11_finalize", "db11_report_blocker", "read"]);
  assert.equal((await value.manager.inspectExactBinding(value.binding)).code, "healthy");
});

test("healthy companion runtime renews its lease and fails closed on renewal failure", async (t) => {
  const value = await extensionFixture();
  t.after(value.home.cleanup);
  const harness = companionHarness({ cwd: value.project });
  const leases = new FencedLeaseManager(value.root);
  let renewCalls = 0;
  let renewSettled = 0;
  const originalRenew = leases.renew.bind(leases);
  leases.renew = async (...args) => {
    renewCalls += 1;
    try {
      if (renewCalls === 2) throw new Error("token=renew-secret /private/path");
      return await originalRenew(...args);
    } finally {
      renewSettled += 1;
    }
  };
  installMemberCompanion(harness.api, {
    extensionPath: memberExtensionPath,
    environment: value.environment,
    openRoot: async () => value.root,
    openStore: async () => value.store,
    createLeaseManager: () => leases,
    scheduleInterval: harness.scheduleInterval,
    clearScheduledInterval: harness.clearScheduledInterval,
  });
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await settleProgress();

  assert.deepEqual(harness.activeTools().sort(), ["ambient_shell", "db11_finalize", "db11_report_blocker", "read"]);
  assert.equal((await value.manager.inspectExactBinding(value.binding)).code, "healthy");
  assert.equal((await leases.inspectExactBinding(leaseBinding(value), 1)).code, "healthy");
  assert.equal(harness.timers.length, 2);

  harness.timers[1]!.callback();
  await eventually(() => renewSettled === 1);
  await settleProgress();
  assert.equal(renewCalls, 1);
  assert.equal((await leases.inspectExactBinding(leaseBinding(value), 1)).code, "healthy");

  harness.timers[1]!.callback();
  await eventually(() => renewCalls === 2);
  await eventually(async () => (await value.manager.inspectExactBinding(value.binding)).code === "revoked");
  assert.equal(renewCalls, 2);
  assert.deepEqual(harness.activeTools().sort(), ["ambient_shell", "read"]);
  assert.equal((await value.manager.inspectExactBinding(value.binding)).code, "revoked");
  assert.equal((await leases.inspectExactBinding(leaseBinding(value), 1)).code, "released");
  assert.equal(harness.timers.every((timer) => timer.cleared), true);
});

test("runtime health rejects a replaced lease without releasing the replacement epoch", async (t) => {
  const value = await extensionFixture();
  t.after(value.home.cleanup);
  const harness = companionHarness({ cwd: value.project });
  const leases = new FencedLeaseManager(value.root);
  let selectedLease: Awaited<ReturnType<FencedLeaseManager["acquire"]>> | undefined;
  const originalAcquire = leases.acquire.bind(leases);
  leases.acquire = async (...args) => {
    const lease = await originalAcquire(...args);
    selectedLease ??= lease;
    return lease;
  };
  installMemberCompanion(harness.api, {
    extensionPath: memberExtensionPath,
    environment: value.environment,
    openRoot: async () => value.root,
    openStore: async () => value.store,
    createLeaseManager: () => leases,
    scheduleInterval: harness.scheduleInterval,
    clearScheduledInterval: harness.clearScheduledInterval,
  });
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await settleProgress();
  assert.ok(selectedLease);

  await leases.release(leaseBinding(value), selectedLease.leaseToken, selectedLease.fencingEpoch);
  const replacement = await leases.acquire(leaseBinding(value));
  assert.equal(replacement.fencingEpoch, 2);
  await harness.emit("turn_start", { type: "turn_start" });
  await eventually(() => !harness.activeTools().includes("db11_finalize"));

  assert.deepEqual(harness.activeTools().sort(), ["ambient_shell", "read"]);
  assert.equal((await value.manager.inspectExactBinding(value.binding)).code, "revoked");
  assert.equal((await leases.inspectExactBinding(leaseBinding(value), 2)).code, "healthy");
});

test("every companion input path rejects a stale Pi session and revokes its selected attempt", async (t) => {
  const value = await extensionFixture();
  t.after(value.home.cleanup);
  const harness = companionHarness({ cwd: value.project });
  installMemberCompanion(harness.api, {
    extensionPath: memberExtensionPath,
    environment: value.environment,
    openRoot: async () => value.root,
    openStore: async () => value.store,
    scheduleInterval: harness.scheduleInterval,
    clearScheduledInterval: harness.clearScheduledInterval,
  });
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await settleProgress();
  harness.setSessionId("replacement-session");
  await assert.rejects(
    harness.emit("input", { type: "input", text: "unexpected", source: "interactive" }),
    /companion is not ready/u,
  );
  assert.deepEqual(harness.activeTools().sort(), ["ambient_shell", "read"]);
  assert.equal((await value.manager.inspectExactBinding(value.binding)).code, "revoked");
  assert.equal(
    (await new FencedLeaseManager(value.root).inspectExactBinding(leaseBinding(value), 1)).code,
    "released",
  );
});

test("ordered amendments survive restart and reject stale direct-human races", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const firstRun = await value.protocol.currentRun();
  const firstMeta = await meta(value.protocol, "control", "amendment-message-1");
  const amendment = {
    schemaVersion: 1,
    amendmentId: "amendment-1",
    runId: firstRun.runId,
    sequence: 1,
    expectedRevision: firstRun.revision,
    author: "human",
    timestamp: later,
    kind: "clarification",
    summary: "Use the package-owned manifest as the primary source.",
  };
  const committed = await value.protocol.appendAmendment(firstMeta, amendment);
  assert.equal(committed.run.revision, firstRun.revision + 1);
  assert.equal(await value.protocol.nextAmendmentSequence(), 2);

  const restarted = new CompanionProtocol(
    value.store,
    value.manager,
    value.binding,
    value.claimed.capabilities,
    value.config,
  );
  const replay = await restarted.appendAmendment(firstMeta, amendment);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.run.revision, committed.run.revision);

  await assert.rejects(
    restarted.appendAmendment(
      { messageId: "amendment-message-stale", sequence: await restarted.nextSequence("control"), expectedRevision: firstRun.revision },
      { ...amendment, amendmentId: "amendment-stale", sequence: 2 },
    ),
    (error) => error instanceof StateSecurityError && error.code === "revision_conflict",
  );
});

test("blocker creation, revision, stale response rejection, and explicit clearing are atomic", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  let run = await value.protocol.currentRun();
  const openMeta = await meta(value.protocol, "finalization", "blocker-open");
  const opening = blocker(run);
  run = (await value.protocol.recordBlocker(openMeta, opening)).run;
  assert.equal(run.state, "blocked");
  assert.equal((await value.protocol.recordBlocker(openMeta, opening)).duplicate, true);
  assert.equal(run.activeBlockerId, "blocker-1");

  const stale = blocker(run, 1);
  await assert.rejects(
    value.protocol.recordBlocker(await meta(value.protocol, "finalization", "blocker-stale"), stale),
    (error) => error instanceof StateSecurityError && error.code === "invalid_transition",
  );

  run = (await value.protocol.recordBlocker(
    await meta(value.protocol, "finalization", "blocker-revise"),
    blocker(run, 2),
  )).run;
  assert.equal(run.state, "blocked");
  run = (await value.protocol.recordBlocker(
    await meta(value.protocol, "finalization", "blocker-clear"),
    blocker(run, 3, "cleared"),
  )).run;
  assert.equal(run.state, "working");
  assert.equal(run.activeBlockerId, undefined);
});

test("finalization enforces packet IDs, evidence gates, open blockers, immutable IDs, and replay", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  let run = await value.protocol.currentRun();
  await assert.rejects(
    value.protocol.finalize(
      await meta(value.protocol, "finalization", "missing-evidence"),
      result(run, { deliverables: [{ id: "report", status: "produced", references: [] }] }),
    ),
    (error) => error instanceof StateSecurityError && error.code === "invalid_transition",
  );

  run = (await value.protocol.recordBlocker(await meta(value.protocol, "finalization", "open-before-finish"), blocker(run))).run;
  await assert.rejects(
    value.protocol.finalize(await meta(value.protocol, "finalization", "finish-blocked"), result(run)),
    (error) => error instanceof StateSecurityError && error.code === "invalid_transition",
  );
  run = (await value.protocol.recordBlocker(
    await meta(value.protocol, "finalization", "clear-before-finish"),
    blocker(run, 2, "cleared"),
  )).run;

  const finishMeta = await meta(value.protocol, "finalization", "finish-valid");
  const final = result(run);
  const committed = await value.protocol.finalize(finishMeta, final);
  assert.equal(committed.run.state, "completed");
  const replay = await value.protocol.finalize(finishMeta, final);
  assert.equal(replay.duplicate, true);
  await assert.rejects(
    value.protocol.finalize(finishMeta, { ...final, summary: "Conflicting content." }),
    (error) => error instanceof StateSecurityError && error.code === "idempotency_conflict",
  );
  await assert.rejects(
    value.protocol.finalize({ ...finishMeta, messageId: "other-result", sequence: finishMeta.sequence + 1 }, { ...final, resultId: "result-2" }),
    (error) => error instanceof StateSecurityError && error.code === "terminal_immutable",
  );
});

test("Builder finalization requires exact authoritative Git evidence and leaves mismatches active", async (t) => {
  let validations = 0;
  const value = await fixture(1_000_000, "builder", async (run) => {
    validations += 1;
    return authoritativeBuilderEvidence(run);
  });
  t.after(value.home.cleanup);
  const run = await value.protocol.currentRun();
  const mismatches = [
    { name: "repository root", evidence: { repositoryRootDigest: "f".repeat(64) } },
    { name: "base commit", evidence: { baseCommit: "f".repeat(40) } },
    { name: "head commit", evidence: { headCommit: "f".repeat(40) } },
    { name: "commit list", evidence: { commits: ["f".repeat(40)] } },
    { name: "changed paths", evidence: { changedPaths: ["other.txt"] } },
    { name: "no-change declaration", evidence: { noChange: false } },
    { name: "clean-worktree declaration", evidence: { worktreeClean: false } },
  ] as const;
  for (const [index, mismatch] of mismatches.entries()) {
    const protocol = new CompanionProtocol(
      value.store,
      value.manager,
      value.binding,
      value.claimed.capabilities,
      value.config,
      {
        now: () => 1_000_000,
        verifyBuilderOutcome: async (current) => authoritativeBuilderEvidence(current, mismatch.evidence),
      },
    );
    await assert.rejects(
      protocol.finalize(
        await meta(protocol, "finalization", `builder-mismatch-${index}`),
        builderResult(run),
      ),
      (error) => error instanceof StateSecurityError && error.code === "invalid_record",
      mismatch.name,
    );
    const current = await protocol.currentRun();
    assert.equal(current.state, "working");
    assert.equal(current.resultId, undefined);
  }

  const committed = await value.protocol.finalize(
    await meta(value.protocol, "finalization", "builder-exact"),
    builderResult(run),
  );
  assert.equal(committed.run.state, "completed");
  assert.equal(validations, 1);
});

test("Builder completion fails closed without a verifier or when durable state races live evidence", async (t) => {
  await t.test("missing verifier", async (subtest) => {
    const value = await fixture(1_000_000, "builder");
    subtest.after(value.home.cleanup);
    const run = await value.protocol.currentRun();
    await assert.rejects(
      value.protocol.finalize(
        await meta(value.protocol, "finalization", "builder-missing-verifier"),
        builderResult(run),
      ),
      (error) => error instanceof StateSecurityError && error.code === "invalid_binding",
    );
    assert.equal((await value.protocol.currentRun()).state, "working");
  });

  await t.test("revision race", async (subtest) => {
    let value: Awaited<ReturnType<typeof fixture>>;
    value = await fixture(1_000_000, "builder", async (run) => {
      await value.lifecycle.recordHealth({
        operationId: "builder-finalization-race",
        runId: run.runId,
        expectedRevision: run.revision,
        expectedFencingEpoch: run.fencingEpoch,
        actor: "crewlead",
        status: "degraded",
        reconciliationRequired: true,
        reason: "A deterministic durable race changed the finalization input.",
        evidenceRefs: ["test:builder-finalization-race"],
        timestamp: "2026-08-17T12:00:03Z",
      });
      return authoritativeBuilderEvidence(run);
    });
    subtest.after(value.home.cleanup);
    const run = await value.protocol.currentRun();
    await assert.rejects(
      value.protocol.finalize(
        await meta(value.protocol, "finalization", "builder-revision-race"),
        builderResult(run),
      ),
      (error) => error instanceof StateSecurityError && error.code === "revision_conflict",
    );
    const current = await value.protocol.currentRun();
    assert.equal(current.state, "working");
    assert.equal(current.resultId, undefined);
  });
});

test("member-declared failure requires classification and evidence but remains structurally bounded", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const run = await value.protocol.currentRun();
  const failed = result(run, {
    resultId: "result-failed",
    outcome: "failed",
    failure: { classification: "validation", summary: "Focused validation failed.", evidenceRefs: ["evidence:failure"] },
    deliverables: [{ id: "report", status: "not_produced", references: [], note: "Validation prevented the report." }],
    completionCriteria: [{ id: "complete", status: "not_met", evidenceRefs: [], note: "The report is incomplete." }],
    validation: [{ id: "tests", status: "failed", evidenceRefs: ["evidence:failure"], summary: "Focused validation failed." }],
    unresolvedDecisions: ["A responsible human must decide whether to retry."],
  });
  const committed = await value.protocol.finalize(await meta(value.protocol, "finalization", "finish-failed"), failed);
  assert.equal(committed.run.state, "failed");
  assert.equal(committed.run.resourceDisposition, "retained");
});

test("progress accepts bounded ambient tool names and rejects malformed, leaky, out-of-order, and stale frames", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const run = await value.protocol.currentRun();
  const base = {
    schemaVersion: 1,
    progressId: "progress-1",
    runId: run.runId,
    sequence: 1,
    fencingEpoch: run.fencingEpoch,
    kind: "phase",
    phase: "inspection",
    timestamp: later,
  };
  const malformed = parseContractText("progressFrame", "{not-json");
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.code, "invalid_json_value");
  await assert.rejects(value.protocol.acceptProgress({ ...base, unexpected: true }));
  await assert.rejects(value.protocol.acceptProgress({ ...base, summary: "x".repeat(LIMITS.progressFrameBytes) }));
  await assert.rejects(value.protocol.acceptProgress({ ...base, kind: "tool", tool: "ambient_shell", arguments: ["secret"] }));
  await assert.rejects(value.protocol.acceptProgress({ ...base, kind: "tool", tool: "ambient_shell", output: "secret" }));
  await assert.rejects(value.protocol.acceptProgress({ ...base, kind: "tool", tool: "invalid tool name" }));
  const ambient = await value.protocol.acceptProgress({ ...base, kind: "tool", tool: "ambient_shell" });
  assert.equal(ambient.rendered, true);
  assert.equal(ambient.frame?.tool, "ambient_shell");
  assert.deepEqual(Object.keys(ambient.frame ?? {}).filter((key) => ["arguments", "output"].includes(key)), []);
  await assert.rejects(value.protocol.acceptProgress({ ...base, progressId: "progress-epoch", sequence: 2, fencingEpoch: 2 }), (error) => {
    return error instanceof StateSecurityError && error.code === "epoch_conflict";
  });
  await assert.rejects(value.protocol.acceptProgress({ ...base, progressId: "progress-gap", sequence: 3 }), (error) => {
    return error instanceof StateSecurityError && error.code === "stale_sequence";
  });
});

test("progress is deduplicated, rate-limited, sanitized, coalesced, and deterministically cleared", async (t) => {
  let now = 1_000_000;
  const home = await temporaryAccountHome();
  t.after(home.cleanup);
  // Build with a shared mutable clock so capability and coalescing checks are deterministic.
  const project = join(home.path, "project");
  await mkdir(project, { mode: 0o700 });
  const root = await SecureStateRoot.openAtAccountHome(home.path, { now: () => now });
  const store = await DurableStateStore.openAtAccountHome(home.path, { now: () => now });
  const lifecycle = new LifecycleService(store, { maxActiveMembers: 6, maxOpenMemberResources: 6, maxQueuedDelegations: 6 });
  const admitted = (await lifecycle.admitBatch({ candidates: [{ admissionId: "admission-p", runId: "run-p", packetId: "packet-1", intentDigest: "d".repeat(64), purposeLabel: "progress", role: "scout", binding: { crewleadSessionId: "crewlead-session", memberSessionId: "member-session", herdrWorkspaceId: "workspace-1", canonicalProjectPath: project }, retentionPolicy: "retain", createdAt: timestamp }], mode: "start", actor: "crewlead", evidenceRefs: ["request:authorized"] })).runs[0]!;
  await lifecycle.transition({ operationId: "working-p", runId: admitted.runId, expectedRevision: admitted.revision, expectedFencingEpoch: 1, actor: "crewlead", targetState: "working", reason: "Ready.", evidenceRefs: ["prompt:ack"], timestamp: later });
  const binding = { protocolVersion: 1 as const, crewleadSessionId: "crewlead-session", herdrWorkspaceId: "workspace-1", canonicalProjectPath: project, runId: "run-p", memberSessionId: "member-session", role: "scout" as const, fencingEpoch: 1 };
  const manager = new RunCapabilityManager(root, { now: () => now });
  const config = { ...configuration(project), packet: { ...packet(), packetId: "packet-1" } } as CompanionConfiguration;
  const locator = await manager.provision(binding, config);
  const claimed = await manager.claimCompanionBootstrap(locator.bootstrapPath, { memberSessionId: "member-session", role: "scout" });
  const rendered: Array<unknown> = [];
  const protocol = new CompanionProtocol(store, manager, binding, claimed.capabilities, config, { now: () => now, onProgress: (frame) => rendered.push(frame) });
  const make = (sequence: number, id = `progress-${sequence}`) => ({ schemaVersion: 1, progressId: id, runId: "run-p", sequence, fencingEpoch: 1, kind: "phase", phase: `phase ${sequence}`, summary: "token=secret /home/alice/private", timestamp: later });
  const first = await protocol.acceptProgress(make(1));
  assert.equal(first.frame?.summary?.includes("secret"), false);
  assert.equal((await protocol.acceptProgress(make(1))).duplicate, true);
  for (let sequence = 2; sequence <= 4; sequence += 1) assert.equal((await protocol.acceptProgress(make(sequence))).coalesced, true);
  await assert.rejects(protocol.acceptProgress(make(5)), (error) => error instanceof StateSecurityError && error.code === "rate_limited");
  now += LIMITS.progressCoalesceMilliseconds;
  assert.equal(protocol.flushProgress()?.sequence, 4);
  protocol.clearProgress("shutdown");
  assert.equal(protocol.progressSnapshot(), undefined);
  assert.equal(rendered.at(-1), undefined);
});

test("graceful cancellation requires durable intent, abort, settlement, checkpoint, and wins revision races", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  let run = await value.protocol.currentRun();
  const requestMeta = await meta(value.protocol, "control", "cancel-request-message");
  const requestValue = { controlId: "cancel-1", reason: "The responsible human cancelled this run.", evidenceRefs: ["human:cancel"], timestamp: later };
  const requested = await value.protocol.requestCancellation(requestMeta, requestValue);
  run = requested.run;
  assert.equal((await value.protocol.requestCancellation(requestMeta, requestValue)).duplicate, true);
  assert.equal(run.state, "working");
  assert.deepEqual(await value.protocol.pendingCancellation(), { controlId: "cancel-1", revision: run.revision });
  await assert.rejects(
    value.protocol.finalize(await meta(value.protocol, "finalization", "late-finish"), result(run)),
    (error) => error instanceof StateSecurityError && error.code === "revision_conflict",
  );

  let aborted = false;
  const ackMeta = await meta(value.protocol, "control", "cancel-ack-message");
  const checkpoint = {
    schemaVersion: 1,
    checkpointId: "checkpoint-1",
    cancelRequestId: "cancel-1",
    runId: run.runId,
    expectedRevision: run.revision,
    fencingEpoch: run.fencingEpoch,
    summary: "The member settled after graceful cancellation.",
    completedWork: ["Repository evidence was partially inspected."],
    validation: [],
    unresolvedEffects: ["No mutations were performed."],
    retainedArtifacts: [],
    timestamp: later,
  };
  await assert.rejects(
    value.protocol.acknowledgeCancellation(ackMeta, checkpoint, { abort: () => { aborted = true; }, settled: () => false }),
    (error) => error instanceof StateSecurityError && error.code === "invalid_transition",
  );
  assert.equal(aborted, true);
  const committed = await value.protocol.acknowledgeCancellation(ackMeta, checkpoint, { abort: () => {}, settled: () => true });
  assert.equal(committed.run.state, "cancelled");
  assert.equal(committed.run.resourceDisposition, "retained");
  assert.equal((await value.protocol.acknowledgeCancellation(ackMeta, checkpoint, { abort: () => {}, settled: () => true })).duplicate, true);
});

test("cancellation and finalization share one atomic revision winner", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const run = await value.protocol.currentRun();
  const finishMeta = await meta(value.protocol, "finalization", "race-finish");
  const cancelMeta = await meta(value.protocol, "control", "race-cancel");
  const settled = await Promise.allSettled([
    value.protocol.finalize(finishMeta, result(run)),
    value.protocol.requestCancellation(cancelMeta, {
      controlId: "cancel-race",
      reason: "Race cancellation against finalization.",
      evidenceRefs: ["human:cancel-race"],
      timestamp: later,
    }),
  ]);
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(settled.filter((item) => item.status === "rejected").length, 1);
  const current = await value.protocol.currentRun();
  assert.equal(current.state === "completed" || current.state === "working", true);
  if (current.state === "working") assert.equal((await value.protocol.pendingCancellation())?.controlId, "cancel-race");
});

test("Pi settlement alone remains nonterminal and restart does not replay transient progress", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const run = await value.protocol.currentRun();
  assert.equal(run.state, "working");
  const restartedFrames: unknown[] = [];
  const restarted = new CompanionProtocol(value.store, value.manager, value.binding, value.claimed.capabilities, value.config, {
    onProgress: (frame) => restartedFrames.push(frame),
  });
  assert.equal(restarted.progressSnapshot(), undefined);
  assert.deepEqual(restartedFrames, []);
  assert.equal((await restarted.currentRun()).state, "working");
});

test("companion accepts a Crewlead prompt only when it exactly matches a committed amendment", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const current = await value.protocol.currentRun();
  const amendment = {
    schemaVersion: 1,
    amendmentId: "amendment-crewlead-1",
    runId: current.runId,
    sequence: 1,
    expectedRevision: current.revision,
    author: "crewlead",
    timestamp: later,
    kind: "clarification",
    summary: "Use the accepted local fixture only.",
  };
  const next = { ...structuredClone(current), revision: current.revision + 1, updatedAt: later };
  await value.store.commitRun({
    operationId: "op-amendment-crewlead-1",
    expectedRevision: current.revision,
    expectedFencingEpoch: current.fencingEpoch,
    run: next,
    history: [
      {
        kind: "lifecycle",
        payload: {
          schemaVersion: 1,
          eventId: "op-amendment-crewlead-1",
          runId: current.runId,
          sequence: next.revision,
          timestamp: later,
          actor: "crewlead",
          type: "amendment_appended",
          reason: "The Crewlead committed a same-task amendment.",
          evidenceRefs: ["request:clarification"],
          expectedPriorState: current.state,
          resultingState: current.state,
          expectedRevision: current.revision,
          resultingRevision: next.revision,
          fencingEpoch: current.fencingEpoch,
        },
      },
      { kind: "control", payload: amendment },
    ],
  });
  const prompt = [
    "DB11 Crew authenticated amendment amendment-crewlead-1 (sequence 1).",
    "Apply it only within the immutable task objective, role, permissions, and scope. Block if it would widen them.",
    "",
    amendment.summary,
  ].join("\n");
  assert.equal((await value.protocol.matchCrewleadAmendmentPrompt(prompt))?.amendmentId, amendment.amendmentId);
  assert.equal(await value.protocol.matchCrewleadAmendmentPrompt(prompt.replace("local", "remote")), undefined);
  assert.equal(await value.protocol.matchCrewleadAmendmentPrompt(prompt.replace("sequence 1", "sequence 2")), undefined);
});
