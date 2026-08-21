import {
  HERDR_API_SCHEMA,
  HERDR_PROTOCOL,
  herdrError,
  type HerdrAgent,
  type HerdrAgentSession,
  type HerdrAgentState,
  type HerdrEvent,
  type HerdrPane,
  type HerdrProbe,
  type HerdrSnapshot,
  type HerdrTab,
  type HerdrWorkspace,
} from "./contracts.ts";

const STATES = new Set<HerdrAgentState>(["idle", "working", "blocked", "done", "unknown"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw herdrError("schema_mismatch");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, maximum = 2048): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw herdrError("schema_mismatch");
  }
  return value;
}

function identifier(value: unknown): string {
  const result = string(value, 128);
  if (!IDENTIFIER.test(result)) throw herdrError("schema_mismatch");
  return result;
}

function optionalString(value: unknown, maximum = 2048): string | undefined {
  return value === null || value === undefined ? undefined : string(value, maximum);
}

function bool(value: unknown, fallback?: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (fallback !== undefined && value === undefined) return fallback;
  throw herdrError("schema_mismatch");
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw herdrError("schema_mismatch");
  return value as number;
}

function state(value: unknown): HerdrAgentState {
  if (!STATES.has(value as HerdrAgentState)) throw herdrError("schema_mismatch");
  return value as HerdrAgentState;
}

function array(value: unknown, maximum = 10_000): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw herdrError("schema_mismatch");
  return value;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const set = new Set(allowed);
  if (Object.keys(value).some((key) => !set.has(key))) throw herdrError("schema_mismatch");
}

function agentSession(value: unknown): HerdrAgentSession | undefined {
  if (value === null || value === undefined) return undefined;
  const object = record(value);
  onlyKeys(object, ["source", "agent", "kind", "value"]);
  if (object.kind !== "id" && object.kind !== "path") throw herdrError("schema_mismatch");
  return {
    source: identifier(object.source),
    agent: identifier(object.agent),
    kind: object.kind,
    value: string(object.value, 1024),
  };
}

function managedRunId(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const tokens = record(value);
  if (Object.keys(tokens).length > 32) throw herdrError("schema_mismatch");
  for (const [key, token] of Object.entries(tokens)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/u.test(key) || typeof token !== "string" || token.length > 256) {
      throw herdrError("schema_mismatch");
    }
  }
  return tokens.db11_run === undefined ? undefined : identifier(tokens.db11_run);
}

export function parseWorkspace(value: unknown): HerdrWorkspace {
  const object = record(value);
  const workspace: HerdrWorkspace = {
    workspaceId: identifier(object.workspace_id),
    label: string(object.label, 256),
    focused: bool(object.focused),
    activeTabId: identifier(object.active_tab_id),
    tabCount: integer(object.tab_count),
    paneCount: integer(object.pane_count),
    agentState: state(object.agent_status),
  };
  return workspace;
}

export function parseTab(value: unknown): HerdrTab {
  const object = record(value);
  return {
    tabId: identifier(object.tab_id),
    workspaceId: identifier(object.workspace_id),
    label: string(object.label, 256),
    focused: bool(object.focused),
    paneCount: integer(object.pane_count),
    agentState: state(object.agent_status),
  };
}

export function parsePane(value: unknown): HerdrPane {
  const object = record(value);
  return {
    paneId: identifier(object.pane_id),
    terminalId: identifier(object.terminal_id),
    workspaceId: identifier(object.workspace_id),
    tabId: identifier(object.tab_id),
    focused: bool(object.focused),
    agentState: state(object.agent_status),
    revision: integer(object.revision),
    agent: optionalString(object.agent, 128),
    displayAgent: optionalString(object.display_agent, 128),
    title: optionalString(object.title, 256),
    cwd: optionalString(object.cwd, 1024),
    managedRunId: managedRunId(object.tokens),
    agentSession: agentSession(object.agent_session),
  };
}

export function parseAgent(value: unknown): HerdrAgent {
  const object = record(value);
  const pane = parsePane(object);
  return {
    ...pane,
    name: optionalString(object.name, 128),
    interactiveReady: bool(object.interactive_ready, false),
    launchPending: bool(object.launch_pending, false),
    stateChangeSequence: object.state_change_seq === undefined ? 0 : integer(object.state_change_seq),
  };
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function validateTopology(snapshot: HerdrSnapshot): void {
  if (
    !unique(snapshot.workspaces.map((item) => item.workspaceId)) ||
    !unique(snapshot.tabs.map((item) => item.tabId)) ||
    !unique(snapshot.panes.map((item) => item.paneId)) ||
    !unique(snapshot.agents.map((item) => item.paneId))
  ) {
    throw herdrError("identity_mismatch");
  }
  const workspaces = new Set(snapshot.workspaces.map((item) => item.workspaceId));
  const tabs = new Map(snapshot.tabs.map((item) => [item.tabId, item]));
  const panes = new Map(snapshot.panes.map((item) => [item.paneId, item]));
  for (const tab of snapshot.tabs) {
    if (!workspaces.has(tab.workspaceId)) throw herdrError("identity_mismatch");
  }
  for (const pane of snapshot.panes) {
    const tab = tabs.get(pane.tabId);
    if (!tab || tab.workspaceId !== pane.workspaceId) throw herdrError("identity_mismatch");
  }
  for (const agent of snapshot.agents) {
    const pane = panes.get(agent.paneId);
    if (!pane || pane.workspaceId !== agent.workspaceId || pane.tabId !== agent.tabId) {
      throw herdrError("identity_mismatch");
    }
  }
}

export function parseSnapshotResult(value: unknown): HerdrSnapshot {
  const result = record(value);
  onlyKeys(result, ["type", "snapshot"]);
  if (result.type !== "session_snapshot") throw herdrError("schema_mismatch");
  const object = record(result.snapshot);
  const protocol = integer(object.protocol);
  if (protocol !== HERDR_PROTOCOL) throw herdrError("unsupported_protocol");
  // Layout objects are intentionally not surfaced, but every array and bounded
  // top-level snapshot field from schema 1 is required and validated here.
  array(object.layouts);
  const snapshot: HerdrSnapshot = {
    version: string(object.version, 32),
    protocol: HERDR_PROTOCOL,
    apiSchema: HERDR_API_SCHEMA,
    focusedWorkspaceId: optionalString(object.focused_workspace_id, 128),
    focusedTabId: optionalString(object.focused_tab_id, 128),
    focusedPaneId: optionalString(object.focused_pane_id, 128),
    workspaces: array(object.workspaces).map(parseWorkspace),
    tabs: array(object.tabs).map(parseTab),
    panes: array(object.panes).map(parsePane),
    agents: array(object.agents).map(parseAgent),
  };
  validateTopology(snapshot);
  return Object.freeze(snapshot);
}

export function parseProbeResult(value: unknown): HerdrProbe {
  const result = record(value);
  onlyKeys(result, ["type", "version", "protocol", "capabilities"]);
  if (result.type !== "pong") throw herdrError("schema_mismatch");
  if (integer(result.protocol) !== HERDR_PROTOCOL) throw herdrError("unsupported_protocol");
  let liveHandoff = false;
  let detachedServerDaemon = false;
  if (result.capabilities !== null && result.capabilities !== undefined) {
    const capabilities = record(result.capabilities);
    onlyKeys(capabilities, ["live_handoff", "detached_server_daemon"]);
    liveHandoff = bool(capabilities.live_handoff);
    detachedServerDaemon = bool(capabilities.detached_server_daemon, false);
  }
  return {
    version: string(result.version, 32),
    protocol: HERDR_PROTOCOL,
    apiSchema: HERDR_API_SCHEMA,
    capabilities: [],
    liveHandoff,
    detachedServerDaemon,
  };
}

export function expectedResult(value: unknown, type: string): Record<string, unknown> {
  const result = record(value);
  if (result.type !== type) throw herdrError("schema_mismatch");
  return result;
}

export function parseEventFrame(value: unknown): HerdrEvent {
  const frame = record(value);
  onlyKeys(frame, ["event", "data"]);
  const event = string(frame.event, 64);
  const data = record(frame.data);
  if (event.includes("_") && data.type !== event) throw herdrError("schema_mismatch");
  const workspace = () => identifier(data.workspace_id);
  const pane = () => identifier(data.pane_id);
  switch (event) {
    case "workspace_updated":
    case "workspace_metadata_updated": {
      const item = parseWorkspace(data.workspace);
      return { kind: "workspace_changed", workspaceId: item.workspaceId };
    }
    case "workspace_closed":
      return { kind: "workspace_closed", workspaceId: workspace() };
    case "tab_created": {
      const item = parseTab(data.tab);
      return { kind: "tab_created", workspaceId: item.workspaceId, tabId: item.tabId };
    }
    case "tab_closed":
      return { kind: "tab_closed", workspaceId: workspace(), tabId: identifier(data.tab_id) };
    case "pane_created": {
      const item = parsePane(data.pane);
      return { kind: "pane_created", workspaceId: item.workspaceId, tabId: item.tabId, paneId: item.paneId };
    }
    case "pane_updated": {
      const item = parsePane(data.pane);
      return { kind: "pane_changed", workspaceId: item.workspaceId, tabId: item.tabId, paneId: item.paneId };
    }
    case "pane_closed":
      return { kind: "pane_closed", workspaceId: workspace(), paneId: pane() };
    case "pane_exited":
      return { kind: "pane_exited", workspaceId: workspace(), paneId: pane() };
    case "pane_agent_detected":
      return {
        kind: "agent_detected",
        workspaceId: workspace(),
        paneId: pane(),
        agent: optionalString(data.agent, 128),
        state: data.final_status === null || data.final_status === undefined ? undefined : state(data.final_status),
      };
    case "pane_agent_status_changed":
    case "pane.agent_status_changed":
      return {
        kind: "agent_state_changed",
        workspaceId: workspace(),
        paneId: pane(),
        agent: optionalString(data.agent, 128),
        state: state(data.agent_status),
      };
    default:
      throw herdrError("schema_mismatch");
  }
}

export function assertSchemaMetadata(value: { protocol: number; schemaVersion: number }): void {
  if (value.protocol !== HERDR_PROTOCOL || value.schemaVersion !== HERDR_API_SCHEMA) {
    throw herdrError("unsupported_schema");
  }
}
