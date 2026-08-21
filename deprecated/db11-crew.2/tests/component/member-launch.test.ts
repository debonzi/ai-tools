import assert from "node:assert/strict";
import { access, chmod, cp, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertFreshSessionDestination,
  buildMemberLaunchPlan,
  launchMember,
  type MemberLaunchRequest,
} from "../../src/adapters/pi/launcher.ts";
import {
  FakeHerdrAdapter,
  HERDR_ENVIRONMENT_LIMITS,
  type HerdrSnapshot,
} from "../../src/adapters/herdr/contracts.ts";
import type { RepositoryResource } from "../../src/orchestration/lifecycle.ts";
import type { RoleReadinessReceipt } from "../../src/roles/resolve.ts";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function snapshot(): HerdrSnapshot {
  return {
    version: "0.7.5",
    protocol: 17,
    apiSchema: 1,
    focusedWorkspaceId: "workspace-1",
    focusedTabId: "tab-crewlead",
    focusedPaneId: "pane-crewlead",
    workspaces: [{
      workspaceId: "workspace-1",
      label: "crew",
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
    }],
    agents: [],
  };
}

function packet(role: "scout" | "planner" | "builder") {
  return {
    schemaVersion: 1,
    packetId: `packet-${role}`,
    resultContractVersion: 1,
    role,
    objective: `Complete the bounded ${role} task.`,
    scope: {
      readPaths: ["."],
      ...(role === "builder" ? { mutablePaths: ["src"] } : {}),
      ...(role === "planner" ? { wyrd: { ticketId: 10, taskIds: ["10.8"] } } : {}),
    },
    inputs: [],
    constraints: ["Do not widen the task."],
    nonGoals: ["Do not access remote private services."],
    deliverables: [{ id: "result", description: "Produce the assigned result.", required: true }],
    validation: [{ id: "focused", description: "Run focused checks.", required: true }],
    completionCriteria: [{ id: "done", description: "The bounded result is complete.", required: true }],
    escalationConditions: ["Block when required authorization is missing."],
  };
}

function readiness(role: "scout" | "planner" | "builder"): RoleReadinessReceipt {
  return {
    schemaVersion: 1,
    role,
    profileVersion: 2,
    ready: true,
    runtime: {
      provider: "test-provider",
      model: "test-model",
      thinking: "medium",
      sources: { provider: "dispatch", model: "dispatch", thinking: "dispatch" },
    },
    profile: {
      profileVersion: 2,
      profilePath: `agents/pi/roles/${role}.md`,
      profileSha256: "a".repeat(64),
    },
    resources: [],
    checks: [{ id: "provenance", ready: true, code: "ready", message: "ready" }],
  };
}

async function fixture(role: "scout" | "planner" | "builder", runId: string) {
  const base = await mkdtemp(join(tmpdir(), "db11-member-launch-"));
  const project = join(base, "project");
  const assignedRoot = join(base, role === "builder" ? "builder-worktree" : "read-snapshot");
  const privateRoot = join(base, "private");
  const agentDir = join(base, "pi-agent");
  await mkdir(join(project, "src"), { recursive: true, mode: 0o700 });
  await mkdir(join(assignedRoot, "src"), { recursive: true, mode: 0o700 });
  await mkdir(privateRoot, { mode: 0o700 });
  const bootstrap = join(privateRoot, `${runId}.json`);
  await writeFile(bootstrap, "{}\n", { mode: 0o600 });
  await chmod(bootstrap, 0o600);
  const herdr = new FakeHerdrAdapter(snapshot());
  const source = {
    canonicalRoot: project,
    canonicalRootDigest: "a".repeat(64),
    commonGitDirectory: join(project, ".git"),
    commonGitDirectoryDigest: "b".repeat(64),
    commonGitDevice: "1",
    commonGitInode: "2",
  };
  const repositoryResource: RepositoryResource = role === "builder"
    ? {
        kind: "builder_worktree",
        runId,
        source,
        path: assignedRoot,
        branch: `db11-crew/${runId}`,
        branchRef: `refs/heads/db11-crew/${runId}`,
        baseCommit: "c".repeat(40),
        targetBranch: "main",
        targetRef: "refs/heads/main",
        targetCommit: "c".repeat(40),
        automaticIntegrationEligible: true,
      }
    : {
        kind: "read_snapshot",
        runId,
        source,
        path: assignedRoot,
        sourceHead: "c".repeat(40),
        baselineManifestDigest: "d".repeat(64),
      };
  const request: MemberLaunchRequest = {
    packageRoot,
    herdr,
    runId,
    memberSessionId: `member-session-${runId}`,
    role,
    purpose: "focused launch",
    herdrWorkspaceId: "workspace-1",
    canonicalProjectPath: project,
    repositoryResource,
    assignedRoot,
    projectTrusted: true,
    sessionDirectory: join(privateRoot, `session-${runId}`),
    companionBootstrapPath: bootstrap,
    packet: packet(role),
    readiness: readiness(role),
    sourceEnvironment: {
      HOME: base,
      PATH: process.env.PATH,
      TERM: "xterm-256color",
      PI_CODING_AGENT_DIR: agentDir,
      PI_SESSION_ID: "crewlead-session",
      PI_SESSION_FILE: "/private/crewlead.jsonl",
      PI_PROVIDER: "crewlead-provider",
      PI_MODEL: "crewlead-model",
      PI_REASONING_LEVEL: "high",
      HERDR_ENV: "1",
      HERDR_SOCKET: "/private/legacy-herdr.sock",
      HERDR_SOCKET_PATH: "/private/herdr.sock",
      HERDR_WORKSPACE_ID: "crewlead-workspace",
      HERDR_TAB_ID: "crewlead-tab",
      HERDR_PANE_ID: "crewlead-pane",
      HERDR_BIN_PATH: "/usr/bin/herdr",
      OPENAI_API_KEY: "provider-secret",
      HTTPS_PROXY: "https://proxy.example.test",
      AWS_PROFILE: "member-profile",
      SSH_AUTH_SOCK: "/private/ssh-agent.sock",
      XDG_CONFIG_HOME: join(base, "xdg-config"),
      PI_PACKAGE_DIR: join(base, "pi-packages"),
      EMPTY_AMBIENT_VALUE: "",
      DB11_CREW_RUN_ID: "stale-run",
      DB11_CREW_MEMBER_BOOTSTRAP: "/private/stale-bootstrap.json",
      DB11_PRIVATE_CAPABILITY: "stale-capability",
    },
  };
  return { base, project, assignedRoot, privateRoot, request, herdr };
}

test("member launch uses ordinary ambient Pi discovery with one companion and one role profile", async (t) => {
  const value = await fixture("scout", "run-scout-001");
  t.after(() => rm(value.base, { recursive: true, force: true }));
  const plan = await buildMemberLaunchPlan(value.request);
  const args = [...plan.arguments];

  for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-builtin-tools", "--tools"]) {
    assert.equal(args.includes(flag), false, flag);
  }
  assert.equal(args.includes("--approve"), true);
  assert.equal(args.includes("--no-context-files"), false);
  assert.equal(args.includes("--no-session"), false);
  assert.equal(args.includes("--continue"), false);
  assert.equal(args.includes("--resume"), false);
  assert.equal(args.includes("--session-id"), true);
  assert.equal(args.includes("member-session-run-scout-001"), true);
  assert.equal(args.filter((value) => value === "--extension").length, 1);
  assert.equal(args.includes(plan.resources.memberCompanionPath), true);
  assert.deepEqual(
    Object.keys(plan.resources).sort(),
    [
      "memberCompanionPath",
      "memberCompanionProtocolPath",
      "memberCompanionRuntimePath",
      "memberProgressTransportPath",
      "packageRoot",
      "roleProfilePath",
    ],
  );
  assert.equal(args.includes(plan.resources.roleProfilePath), true);
  assert.equal(args.includes(plan.prompt), false, "the task packet must not be exposed in argv");
  assert.match(plan.prompt, /Immutable task packet/u);
  assert.equal(plan.prompt.includes("crewlead-session"), false);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.arguments), true);

  for (const stale of [
    "PI_SESSION_ID",
    "PI_SESSION_FILE",
    "PI_PROVIDER",
    "PI_MODEL",
    "PI_REASONING_LEVEL",
    "HERDR_ENV",
    "HERDR_SOCKET",
    "HERDR_SOCKET_PATH",
    "HERDR_WORKSPACE_ID",
    "HERDR_TAB_ID",
    "HERDR_PANE_ID",
    "DB11_PRIVATE_CAPABILITY",
  ]) {
    assert.equal(stale in plan.environment, false, stale);
  }
  for (const inherited of [
    "HOME",
    "PATH",
    "TERM",
    "PI_CODING_AGENT_DIR",
    "HERDR_BIN_PATH",
    "OPENAI_API_KEY",
    "HTTPS_PROXY",
    "AWS_PROFILE",
    "SSH_AUTH_SOCK",
    "XDG_CONFIG_HOME",
    "PI_PACKAGE_DIR",
    "EMPTY_AMBIENT_VALUE",
  ]) {
    assert.equal(plan.environment[inherited], value.request.sourceEnvironment?.[inherited], inherited);
  }
  assert.equal("PI_OFFLINE" in plan.environment, false);
  assert.equal(plan.environment.DB11_CREW_ROLE, "scout");
  assert.equal(plan.environment.DB11_CREW_RUN_ID, "run-scout-001");
  assert.equal(plan.environment.DB11_CREW_MEMBER_BOOTSTRAP, value.request.companionBootstrapPath);
  assert.equal(plan.environment.DB11_CREW_ASSIGNED_ROOT, value.assignedRoot);
  assert.equal(plan.environment.DB11_CREW_MEMBER_EXTENSION_PATH, plan.resources.memberCompanionPath);
  assert.equal(plan.environment.DB11_CREW_ROLE_PROFILE_PATH, plan.resources.roleProfilePath);
  assert.deepEqual(
    Object.keys(plan.environment).filter((key) => key.startsWith("DB11_")).sort(),
    [
      "DB11_CREW_ASSIGNED_ROOT",
      "DB11_CREW_MEMBER_BOOTSTRAP",
      "DB11_CREW_MEMBER_EXTENSION_PATH",
      "DB11_CREW_ROLE",
      "DB11_CREW_ROLE_PROFILE_PATH",
      "DB11_CREW_RUN_ID",
    ],
  );

  value.request.sourceEnvironment!.PI_OFFLINE = "1";
  assert.equal((await buildMemberLaunchPlan(value.request)).environment.PI_OFFLINE, "1");
});

test("every role uses ambient launch without package-owned tool inventory metadata", async (t) => {
  const values = await Promise.all([
    fixture("scout", "run-scout-architecture"),
    fixture("planner", "run-planner-architecture"),
    fixture("builder", "run-builder-architecture"),
  ]);
  t.after(() => Promise.all(values.map((value) => rm(value.base, { recursive: true, force: true }))));

  for (const value of values) {
    const plan = await buildMemberLaunchPlan(value.request);
    const args = [...plan.arguments];
    assert.equal(args.filter((argument) => argument === "--extension").length, 1, plan.role);
    assert.equal(args.filter((argument) => argument === "--append-system-prompt").length, 1, plan.role);
    assert.equal(args.includes(plan.resources.memberCompanionPath), true, plan.role);
    assert.equal(args.includes(plan.resources.roleProfilePath), true, plan.role);
    assert.equal(plan.cwd, value.assignedRoot, plan.role);
    assert.equal("DB11_CREW_ACTIVE_TOOLS" in plan.environment, false, plan.role);
    for (const tool of ["db11_read", "db11_edit", "db11_write", "db11_exec", "db11_git_inspect", "db11_wyrd"]) {
      assert.equal(args.includes(tool), false, `${plan.role}:${tool}`);
      assert.equal(Object.values(plan.environment).includes(tool), false, `${plan.role}:${tool}:environment`);
    }
  }
});

test("member environment rejects invalid or oversized ambient envelopes before Herdr side effects", async (t) => {
  const value = await fixture("builder", "run-builder-environment-bounds");
  t.after(() => rm(value.base, { recursive: true, force: true }));
  const source = { ...value.request.sourceEnvironment };
  const rejects = async (environment: NodeJS.ProcessEnv) => {
    value.request.sourceEnvironment = environment;
    await assert.rejects(
      () => buildMemberLaunchPlan(value.request),
      (error: unknown) => (error as { code?: unknown }).code === "invalid_argument",
    );
  };

  await rejects({ ...source, "INVALID-KEY": "value" });
  await rejects({ ...source, INVALID_NUL: "before\0after" });
  await rejects({ ...source, INVALID_VALUE: "x".repeat(HERDR_ENVIRONMENT_LIMITS.valueCharacters + 1) });
  await rejects({
    ...source,
    ...Object.fromEntries(Array.from(
      { length: HERDR_ENVIRONMENT_LIMITS.entries },
      (_, index) => [`EXCESSIVE_${index}`, "value"],
    )),
  });
  await rejects({
    ...source,
    ...Object.fromEntries(Array.from(
      { length: 65 },
      (_, index) => [`AGGREGATE_${index}`, "x".repeat(HERDR_ENVIRONMENT_LIMITS.valueCharacters)],
    )),
  });
  assert.equal(value.herdr.calls.length, 0);
});

test("session preflight rejects occupied exact files directories and symlinks without Herdr launch", async (t) => {
  const value = await fixture("builder", "run-builder-session-collision");
  t.after(() => rm(value.base, { recursive: true, force: true }));
  await assertFreshSessionDestination(value.request.sessionDirectory);
  for (const kind of ["file", "directory", "symlink"] as const) {
    const destination = join(value.privateRoot, `occupied-${kind}`);
    if (kind === "file") await writeFile(destination, "foreign\n");
    if (kind === "directory") await mkdir(destination);
    if (kind === "symlink") await symlink(value.assignedRoot, destination);
    await assert.rejects(
      assertFreshSessionDestination(destination),
      (error: unknown) => (error as { code?: unknown }).code === "repository_collision",
      kind,
    );
  }
  assert.equal(value.herdr.calls.length, 0);
});

test("trusted read snapshots and Builder worktrees create fresh persistent sessions", async (t) => {
  const first = await fixture("planner", "run-planner-001");
  const second = await fixture("builder", "run-builder-002");
  t.after(() => Promise.all([
    rm(first.base, { recursive: true, force: true }),
    rm(second.base, { recursive: true, force: true }),
  ]));

  const launchedFirst = await launchMember(first.request);
  const launchedSecond = await launchMember(second.request);
  assert.notEqual(launchedFirst.plan.sessionDirectory, launchedSecond.plan.sessionDirectory);
  assert.equal(first.herdr.calls.filter((call) => call.operation === "prompt").length, 1);
  assert.equal(second.herdr.calls.filter((call) => call.operation === "prompt").length, 1);
  assert.equal(first.herdr.calls.some((call) => call.operation === "startPiAgent"), true);
  assert.equal(second.herdr.calls.some((call) => call.operation === "startPiAgent"), true);
});

test("package-owned member replacement adapters and guards are absent", async () => {
  for (const path of [
    "src/adapters/pi/launch-guard.ts",
    "src/adapters/pi/tools.ts",
    "src/adapters/web/guard.ts",
    "src/adapters/wyrd/adapter.ts",
  ]) {
    await assert.rejects(access(join(packageRoot, path)), { code: "ENOENT" }, path);
  }
});

test("companion implementation provenance fails before Herdr side effects", async (t) => {
  const value = await fixture("builder", "run-builder-tampered-companion");
  t.after(() => rm(value.base, { recursive: true, force: true }));
  const copiedPackage = join(value.base, "db11-crew-package");
  await mkdir(copiedPackage, { mode: 0o700 });
  for (const entry of ["package.json", "agents", "src"]) {
    await cp(join(packageRoot, entry), join(copiedPackage, entry), { recursive: true });
  }
  await writeFile(
    join(copiedPackage, "src", "companion", "protocol.ts"),
    "export const tampered = true;\n",
    { mode: 0o600 },
  );
  value.request.packageRoot = copiedPackage;
  await assert.rejects(() => launchMember(value.request));
  assert.equal(value.herdr.calls.length, 0);
});

test("trust and readiness failures occur before Herdr side effects", async (t) => {
  const untrusted = await fixture("planner", "run-planner-untrusted");
  const unready = await fixture("builder", "run-builder-unready");
  t.after(() => Promise.all([untrusted, unready].map((value) => rm(value.base, { recursive: true, force: true }))));
  untrusted.request.projectTrusted = false;
  unready.request.readiness.ready = false;

  await assert.rejects(() => launchMember(untrusted.request));
  await assert.rejects(() => launchMember(unready.request));
  assert.equal(untrusted.herdr.calls.length, 0);
  assert.equal(unready.herdr.calls.length, 0);
});

test("assigned-artifact mismatches fail before approval or Herdr side effects", async (t) => {
  const wrongProject = await fixture("planner", "run-wrong-project");
  const wrongSource = await fixture("scout", "run-wrong-source");
  const wrongPath = await fixture("builder", "run-wrong-path");
  const wrongKind = await fixture("builder", "run-wrong-kind");
  const wrongRun = await fixture("scout", "run-wrong-run");
  const values = [wrongProject, wrongSource, wrongPath, wrongKind, wrongRun];
  t.after(() => Promise.all(values.map((value) => rm(value.base, { recursive: true, force: true }))));

  const unrelatedProject = join(wrongProject.base, "unrelated-project");
  await mkdir(unrelatedProject, { mode: 0o700 });
  wrongProject.request.canonicalProjectPath = unrelatedProject;

  const unrelatedSource = join(wrongSource.base, "unrelated-source");
  await mkdir(unrelatedSource, { mode: 0o700 });
  wrongSource.request.repositoryResource = {
    ...wrongSource.request.repositoryResource,
    source: { ...wrongSource.request.repositoryResource.source, canonicalRoot: unrelatedSource },
  };

  const unrelatedPath = join(wrongPath.base, "unrelated-path");
  await mkdir(unrelatedPath, { mode: 0o700 });
  wrongPath.request.assignedRoot = unrelatedPath;

  wrongKind.request.repositoryResource = {
    kind: "read_snapshot",
    runId: wrongKind.request.runId,
    source: wrongKind.request.repositoryResource.source,
    path: wrongKind.request.assignedRoot,
    sourceHead: "c".repeat(40),
    baselineManifestDigest: "d".repeat(64),
  };

  wrongRun.request.repositoryResource = {
    ...wrongRun.request.repositoryResource,
    runId: "different-run",
  };

  for (const value of values) {
    await assert.rejects(
      () => launchMember(value.request),
      (error: unknown) => (error as { code?: unknown }).code === "repository_identity",
    );
    assert.equal(value.herdr.calls.length, 0);
  }
});
