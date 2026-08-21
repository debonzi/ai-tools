import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  FakeHerdrAdapter,
  HERDR_ADAPTER_CAPABILITIES,
  HERDR_ENVIRONMENT_LIMITS,
  Protocol17HerdrAdapter,
  type HerdrSnapshot,
} from "../../src/adapters/herdr/adapter.ts";

interface FakeServer {
  path: string;
  requests: Array<Record<string, unknown>>;
  sockets: Set<Socket>;
  close(): Promise<void>;
}

async function fakeServer(
  context: test.TestContext,
  respond: (request: Record<string, unknown>, socket: Socket, connection: number) => unknown | undefined,
): Promise<FakeServer> {
  const root = await mkdtemp(join(tmpdir(), "db11-herdr-"));
  const path = join(root, "herdr.sock");
  const requests: Array<Record<string, unknown>> = [];
  const sockets = new Set<Socket>();
  let connection = 0;
  const server: Server = createServer((socket) => {
    const current = ++connection;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      while (input.includes("\n")) {
        const index = input.indexOf("\n");
        const line = input.slice(0, index);
        input = input.slice(index + 1);
        const request = JSON.parse(line) as Record<string, unknown>;
        requests.push(request);
        const result = respond(request, socket, current);
        if (result !== undefined) socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  };
  context.after(close);
  return { path, requests, sockets, close };
}

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: "workspace:crewlead",
    number: 1,
    label: "Crewlead",
    focused: true,
    pane_count: 1,
    tab_count: 1,
    active_tab_id: "tab:crewlead",
    agent_status: "idle",
    ...overrides,
  };
}

function tab(overrides: Record<string, unknown> = {}) {
  return {
    tab_id: "tab:crewlead",
    workspace_id: "workspace:crewlead",
    number: 1,
    label: "Crewlead",
    focused: true,
    pane_count: 1,
    agent_status: "idle",
    ...overrides,
  };
}

function pane(overrides: Record<string, unknown> = {}) {
  return {
    pane_id: "pane:crewlead",
    terminal_id: "terminal:crewlead",
    workspace_id: "workspace:crewlead",
    tab_id: "tab:crewlead",
    focused: true,
    agent_status: "idle",
    revision: 1,
    ...overrides,
  };
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    ...pane(),
    name: "pi-crewlead",
    interactive_ready: true,
    launch_pending: false,
    state_change_seq: 1,
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    type: "session_snapshot",
    snapshot: {
      version: "0.7.5",
      protocol: 17,
      focused_workspace_id: "workspace:crewlead",
      focused_tab_id: "tab:crewlead",
      focused_pane_id: "pane:crewlead",
      workspaces: [workspace()],
      tabs: [tab()],
      panes: [pane()],
      layouts: [],
      agents: [agent()],
      ...overrides,
    },
  };
}

function responseForProvision(request: Record<string, unknown>): unknown {
  const params = request.params as Record<string, unknown>;
  switch (request.method) {
    case "workspace.get":
      return { type: "workspace_info", workspace: workspace() };
    case "tab.create":
      return {
        type: "tab_created",
        tab: tab({
          tab_id: "tab:member",
          label: params.label,
          focused: false,
        }),
        root_pane: pane({
          pane_id: "pane:member",
          terminal_id: "terminal:member",
          tab_id: "tab:member",
          focused: false,
          cwd: params.cwd,
        }),
      };
    case "agent.start":
      return {
        type: "agent_started",
        agent: agent({
          pane_id: "pane:member",
          terminal_id: "terminal:member",
          tab_id: "tab:member",
          focused: false,
          name: params.name,
          agent_session: { source: "pi", agent: "pi", kind: "id", value: "member-session" },
        }),
        argv: ["pi"],
      };
    case "pane.report_metadata":
      return { type: "ok" };
    case "agent.prompt":
      return {
        type: "agent_prompted",
        agent: agent({
          pane_id: "pane:member",
          terminal_id: "terminal:member",
          tab_id: "tab:member",
          focused: false,
          name: "builder-api-review-cafe",
        }),
      };
    default:
      throw new Error(`unexpected method ${String(request.method)}`);
  }
}

async function waitFor(predicate: () => boolean, timeout = 1_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("protocol and installed-schema mismatches fail closed", async (context) => {
  assert.throws(
    () => new Protocol17HerdrAdapter({ socketPath: "/tmp/unused.sock", schemaMetadata: { protocol: 17, schemaVersion: 2 } }),
    (error: unknown) => (error as { code?: string }).code === "unsupported_schema",
  );
  const server = await fakeServer(context, (request) =>
    request.method === "ping"
      ? { type: "pong", version: "0.8.0", protocol: 18, capabilities: null }
      : undefined,
  );
  const adapter = new Protocol17HerdrAdapter({ socketPath: server.path, requestTimeoutMilliseconds: 100 });
  await assert.rejects(adapter.probe(), (error: unknown) => (error as { code?: string }).code === "unsupported_protocol");
  adapter.stop();
});

test("probe exposes only the package-owned protocol capability adapter", async (context) => {
  const server = await fakeServer(context, (request) =>
    request.method === "ping"
      ? { type: "pong", version: "0.7.5", protocol: 17, capabilities: { live_handoff: true, detached_server_daemon: true } }
      : undefined,
  );
  const adapter = new Protocol17HerdrAdapter({ socketPath: server.path });
  const probe = await adapter.probe();
  assert.deepEqual(probe.capabilities, [...HERDR_ADAPTER_CAPABILITIES]);
  assert.equal(probe.liveHandoff, true);
  assert.equal(probe.apiSchema, 1);
  adapter.stop();
});

test("fresh snapshots expose only the bounded DB11 run marker used for orphan collision diagnostics", async (context) => {
  const server = await fakeServer(context, (request) => {
    if (request.method !== "session.snapshot") throw new Error("unexpected request");
    return snapshot({
      panes: [pane({ tokens: { db11_run: "run-cafe", unrelated: "display-only" } })],
      agents: [agent({ tokens: { db11_run: "run-cafe" } })],
    });
  });
  const adapter = new Protocol17HerdrAdapter({ socketPath: server.path });
  const value = await adapter.snapshot();
  assert.equal(value.panes[0]?.managedRunId, "run-cafe");
  assert.equal(value.agents[0]?.managedRunId, "run-cafe");
  adapter.stop();
});

test("member provisioning is non-focused, identity-bound, ready, and prompt-nonwaiting", async (context) => {
  const server = await fakeServer(context, responseForProvision);
  const adapter = new Protocol17HerdrAdapter({ socketPath: server.path });
  const resources = await adapter.provisionMember({
    runId: "run-cafe",
    role: "builder",
    purpose: "API review",
    workspaceId: "workspace:crewlead",
    cwd: "/tmp/disposable-worktree",
    agentArguments: ["--no-session"],
    prompt: "Implement the bounded packet.",
  });
  assert.deepEqual(resources, {
    workspaceId: "workspace:crewlead",
    tabId: "tab:member",
    paneId: "pane:member",
    agentTarget: "pane:member",
    agentName: "builder-api-review-cafe",
    memberSession: { source: "pi", agent: "pi", kind: "id", value: "member-session" },
  });
  const create = server.requests.find((request) => request.method === "tab.create")!;
  assert.equal((create.params as Record<string, unknown>).focus, false);
  assert.equal((create.params as Record<string, unknown>).workspace_id, "workspace:crewlead");
  const metadata = server.requests.find((request) => request.method === "pane.report_metadata")!;
  assert.equal((metadata.params as Record<string, unknown>).source, "db11-crew");
  const prompt = server.requests.find((request) => request.method === "agent.prompt")!;
  assert.deepEqual(Object.keys(prompt.params as object).sort(), ["target", "text"]);
  assert.equal((prompt.params as Record<string, unknown>).target, "pane:member");
  adapter.stop();
});

test("Herdr transports a bounded ambient environment and rejects invalid envelopes without exposing values", async (context) => {
  const server = await fakeServer(context, responseForProvision);
  const adapter = new Protocol17HerdrAdapter({ socketPath: server.path });
  const environment = Object.fromEntries([
    ...Array.from({ length: 40 }, (_, index) => [`AMBIENT_${index}`, `value-${index}`]),
    ["OPENAI_API_KEY", "provider-secret"],
    ["HTTPS_PROXY", "https://proxy.example.test"],
    ["SSH_AUTH_SOCK", "/private/ssh-agent.sock"],
    ["EMPTY_AMBIENT_VALUE", ""],
  ]);
  await adapter.createMemberTab({
    workspaceId: "workspace:crewlead",
    cwd: "/tmp/read-snapshot",
    label: "Scout · ambient transport",
    environment,
  });
  const create = server.requests.find((request) => request.method === "tab.create")!;
  assert.deepEqual((create.params as { env?: unknown }).env, environment);
  const acceptedRequests = server.requests.length;

  const rejected = async (candidate: Record<string, string>) => {
    await assert.rejects(
      adapter.createMemberTab({
        workspaceId: "workspace:crewlead",
        cwd: "/tmp/read-snapshot",
        label: "Scout · rejected transport",
        environment: candidate,
      }),
      (error: unknown) => {
        const value = error as { code?: unknown; message?: unknown };
        assert.equal(value.code, "invalid_argument");
        assert.equal(String(value.message).includes("provider-secret"), false);
        return true;
      },
    );
    assert.equal(server.requests.length, acceptedRequests);
  };

  await rejected({ "INVALID-KEY": "value" });
  await rejected({ INVALID_NUL: "provider-secret\0suffix" });
  await rejected({
    INVALID_VALUE: `provider-secret${"x".repeat(HERDR_ENVIRONMENT_LIMITS.valueCharacters)}`,
  });
  await rejected(Object.fromEntries(Array.from(
    { length: HERDR_ENVIRONMENT_LIMITS.entries + 1 },
    (_, index) => [`EXCESSIVE_${index}`, "value"],
  )));
  await rejected(Object.fromEntries(Array.from(
    { length: 65 },
    (_, index) => [`AGGREGATE_${index}`, "x".repeat(HERDR_ENVIRONMENT_LIMITS.valueCharacters)],
  )));
  adapter.stop();
});

test("identity mismatch preserves partial startup evidence without cleanup or blind retry", async (context) => {
  const server = await fakeServer(context, (request) => {
    const result = responseForProvision(request);
    if (request.method === "tab.create") {
      (result as { root_pane: Record<string, unknown> }).root_pane.workspace_id = "workspace:foreign";
    }
    return result;
  });
  const adapter = new Protocol17HerdrAdapter({ socketPath: server.path });
  await assert.rejects(
    adapter.provisionMember({
      runId: "run-dead",
      role: "scout",
      purpose: "inspect",
      workspaceId: "workspace:crewlead",
      cwd: "/tmp/read-snapshot",
      agentArguments: [],
      prompt: "Inspect.",
    }),
    (error: unknown) => {
      const value = error as { code?: string; partialResources?: Record<string, unknown> };
      assert.equal(value.code, "startup_partial");
      assert.deepEqual(value.partialResources, { workspaceId: "workspace:crewlead" });
      return true;
    },
  );
  assert.equal(server.requests.filter((request) => request.method === "tab.create").length, 1);
  assert.equal(server.requests.some((request) => request.method === "tab.close"), false);
  adapter.stop();
});

test("acknowledgement failure reports every partial resource without cleanup or retry", async (context) => {
  const server = await fakeServer(context, (request, socket) => {
    if (request.method === "agent.prompt") {
      socket.write(`${JSON.stringify({
        id: request.id,
        error: { code: "agent_not_running", message: "/private/path must not escape" },
      })}\n`);
      return undefined;
    }
    return responseForProvision(request);
  });
  const adapter = new Protocol17HerdrAdapter({ socketPath: server.path });
  await assert.rejects(
    adapter.provisionMember({
      runId: "run-cafe",
      role: "builder",
      purpose: "API review",
      workspaceId: "workspace:crewlead",
      cwd: "/tmp/disposable-worktree",
      agentArguments: [],
      prompt: "Implement.",
    }),
    (error: unknown) => {
      const value = error as { code?: string; message?: string; partialResources?: Record<string, unknown> };
      assert.equal(value.code, "startup_partial");
      assert.equal(value.message?.includes("/private/path"), false);
      assert.deepEqual(value.partialResources, {
        workspaceId: "workspace:crewlead",
        tabId: "tab:member",
        paneId: "pane:member",
        agentTarget: "pane:member",
        agentName: "builder-api-review-cafe",
        memberSession: { source: "pi", agent: "pi", kind: "id", value: "member-session" },
      });
      return true;
    },
  );
  assert.equal(server.requests.filter((request) => request.method === "agent.prompt").length, 1);
  assert.equal(server.requests.some((request) => request.method === "tab.close"), false);
  adapter.stop();
});

test("malformed, oversized frames and bounded request timeouts fail deterministically", async (context) => {
  const malformed = await fakeServer(context, (_request, socket) => {
    socket.write('{"unexpected":true}\n');
    return undefined;
  });
  const malformedAdapter = new Protocol17HerdrAdapter({ socketPath: malformed.path, requestTimeoutMilliseconds: 100 });
  await assert.rejects(malformedAdapter.snapshot(), (error: unknown) => (error as { code?: string }).code === "malformed_frame");
  malformedAdapter.stop();

  const oversized = await fakeServer(context, (_request, socket) => {
    socket.write("x".repeat(1_025));
    return undefined;
  });
  const oversizedAdapter = new Protocol17HerdrAdapter({ socketPath: oversized.path, maximumFrameBytes: 1_024 });
  await assert.rejects(oversizedAdapter.snapshot(), (error: unknown) => (error as { code?: string }).code === "malformed_frame");
  oversizedAdapter.stop();

  const silent = await fakeServer(context, () => undefined);
  const timeoutAdapter = new Protocol17HerdrAdapter({ socketPath: silent.path, requestTimeoutMilliseconds: 20 });
  await assert.rejects(timeoutAdapter.snapshot(), (error: unknown) => (error as { code?: string }).code === "request_timeout");
  timeoutAdapter.stop();
});

test("disconnect gaps reconnect with a fresh snapshot before later events", async (context) => {
  let firstStreamSocket: Socket | undefined;
  let currentStreamSocket: Socket | undefined;
  let snapshotCount = 0;
  const server = await fakeServer(context, (request, socket) => {
    if (request.method === "events.subscribe") {
      firstStreamSocket ??= socket;
      currentStreamSocket = socket;
      return { type: "subscription_started" };
    }
    if (request.method === "session.snapshot") {
      snapshotCount += 1;
      const state = snapshotCount === 1 ? "idle" : "working";
      const result = snapshot({
        panes: [pane({ agent_status: state, revision: snapshotCount })],
        agents: [agent({ agent_status: state, revision: snapshotCount, state_change_seq: snapshotCount })],
      });
      if (snapshotCount > 1) {
        setTimeout(() => currentStreamSocket?.write(`${JSON.stringify({
          event: "pane_agent_status_changed",
          data: { type: "pane_agent_status_changed", pane_id: "pane:crewlead", workspace_id: "workspace:crewlead", agent_status: "blocked", agent: "pi" },
        })}\n`), 5);
      }
      return result;
    }
    return undefined;
  });
  const adapter = new Protocol17HerdrAdapter({
    socketPath: server.path,
    requestTimeoutMilliseconds: 100,
    reconnectInitialMilliseconds: 5,
    reconnectMaximumMilliseconds: 10,
  });
  const order: string[] = [];
  const gaps: string[] = [];
  const stop = await adapter.subscribe({
    onReconcile(value, generation) {
      order.push(`snapshot:${generation}:${value.agents[0]!.agentState}`);
    },
    onEvent(event) {
      order.push(`event:${event.kind}:${event.kind === "agent_state_changed" ? event.state : ""}`);
    },
    onGap(reason) {
      gaps.push(reason);
    },
  });
  firstStreamSocket!.destroy();
  await waitFor(() => order.some((item) => item === "event:agent_state_changed:blocked"));
  assert.deepEqual(order.slice(0, 3), [
    "snapshot:1:idle",
    "snapshot:2:working",
    "event:agent_state_changed:blocked",
  ]);
  assert.deepEqual(gaps, ["connection_lost"]);
  stop();
});

test("exact close refuses auxiliary or mismatched topology", async (context) => {
  const server = await fakeServer(context, (request) => {
    if (request.method === "tab.get") return { type: "tab_info", tab: tab({ tab_id: "tab:member", pane_count: 2 }) };
    if (request.method === "pane.get") return { type: "pane_info", pane: pane({ pane_id: "pane:member", tab_id: "tab:member" }) };
    if (request.method === "tab.close") return { type: "ok" };
    return undefined;
  });
  const adapter = new Protocol17HerdrAdapter({ socketPath: server.path });
  await assert.rejects(
    adapter.closeTabExact({ workspaceId: "workspace:crewlead", tabId: "tab:member", paneId: "pane:member" }),
    (error: unknown) => (error as { code?: string }).code === "unowned_topology",
  );
  assert.equal(server.requests.some((request) => request.method === "tab.close"), false);
  adapter.stop();
});

test("fake adapter provides deterministic component events and calls", async () => {
  const value = snapshot().snapshot as Record<string, unknown>;
  const fake = new FakeHerdrAdapter({
    version: "0.7.5",
    protocol: 17,
    apiSchema: 1,
    focusedWorkspaceId: "workspace:crewlead",
    focusedTabId: "tab:crewlead",
    focusedPaneId: "pane:crewlead",
    workspaces: [
      { workspaceId: "workspace:crewlead", label: "Crewlead", focused: true, activeTabId: "tab:crewlead", tabCount: 1, paneCount: 1, agentState: "idle" },
    ],
    tabs: [{ tabId: "tab:crewlead", workspaceId: "workspace:crewlead", label: "Crewlead", focused: true, paneCount: 1, agentState: "idle" }],
    panes: [{ paneId: "pane:crewlead", terminalId: "terminal:crewlead", workspaceId: "workspace:crewlead", tabId: "tab:crewlead", focused: true, agentState: "idle", revision: 1 }],
    agents: [{ paneId: "pane:crewlead", terminalId: "terminal:crewlead", workspaceId: "workspace:crewlead", tabId: "tab:crewlead", focused: true, agentState: "idle", revision: 1, interactiveReady: true, launchPending: false, stateChangeSequence: 1 }],
  } satisfies HerdrSnapshot);
  const observed: string[] = [];
  await fake.subscribe({
    onReconcile: () => {
      observed.push("snapshot");
    },
    onEvent: (event) => {
      observed.push(event.kind);
    },
  });
  fake.emitEvent({ kind: "pane_exited", workspaceId: "workspace:crewlead", paneId: "pane:crewlead" });
  assert.deepEqual(observed, ["snapshot", "pane_exited"]);
  assert.equal(fake.calls[0]!.operation, "subscribe");
  const resources = await fake.provisionMember({
    runId: "run-f00d",
    role: "planner",
    purpose: "ticket review",
    workspaceId: "workspace:crewlead",
    cwd: "/tmp/fake-snapshot",
    agentArguments: [],
    prompt: "Review the assigned ticket.",
  });
  assert.equal(resources.paneId, "pane:2");
  assert.equal(fake.calls.some((call) => call.operation === "prompt"), true);
  const metadata = fake.calls.find((call) => call.operation === "reportMetadata")!;
  assert.equal((metadata.input as { source?: unknown }).source, "db11-crew");
  assert.ok(value);
});
