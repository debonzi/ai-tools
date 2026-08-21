import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  FakeHerdrAdapter,
  HerdrAdapterError,
  type HerdrSnapshot,
  type MemberResources,
} from "../../src/adapters/herdr/contracts.ts";
import { DEFAULT_CONFIGURATION, type EffectiveConfiguration, type RoleId } from "../../src/config/config.ts";
import {
  createCrewleadDesignation,
  CREWLEAD_DESIGNATION_ENTRY_TYPE,
  CREWLEAD_TOOL_NAMES,
} from "../../src/crewlead/activation.ts";
import { installCrewleadExtension } from "../../src/crewlead/extension.ts";
import {
  CrewleadRuntime,
  type CrewleadIdentity,
  type CrewleadRuntimeDependencies,
  type TaskPacket,
} from "../../src/crewlead/runtime.ts";
import { LifecycleService, type RunRecord } from "../../src/orchestration/lifecycle.ts";
import type { RoleReadinessReceipt } from "../../src/roles/resolve.ts";
import {
  RunCapabilityManager,
  type ClaimedRunCapabilities,
  type CompanionConfiguration,
} from "../../src/security/capabilities.ts";
import type { LeaseBinding, RunCapabilityBinding } from "../../src/security/binding.ts";
import { StateSecurityError } from "../../src/security/errors.ts";
import { FencedLeaseManager, type FencedLease } from "../../src/state/leases.ts";
import { DurableStateStore } from "../../src/state/store.ts";
import { SecureStateRoot } from "../../src/state/filesystem.ts";
import { temporaryAccountHome } from "../security/helpers.ts";

const timestamp = Date.parse("2026-08-18T12:00:00Z");

function snapshot(project: string): HerdrSnapshot {
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

function packet(id: string, role: RoleId = "scout"): TaskPacket {
  return {
    schemaVersion: 1,
    packetId: id,
    resultContractVersion: 1,
    role,
    objective: `Complete bounded task ${id}.`,
    scope: {
      readPaths: ["."],
      ...(role === "builder" ? { mutablePaths: ["src"] } : {}),
      ...(role === "planner" ? { wyrd: { ticketId: 10, taskIds: ["10.10"] } } : {}),
    },
    inputs: [],
    constraints: ["Remain inside the assigned scope."],
    nonGoals: ["Do not access remote private services."],
    deliverables: [{ id: "result", description: "Produce the bounded result.", required: true }],
    validation: [{ id: "focused", description: "Run focused checks.", required: true }],
    completionCriteria: [{ id: "done", description: "The task is complete.", required: true }],
    escalationConditions: ["Block instead of widening authority."],
    ...(role === "builder" ? {
      executionGrants: [{
        id: "git-commit",
        executable: "git",
        argumentPrefixes: [["status"], ["add"], ["commit"]],
      }],
    } : {}),
  };
}

function readiness(role: RoleId, ready = true): RoleReadinessReceipt {
  return {
    schemaVersion: 1,
    role,
    profileVersion: 2,
    ready,
    ...(ready ? {
      runtime: {
        provider: "test",
        model: "test",
        thinking: "off" as const,
        sources: { provider: "crewlead" as const, model: "crewlead" as const, thinking: "crewlead" as const },
      },
      profile: {
        profileVersion: 2,
        profilePath: `agents/pi/roles/${role}.md`,
        profileSha256: "b".repeat(64),
      },
      resources: [{
        id: "member_companion",
        packageName: "@debonzi/db11-crew",
        packageVersion: "0.2.0",
        resourcePath: "agents/pi/extensions/db11-crew-member/index.ts",
        sha256: "a".repeat(64),
      }],
    } : { resources: [] }),
    checks: [{ id: "provenance", ready, code: ready ? "ready" : "unavailable", message: ready ? "ready" : "unavailable" }],
  };
}

interface Fixture {
  home: Awaited<ReturnType<typeof temporaryAccountHome>>;
  project: string;
  root: SecureStateRoot;
  store: DurableStateStore;
  lifecycle: LifecycleService;
  capabilities: RunCapabilityManager;
  leases: FencedLeaseManager;
  herdr: FakeHerdrAdapter;
  configuration: EffectiveConfiguration;
  identity: CrewleadIdentity;
  launchCalls: string[];
  bootstrapConfigurations: CompanionConfiguration[];
  readinessByRole: Map<RoleId, boolean>;
  companionAttempts: Map<string, {
    binding: RunCapabilityBinding;
    capabilities: ClaimedRunCapabilities;
    leaseBinding: LeaseBinding;
    lease: FencedLease;
  }>;
  failures: Map<string, Error>;
  runtime(): CrewleadRuntime;
}

async function fixture(
  limits: Partial<EffectiveConfiguration["limits"]> = {},
  suppliedHome?: Awaited<ReturnType<typeof temporaryAccountHome>>,
): Promise<Fixture> {
  const home = suppliedHome ?? await temporaryAccountHome();
  const project = join(home.path, "project");
  await mkdir(join(project, "src"), { recursive: true, mode: 0o700 });
  const root = await SecureStateRoot.openAtAccountHome(home.path, { now: () => timestamp });
  const store = await DurableStateStore.openAtAccountHome(home.path, { now: () => timestamp });
  const configuration: EffectiveConfiguration = {
    ...DEFAULT_CONFIGURATION,
    limits: { ...DEFAULT_CONFIGURATION.limits, ...limits },
  };
  const lifecycle = new LifecycleService(store, configuration.limits);
  const capabilities = new RunCapabilityManager(root, { now: () => timestamp });
  const bootstrapConfigurations: CompanionConfiguration[] = [];
  const provision = capabilities.provision.bind(capabilities);
  capabilities.provision = async (binding, companionConfiguration) => {
    if (companionConfiguration) bootstrapConfigurations.push(structuredClone(companionConfiguration));
    return provision(binding, companionConfiguration);
  };
  const leases = new FencedLeaseManager(root, { now: () => timestamp });
  const herdr = new FakeHerdrAdapter(snapshot(project));
  const identity: CrewleadIdentity = {
    crewleadSessionId: "crewlead-session",
    herdrWorkspaceId: "workspace-1",
    herdrPaneId: "pane-crewlead",
    canonicalProjectPath: project,
  };
  const launchCalls: string[] = [];
  const readinessByRole = new Map<RoleId, boolean>([["scout", true], ["planner", true], ["builder", true]]);
  const companionAttempts = new Map<string, {
    binding: RunCapabilityBinding;
    capabilities: ClaimedRunCapabilities;
    leaseBinding: LeaseBinding;
    lease: FencedLease;
  }>();
  const failures = new Map<string, Error>();
  let identifier = 0;
  const value: Fixture = {
    home,
    project,
    root,
    store,
    lifecycle,
    capabilities,
    leases,
    herdr,
    configuration,
    identity,
    launchCalls,
    bootstrapConfigurations,
    readinessByRole,
    companionAttempts,
    failures,
    runtime() {
      const dependencies: CrewleadRuntimeDependencies = {
        store,
        lifecycle,
        herdr,
        capabilities,
        leases,
        configuration,
        memberExtensionSha256: "a".repeat(64),
        now: () => timestamp,
        id: () => String(++identifier).padStart(8, "0"),
        enableRenewalTimer: false,
        resolveReadiness: async (role) => readiness(role, readinessByRole.get(role) !== false),
        prepareWorkspace: async (run) => ({
          assignedRoot: project,
          sessionDirectory: join(home.path, `session-${run.runId}`),
          evidenceRef: `workspace:${run.runId}`,
          repositoryResource: {
            kind: "read_snapshot",
            runId: run.runId,
            source: {
              canonicalRoot: project,
              canonicalRootDigest: "a".repeat(64),
              commonGitDirectory: join(project, ".git"),
              commonGitDirectoryDigest: "b".repeat(64),
              commonGitDevice: "1",
              commonGitInode: "2",
            },
            path: project,
            sourceHead: "c".repeat(40),
            baselineManifestDigest: "d".repeat(64),
          },
        }),
        planBuilderWorkspace: async (run) => {
          const sessionDirectory = join(home.path, `session-${run.runId}`);
          return {
            kind: "builder_allocation",
            assignedRoot: project,
            sessionDirectory,
            evidenceRef: `builder-allocation:${run.runId}`,
            allocation: {
              runId: run.runId,
              source: {
                canonicalRoot: project,
                canonicalRootDigest: "a".repeat(64),
                commonGitDirectory: join(project, ".git"),
                commonGitDirectoryDigest: "b".repeat(64),
                commonGitDevice: "1",
                commonGitInode: "2",
              },
              sourceStatusDigest: "c".repeat(64),
              path: project,
              sessionDirectory,
              branch: `db11-crew/${run.runId}`,
              branchRef: `refs/heads/db11-crew/${run.runId}`,
              baseCommit: "d".repeat(40),
              targetBranch: "main",
              targetRef: "refs/heads/main",
              targetCommit: "d".repeat(40),
              protectedRefDigest: "e".repeat(64),
              automaticIntegrationEligible: true,
            },
          };
        },
        createBuilderWorkspace: async (run, _taskPacket, plan) => ({
          assignedRoot: plan.assignedRoot,
          sessionDirectory: plan.sessionDirectory,
          evidenceRef: `builder-worktree:${run.runId}`,
          repositoryResource: {
            kind: "builder_worktree",
            runId: run.runId,
            source: structuredClone(plan.allocation.source),
            path: plan.assignedRoot,
            branch: plan.allocation.branch,
            branchRef: plan.allocation.branchRef,
            baseCommit: plan.allocation.baseCommit,
            targetBranch: plan.allocation.targetBranch,
            targetRef: plan.allocation.targetRef,
            targetCommit: plan.allocation.targetCommit,
            protectedRefDigest: plan.allocation.protectedRefDigest,
            automaticIntegrationEligible: plan.allocation.automaticIntegrationEligible,
          },
        }),
        verifyBuilderResource: async () => {},
        launch: async ({ run, bootstrapPath }) => {
          launchCalls.push(run.packetId);
          const failure = failures.get(run.packetId);
          if (failure) throw failure;
          const claimed = await capabilities.claimCompanionBootstrap(bootstrapPath, {
            memberSessionId: run.binding.memberSessionId!,
            role: run.role,
          });
          const leaseBinding: LeaseBinding = {
            protocolVersion: 1,
            scope: "companion",
            crewleadSessionId: run.binding.crewleadSessionId,
            herdrWorkspaceId: run.binding.herdrWorkspaceId,
            canonicalProjectPath: run.binding.canonicalProjectPath,
            runId: run.runId,
            memberSessionId: run.binding.memberSessionId!,
            role: run.role,
          };
          const lease = await leases.acquire(leaseBinding);
          assert.equal(lease.fencingEpoch, run.fencingEpoch);
          companionAttempts.set(run.runId, {
            binding: claimed.binding,
            capabilities: claimed.capabilities,
            leaseBinding,
            lease,
          });
          const resources: MemberResources = {
            workspaceId: "workspace-1",
            tabId: `tab-${run.runId}`,
            paneId: `pane-${run.runId}`,
            agentTarget: `pane-${run.runId}`,
            agentName: `scout-${run.runId}`.slice(0, 32),
            memberSession: { source: "pi", agent: "pi", kind: "id", value: run.binding.memberSessionId! },
          };
          const pane = {
            paneId: resources.paneId,
            terminalId: `terminal-${run.runId}`,
            workspaceId: resources.workspaceId,
            tabId: resources.tabId,
            focused: false,
            agentState: "idle" as const,
            revision: 1,
            cwd: project,
          };
          herdr.snapshotValue = {
            ...herdr.snapshotValue,
            tabs: [...herdr.snapshotValue.tabs, {
              tabId: resources.tabId,
              workspaceId: resources.workspaceId,
              label: run.purposeLabel,
              focused: false,
              paneCount: 1,
              agentState: "idle",
            }],
            panes: [...herdr.snapshotValue.panes, pane],
            agents: [...herdr.snapshotValue.agents, {
              ...pane,
              name: resources.agentName,
              interactiveReady: true,
              launchPending: false,
              stateChangeSequence: 1,
              agentSession: resources.memberSession,
            }],
          };
          return { resources };
        },
      };
      return new CrewleadRuntime(identity, dependencies);
    },
  };
  return value;
}

function request(id: string, role: RoleId = "scout", mode: "start" | "queue" = "start") {
  return {
    mode,
    evidenceRefs: ["request:authorized"],
    items: [{ role, purpose: id, packet: packet(`packet-${id}`, role) }],
  } as const;
}

async function cancelDirect(value: Fixture, run: RunRecord): Promise<RunRecord> {
  return value.lifecycle.transition({
    operationId: `test-cancel-${run.runId}-${run.revision}`,
    runId: run.runId,
    expectedRevision: run.revision,
    expectedFencingEpoch: run.fencingEpoch,
    actor: "crewlead",
    targetState: "cancelled",
    reason: "The deterministic test releases capacity.",
    evidenceRefs: ["test:capacity-release"],
    timestamp: new Date(timestamp).toISOString(),
  });
}

async function mutateRunForRecoveryTest(
  value: Fixture,
  runId: string,
  suffix: string,
  mutate: (next: RunRecord) => void,
): Promise<RunRecord> {
  const current = structuredClone(await value.store.readRun(runId)) as RunRecord;
  const next = structuredClone(current);
  mutate(next);
  next.revision += 1;
  next.updatedAt = new Date(timestamp + next.revision * 1_000).toISOString();
  const operationId = `test-${suffix}-${next.revision}`;
  const event = {
    schemaVersion: 1,
    eventId: operationId,
    runId,
    sequence: next.revision,
    timestamp: next.updatedAt,
    actor: "crewlead",
    type: "diagnostic",
    reason: "A deterministic test changed one recovery gate input.",
    evidenceRefs: [`test:${suffix}`],
    expectedPriorState: current.state,
    resultingState: next.state,
    expectedRevision: current.revision,
    resultingRevision: next.revision,
    fencingEpoch: next.fencingEpoch,
  };
  const committed = await value.store.commitRun({
    operationId,
    expectedRevision: current.revision,
    expectedFencingEpoch: current.fencingEpoch,
    run: next,
    history: [{ kind: "lifecycle", payload: event }],
  });
  return structuredClone(committed.run) as RunRecord;
}

interface CapturedTool {
  name: string;
  parameters: unknown;
  execute: (...args: never[]) => Promise<unknown>;
}

type CapturedHandler = (...args: never[]) => unknown;

interface ExtensionHarness {
  api: ExtensionAPI;
  tools: Map<string, CapturedTool>;
  commands: Set<string>;
  entries: Array<Record<string, unknown>>;
  context: ExtensionContext;
  activeTools(): string[];
  actionCalls(): number;
  setActiveTools(names: readonly string[]): void;
  emit(name: string, event: Record<string, unknown>): Promise<unknown>;
}

function extensionHarness(options: {
  sessionId?: string;
  entries?: Array<Record<string, unknown>>;
  activeTools?: string[];
  appendFailure?: Error;
  onAppend?: () => void;
  onActiveTools?: (names: readonly string[]) => void;
} = {}): ExtensionHarness {
  const tools = new Map<string, CapturedTool>();
  const commands = new Set<string>();
  const handlers = new Map<string, CapturedHandler[]>();
  const entries = options.entries ?? [];
  let activeTools = [...(options.activeTools ?? ["read", "unrelated_tool"])];
  let actionCalls = 0;
  const context = {
    hasUI: false,
    cwd: "/project",
    isIdle: () => true,
    hasPendingMessages: () => false,
    isProjectTrusted: () => true,
    sessionManager: {
      getEntries: () => entries,
      getSessionFile: () => "/sessions/current.jsonl",
      getSessionId: () => options.sessionId ?? "crewlead-session",
    },
  } as unknown as ExtensionContext;
  const api = {
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
      if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
    },
    registerCommand(name: string) { commands.add(name); },
    on(name: string, handler: CapturedHandler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools(names: string[]) {
      actionCalls += 1;
      activeTools = [...new Set(names)];
      options.onActiveTools?.(activeTools);
    },
    appendEntry(customType: string, data: unknown) {
      if (options.appendFailure) throw options.appendFailure;
      entries.push({ type: "custom", customType, data });
      options.onAppend?.();
    },
    sendMessage() {},
  } as unknown as ExtensionAPI;
  return {
    api,
    tools,
    commands,
    entries,
    context,
    activeTools: () => [...activeTools],
    actionCalls: () => actionCalls,
    setActiveTools(names) { activeTools = [...names]; },
    async emit(name, event) {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) {
        result = await handler(event as never, context as never);
      }
      return result;
    },
  };
}

async function createCandidateRuntime(value: Fixture): Promise<CrewleadRuntime> {
  return value.runtime();
}

function marker(sessionId = "crewlead-session"): Record<string, unknown> {
  return {
    type: "custom",
    customType: CREWLEAD_DESIGNATION_ENTRY_TYPE,
    data: createCrewleadDesignation(sessionId),
  };
}

function hasAllCrewleadTools(active: readonly string[]): boolean {
  return CREWLEAD_TOOL_NAMES.every((name) => active.includes(name));
}

function hasNoCrewleadTools(active: readonly string[]): boolean {
  return CREWLEAD_TOOL_NAMES.every((name) => !active.includes(name));
}

test("Crewlead extension loads without action calls and the first session start makes it passive", async () => {
  const harness = extensionHarness();
  installCrewleadExtension(harness.api, {
    extensionPath: "/package/agents/pi/extensions/db11-crew/index.ts",
    createRuntime: async () => undefined,
  });
  assert.deepEqual([...harness.tools.keys()].sort(), [...CREWLEAD_TOOL_NAMES].sort());
  assert.equal([...harness.tools.keys()].some((name) => name.includes("shell") || name.includes("herdr_proxy")), false);
  assert.deepEqual([...harness.commands].sort(), ["db11-crew-doctor", "db11-crew-settings", "db11-crew-setup"]);
  assert.equal(harness.actionCalls(), 0, "extension factory loading must not invoke Pi action methods");
  assert.equal(hasAllCrewleadTools(harness.activeTools()), true, "Pi activates registered tools until session_start");
  const dispatchSchema = JSON.stringify(harness.tools.get("db11_crew_dispatch")!.parameters);
  assert.equal(dispatchSchema.includes('"additionalProperties":false'), true);
  assert.equal(dispatchSchema.includes('"const"'), false);
  const resultSchema = JSON.stringify(harness.tools.get("db11_crew_result")!.parameters);
  assert.match(resultSchema, /completion_criteria/u);
  assert.match(resultSchema, /role_details/u);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  assert.equal(hasNoCrewleadTools(harness.activeTools()), true);
  assert.deepEqual(harness.activeTools().sort(), ["read", "unrelated_tool"]);
  harness.setActiveTools(["read", "unrelated_tool", ...CREWLEAD_TOOL_NAMES]);
  await harness.emit("before_agent_start", { type: "before_agent_start" });
  assert.equal(hasNoCrewleadTools(harness.activeTools()), true);
  assert.equal(harness.activeTools().includes("unrelated_tool"), true);
  await assert.rejects(
    harness.tools.get("db11_crew_dispatch")!.execute("call" as never, {
      mode: "start",
      items: [{ role: "scout", purpose: "inert", packet: packet("packet-inert") }],
      evidenceRefs: ["request:authorized"],
    } as never),
    /inactive until/u,
  );
});

test("exact interactive and RPC input designate once and preserve unrelated active tools", async () => {
  for (const source of ["interactive", "rpc"] as const) {
    const value = await fixture();
    try {
      const harness = extensionHarness();
      let createCalls = 0;
      installCrewleadExtension(harness.api, {
        extensionPath: "/package/agents/pi/extensions/db11-crew/index.ts",
        createRuntime: async () => {
          createCalls += 1;
          return createCandidateRuntime(value);
        },
      });
      await harness.emit("session_start", { type: "session_start", reason: "startup" });
      assert.equal(createCalls, 0);
      assert.equal(hasNoCrewleadTools(harness.activeTools()), true);

      assert.deepEqual(await harness.emit("input", {
        type: "input",
        text: "/skill:db11-crew",
        source,
      }), { action: "continue" });
      assert.equal(createCalls, 1);
      assert.equal(hasAllCrewleadTools(harness.activeTools()), true);
      assert.equal(harness.activeTools().includes("unrelated_tool"), true);
      assert.equal(harness.entries.filter((entry) =>
        entry.type === "custom" && entry.customType === CREWLEAD_DESIGNATION_ENTRY_TYPE).length, 1);

      assert.deepEqual(await harness.emit("input", {
        type: "input",
        text: "/skill:db11-crew",
        source,
      }), { action: "continue" });
      assert.equal(createCalls, 1);
      assert.equal(harness.entries.length, 1);

      harness.setActiveTools(["read", "unrelated_tool"]);
      await harness.emit("before_agent_start", { type: "before_agent_start" });
      assert.equal(hasAllCrewleadTools(harness.activeTools()), true);
      assert.equal(harness.activeTools().includes("unrelated_tool"), true);
      harness.setActiveTools(["read", "unrelated_tool"]);
      await harness.emit("session_tree", { type: "session_tree", newLeafId: "leaf", oldLeafId: "old" });
      assert.equal(hasAllCrewleadTools(harness.activeTools()), true);
      assert.equal(harness.activeTools().includes("unrelated_tool"), true);

      await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
      assert.equal(hasNoCrewleadTools(harness.activeTools()), true);
      assert.equal(harness.entries.length, 1, "shutdown never removes or rewrites the designation marker");
    } finally {
      await value.home.cleanup();
    }
  }
});

test("rejected activation paths never start a runtime or enable Crewlead tools", async () => {
  const harness = extensionHarness();
  let createCalls = 0;
  installCrewleadExtension(harness.api, {
    extensionPath: "/package/agents/pi/extensions/db11-crew/index.ts",
    createRuntime: async () => {
      createCalls += 1;
      return undefined;
    },
  });
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  const rejected = [
    { text: "/skill:db11-crew", source: "extension" },
    { text: " /skill:db11-crew", source: "interactive" },
    { text: "/skill:db11-crew now", source: "rpc" },
    { text: "/skill:db11-crew", source: "interactive", images: [{ type: "image" }] },
    { text: "Please use DB11 Crew", source: "interactive" },
  ];
  const results = [];
  for (const input of rejected) {
    results.push(await harness.emit("input", { type: "input", ...input }));
  }
  assert.deepEqual(results, [
    { action: "handled" },
    { action: "continue" },
    { action: "continue" },
    { action: "continue" },
    { action: "continue" },
  ]);
  assert.equal(createCalls, 0);
  assert.equal(harness.entries.length, 0);
  assert.equal(hasNoCrewleadTools(harness.activeTools()), true);

  const member = extensionHarness();
  let memberCreateCalls = 0;
  installCrewleadExtension(member.api, {
    extensionPath: "/package/agents/pi/extensions/db11-crew/index.ts",
    environment: { DB11_CREW_MEMBER_BOOTSTRAP: "/private/bootstrap.json" },
    createRuntime: async () => {
      memberCreateCalls += 1;
      return undefined;
    },
  });
  await member.emit("session_start", { type: "session_start", reason: "startup" });
  assert.deepEqual(await member.emit("input", {
    type: "input",
    text: "/skill:db11-crew",
    source: "interactive",
  }), { action: "handled" });
  assert.equal(memberCreateCalls, 0);
  assert.equal(member.entries.length, 0);
  assert.equal(hasNoCrewleadTools(member.activeTools()), true);
  assert.deepEqual(member.activeTools().sort(), ["read", "unrelated_tool"]);

  const markedMember = extensionHarness({ entries: [marker()] });
  installCrewleadExtension(markedMember.api, {
    extensionPath: "/package/agents/pi/extensions/db11-crew/index.ts",
    environment: { DB11_CREW_RUN_ID: "run-managed-member" },
    createRuntime: async () => {
      throw new Error("a managed member marker must never start the Crewlead runtime");
    },
  });
  await markedMember.emit("session_start", { type: "session_start", reason: "resume" });
  assert.equal(hasNoCrewleadTools(markedMember.activeTools()), true);
  assert.deepEqual(markedMember.activeTools().sort(), ["read", "unrelated_tool"]);
  assert.equal(markedMember.entries.length, 1);
});

test("startup-gate and marker-persistence failures leave the session undesignated", async () => {
  for (const failure of ["unavailable", "throw"] as const) {
    const harness = extensionHarness();
    let createCalls = 0;
    installCrewleadExtension(harness.api, {
      extensionPath: "/package/agents/pi/extensions/db11-crew/index.ts",
      createRuntime: async () => {
        createCalls += 1;
        if (failure === "throw") throw new Error("injected readiness failure");
        return undefined;
      },
    });
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    assert.deepEqual(await harness.emit("input", {
      type: "input",
      text: "/skill:db11-crew",
      source: "interactive",
    }), { action: "handled" });
    assert.equal(createCalls, 1);
    assert.equal(harness.entries.length, 0);
    assert.equal(hasNoCrewleadTools(harness.activeTools()), true);
  }

  const value = await fixture();
  try {
    const harness = extensionHarness({ appendFailure: new Error("injected append failure") });
    let stops = 0;
    installCrewleadExtension(harness.api, {
      extensionPath: "/package/agents/pi/extensions/db11-crew/index.ts",
      createRuntime: async () => {
        const runtime = await createCandidateRuntime(value);
        const stop = runtime.stop.bind(runtime);
        runtime.stop = async () => {
          stops += 1;
          await stop();
        };
        return runtime;
      },
    });
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    assert.deepEqual(await harness.emit("input", {
      type: "input",
      text: "/skill:db11-crew",
      source: "rpc",
    }), { action: "handled" });
    assert.equal(stops, 1, "the candidate runtime is torn down when marker persistence fails");
    assert.equal(harness.entries.length, 0);
    assert.equal(hasNoCrewleadTools(harness.activeTools()), true);
  } finally {
    await value.home.cleanup();
  }
});

test("direct activation stages initialization, fencing, designation, operations, presentation, and tools", async () => {
  const home = await temporaryAccountHome();
  await mkdir(join(home.path, "project", "src"), { recursive: true, mode: 0o700 });
  const trace: string[] = [];
  let value: Fixture | undefined;
  const harness = extensionHarness({
    onAppend: () => trace.push("designation"),
    onActiveTools: (names) => {
      if (hasAllCrewleadTools(names)) trace.push("tools");
    },
  });
  try {
    installCrewleadExtension(harness.api, {
      extensionPath: "/package/agents/pi/extensions/db11-crew/index.ts",
      prepareRuntime: async () => {
        trace.push("prepare");
        assert.equal(await SecureStateRoot.inspectAtAccountHome(home.path), "missing_safe");
        return {
          initialize: async () => {
            trace.push("initialize");
            value = await fixture({}, home);
            const candidate = value.runtime();
            const startFenced = candidate.startFenced.bind(candidate);
            candidate.startFenced = async () => {
              trace.push("fenced");
              await startFenced();
            };
            const enableOperations = candidate.enableOperations.bind(candidate);
            candidate.enableOperations = async () => {
              trace.push("operations");
              await enableOperations();
            };
            const sweepRuntimeCleanup = candidate.sweepRuntimeCleanup.bind(candidate);
            candidate.sweepRuntimeCleanup = async () => {
              trace.push("presentation");
              return sweepRuntimeCleanup();
            };
            return candidate;
          },
        };
      },
    });
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    trace.length = 0;
    assert.deepEqual(await harness.emit("input", {
      type: "input",
      text: "/skill:db11-crew",
      source: "interactive",
    }), { action: "continue" });
    assert.deepEqual(trace, [
      "prepare",
      "initialize",
      "fenced",
      "designation",
      "operations",
      "presentation",
      "tools",
    ]);
    assert.equal(await SecureStateRoot.inspectAtAccountHome(home.path), "recognized");
    assert.equal(harness.entries.length, 1);
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    await home.cleanup();
  }
});

test("pre-designation failures retain initialized canonical state and release fencing", async () => {
  for (const stage of ["initialize", "fenced", "designation"] as const) {
    const home = await temporaryAccountHome();
    await mkdir(join(home.path, "project", "src"), { recursive: true, mode: 0o700 });
    let value: Fixture | undefined;
    let storeId: string | undefined;
    const harness = extensionHarness({
      ...(stage === "designation" ? { appendFailure: new Error("injected designation failure") } : {}),
    });
    try {
      installCrewleadExtension(harness.api, {
        extensionPath: "/package/agents/pi/extensions/db11-crew/index.ts",
        prepareRuntime: async () => ({
          initialize: async () => {
            if (stage === "initialize") {
              const root = await SecureStateRoot.openAtAccountHome(home.path);
              storeId = root.storeId;
              throw new Error("injected post-initialization failure");
            }
            value = await fixture({}, home);
            storeId = value.root.storeId;
            if (stage === "fenced") value.herdr.failNext("subscribe", new Error("injected fenced startup failure"));
            return value.runtime();
          },
        }),
      });
      await harness.emit("session_start", { type: "session_start", reason: "startup" });
      assert.deepEqual(await harness.emit("input", {
        type: "input",
        text: "/skill:db11-crew",
        source: "rpc",
      }), { action: "handled" }, stage);
      assert.equal(harness.entries.length, 0, stage);
      assert.equal(hasNoCrewleadTools(harness.activeTools()), true, stage);
      assert.equal(await SecureStateRoot.inspectAtAccountHome(home.path), "recognized", stage);
      assert.equal((await SecureStateRoot.openAtAccountHome(home.path)).storeId, storeId, stage);
      if (value) {
        const replacement = value.runtime();
        await replacement.startFenced();
        await replacement.stop();
      }
    } finally {
      await home.cleanup();
    }
  }
});

test("post-designation operation and presentation failures leave one permanent unavailable marker", async () => {
  for (const stage of ["operations", "presentation"] as const) {
    const value = await fixture();
    let preparations = 0;
    const harness = extensionHarness();
    try {
      installCrewleadExtension(harness.api, {
        extensionPath: "/package/agents/pi/extensions/db11-crew/index.ts",
        prepareRuntime: async () => {
          preparations += 1;
          return {
            initialize: async () => {
              const candidate = value.runtime();
              if (stage === "operations") {
                candidate.enableOperations = async () => {
                  throw new Error("injected operation enablement failure");
                };
              } else {
                candidate.sweepRuntimeCleanup = async () => {
                  throw new Error("injected presentation failure");
                };
              }
              return candidate;
            },
          };
        },
      });
      await harness.emit("session_start", { type: "session_start", reason: "startup" });
      assert.deepEqual(await harness.emit("input", {
        type: "input",
        text: "/skill:db11-crew",
        source: "interactive",
      }), { action: "handled" }, stage);
      assert.equal(harness.entries.filter((entry) =>
        entry.type === "custom" && entry.customType === CREWLEAD_DESIGNATION_ENTRY_TYPE).length, 1, stage);
      assert.equal(hasNoCrewleadTools(harness.activeTools()), true, stage);
      assert.deepEqual(await harness.emit("input", {
        type: "input",
        text: "/skill:db11-crew",
        source: "interactive",
      }), { action: "handled" }, stage);
      assert.equal(preparations, 1, stage);
      assert.equal(harness.entries.length, 1, stage);
      assert.equal(await SecureStateRoot.inspectAtAccountHome(value.home.path), "recognized", stage);
    } finally {
      await value.home.cleanup();
    }
  }
});

test("fenced startup latches subscription and queue promotion until operations are enabled", async (t) => {
  const value = await fixture({ maxActiveMembers: 1, maxOpenMemberResources: 1 });
  t.after(value.home.cleanup);
  const first = value.runtime();
  await first.start();
  const [queued] = await first.dispatch(request("latched", "scout", "queue"));
  assert.equal(queued!.state, "queued");
  await first.stop();

  const replacement = value.runtime();
  await replacement.startFenced();
  await assert.rejects(
    replacement.list(),
    (error) => error instanceof StateSecurityError && error.code === "lease_invalid",
  );
  value.herdr.emitEvent({ kind: "workspace_changed", workspaceId: value.identity.herdrWorkspaceId });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(value.launchCalls.length, 0);
  assert.equal((await value.store.readRun(queued!.runId) as unknown as RunRecord).state, "queued");

  await replacement.enableOperations();
  assert.deepEqual(value.launchCalls, ["packet-latched"]);
  assert.equal((await value.store.readRun(queued!.runId) as unknown as RunRecord).state, "working");
  await replacement.stop();
});

test("same-session markers restore across startup, resume, reload, compaction, tree navigation, and shutdown/restart", async () => {
  const value = await fixture();
  const entries = [
    { type: "custom", customType: "unrelated", data: { value: true } },
    marker(),
    { type: "compaction", retainedTail: [] },
  ];
  try {
    for (const reason of ["startup", "resume", "reload"] as const) {
      const harness = extensionHarness({ entries });
      let createCalls = 0;
      installCrewleadExtension(harness.api, {
        extensionPath: "/package/agents/pi/extensions/db11-crew/index.ts",
        createRuntime: async () => {
          createCalls += 1;
          return createCandidateRuntime(value);
        },
      });
      await harness.emit("session_start", { type: "session_start", reason });
      assert.equal(createCalls, 1, reason);
      assert.equal(hasAllCrewleadTools(harness.activeTools()), true, reason);
      assert.equal(entries.filter((entry) => entry.customType === CREWLEAD_DESIGNATION_ENTRY_TYPE).length, 1);
      harness.setActiveTools(["read", "unrelated_tool"]);
      await harness.emit("session_tree", { type: "session_tree", newLeafId: null, oldLeafId: "old" });
      assert.equal(hasAllCrewleadTools(harness.activeTools()), true, reason);
      await harness.emit("session_shutdown", { type: "session_shutdown", reason });
      assert.equal(hasNoCrewleadTools(harness.activeTools()), true, reason);
    }
  } finally {
    await value.home.cleanup();
  }
});

test("new, forked, cloned, copied, different, and resumed-other sessions never inherit designation", async () => {
  const inheritedSessionCases = [
    { name: "new", sessionId: "new-session", entries: [] },
    { name: "forked", sessionId: "forked-session", entries: [marker()] },
    { name: "cloned", sessionId: "cloned-session", entries: [marker()] },
    { name: "copied", sessionId: "copied-session", entries: [marker()] },
    { name: "different", sessionId: "different-session", entries: [marker()] },
    { name: "resumed-other", sessionId: "resumed-other-session", entries: [marker()] },
  ];

  for (const inherited of inheritedSessionCases) {
    const harness = extensionHarness({
      sessionId: inherited.sessionId,
      entries: inherited.entries,
    });
    let createCalls = 0;
    installCrewleadExtension(harness.api, {
      extensionPath: "/package/agents/pi/extensions/db11-crew/index.ts",
      createRuntime: async () => {
        createCalls += 1;
        return undefined;
      },
    });
    await harness.emit("session_start", { type: "session_start", reason: inherited.name });
    assert.equal(createCalls, 0, inherited.name);
    assert.equal(hasNoCrewleadTools(harness.activeTools()), true, inherited.name);
    assert.equal(
      inherited.entries.filter((entry) => entry.customType === CREWLEAD_DESIGNATION_ENTRY_TYPE).length,
      inherited.name === "new" ? 0 : 1,
      inherited.name,
    );
  }
});

test("a designated unavailable owner retries only on a later session lifecycle start", async () => {
  const value = await fixture();
  try {
    const harness = extensionHarness({ entries: [marker()] });
    let createCalls = 0;
    installCrewleadExtension(harness.api, {
      extensionPath: "/package/agents/pi/extensions/db11-crew/index.ts",
      createRuntime: async () => {
        createCalls += 1;
        return createCalls === 1 ? undefined : createCandidateRuntime(value);
      },
    });
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    assert.equal(createCalls, 1);
    assert.equal(hasNoCrewleadTools(harness.activeTools()), true);
    assert.deepEqual(await harness.emit("input", {
      type: "input",
      text: "/skill:db11-crew",
      source: "interactive",
    }), { action: "handled" });
    assert.equal(createCalls, 1, "direct input does not retry a designated unavailable runtime");
    assert.equal(harness.entries.length, 1);

    await harness.emit("session_start", { type: "session_start", reason: "reload" });
    assert.equal(createCalls, 2);
    assert.equal(hasAllCrewleadTools(harness.activeTools()), true);
    assert.equal(harness.entries.length, 1);
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    await value.home.cleanup();
  }
});

test("concurrent admission never oversubscribes and invalid batch preflight has no side effects", async (t) => {
  const value = await fixture({ maxActiveMembers: 1, maxOpenMemberResources: 1 });
  t.after(value.home.cleanup);
  const runtime = value.runtime();
  await runtime.start();
  t.after(() => runtime.stop());

  const settled = await Promise.allSettled([
    runtime.dispatch(request("one")),
    runtime.dispatch(request("two")),
  ]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal((rejected?.reason as { code?: unknown } | undefined)?.code, "admission_capacity");
  assert.equal((await value.store.listRuns()).length, 1);
  assert.equal(value.launchCalls.length, 1);

  const invalid = packet("packet-invalid");
  (invalid as unknown as { unexpected: boolean }).unexpected = true;
  await assert.rejects(runtime.dispatch({
    mode: "start",
    evidenceRefs: ["request:authorized"],
    items: [
      { role: "scout", purpose: "valid", packet: packet("packet-valid") },
      { role: "scout", purpose: "invalid", packet: invalid },
    ],
  }));
  assert.equal((await value.store.listRuns()).length, 1);
  assert.equal(value.launchCalls.length, 1);
});

test("immediate startup refreshes role readiness before workspace and member side effects", async (t) => {
  await t.test("readiness changes after admission", async (subtest) => {
    const value = await fixture();
    subtest.after(value.home.cleanup);
    const runtime = value.runtime();
    await runtime.start();
    subtest.after(() => runtime.stop());
    const resolve = runtime.dependencies.resolveReadiness;
    const prepare = runtime.dependencies.prepareWorkspace;
    let readinessCalls = 0;
    let preparationCalls = 0;
    runtime.dependencies.resolveReadiness = async (role, explicitRuntime) => {
      readinessCalls += 1;
      if (readinessCalls === 2) return readiness(role, false);
      return resolve(role, explicitRuntime);
    };
    runtime.dependencies.prepareWorkspace = async (run, taskPacket) => {
      preparationCalls += 1;
      return prepare(run, taskPacket);
    };

    const receipt = (await runtime.dispatch(request("admission-readiness-flip")))[0]!;
    const stored = (await runtime.inspect(receipt.runId)).run;
    assert.equal(readinessCalls, 2);
    assert.equal(preparationCalls, 0);
    assert.equal(value.bootstrapConfigurations.length, 0);
    assert.equal(value.launchCalls.length, 0);
    assert.equal(stored.startup?.phase, "partial_failure");
    assert.equal(stored.repositoryResource, undefined);
    assert.match(receipt.warnings.join(" "), /No automatic retry or cleanup/u);
  });

  await t.test("readiness changes after workspace preparation", async (subtest) => {
    const value = await fixture();
    subtest.after(value.home.cleanup);
    const runtime = value.runtime();
    await runtime.start();
    subtest.after(() => runtime.stop());
    const prepare = runtime.dependencies.prepareWorkspace;
    runtime.dependencies.prepareWorkspace = async (run, taskPacket) => {
      const prepared = await prepare(run, taskPacket);
      value.readinessByRole.set(run.role, false);
      return prepared;
    };

    const receipt = (await runtime.dispatch(request("launch-readiness-flip")))[0]!;
    const stored = (await runtime.inspect(receipt.runId)).run;
    assert.equal(stored.startup?.phase, "partial_failure");
    assert.equal(stored.repositoryResource?.runId, receipt.runId);
    assert.equal(value.bootstrapConfigurations.length, 0);
    assert.equal(value.launchCalls.length, 0);
    assert.match(receipt.warnings.join(" "), /No automatic retry or cleanup/u);
  });

  await t.test("readiness changes after bootstrap provisioning", async (subtest) => {
    const value = await fixture();
    subtest.after(value.home.cleanup);
    const runtime = value.runtime();
    await runtime.start();
    subtest.after(() => runtime.stop());
    const provision = value.capabilities.provision.bind(value.capabilities);
    value.capabilities.provision = async (binding, configuration) => {
      const bootstrap = await provision(binding, configuration);
      value.readinessByRole.set(binding.role!, false);
      return bootstrap;
    };

    const receipt = (await runtime.dispatch(request("post-bootstrap-readiness-flip")))[0]!;
    const stored = (await runtime.inspect(receipt.runId)).run;
    assert.equal(stored.startup?.phase, "partial_failure");
    assert.equal(typeof stored.startup?.bootstrapId, "string");
    assert.equal(value.bootstrapConfigurations.length, 1);
    assert.equal(value.launchCalls.length, 0);
    assert.match(receipt.warnings.join(" "), /No automatic retry or cleanup/u);
  });
});

test("Builder startup persists exact allocation before creation and retains failed intent", async (t) => {
  const configureBuilderAllocation = (value: Fixture, runtime: CrewleadRuntime, failCreation: boolean) => {
    const trace: string[] = [];
    runtime.dependencies.planBuilderWorkspace = async (run) => {
      trace.push("plan");
      const sessionDirectory = join(value.home.path, `session-${run.runId}`);
      return {
        kind: "builder_allocation",
        assignedRoot: value.project,
        sessionDirectory,
        evidenceRef: `builder-allocation:${run.runId}`,
        allocation: {
          runId: run.runId,
          source: {
            canonicalRoot: value.project,
            canonicalRootDigest: "a".repeat(64),
            commonGitDirectory: join(value.project, ".git"),
            commonGitDirectoryDigest: "b".repeat(64),
            commonGitDevice: "1",
            commonGitInode: "2",
          },
          sourceStatusDigest: "c".repeat(64),
          path: value.project,
          sessionDirectory,
          branch: `db11-crew/${run.runId}`,
          branchRef: `refs/heads/db11-crew/${run.runId}`,
          baseCommit: "d".repeat(40),
          targetBranch: "main",
          targetRef: "refs/heads/main",
          targetCommit: "d".repeat(40),
          protectedRefDigest: "e".repeat(64),
          automaticIntegrationEligible: true,
        },
      };
    };
    runtime.dependencies.createBuilderWorkspace = async (run, _taskPacket, plan) => {
      const stored = await value.store.readRun(run.runId) as unknown as RunRecord;
      assert.equal(stored.repositoryAllocation?.status, "prepared");
      assert.equal(stored.revision, run.revision);
      trace.push("create");
      if (failCreation) throw new Error("injected exact Git creation failure");
      return {
        assignedRoot: plan.assignedRoot,
        sessionDirectory: plan.sessionDirectory,
        evidenceRef: `builder-worktree:${run.runId}`,
        repositoryResource: {
          kind: "builder_worktree",
          runId: run.runId,
          source: structuredClone(plan.allocation.source),
          path: plan.assignedRoot,
          branch: plan.allocation.branch,
          branchRef: plan.allocation.branchRef,
          baseCommit: plan.allocation.baseCommit,
          targetBranch: plan.allocation.targetBranch,
          targetRef: plan.allocation.targetRef,
          targetCommit: plan.allocation.targetCommit,
          protectedRefDigest: plan.allocation.protectedRefDigest,
          automaticIntegrationEligible: true,
        },
      };
    };
    return trace;
  };

  await t.test("verified creation promotes the same durable intent", async (subtest) => {
    const value = await fixture();
    subtest.after(value.home.cleanup);
    const runtime = value.runtime();
    const trace = configureBuilderAllocation(value, runtime, false);
    const launch = runtime.dependencies.launch;
    runtime.dependencies.launch = async (input) => {
      trace.push("launch");
      return launch(input);
    };
    await runtime.start();
    subtest.after(() => runtime.stop());
    const receipt = (await runtime.dispatch(request("durable-allocation", "builder")))[0]!;
    const stored = (await runtime.inspect(receipt.runId)).run;
    assert.deepEqual(trace, ["plan", "create", "launch"]);
    assert.equal(stored.repositoryAllocation?.status, "created");
    assert.equal(stored.repositoryAllocation?.expectedRevision, 1);
    assert.equal(stored.repositoryAllocation?.protectedRefDigest, "e".repeat(64));
    assert.equal(stored.repositoryResource?.kind, "builder_worktree");
    assert.equal(stored.repositoryResource?.protectedRefDigest, "e".repeat(64));
  });

  await t.test("creation failure retains exact failed allocation without launch", async (subtest) => {
    const value = await fixture();
    subtest.after(value.home.cleanup);
    const runtime = value.runtime();
    const trace = configureBuilderAllocation(value, runtime, true);
    await runtime.start();
    subtest.after(() => runtime.stop());
    const receipt = (await runtime.dispatch(request("failed-allocation", "builder")))[0]!;
    const stored = (await runtime.inspect(receipt.runId)).run;
    assert.deepEqual(trace, ["plan", "create"]);
    assert.equal(stored.startup?.phase, "partial_failure");
    assert.equal(stored.repositoryAllocation?.status, "failed");
    assert.equal(stored.repositoryAllocation?.diagnostic, "A private operation failed.");
    assert.equal(stored.repositoryResource, undefined);
    assert.equal(value.launchCalls.length, 0);
    assert.match(receipt.warnings.join(" "), /No automatic retry or cleanup/u);
  });
});

test("queued promotion does not reuse its role-readiness receipt for startup", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const runtime = value.runtime();
  await runtime.start();
  t.after(() => runtime.stop());
  const queued = (await runtime.dispatch(request("queued-readiness-flip", "planner", "queue")))[0]!;
  const resolve = runtime.dependencies.resolveReadiness;
  const prepare = runtime.dependencies.prepareWorkspace;
  let readinessCalls = 0;
  let preparationCalls = 0;
  runtime.dependencies.resolveReadiness = async (role, explicitRuntime) => {
    readinessCalls += 1;
    const receipt = await resolve(role, explicitRuntime);
    if (readinessCalls === 1) value.readinessByRole.set(role, false);
    return receipt;
  };
  runtime.dependencies.prepareWorkspace = async (run, taskPacket) => {
    preparationCalls += 1;
    return prepare(run, taskPacket);
  };

  const promoted = await runtime.promoteAvailable();
  const stored = (await runtime.inspect(queued.runId)).run;
  assert.equal(promoted[0]?.runId, queued.runId);
  assert.equal(readinessCalls, 2, "promotion and startup each obtain fresh evidence");
  assert.equal(preparationCalls, 0);
  assert.equal(value.launchCalls.length, 0);
  assert.equal(stored.state, "starting");
  assert.equal(stored.startup?.phase, "partial_failure");
});

test("Crewlead bootstrap uses companion v2 provenance without role tool or adapter metadata", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const runtime = value.runtime();
  await runtime.start();
  t.after(() => runtime.stop());

  await runtime.dispatch(request("bootstrap-v2", "builder"));
  assert.equal(value.bootstrapConfigurations.length, 1);
  const companionConfiguration = value.bootstrapConfigurations[0]!;
  assert.equal(companionConfiguration.schemaVersion, 2);
  assert.equal(companionConfiguration.memberExtensionPath, "agents/pi/extensions/db11-crew-member/index.ts");
  assert.equal(companionConfiguration.roleProfilePath, "agents/pi/roles/builder.md");
  assert.equal(Object.hasOwn(companionConfiguration, "activeTools"), false);
  assert.equal(Object.hasOwn(companionConfiguration, "executionGrants"), false);
  assert.equal(companionConfiguration.packet.executionGrants?.[0]?.id, "git-commit");
});

test("the hard maximum of six starts concurrently and a seventh delegation is rejected before launch", async (t) => {
  const value = await fixture({ maxActiveMembers: 6, maxOpenMemberResources: 6 });
  t.after(value.home.cleanup);
  const runtime = value.runtime();
  await runtime.start();
  t.after(() => runtime.stop());
  const receipts = await runtime.dispatch({
    mode: "start",
    evidenceRefs: ["request:authorized"],
    items: Array.from({ length: 6 }, (_, index) => ({
      role: "scout" as const,
      purpose: `load-${index + 1}`,
      packet: packet(`packet-load-${index + 1}`),
    })),
  });
  assert.equal(receipts.length, 6);
  assert.equal(receipts.every((receipt) => receipt.state === "working"), true, JSON.stringify(receipts));
  assert.equal(value.launchCalls.length, 6);
  await assert.rejects(
    runtime.dispatch(request("overload")),
    (error) => (error as { code?: unknown }).code === "admission_capacity",
  );
  assert.equal(value.launchCalls.length, 6);
});

test("batch startup records successes and partial failures without blind retry", async (t) => {
  const value = await fixture({ maxActiveMembers: 2, maxOpenMemberResources: 2 });
  t.after(value.home.cleanup);
  const runtime = value.runtime();
  await runtime.start();
  t.after(() => runtime.stop());
  value.failures.set(
    "packet-partial",
    new HerdrAdapterError("startup_partial", {
      partialResources: {
        workspaceId: "workspace-1",
        tabId: "tab-partial",
        paneId: "pane-partial",
        agentTarget: "pane-partial",
      },
    }),
  );

  const receipts = await runtime.dispatch({
    mode: "start",
    requestId: "tool-call-batch-partial",
    evidenceRefs: ["request:authorized"],
    items: [
      { role: "scout", purpose: "success", packet: packet("packet-success") },
      { role: "scout", purpose: "partial", packet: packet("packet-partial") },
    ],
  });
  assert.deepEqual(receipts.map((receipt) => receipt.state).sort(), ["starting", "working"]);
  const partial = receipts.find((receipt) => receipt.state === "starting")!;
  const stored = await runtime.inspect(partial.runId);
  assert.equal(stored.run.startup?.phase, "partial_failure");
  assert.equal(stored.run.startup?.partialResources?.tabId, "tab-partial");
  assert.equal(stored.run.health.reconciliationRequired, true);
  assert.match(partial.warnings.join(" "), /No automatic retry/u);
  assert.equal(value.launchCalls.filter((id) => id === "packet-partial").length, 1);
  await runtime.promoteAvailable();
  const replayed = await runtime.dispatch({
    mode: "start",
    requestId: "tool-call-batch-partial",
    evidenceRefs: ["request:authorized"],
    items: [
      { role: "scout", purpose: "success", packet: packet("packet-success") },
      { role: "scout", purpose: "partial", packet: packet("packet-partial") },
    ],
  });
  assert.match(replayed[0]!.warnings.join(" "), /already admitted/u);
  assert.equal(value.launchCalls.filter((id) => id === "packet-success").length, 1);
  assert.equal(value.launchCalls.filter((id) => id === "packet-partial").length, 1);
});

test("explicit queue promotion is strict FIFO and a blocked head never lets later work pass", async (t) => {
  const value = await fixture({ maxActiveMembers: 1, maxOpenMemberResources: 3, maxQueuedDelegations: 3 });
  t.after(value.home.cleanup);
  const runtime = value.runtime();
  await runtime.start();
  t.after(() => runtime.stop());

  const active = (await runtime.dispatch(request("active")))[0]!;
  const first = (await runtime.dispatch(request("first", "planner", "queue")))[0]!;
  const second = (await runtime.dispatch(request("second", "scout", "queue")))[0]!;
  assert.ok(first.queuedPosition! < second.queuedPosition!);
  assert.deepEqual(value.launchCalls, ["packet-active"]);

  await cancelDirect(value, (await runtime.inspect(active.runId)).run as RunRecord);
  value.readinessByRole.set("planner", false);
  const blocked = await runtime.promoteAvailable();
  assert.equal(blocked[0]?.runId, first.runId);
  assert.equal(blocked[0]?.state, "queued");
  assert.match((await runtime.inspect(first.runId)).run.queue?.startBlockedReason ?? "", /not currently role-ready/u);
  assert.equal((await runtime.inspect(second.runId)).run.state, "queued");
  assert.deepEqual(value.launchCalls, ["packet-active"]);

  value.readinessByRole.set("planner", true);
  await runtime.promoteAvailable();
  assert.deepEqual(value.launchCalls, ["packet-active", "packet-first"]);
  const promotedFirst = (await runtime.inspect(first.runId)).run as RunRecord;
  await cancelDirect(value, promotedFirst);
  await runtime.promoteAvailable();
  assert.deepEqual(value.launchCalls, ["packet-active", "packet-first", "packet-second"]);
});

test("same-session restart restores queue ownership while replacement sessions cannot inspect or control runs", async (t) => {
  const value = await fixture({ maxActiveMembers: 1, maxOpenMemberResources: 2, maxQueuedDelegations: 2 });
  t.after(value.home.cleanup);
  const firstRuntime = value.runtime();
  await firstRuntime.start();
  const active = (await firstRuntime.dispatch(request("active")))[0]!;
  const queued = (await firstRuntime.dispatch(request("restart", "scout", "queue")))[0]!;
  await firstRuntime.stop();
  await cancelDirect(value, (await value.store.readRun(active.runId)) as RunRecord);

  const replacementIdentity = { ...value.identity, crewleadSessionId: "replacement-session" };
  const replacement = new CrewleadRuntime(replacementIdentity, {
    ...firstRuntime.dependencies,
    enableRenewalTimer: false,
  });
  await replacement.start();
  assert.deepEqual(await replacement.list(), []);
  await assert.rejects(
    replacement.inspect(queued.runId),
    (error) => error instanceof StateSecurityError && error.code === "invalid_binding",
  );
  await replacement.stop();

  const resumed = value.runtime();
  await resumed.start();
  t.after(() => resumed.stop());
  assert.equal((await resumed.inspect(queued.runId)).run.state, "working");
  assert.equal(value.launchCalls.filter((id) => id === "packet-restart").length, 1);
});

test("amendment persistence precedes prompt delivery and prompt failure is not retried", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const runtime = value.runtime();
  await runtime.start();
  t.after(() => runtime.stop());
  const receipt = (await runtime.dispatch(request("amend")))[0]!;
  const run = (await runtime.inspect(receipt.runId)).run;
  value.herdr.failNext("prompt", new Error("simulated prompt failure"));
  const amended = await runtime.amend({
    runId: run.runId,
    expectedRevision: run.revision,
    kind: "clarification",
    summary: "Use the already accepted local fixture.",
    evidenceRefs: ["request:clarification"],
  });
  assert.equal(amended.promptAcknowledged, false);
  assert.match(amended.warning ?? "", /not retried/u);
  const history = await value.store.readHistory(run.runId);
  assert.equal(history.some((record) => record.kind === "control" &&
    (record.payload as { author?: unknown }).author === "crewlead"), true);
  assert.equal(value.herdr.calls.filter((call) => call.operation === "prompt").length, 1);
});

test("member-directed prompt and interrupt fail closed when the live native session changes", async (t) => {
  await t.test("amendment prompt", async (subtest) => {
    const value = await fixture();
    subtest.after(value.home.cleanup);
    const runtime = value.runtime();
    await runtime.start();
    subtest.after(() => runtime.stop());
    const receipt = (await runtime.dispatch(request("stale-amend-target")))[0]!;
    const run = (await runtime.inspect(receipt.runId)).run;
    value.herdr.snapshotValue = {
      ...value.herdr.snapshotValue,
      agents: value.herdr.snapshotValue.agents.map((agent) => agent.paneId === run.resources!.paneId
        ? { ...agent, agentSession: { source: "pi", agent: "pi", kind: "id" as const, value: "replacement-session" } }
        : agent),
    };

    const amended = await runtime.amend({
      runId: run.runId,
      expectedRevision: run.revision,
      kind: "clarification",
      summary: "Do not target a replacement native session.",
      evidenceRefs: ["request:stale-amend-target"],
    });
    assert.equal(amended.promptAcknowledged, false);
    assert.equal(amended.run.health.status, "recovery_required");
    assert.match(amended.warning ?? "", /exact live member identity changed/u);
    assert.equal(value.herdr.calls.filter((call) => call.operation === "prompt").length, 0);
  });

  await t.test("graceful interrupt", async (subtest) => {
    const value = await fixture();
    subtest.after(value.home.cleanup);
    const runtime = value.runtime();
    await runtime.start();
    subtest.after(() => runtime.stop());
    const receipt = (await runtime.dispatch(request("stale-cancel-target")))[0]!;
    const run = (await runtime.inspect(receipt.runId)).run;
    value.herdr.snapshotValue = {
      ...value.herdr.snapshotValue,
      agents: value.herdr.snapshotValue.agents.filter((agent) => agent.paneId !== run.resources!.paneId),
    };

    const cancelled = await runtime.cancel({
      runId: run.runId,
      expectedRevision: run.revision,
      reason: "Do not interrupt an unbound replacement pane.",
      evidenceRefs: ["request:stale-cancel-target"],
    });
    assert.equal(cancelled.interruptAcknowledged, false);
    assert.equal(cancelled.run.health.status, "recovery_required");
    assert.match(cancelled.warning ?? "", /No blind interrupt, retry, or force escalation/u);
    assert.equal(value.herdr.calls.filter((call) => call.operation === "interruptAgent").length, 0);
  });
});

test("active cancellation is durable before one exact interrupt and result acknowledgement is revision checked", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const runtime = value.runtime();
  await runtime.start();
  t.after(() => runtime.stop());
  const receipt = (await runtime.dispatch(request("controls")))[0]!;
  let run = (await runtime.inspect(receipt.runId)).run as RunRecord;
  const cancelled = await runtime.cancel({
    runId: run.runId,
    expectedRevision: run.revision,
    reason: "The requester cancelled the bounded run.",
    evidenceRefs: ["request:cancel"],
  });
  assert.equal(cancelled.run.state, "working", "cancellation remains pending until companion acknowledgement");
  assert.equal(cancelled.interruptAcknowledged, true);
  const history = await value.store.readHistory(run.runId);
  assert.equal(history.some((record) => record.kind === "control" &&
    (record.payload as { type?: unknown }).type === "cancel_requested"), true);
  assert.equal(value.herdr.calls.filter((call) => call.operation === "interruptAgent").length, 1);

  const other = (await runtime.dispatch(request("result")))[0]!;
  run = (await runtime.inspect(other.runId)).run as RunRecord;
  const result = {
    schemaVersion: 1,
    resultContractVersion: 1,
    resultId: `result-${run.runId}`,
    runId: run.runId,
    packetId: run.packetId,
    role: "scout",
    profileVersion: 2,
    outcome: "failed",
    summary: "The bounded task failed with explicit evidence.",
    failure: { classification: "task", summary: "The fixture reported failure.", evidenceRefs: ["evidence:failure"] },
    deliverables: [{ id: "result", status: "not_produced", references: [], note: "No result was produced." }],
    completionCriteria: [{ id: "done", status: "not_met", evidenceRefs: [], note: "The task did not complete." }],
    validation: [{ id: "focused", status: "failed", evidenceRefs: ["evidence:failure"], summary: "Focused validation failed." }],
    unresolvedBlockerIds: [],
    unresolvedDecisions: ["Review the explicit failure."],
    stateChanges: [],
    durableReferences: ["evidence:failure"],
    recommendedNextSteps: ["Inspect the retained run."],
    roleDetails: { role: "scout", repositoryManifestDigest: "b".repeat(64), evidenceRefs: ["evidence:failure"] },
  };
  run = await value.lifecycle.transition({
    operationId: `finalize-${run.runId}`,
    runId: run.runId,
    expectedRevision: run.revision,
    expectedFencingEpoch: run.fencingEpoch,
    actor: "companion",
    targetState: "failed",
    reason: "The deterministic companion committed failure.",
    evidenceRefs: ["evidence:failure"],
    timestamp: new Date(timestamp).toISOString(),
    result,
  });
  assert.equal((await runtime.result(run.runId)).resultId, result.resultId);
  const acknowledged = await runtime.acknowledgeResult({
    runId: run.runId,
    expectedRevision: run.revision,
    evidenceRefs: ["crewlead:retrieved"],
  });
  assert.equal((await runtime.inspect(run.runId)).resultAcknowledged, true);
  await assert.rejects(
    runtime.acknowledgeResult({
      runId: run.runId,
      expectedRevision: acknowledged.revision,
      evidenceRefs: ["crewlead:retrieved"],
    }),
    (error) => error instanceof StateSecurityError && error.code === "invalid_transition",
  );
});

test("graceful cancellation is idempotent, timeout-bounded, and never escalates itself to force", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const runtime = value.runtime();
  await runtime.start();
  t.after(() => runtime.stop());
  const receipt = (await runtime.dispatch(request("cancel-timeout")))[0]!;
  const run = (await runtime.inspect(receipt.runId)).run;
  value.herdr.failNext("interruptAgent", new HerdrAdapterError("request_timeout"));
  const first = await runtime.cancel({
    runId: run.runId,
    expectedRevision: run.revision,
    reason: "The requester explicitly cancelled this exact run.",
    evidenceRefs: ["request:cancel-timeout"],
    requestId: "cancel-tool-call-1",
  });
  assert.equal(first.interruptAcknowledged, false);
  assert.equal(first.run.state, "working");
  assert.equal(first.run.health.status, "unreachable");
  assert.match(first.warning ?? "", /not retried and force was not inferred/u);
  assert.equal(value.herdr.calls.filter((call) => call.operation === "interruptAgent").length, 1);
  assert.equal(value.herdr.calls.filter((call) => call.operation === "closeTabExact").length, 0);

  const replay = await runtime.cancel({
    runId: run.runId,
    expectedRevision: run.revision,
    reason: "The requester explicitly cancelled this exact run.",
    evidenceRefs: ["request:cancel-timeout"],
    requestId: "cancel-tool-call-1",
  });
  assert.equal(replay.duplicate, true);
  assert.equal(value.herdr.calls.filter((call) => call.operation === "interruptAgent").length, 1);
});

test("queued cancellation is one atomic durable tombstone and allocates no member resource", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const runtime = value.runtime();
  await runtime.start();
  t.after(() => runtime.stop());
  const queued = (await runtime.dispatch(request("queued-cancel", "scout", "queue")))[0]!;
  const cancelled = await runtime.cancel({
    runId: queued.runId,
    expectedRevision: queued.revision,
    reason: "Cancel the explicitly queued delegation.",
    evidenceRefs: ["request:queued-cancel"],
    requestId: "queued-cancel-call",
  });
  assert.equal(cancelled.run.state, "cancelled");
  assert.equal(cancelled.run.resourceDisposition, "unallocated");
  assert.equal(value.launchCalls.length, 0);
  const history = await value.store.readHistory(queued.runId);
  assert.equal(history.some((record) => record.kind === "control" &&
    (record.payload as { type?: unknown }).type === "cancel_requested"), true);
  assert.equal(history.filter((record) => record.resultingRevision === cancelled.run.revision).length, 2);
});

test("force cancellation is separately confirmed, exact-session scoped, observed, and never replayed", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const runtime = value.runtime();
  await runtime.start();
  t.after(() => runtime.stop());
  const receipt = (await runtime.dispatch(request("force")))[0]!;
  const run = (await runtime.inspect(receipt.runId)).run;
  const graceful = await runtime.cancel({
    runId: run.runId,
    expectedRevision: run.revision,
    reason: "Request graceful cancellation first.",
    evidenceRefs: ["request:graceful-first"],
    requestId: "graceful-before-force",
  });
  const forced = await runtime.forceCancel({
    runId: run.runId,
    expectedRevision: graceful.run.revision,
    reason: "The unreachable companion requires explicit exact force termination.",
    evidenceRefs: ["request:force-confirmed"],
    confirmation: "terminate_exact_member",
    requestId: "force-tool-call-1",
  });
  assert.equal(forced.terminationConfirmed, true);
  assert.equal(forced.run.state, "cancelled");
  assert.equal(forced.run.resourceDisposition, "closed");
  assert.equal(value.herdr.calls.filter((call) => call.operation === "closeTabExact").length, 1);
  const replay = await runtime.forceCancel({
    runId: run.runId,
    expectedRevision: graceful.run.revision,
    reason: "The unreachable companion requires explicit exact force termination.",
    evidenceRefs: ["request:force-confirmed"],
    confirmation: "terminate_exact_member",
    requestId: "force-tool-call-1",
  });
  assert.equal(replay.duplicate, true);
  assert.equal(value.herdr.calls.filter((call) => call.operation === "closeTabExact").length, 1);
});

test("ambiguous force timeout remains nonterminal and the destructive side effect is never retried", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const runtime = value.runtime();
  await runtime.start();
  t.after(() => runtime.stop());
  const receipt = (await runtime.dispatch(request("force-timeout")))[0]!;
  const run = (await runtime.inspect(receipt.runId)).run;
  const graceful = await runtime.cancel({
    runId: run.runId,
    expectedRevision: run.revision,
    reason: "Request graceful cancellation first.",
    evidenceRefs: ["request:force-timeout"],
    requestId: "force-timeout-graceful",
  });
  value.herdr.failNext("closeTabExact", new HerdrAdapterError("request_timeout"));
  const first = await runtime.forceCancel({
    runId: run.runId,
    expectedRevision: graceful.run.revision,
    reason: "Explicitly force the exact member after graceful timeout.",
    evidenceRefs: ["request:force-timeout"],
    confirmation: "terminate_exact_member",
    requestId: "force-timeout-call",
  });
  assert.equal(first.terminationConfirmed, false);
  assert.equal(first.run.state, "working");
  assert.equal(first.run.health.status, "recovery_required");
  assert.match(first.warning ?? "", /No force retry, outcome inference, cleanup, or rollback/u);
  const replay = await runtime.forceCancel({
    runId: run.runId,
    expectedRevision: graceful.run.revision,
    reason: "Explicitly force the exact member after graceful timeout.",
    evidenceRefs: ["request:force-timeout"],
    confirmation: "terminate_exact_member",
    requestId: "force-timeout-call",
  });
  assert.equal(replay.duplicate, true);
  assert.equal(value.herdr.calls.filter((call) => call.operation === "closeTabExact").length, 1);
});

test("reconciliation applies every complete readiness gate with bounded reasons and no member-runtime side effects", async (t) => {
  const scenarios: Array<{
    name: string;
    code: string;
    arrange(value: Fixture, runtime: CrewleadRuntime, run: RunRecord): Promise<void>;
  }> = [
    {
      name: "durable startup lifecycle",
      code: "startup_incomplete",
      async arrange(value, _runtime, run) {
        await mutateRunForRecoveryTest(value, run.runId, "startup-gate", (next) => {
          next.startup = { ...next.startup!, phase: "workspace_prepared" };
        });
      },
    },
    {
      name: "trusted assigned path binding",
      code: "path_binding_invalid",
      async arrange(value, _runtime, run) {
        await mutateRunForRecoveryTest(value, run.runId, "path-gate", (next) => {
          next.repositoryResource = { ...next.repositoryResource!, path: join(value.project, "different") };
        });
      },
    },
    {
      name: "package role readiness",
      code: "role_readiness_failed",
      async arrange(value, _runtime, run) {
        value.readinessByRole.set(run.role, false);
      },
    },
    {
      name: "companion provenance",
      code: "companion_provenance_failed",
      async arrange(_value, runtime) {
        const resolve = runtime.dependencies.resolveReadiness;
        runtime.dependencies.resolveReadiness = async (role, explicitRuntime) => {
          const receipt = await resolve(role, explicitRuntime);
          return {
            ...receipt,
            resources: receipt.resources.map((resource) =>
              resource.id === "member_companion" ? { ...resource, sha256: "f".repeat(64) } : resource),
          };
        };
      },
    },
    {
      name: "durable revision and fencing",
      code: "capability_binding_mismatch",
      async arrange(value, _runtime, run) {
        await mutateRunForRecoveryTest(value, run.runId, "fencing-gate", (next) => {
          next.fencingEpoch += 1;
        });
      },
    },
    {
      name: "authenticated capability set",
      code: "capability_revoked",
      async arrange(value, _runtime, run) {
        const attempt = value.companionAttempts.get(run.runId)!;
        await value.capabilities.revokeClaimedCapabilities(
          attempt.binding,
          attempt.capabilities,
          "deterministic recovery test",
        );
      },
    },
    {
      name: "active companion lease",
      code: "lease_released",
      async arrange(value, _runtime, run) {
        const attempt = value.companionAttempts.get(run.runId)!;
        await value.leases.release(
          attempt.leaseBinding,
          attempt.lease.leaseToken,
          attempt.lease.fencingEpoch,
        );
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      const value = await fixture();
      subtest.after(value.home.cleanup);
      const runtime = value.runtime();
      await runtime.start();
      subtest.after(() => runtime.stop());
      const receipt = (await runtime.dispatch(request(`gate-${scenario.code}`)))[0]!;
      const before = (await runtime.inspect(receipt.runId)).run;
      await scenario.arrange(value, runtime, before);
      const memberSideEffectsBefore = value.herdr.calls.filter((call) =>
        ["createMemberTab", "prompt", "interruptAgent", "closePaneExact", "closeTabExact"].includes(call.operation)).length;

      const report = await runtime.reconcile();
      const outcome = report.runs.find((item) => item.runId === receipt.runId)!;
      const stored = (await runtime.inspect(receipt.runId)).run;
      assert.equal(outcome.status, "recovery_required");
      assert.equal(outcome.diagnostic, `Member readiness gate failed (${scenario.code}).`);
      assert.equal(stored.health.status, "recovery_required");
      assert.equal(stored.health.reason, outcome.diagnostic);
      assert.equal(stored.health.evidenceRefs.includes(`member-readiness:${scenario.code}`), true);
      assert.equal(stored.state, "working");
      assert.equal(stored.resourceDisposition, "open");
      assert.equal(value.herdr.calls.filter((call) =>
        ["createMemberTab", "prompt", "interruptAgent", "closePaneExact", "closeTabExact"].includes(call.operation)).length,
      memberSideEffectsBefore);
    });
  }
});

test("Builder reconciliation fails closed on missing or rejected exact Git evidence", async (t) => {
  for (const scenario of ["missing-baseline", "live-evidence-rejected"] as const) {
    await t.test(scenario, async (subtest) => {
      const value = await fixture();
      subtest.after(value.home.cleanup);
      const runtime = value.runtime();
      await runtime.start();
      subtest.after(() => runtime.stop());
      const receipt = (await runtime.dispatch(request(`builder-${scenario}`, "builder")))[0]!;
      let verificationCalls = 0;
      runtime.dependencies.verifyBuilderResource = async (resource) => {
        verificationCalls += 1;
        assert.equal(resource.runId, receipt.runId);
        throw new Error("The deterministic live Builder evidence changed.");
      };
      if (scenario === "missing-baseline") {
        await mutateRunForRecoveryTest(value, receipt.runId, "missing-builder-baseline", (next) => {
          if (next.repositoryResource?.kind === "builder_worktree") {
            delete next.repositoryResource.protectedRefDigest;
          }
          delete next.repositoryAllocation;
        });
      }

      const report = await runtime.reconcile();
      const outcome = report.runs.find((item) => item.runId === receipt.runId)!;
      const stored = (await runtime.inspect(receipt.runId)).run;
      assert.equal(outcome.status, "recovery_required");
      assert.equal(outcome.diagnostic, "Member readiness gate failed (builder_resource_invalid).");
      assert.equal(stored.health.status, "recovery_required");
      assert.equal(stored.resultId, undefined);
      assert.equal(verificationCalls, scenario === "missing-baseline" ? 0 : 1);
      assert.equal(value.herdr.calls.filter((call) => call.operation === "prompt").length, 0);
    });
  }
});

test("unchanged exact Builder evidence permits explicit reviewed recovery", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const runtime = value.runtime();
  let verificationCalls = 0;
  runtime.dependencies.verifyBuilderResource = async (resource) => {
    verificationCalls += 1;
    assert.match(resource.protectedRefDigest ?? "", /^[a-f0-9]{64}$/u);
  };
  await runtime.start();
  t.after(() => runtime.stop());
  const receipt = (await runtime.dispatch(request("builder-recovery-exact", "builder")))[0]!;
  value.herdr.gap("connection_lost");
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.reconcile();
  const run = (await runtime.inspect(receipt.runId)).run;
  const recovered = await runtime.recover({
    runId: run.runId,
    expectedRevision: run.revision,
    effectAssessment: "none_found",
    reviewedByHuman: true,
    summary: "Continue the unchanged exact Builder resource.",
    evidenceRefs: ["review:builder-exact"],
  });
  assert.equal(recovered.status, "continued");
  assert.equal(verificationCalls >= 2, true);
  assert.equal(value.herdr.calls.filter((call) => call.operation === "prompt").length, 1);
});

test("explicit Builder recovery rechecks Git evidence and rejects a revision race after observation", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const runtime = value.runtime();
  await runtime.start();
  t.after(() => runtime.stop());
  const receipt = (await runtime.dispatch(request("builder-recovery-race", "builder")))[0]!;
  value.herdr.gap("connection_lost");
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.reconcile();
  const run = (await runtime.inspect(receipt.runId)).run;
  let injected = false;
  runtime.dependencies.verifyBuilderResource = async (resource) => {
    assert.equal(resource.runId, run.runId);
    if (injected) return;
    injected = true;
    await value.lifecycle.recordHealth({
      operationId: "test-builder-git-observation-race",
      runId: run.runId,
      expectedRevision: run.revision,
      expectedFencingEpoch: run.fencingEpoch,
      actor: "crewlead",
      status: "recovery_required",
      reconciliationRequired: true,
      reason: "A concurrent durable change raced exact Builder Git observation.",
      evidenceRefs: ["test:builder-git-race"],
      timestamp: new Date(timestamp + 60_000).toISOString(),
    });
  };

  await assert.rejects(
    runtime.recover({
      runId: run.runId,
      expectedRevision: run.revision,
      effectAssessment: "reviewed_bounded",
      reviewedByHuman: true,
      summary: "Do not continue after the exact Builder evidence raced durable state.",
      evidenceRefs: ["review:builder-git-race"],
    }),
    (error) => error instanceof StateSecurityError && error.code === "revision_conflict",
  );
  const current = (await runtime.inspect(run.runId)).run;
  assert.equal(current.state, "working");
  assert.equal(current.resultId, undefined);
  assert.equal((await value.store.readHistory(run.runId)).some((record) =>
    record.kind === "control" && (record.payload as { author?: unknown }).author === "recovery"), false);
  assert.equal(value.herdr.calls.filter((call) => call.operation === "prompt").length, 0);
});

test("same-session reload reconciles the exact native Pi session without relaunch, resubmit, or ownership transfer", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const first = value.runtime();
  await first.start();
  const receipt = (await first.dispatch(request("reload-resume")))[0]!;
  const launches = value.launchCalls.length;
  await first.stop();

  const resumed = value.runtime();
  await resumed.start();
  t.after(() => resumed.stop());
  const report = resumed.reconciliationReport();
  assert.equal(report?.runs.find((item) => item.runId === receipt.runId)?.status, "exact");
  assert.equal((await resumed.inspect(receipt.runId)).run.state, "working");
  assert.equal(value.launchCalls.length, launches);
  assert.equal(value.herdr.calls.filter((call) => call.operation === "prompt").length, 0);
  assert.equal(value.herdr.calls.filter((call) => call.operation === "createMemberTab").length, 0);
});

test("full Herdr member loss records health only and unbound or collision orphans are never adopted or mutated", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const runtime = value.runtime();
  await runtime.start();
  t.after(() => runtime.stop());
  const receipt = (await runtime.dispatch(request("herdr-loss")))[0]!;
  const member = (await runtime.inspect(receipt.runId)).run;
  value.herdr.snapshotValue = {
    ...value.herdr.snapshotValue,
    panes: [
      ...value.herdr.snapshotValue.panes.filter((pane) => pane.paneId === "pane-crewlead"),
      {
        paneId: "pane-orphan",
        terminalId: "terminal-orphan",
        workspaceId: "workspace-1",
        tabId: "tab-orphan",
        focused: false,
        agentState: "idle",
        revision: 1,
        managedRunId: "run-without-durable-state",
      },
      {
        paneId: "pane-collision",
        terminalId: "terminal-collision",
        workspaceId: "workspace-1",
        tabId: "tab-collision",
        focused: false,
        agentState: "idle",
        revision: 1,
        managedRunId: member.runId,
      },
      {
        paneId: "pane-collision-2",
        terminalId: "terminal-collision-2",
        workspaceId: "workspace-1",
        tabId: "tab-collision-2",
        focused: false,
        agentState: "idle",
        revision: 1,
        managedRunId: member.runId,
      },
    ],
    tabs: [
      ...value.herdr.snapshotValue.tabs.filter((tab) => tab.tabId === "tab-crewlead"),
      { tabId: "tab-orphan", workspaceId: "workspace-1", label: "renamed", focused: false, paneCount: 1, agentState: "idle" },
      { tabId: "tab-collision", workspaceId: "workspace-1", label: "renamed", focused: false, paneCount: 1, agentState: "idle" },
      { tabId: "tab-collision-2", workspaceId: "workspace-1", label: "renamed again", focused: false, paneCount: 1, agentState: "idle" },
    ],
    agents: [],
  };
  const report = await runtime.reconcile();
  const stored = (await runtime.inspect(member.runId)).run;
  assert.equal(stored.state, "working");
  assert.equal(stored.resourceDisposition, "missing");
  assert.equal(stored.health.status, "orphan_suspected");
  assert.equal(report.orphanResources.some((item) => item.reason === "unbound_managed_resource"), true);
  assert.equal(report.orphanResources.some((item) => item.reason === "identity_collision"), true);
  assert.equal(value.herdr.calls.some((call) => ["closePaneExact", "closeTabExact", "prompt", "createMemberTab"].includes(call.operation)), false);
});

test("a recorded pane bound to the wrong native Pi session is quarantined without semantic or resource mutation", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const runtime = value.runtime();
  await runtime.start();
  t.after(() => runtime.stop());
  const receipt = (await runtime.dispatch(request("identity-mismatch")))[0]!;
  const before = (await runtime.inspect(receipt.runId)).run;
  value.herdr.snapshotValue = {
    ...value.herdr.snapshotValue,
    agents: value.herdr.snapshotValue.agents.map((agent) => agent.paneId === before.resources!.paneId
      ? { ...agent, agentSession: { source: "pi", agent: "pi", kind: "id" as const, value: "different-native-session" } }
      : agent),
  };
  const report = await runtime.reconcile();
  const after = (await runtime.inspect(before.runId)).run;
  assert.equal(report.runs.find((item) => item.runId === before.runId)?.status, "mismatched");
  assert.equal(after.state, "working");
  assert.equal(after.resourceDisposition, "open");
  assert.equal(after.health.status, "inconsistent");
  assert.equal(value.herdr.calls.some((call) => ["closePaneExact", "closeTabExact", "prompt"].includes(call.operation)), false);
});

test("stale supervisor ownership is fenced after replacement acquires the exact session lease", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const stale = value.runtime();
  await stale.start();
  const receipt = (await stale.dispatch(request("stale-owner")))[0]!;
  const run = (await stale.inspect(receipt.runId)).run;
  await stale.stop();
  const replacement = value.runtime();
  await replacement.start();
  t.after(() => replacement.stop());
  await assert.rejects(
    stale.cancel({
      runId: run.runId,
      expectedRevision: run.revision,
      reason: "A stale owner must not control this run.",
      evidenceRefs: ["test:stale-owner"],
      requestId: "stale-owner-call",
    }),
    (error) => error instanceof StateSecurityError && error.code === "lease_invalid",
  );
  assert.equal(value.herdr.calls.filter((call) => call.operation === "interruptAgent").length, 0);
});

test("exact-session continuation requires explicit side-effect review while unknown effects preserve the new-run boundary", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const runtime = value.runtime();
  await runtime.start();
  t.after(() => runtime.stop());
  const receipt = (await runtime.dispatch(request("recovery")))[0]!;
  value.herdr.gap("connection_lost");
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.reconcile();
  let run = (await runtime.inspect(receipt.runId)).run;
  assert.equal(run.health.status, "recovery_required");
  const beforeRevision = run.revision;
  const beforeCount = (await value.store.listRuns()).length;
  const unknown = await runtime.recover({
    runId: run.runId,
    expectedRevision: run.revision,
    effectAssessment: "unknown",
    reviewedByHuman: false,
    summary: "The interrupted tool effects cannot be bounded.",
    evidenceRefs: ["review:unknown-effects"],
  });
  assert.equal(unknown.status, "new_run_required");
  assert.equal((await runtime.inspect(run.runId)).run.revision, beforeRevision);
  assert.equal((await value.store.listRuns()).length, beforeCount);
  assert.equal(value.herdr.calls.filter((call) => call.operation === "prompt").length, 0);

  await assert.rejects(
    runtime.recover({
      runId: run.runId,
      expectedRevision: run.revision,
      effectAssessment: "none_found",
      reviewedByHuman: false,
      summary: "No responsible-human review was supplied.",
      evidenceRefs: ["review:missing-human"],
    }),
    (error) => error instanceof StateSecurityError && error.code === "invalid_transition",
  );
  assert.equal((await runtime.inspect(run.runId)).run.revision, beforeRevision);
  assert.equal(value.herdr.calls.filter((call) => call.operation === "prompt").length, 0);

  const continued = await runtime.recover({
    runId: run.runId,
    expectedRevision: run.revision,
    effectAssessment: "none_found",
    reviewedByHuman: true,
    summary: "Continue only the original bounded task from its exact native Pi session.",
    evidenceRefs: ["review:no-side-effects"],
  });
  assert.equal(continued.status, "continued");
  if (continued.status !== "continued") return;
  run = continued.run;
  assert.equal(run.health.status, "healthy");
  assert.equal(run.health.reconciliationRequired, false);
  assert.equal(continued.promptAcknowledged, true);
  assert.equal(value.herdr.calls.filter((call) => call.operation === "prompt").length, 1);
  const history = await value.store.readHistory(run.runId);
  assert.equal(history.some((record) => record.kind === "control" &&
    (record.payload as { author?: unknown; kind?: unknown }).author === "recovery" &&
    (record.payload as { kind?: unknown }).kind === "recovery"), true);
});

test("explicit recovery reruns control-plane readiness immediately before amendment", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const runtime = value.runtime();
  await runtime.start();
  t.after(() => runtime.stop());
  const receipt = (await runtime.dispatch(request("fresh-recovery-gate")))[0]!;
  value.herdr.gap("connection_lost");
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.reconcile();
  const run = (await runtime.inspect(receipt.runId)).run;
  const attempt = value.companionAttempts.get(run.runId)!;
  await value.capabilities.revokeClaimedCapabilities(
    attempt.binding,
    attempt.capabilities,
    "state changed after reconciliation",
  );
  const historyBefore = await value.store.readHistory(run.runId);

  await assert.rejects(
    runtime.recover({
      runId: run.runId,
      expectedRevision: run.revision,
      effectAssessment: "none_found",
      reviewedByHuman: true,
      summary: "Do not continue after control-plane authorization changed.",
      evidenceRefs: ["review:fresh-gate"],
    }),
    (error) => error instanceof StateSecurityError && error.code === "invalid_binding",
  );
  assert.equal((await runtime.inspect(run.runId)).run.revision, run.revision);
  assert.equal((await value.store.readHistory(run.runId)).length, historyBefore.length);
  assert.equal(value.herdr.calls.filter((call) => call.operation === "prompt").length, 0);
});

test("explicit recovery rejects a durable revision race without appending or prompting", async (t) => {
  const value = await fixture();
  t.after(value.home.cleanup);
  const runtime = value.runtime();
  await runtime.start();
  t.after(() => runtime.stop());
  const receipt = (await runtime.dispatch(request("recovery-race")))[0]!;
  value.herdr.gap("connection_lost");
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.reconcile();
  const run = (await runtime.inspect(receipt.runId)).run;
  const resolve = runtime.dependencies.resolveReadiness;
  let injected = false;
  runtime.dependencies.resolveReadiness = async (role, explicitRuntime) => {
    if (!injected) {
      injected = true;
      await value.lifecycle.recordHealth({
        operationId: "test-concurrent-recovery-health",
        runId: run.runId,
        expectedRevision: run.revision,
        expectedFencingEpoch: run.fencingEpoch,
        actor: "crewlead",
        status: "recovery_required",
        reconciliationRequired: true,
        reason: "A concurrent durable observation changed the recovery input.",
        evidenceRefs: ["test:recovery-race"],
        timestamp: new Date(timestamp + 60_000).toISOString(),
      });
    }
    return resolve(role, explicitRuntime);
  };

  await assert.rejects(
    runtime.recover({
      runId: run.runId,
      expectedRevision: run.revision,
      effectAssessment: "reviewed_bounded",
      reviewedByHuman: true,
      summary: "The stale recovery request must not append an amendment.",
      evidenceRefs: ["review:stale-race"],
    }),
    (error) => error instanceof StateSecurityError && error.code === "revision_conflict",
  );
  const history = await value.store.readHistory(run.runId);
  assert.equal(history.some((record) => record.kind === "control" &&
    (record.payload as { author?: unknown }).author === "recovery"), false);
  assert.equal(value.herdr.calls.filter((call) => call.operation === "prompt").length, 0);
});
