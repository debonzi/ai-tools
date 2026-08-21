import { EventEmitter } from "node:events";

import { CANONICAL_RESOURCE_IDENTITY } from "../../protocol/limits.ts";

export const HERDR_PROTOCOL = 17 as const;
export const HERDR_API_SCHEMA = 1 as const;

/** Bounded envelope for representative same-user environments sent to Herdr. */
export const HERDR_ENVIRONMENT_LIMITS = Object.freeze({
  entries: 256,
  keyCharacters: 64,
  valueCharacters: 4_096,
  aggregateBytes: 256 * 1_024,
} as const);

export type HerdrAgentState = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrWorkspace {
  workspaceId: string;
  label: string;
  focused: boolean;
  activeTabId: string;
  tabCount: number;
  paneCount: number;
  agentState: HerdrAgentState;
}

export interface HerdrTab {
  tabId: string;
  workspaceId: string;
  label: string;
  focused: boolean;
  paneCount: number;
  agentState: HerdrAgentState;
}

export interface HerdrAgentSession {
  source: string;
  agent: string;
  kind: "id" | "path";
  value: string;
}

export interface HerdrPane {
  paneId: string;
  terminalId: string;
  workspaceId: string;
  tabId: string;
  focused: boolean;
  agentState: HerdrAgentState;
  revision: number;
  agent?: string;
  displayAgent?: string;
  title?: string;
  cwd?: string;
  /** Display-only DB11 marker used only to detect collisions/orphans, never as authority. */
  managedRunId?: string;
  agentSession?: HerdrAgentSession;
}

export interface HerdrAgent extends HerdrPane {
  name?: string;
  interactiveReady: boolean;
  launchPending: boolean;
  stateChangeSequence: number;
}

export interface HerdrSnapshot {
  version: string;
  protocol: typeof HERDR_PROTOCOL;
  apiSchema: typeof HERDR_API_SCHEMA;
  focusedWorkspaceId?: string;
  focusedTabId?: string;
  focusedPaneId?: string;
  workspaces: readonly HerdrWorkspace[];
  tabs: readonly HerdrTab[];
  panes: readonly HerdrPane[];
  agents: readonly HerdrAgent[];
}

export const HERDR_ADAPTER_CAPABILITIES = Object.freeze([
  "agent.get",
  "agent.prompt",
  "agent.send_keys",
  "agent.start",
  "agent.wait",
  "events.subscribe",
  "events.wait",
  "notification.show",
  "pane.close",
  "pane.get",
  "pane.report_agent_session",
  "pane.report_metadata",
  "session.snapshot",
  "tab.close",
  "tab.create",
  "tab.get",
  "tab.list",
  "workspace.get",
  "workspace.list",
] as const);

export interface HerdrProbe {
  version: string;
  protocol: typeof HERDR_PROTOCOL;
  apiSchema: typeof HERDR_API_SCHEMA;
  capabilities: readonly string[];
  liveHandoff: boolean;
  detachedServerDaemon: boolean;
}

export type HerdrEvent =
  | { kind: "workspace_changed"; workspaceId: string }
  | { kind: "workspace_closed"; workspaceId: string }
  | { kind: "tab_created"; workspaceId: string; tabId: string }
  | { kind: "tab_closed"; workspaceId: string; tabId: string }
  | { kind: "pane_created"; workspaceId: string; tabId: string; paneId: string }
  | { kind: "pane_changed"; workspaceId: string; tabId?: string; paneId: string }
  | { kind: "pane_closed" | "pane_exited"; workspaceId: string; paneId: string }
  | {
      kind: "agent_detected";
      workspaceId: string;
      paneId: string;
      agent?: string;
      state?: HerdrAgentState;
    }
  | {
      kind: "agent_state_changed";
      workspaceId: string;
      paneId: string;
      agent?: string;
      state: HerdrAgentState;
    };

export type HerdrGapReason =
  | "connection_lost"
  | "protocol_error"
  | "reconnect_exhausted";

export interface HerdrSubscriptionHandlers {
  onEvent(event: HerdrEvent): void;
  /** A fresh authoritative snapshot is delivered before post-reconnect events. */
  onReconcile(snapshot: HerdrSnapshot, generation: number): void | Promise<void>;
  onGap?(reason: HerdrGapReason): void;
}

export interface MemberPresentation {
  tabLabel: string;
  agentName: string;
  displayAgent: string;
  title: string;
  sessionName: string;
}

export interface MemberResources {
  workspaceId: string;
  tabId: string;
  paneId: string;
  agentTarget: string;
  agentName: string;
  memberSession?: HerdrAgentSession;
}

export interface ProvisionMemberRequest {
  runId: string;
  role: "scout" | "planner" | "builder";
  purpose: string;
  workspaceId: string;
  cwd: string;
  agentArguments: readonly string[];
  prompt: string;
  startupTimeoutMilliseconds?: number;
  environment?: Readonly<Record<string, string>>;
}

export interface HerdrAdapter {
  probe(): Promise<HerdrProbe>;
  snapshot(): Promise<HerdrSnapshot>;
  subscribe(handlers: HerdrSubscriptionHandlers): Promise<() => void>;
  getWorkspace(workspaceId: string): Promise<HerdrWorkspace>;
  getTab(tabId: string): Promise<HerdrTab>;
  getPane(paneId: string): Promise<HerdrPane>;
  getAgent(paneId: string): Promise<HerdrAgent>;
  createMemberTab(input: {
    workspaceId: string;
    cwd: string;
    label: string;
    environment?: Readonly<Record<string, string>>;
  }): Promise<{ tab: HerdrTab; pane: HerdrPane }>;
  startPiAgent(input: {
    workspaceId: string;
    tabId: string;
    paneId: string;
    name: string;
    arguments: readonly string[];
    timeoutMilliseconds?: number;
  }): Promise<HerdrAgent>;
  prompt(paneId: string, text: string): Promise<HerdrAgent>;
  reportMetadata(input: {
    paneId: string;
    source: string;
    sequence: number;
    displayAgent: string;
    title: string;
    stateLabels?: Readonly<Record<string, string>>;
    tokens?: Readonly<Record<string, string | null>>;
    ttlMilliseconds?: number;
  }): Promise<void>;
  notify(input: {
    title: string;
    body?: string;
    sound?: "none" | "done" | "request";
  }): Promise<{ shown: boolean; reason: string }>;
  interruptAgent(paneId: string): Promise<void>;
  closePaneExact(expected: { workspaceId: string; tabId: string; paneId: string }): Promise<void>;
  closeTabExact(expected: {
    workspaceId: string;
    tabId: string;
    paneId: string;
    allowAuxiliaryPanes?: boolean;
  }): Promise<void>;
  provisionMember(request: ProvisionMemberRequest): Promise<MemberResources>;
  stop(): void;
}

const SAFE_MESSAGES = {
  invalid_argument: "A Herdr adapter argument was rejected.",
  unsupported_schema: "The installed Herdr API schema is not supported.",
  unsupported_protocol: "The Herdr socket protocol is not supported.",
  connection_failed: "The local Herdr socket connection failed.",
  connection_lost: "The local Herdr socket connection was interrupted.",
  request_timeout: "A bounded Herdr request exceeded its time limit.",
  server_error: "Herdr rejected a structured adapter request.",
  malformed_frame: "Herdr returned a malformed or oversized protocol frame.",
  schema_mismatch: "Herdr returned data outside the supported API schema.",
  identity_mismatch: "Herdr resource identity did not match the managed member.",
  focus_changed: "Herdr focused a member tab during non-focused dispatch.",
  unowned_topology: "The Herdr tab contains topology not owned by this member.",
  startup_partial: "Member startup did not reach acknowledged prompt submission.",
} as const;

export type HerdrErrorCode = keyof typeof SAFE_MESSAGES;

export class HerdrAdapterError extends Error {
  readonly code: HerdrErrorCode;
  readonly partialResources?: Readonly<Partial<MemberResources>>;

  constructor(
    code: HerdrErrorCode,
    options: { cause?: unknown; partialResources?: Partial<MemberResources> } = {},
  ) {
    super(SAFE_MESSAGES[code], options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HerdrAdapterError";
    this.code = code;
    this.partialResources = options.partialResources
      ? Object.freeze(structuredClone(options.partialResources))
      : undefined;
  }
}

export function herdrError(
  code: HerdrErrorCode,
  options?: { cause?: unknown; partialResources?: Partial<MemberResources> },
): HerdrAdapterError {
  return new HerdrAdapterError(code, options);
}

/** Deterministic in-memory contract for higher-level component tests. */
export class FakeHerdrAdapter implements HerdrAdapter {
  readonly calls: Array<{ operation: string; input?: unknown }> = [];
  readonly events = new EventEmitter();
  snapshotValue: HerdrSnapshot;
  failures = new Map<string, Error>();
  private handlers = new Set<HerdrSubscriptionHandlers>();

  constructor(snapshot: HerdrSnapshot) {
    this.snapshotValue = structuredClone(snapshot);
  }

  failNext(operation: string, error: Error = herdrError("connection_failed")): void {
    this.failures.set(operation, error);
  }

  emitEvent(event: HerdrEvent): void {
    for (const handlers of this.handlers) handlers.onEvent(structuredClone(event));
  }

  async reconcile(generation = 1): Promise<void> {
    for (const handlers of this.handlers) {
      await handlers.onReconcile(structuredClone(this.snapshotValue), generation);
    }
  }

  gap(reason: HerdrGapReason = "connection_lost"): void {
    for (const handlers of this.handlers) handlers.onGap?.(reason);
  }

  private record<T>(operation: string, input: unknown, value: T): T {
    this.calls.push({ operation, input: structuredClone(input) });
    const failure = this.failures.get(operation);
    if (failure) {
      this.failures.delete(operation);
      throw failure;
    }
    return structuredClone(value);
  }

  async probe(): Promise<HerdrProbe> {
    return this.record("probe", undefined, {
      version: this.snapshotValue.version,
      protocol: HERDR_PROTOCOL,
      apiSchema: HERDR_API_SCHEMA,
      capabilities: [...HERDR_ADAPTER_CAPABILITIES],
      liveHandoff: false,
      detachedServerDaemon: true,
    });
  }
  async snapshot(): Promise<HerdrSnapshot> {
    return this.record("snapshot", undefined, this.snapshotValue);
  }
  async subscribe(handlers: HerdrSubscriptionHandlers): Promise<() => void> {
    this.record("subscribe", undefined, undefined);
    this.handlers.add(handlers);
    await handlers.onReconcile(structuredClone(this.snapshotValue), 1);
    return () => this.handlers.delete(handlers);
  }
  async getWorkspace(id: string): Promise<HerdrWorkspace> {
    const value = this.snapshotValue.workspaces.find((item) => item.workspaceId === id);
    if (!value) throw herdrError("identity_mismatch");
    return this.record("getWorkspace", id, value);
  }
  async getTab(id: string): Promise<HerdrTab> {
    const value = this.snapshotValue.tabs.find((item) => item.tabId === id);
    if (!value) throw herdrError("identity_mismatch");
    return this.record("getTab", id, value);
  }
  async getPane(id: string): Promise<HerdrPane> {
    const value = this.snapshotValue.panes.find((item) => item.paneId === id);
    if (!value) throw herdrError("identity_mismatch");
    return this.record("getPane", id, value);
  }
  async getAgent(id: string): Promise<HerdrAgent> {
    const value = this.snapshotValue.agents.find((item) => item.paneId === id);
    if (!value) throw herdrError("identity_mismatch");
    return this.record("getAgent", id, value);
  }
  async createMemberTab(input: { workspaceId: string; cwd: string; label: string; environment?: Readonly<Record<string, string>> }) {
    const tab: HerdrTab = { tabId: `tab:${this.snapshotValue.tabs.length + 1}`, workspaceId: input.workspaceId, label: input.label, focused: false, paneCount: 1, agentState: "idle" };
    const pane: HerdrPane = { paneId: `pane:${this.snapshotValue.panes.length + 1}`, terminalId: `terminal:${this.snapshotValue.panes.length + 1}`, workspaceId: input.workspaceId, tabId: tab.tabId, focused: false, agentState: "idle", revision: 0, cwd: input.cwd };
    const value = this.record("createMemberTab", input, { tab, pane });
    this.snapshotValue = {
      ...this.snapshotValue,
      tabs: [...this.snapshotValue.tabs, tab],
      panes: [...this.snapshotValue.panes, pane],
    };
    return value;
  }
  async startPiAgent(input: { workspaceId: string; tabId: string; paneId: string; name: string; arguments: readonly string[]; timeoutMilliseconds?: number }): Promise<HerdrAgent> {
    const pane = await this.getPane(input.paneId);
    const agent: HerdrAgent = { ...pane, name: input.name, interactiveReady: true, launchPending: false, stateChangeSequence: 0 };
    const value = this.record("startPiAgent", input, agent);
    this.snapshotValue = {
      ...this.snapshotValue,
      agents: [...this.snapshotValue.agents.filter((item) => item.paneId !== input.paneId), agent],
    };
    return value;
  }
  async prompt(paneId: string, text: string): Promise<HerdrAgent> {
    const agent = this.snapshotValue.agents.find((item) => item.paneId === paneId);
    if (!agent) throw herdrError("identity_mismatch");
    return this.record("prompt", { paneId, text }, agent);
  }
  async reportMetadata(input: Parameters<HerdrAdapter["reportMetadata"]>[0]): Promise<void> { this.record("reportMetadata", input, undefined); }
  async notify(input: Parameters<HerdrAdapter["notify"]>[0]) { return this.record("notify", input, { shown: true, reason: "shown" }); }
  async interruptAgent(paneId: string): Promise<void> { this.record("interruptAgent", paneId, undefined); }
  async closePaneExact(input: Parameters<HerdrAdapter["closePaneExact"]>[0]): Promise<void> {
    const pane = this.snapshotValue.panes.find((candidate) => candidate.paneId === input.paneId);
    if (!pane || pane.workspaceId !== input.workspaceId || pane.tabId !== input.tabId) {
      throw herdrError("identity_mismatch");
    }
    this.record("closePaneExact", input, undefined);
    this.snapshotValue = {
      ...this.snapshotValue,
      panes: this.snapshotValue.panes.filter((candidate) => candidate.paneId !== input.paneId),
      agents: this.snapshotValue.agents.filter((candidate) => candidate.paneId !== input.paneId),
      tabs: this.snapshotValue.tabs.map((tab) => tab.tabId === input.tabId
        ? { ...tab, paneCount: Math.max(0, tab.paneCount - 1) }
        : tab),
    };
  }
  async closeTabExact(input: Parameters<HerdrAdapter["closeTabExact"]>[0]): Promise<void> {
    const tab = this.snapshotValue.tabs.find((candidate) => candidate.tabId === input.tabId);
    const pane = this.snapshotValue.panes.find((candidate) => candidate.paneId === input.paneId);
    if (
      !tab || !pane || tab.workspaceId !== input.workspaceId ||
      pane.workspaceId !== input.workspaceId || pane.tabId !== input.tabId
    ) {
      throw herdrError("identity_mismatch");
    }
    if (!input.allowAuxiliaryPanes && tab.paneCount !== 1) throw herdrError("unowned_topology");
    this.record("closeTabExact", input, undefined);
    const paneIds = new Set(this.snapshotValue.panes
      .filter((candidate) => candidate.tabId === input.tabId)
      .map((candidate) => candidate.paneId));
    this.snapshotValue = {
      ...this.snapshotValue,
      tabs: this.snapshotValue.tabs.filter((candidate) => candidate.tabId !== input.tabId),
      panes: this.snapshotValue.panes.filter((candidate) => candidate.tabId !== input.tabId),
      agents: this.snapshotValue.agents.filter((candidate) => !paneIds.has(candidate.paneId)),
    };
  }
  async provisionMember(request: ProvisionMemberRequest): Promise<MemberResources> {
    const presentation = memberPresentation(request.role, request.purpose, request.runId);
    const created = await this.createMemberTab({ workspaceId: request.workspaceId, cwd: request.cwd, label: presentation.tabLabel, environment: request.environment });
    const agent = await this.startPiAgent({ workspaceId: request.workspaceId, tabId: created.tab.tabId, paneId: created.pane.paneId, name: presentation.agentName, arguments: request.agentArguments, timeoutMilliseconds: request.startupTimeoutMilliseconds });
    await this.reportMetadata({ paneId: created.pane.paneId, source: CANONICAL_RESOURCE_IDENTITY.herdrMetadataSource, sequence: 1, displayAgent: presentation.displayAgent, title: presentation.title });
    await this.prompt(created.pane.paneId, request.prompt);
    return { workspaceId: request.workspaceId, tabId: created.tab.tabId, paneId: created.pane.paneId, agentTarget: created.pane.paneId, agentName: presentation.agentName, memberSession: agent.agentSession };
  }
  stop(): void { this.handlers.clear(); }
}

export function memberPresentation(
  role: "scout" | "planner" | "builder",
  purpose: string,
  runId: string,
): MemberPresentation {
  const displayAgent = role[0]!.toUpperCase() + role.slice(1);
  const cleanPurpose = purpose
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 _.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48) || "delegated-task";
  const slug = cleanPurpose.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "task";
  const suffix = runId.replace(/[^A-Za-z0-9]/g, "").toLowerCase().slice(-4).padStart(4, "0");
  const prefix = `${role}-${slug}`.slice(0, Math.max(1, 27 - suffix.length)).replace(/-+$/g, "");
  return {
    tabLabel: `${displayAgent} · ${cleanPurpose}`.slice(0, 80),
    agentName: `${prefix}-${suffix}`.slice(0, 32),
    displayAgent,
    title: cleanPurpose,
    sessionName: `DB11 Crew · ${displayAgent} · ${cleanPurpose}`.slice(0, 80),
  };
}
