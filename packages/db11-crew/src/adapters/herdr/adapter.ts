import { isAbsolute } from "node:path";

import { CANONICAL_RESOURCE_IDENTITY } from "../../protocol/limits.ts";
import {
  HERDR_ADAPTER_CAPABILITIES,
  HERDR_API_SCHEMA,
  HERDR_ENVIRONMENT_LIMITS,
  HERDR_PROTOCOL,
  herdrError,
  memberPresentation,
  type HerdrAdapter,
  type HerdrAgent,
  type HerdrPane,
  type HerdrProbe,
  type HerdrSnapshot,
  type HerdrSubscriptionHandlers,
  type HerdrTab,
  type HerdrWorkspace,
  type MemberResources,
  type ProvisionMemberRequest,
} from "./contracts.ts";
import {
  assertSchemaMetadata,
  expectedResult,
  parseAgent,
  parseEventFrame,
  parsePane,
  parseProbeResult,
  parseSnapshotResult,
  parseTab,
  parseWorkspace,
} from "./protocol17.ts";
import { HerdrSocketTransport, type HerdrTransportOptions } from "./transport.ts";

const HERDR_ENVIRONMENT_KEY = new RegExp(
  `^[A-Z_][A-Z0-9_]{0,${HERDR_ENVIRONMENT_LIMITS.keyCharacters - 1}}$`,
  "u",
);

const SUBSCRIPTIONS = Object.freeze([
  { type: "workspace.updated" },
  { type: "workspace.metadata_updated" },
  { type: "workspace.closed" },
  { type: "tab.created" },
  { type: "tab.closed" },
  { type: "pane.created" },
  { type: "pane.closed" },
  { type: "pane.updated" },
  { type: "pane.exited" },
  { type: "pane.agent_detected" },
] as const);

function safeText(value: string, maximum: number, allowNewline = false): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes("\0") ||
    (!allowNewline && /[\r\n]/.test(value))
  ) {
    throw herdrError("invalid_argument");
  }
}

function safeIdentifier(value: string): void {
  safeText(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) throw herdrError("invalid_argument");
}

function safeEnvironment(environment: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!environment) return result;
  const entries = Object.entries(environment);
  if (entries.length > HERDR_ENVIRONMENT_LIMITS.entries) throw herdrError("invalid_argument");
  let aggregateBytes = 0;
  for (const [key, value] of entries) {
    if (
      !HERDR_ENVIRONMENT_KEY.test(key) ||
      typeof value !== "string" ||
      value.length > HERDR_ENVIRONMENT_LIMITS.valueCharacters ||
      value.includes("\0")
    ) {
      throw herdrError("invalid_argument");
    }
    aggregateBytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8") + 2;
    if (aggregateBytes > HERDR_ENVIRONMENT_LIMITS.aggregateBytes) throw herdrError("invalid_argument");
    result[key] = value;
  }
  return result;
}

function expectOnly(result: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(result).some((key) => !allowed.has(key))) throw herdrError("schema_mismatch");
}

function verifyPane(pane: HerdrPane, expected: { workspaceId: string; tabId: string; paneId?: string }): void {
  if (
    pane.workspaceId !== expected.workspaceId ||
    pane.tabId !== expected.tabId ||
    (expected.paneId !== undefined && pane.paneId !== expected.paneId)
  ) {
    throw herdrError("identity_mismatch");
  }
}

export interface Protocol17AdapterOptions extends HerdrTransportOptions {
  schemaMetadata?: { protocol: number; schemaVersion: number };
}

/** API-first local Herdr protocol 17 / schema 1 adapter. */
export class Protocol17HerdrAdapter implements HerdrAdapter {
  readonly protocol = HERDR_PROTOCOL;
  readonly apiSchema = HERDR_API_SCHEMA;
  private readonly transport: HerdrSocketTransport;
  private subscribed = false;

  constructor(options: Protocol17AdapterOptions) {
    assertSchemaMetadata(options.schemaMetadata ?? { protocol: HERDR_PROTOCOL, schemaVersion: HERDR_API_SCHEMA });
    this.transport = new HerdrSocketTransport(options);
  }

  async probe(): Promise<HerdrProbe> {
    const parsed = parseProbeResult(await this.transport.request("ping", {}));
    return { ...parsed, capabilities: [...HERDR_ADAPTER_CAPABILITIES] };
  }

  async snapshot(): Promise<HerdrSnapshot> {
    return parseSnapshotResult(await this.transport.request("session.snapshot", {}));
  }

  async subscribe(handlers: HerdrSubscriptionHandlers): Promise<() => void> {
    if (this.subscribed) throw herdrError("invalid_argument");
    this.subscribed = true;
    try {
      await this.transport.startStream({
        subscriptions: SUBSCRIPTIONS,
        onEvent: (frame) => handlers.onEvent(parseEventFrame(frame)),
        onSnapshot: (result, generation) => handlers.onReconcile(parseSnapshotResult(result), generation),
        onGap: handlers.onGap,
      });
    } catch (error) {
      this.subscribed = false;
      throw error;
    }
    return () => {
      this.subscribed = false;
      this.transport.stop();
    };
  }

  async getWorkspace(workspaceId: string): Promise<HerdrWorkspace> {
    safeIdentifier(workspaceId);
    const result = expectedResult(
      await this.transport.request("workspace.get", { workspace_id: workspaceId }),
      "workspace_info",
    );
    expectOnly(result, ["type", "workspace"]);
    const workspace = parseWorkspace(result.workspace);
    if (workspace.workspaceId !== workspaceId) throw herdrError("identity_mismatch");
    return workspace;
  }

  async getTab(tabId: string): Promise<HerdrTab> {
    safeIdentifier(tabId);
    const result = expectedResult(
      await this.transport.request("tab.get", { tab_id: tabId }),
      "tab_info",
    );
    expectOnly(result, ["type", "tab"]);
    const tab = parseTab(result.tab);
    if (tab.tabId !== tabId) throw herdrError("identity_mismatch");
    return tab;
  }

  async getPane(paneId: string): Promise<HerdrPane> {
    safeIdentifier(paneId);
    const result = expectedResult(
      await this.transport.request("pane.get", { pane_id: paneId }),
      "pane_info",
    );
    expectOnly(result, ["type", "pane"]);
    const pane = parsePane(result.pane);
    if (pane.paneId !== paneId) throw herdrError("identity_mismatch");
    return pane;
  }

  async getAgent(paneId: string): Promise<HerdrAgent> {
    safeIdentifier(paneId);
    const result = expectedResult(
      await this.transport.request("agent.get", { target: paneId }),
      "agent_info",
    );
    expectOnly(result, ["type", "agent"]);
    const agent = parseAgent(result.agent);
    if (agent.paneId !== paneId) throw herdrError("identity_mismatch");
    return agent;
  }

  async createMemberTab(input: {
    workspaceId: string;
    cwd: string;
    label: string;
    environment?: Readonly<Record<string, string>>;
  }): Promise<{ tab: HerdrTab; pane: HerdrPane }> {
    safeIdentifier(input.workspaceId);
    if (!isAbsolute(input.cwd) || input.cwd.includes("\0") || input.cwd.length > 1024) {
      throw herdrError("invalid_argument");
    }
    safeText(input.label, 80);
    const result = expectedResult(
      await this.transport.request("tab.create", {
        workspace_id: input.workspaceId,
        cwd: input.cwd,
        label: input.label,
        env: safeEnvironment(input.environment),
        focus: false,
      }),
      "tab_created",
    );
    expectOnly(result, ["type", "tab", "root_pane"]);
    const tab = parseTab(result.tab);
    const pane = parsePane(result.root_pane);
    if (tab.workspaceId !== input.workspaceId || tab.focused) throw herdrError(tab.focused ? "focus_changed" : "identity_mismatch");
    if (tab.paneCount !== 1) throw herdrError("unowned_topology");
    verifyPane(pane, { workspaceId: input.workspaceId, tabId: tab.tabId });
    if (pane.focused) throw herdrError("focus_changed");
    return { tab, pane };
  }

  async startPiAgent(input: {
    workspaceId: string;
    tabId: string;
    paneId: string;
    name: string;
    arguments: readonly string[];
    timeoutMilliseconds?: number;
  }): Promise<HerdrAgent> {
    safeIdentifier(input.workspaceId);
    safeIdentifier(input.tabId);
    safeIdentifier(input.paneId);
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(input.name) || input.arguments.length > 64) {
      throw herdrError("invalid_argument");
    }
    for (const argument of input.arguments) safeText(argument, 4096, true);
    const timeout = input.timeoutMilliseconds ?? 30_000;
    if (!Number.isInteger(timeout) || timeout <= 3_000 || timeout > 300_000) throw herdrError("invalid_argument");
    const result = expectedResult(
      await this.transport.request("agent.start", {
        name: input.name,
        kind: "pi",
        pane_id: input.paneId,
        args: [...input.arguments],
        timeout_ms: timeout,
      }),
      "agent_started",
    );
    expectOnly(result, ["type", "agent", "argv"]);
    if (!Array.isArray(result.argv) || result.argv.some((item) => typeof item !== "string")) {
      throw herdrError("schema_mismatch");
    }
    const rawAgent = result.agent as Record<string, unknown>;
    const agent = parseAgent(rawAgent);
    verifyPane(agent, input);
    if (
      (agent.name !== undefined && agent.name !== input.name) ||
      rawAgent.interactive_ready === false ||
      agent.launchPending
    ) {
      throw herdrError("identity_mismatch");
    }
    // The protocol contract for `agent.start` itself confirms interactive
    // readiness; schema 1 permits older responders to omit the duplicated flag.
    return { ...agent, name: agent.name ?? input.name, interactiveReady: true, launchPending: false };
  }

  async prompt(paneId: string, text: string): Promise<HerdrAgent> {
    safeIdentifier(paneId);
    safeText(text, 32 * 1024, true);
    const result = expectedResult(
      await this.transport.request("agent.prompt", { target: paneId, text }),
      "agent_prompted",
    );
    expectOnly(result, ["type", "agent"]);
    const agent = parseAgent(result.agent);
    if (agent.paneId !== paneId) throw herdrError("identity_mismatch");
    return agent;
  }

  async reportMetadata(input: {
    paneId: string;
    source: string;
    sequence: number;
    displayAgent: string;
    title: string;
    stateLabels?: Readonly<Record<string, string>>;
    tokens?: Readonly<Record<string, string | null>>;
    ttlMilliseconds?: number;
  }): Promise<void> {
    safeIdentifier(input.paneId);
    safeIdentifier(input.source);
    safeText(input.displayAgent, 80);
    safeText(input.title, 80);
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) throw herdrError("invalid_argument");
    if (input.ttlMilliseconds !== undefined && (!Number.isInteger(input.ttlMilliseconds) || input.ttlMilliseconds < 1 || input.ttlMilliseconds > 86_400_000)) throw herdrError("invalid_argument");
    const stateLabels = safeMetadataMap(input.stateLabels, false);
    const tokens = safeMetadataMap(input.tokens, true);
    const result = expectedResult(await this.transport.request("pane.report_metadata", {
      pane_id: input.paneId,
      source: input.source,
      display_agent: input.displayAgent,
      title: input.title,
      state_labels: stateLabels,
      tokens,
      seq: input.sequence,
      ...(input.ttlMilliseconds === undefined ? {} : { ttl_ms: input.ttlMilliseconds }),
    }), "ok");
    expectOnly(result, ["type"]);
  }

  async notify(input: { title: string; body?: string; sound?: "none" | "done" | "request" }): Promise<{ shown: boolean; reason: string }> {
    safeText(input.title, 256);
    if (input.body !== undefined) safeText(input.body, 2048, true);
    const sound = input.sound ?? "none";
    if (!["none", "done", "request"].includes(sound)) throw herdrError("invalid_argument");
    const result = expectedResult(await this.transport.request("notification.show", {
      title: input.title,
      body: input.body ?? null,
      sound,
    }), "notification_show");
    expectOnly(result, ["type", "shown", "reason"]);
    if (typeof result.shown !== "boolean" || typeof result.reason !== "string") throw herdrError("schema_mismatch");
    return { shown: result.shown, reason: result.reason };
  }

  async interruptAgent(paneId: string): Promise<void> {
    safeIdentifier(paneId);
    const result = expectedResult(
      await this.transport.request("agent.send_keys", { target: paneId, keys: ["ctrl+c"] }),
      "ok",
    );
    expectOnly(result, ["type"]);
  }

  async closePaneExact(expected: { workspaceId: string; tabId: string; paneId: string }): Promise<void> {
    const pane = await this.getPane(expected.paneId);
    verifyPane(pane, expected);
    const result = expectedResult(
      await this.transport.request("pane.close", { pane_id: expected.paneId }),
      "ok",
    );
    expectOnly(result, ["type"]);
  }

  async closeTabExact(expected: { workspaceId: string; tabId: string; paneId: string; allowAuxiliaryPanes?: boolean }): Promise<void> {
    const [tab, pane] = await Promise.all([this.getTab(expected.tabId), this.getPane(expected.paneId)]);
    if (tab.workspaceId !== expected.workspaceId) throw herdrError("identity_mismatch");
    verifyPane(pane, expected);
    if (!expected.allowAuxiliaryPanes && tab.paneCount !== 1) throw herdrError("unowned_topology");
    const result = expectedResult(
      await this.transport.request("tab.close", { tab_id: expected.tabId }),
      "ok",
    );
    expectOnly(result, ["type"]);
  }

  async provisionMember(request: ProvisionMemberRequest): Promise<MemberResources> {
    safeIdentifier(request.runId);
    safeIdentifier(request.workspaceId);
    const presentation = memberPresentation(request.role, request.purpose, request.runId);
    const partial: Partial<MemberResources> = { workspaceId: request.workspaceId };
    try {
      // Verify the exact Crewlead workspace before creating any Herdr resource.
      await this.getWorkspace(request.workspaceId);
      const created = await this.createMemberTab({
        workspaceId: request.workspaceId,
        cwd: request.cwd,
        label: presentation.tabLabel,
        environment: request.environment,
      });
      Object.assign(partial, {
        tabId: created.tab.tabId,
        paneId: created.pane.paneId,
        agentTarget: created.pane.paneId,
        agentName: presentation.agentName,
      });
      const agent = await this.startPiAgent({
        workspaceId: request.workspaceId,
        tabId: created.tab.tabId,
        paneId: created.pane.paneId,
        name: presentation.agentName,
        arguments: request.agentArguments,
        timeoutMilliseconds: request.startupTimeoutMilliseconds,
      });
      partial.memberSession = agent.agentSession;
      await this.reportMetadata({
        paneId: created.pane.paneId,
        source: CANONICAL_RESOURCE_IDENTITY.herdrMetadataSource,
        sequence: 1,
        displayAgent: presentation.displayAgent,
        title: presentation.title,
        stateLabels: { working: "Working", blocked: "Needs input", done: "Turn settled" },
        tokens: { db11_run: request.runId.slice(0, 128) },
      });
      // No wait options are sent: Herdr's response is prompt acceptance only.
      await this.prompt(created.pane.paneId, request.prompt);
      return partial as MemberResources;
    } catch (error) {
      throw herdrError("startup_partial", { cause: error, partialResources: partial });
    }
  }

  stop(): void {
    this.subscribed = false;
    this.transport.stop();
  }
}

function safeMetadataMap(
  input: Readonly<Record<string, string | null>> | undefined,
  allowNull: boolean,
): Record<string, string | null> {
  if (!input) return {};
  const entries = Object.entries(input);
  if (entries.length > 16) throw herdrError("invalid_argument");
  const result: Record<string, string | null> = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(key)) throw herdrError("invalid_argument");
    if (value === null) {
      if (!allowNull) throw herdrError("invalid_argument");
    } else {
      safeText(value, 256);
    }
    result[key] = value;
  }
  return result;
}

export { assertSchemaMetadata } from "./protocol17.ts";
export * from "./contracts.ts";
