import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type { HerdrAdapter, HerdrSnapshot } from "../adapters/herdr/contracts.ts";
import type { DeliveryIdentity } from "../delivery/service.ts";
import { TransientProgressQueue } from "../delivery/transient.ts";
import type { RunRecord } from "../orchestration/lifecycle.ts";
import { LIMITS } from "../protocol/limits.ts";
import { validateContract } from "../protocol/validate.ts";
import { redactDiagnostic } from "../security/redaction.ts";
import type { DurableDeliveryClaims } from "../state/claims.ts";
import type { DurableStateStore } from "../state/store.ts";

export interface ObservabilityCounts {
  queued: number;
  starting: number;
  working: number;
  blocked: number;
  unfinalizedIdle: number;
  terminalUndelivered: number;
}

export interface ObservabilityRow {
  runId: string;
  text: string;
}

export interface ObservabilitySnapshot {
  status: string;
  rows: readonly ObservabilityRow[];
  omittedRows: number;
  fallback: boolean;
  counts: ObservabilityCounts;
}

function asRun(value: Readonly<Record<string, unknown>>): RunRecord | undefined {
  const validation = validateContract("run", value);
  return validation.ok ? structuredClone(value) as RunRecord : undefined;
}

function bounded(value: unknown, maximum: number = LIMITS.diagnosticLength): string {
  return redactDiagnostic(typeof value === "string" ? value : "unavailable", {
    maximumLength: Math.min(maximum, LIMITS.diagnosticLength),
  });
}

function truncate(value: string): string {
  return value.length <= LIMITS.uiLineCharacters
    ? value
    : `${value.slice(0, LIMITS.uiLineCharacters - 1)}…`;
}

function progressText(frame: Readonly<Record<string, unknown>> | undefined): string {
  if (!frame) return "details unavailable";
  if (typeof frame.phase === "string") return `phase ${bounded(frame.phase, LIMITS.labelLength)}`;
  if (typeof frame.tool === "string") {
    return `tool ${bounded(frame.tool, LIMITS.labelLength)}${typeof frame.outcome === "string" ? ` ${frame.outcome}` : ""}`;
  }
  if (typeof frame.summary === "string") return bounded(frame.summary);
  return bounded(frame.kind, LIMITS.labelLength);
}

function observedState(run: RunRecord, snapshot: HerdrSnapshot | undefined): string {
  if (snapshot && run.resources) {
    return snapshot.agents.find((agent) => agent.paneId === run.resources!.paneId)?.agentState ??
      snapshot.panes.find((pane) => pane.paneId === run.resources!.paneId)?.agentState ??
      "unknown";
  }
  return run.observation?.state ?? "unknown";
}

function priority(run: RunRecord, undelivered: ReadonlySet<string>): number {
  if (run.state === "blocked") return 0;
  if (["starting", "working"].includes(run.state)) return 1;
  if (run.state === "queued") return 2;
  if (undelivered.has(run.runId)) return 3;
  return 4;
}

/** Builds one bounded UI-only aggregate from durable state and exact Herdr IDs. */
export class CrewObservabilityService {
  readonly identity: Readonly<DeliveryIdentity>;
  private readonly store: DurableStateStore;
  private readonly herdr: HerdrAdapter;
  private readonly claims: DurableDeliveryClaims;
  private readonly progressQueue: TransientProgressQueue;
  private readonly progress = new Map<string, Readonly<Record<string, unknown>>>();

  constructor(
    identity: DeliveryIdentity,
    dependencies: {
      store: DurableStateStore;
      herdr: HerdrAdapter;
      claims: DurableDeliveryClaims;
      progressQueue: TransientProgressQueue;
    },
  ) {
    this.identity = Object.freeze(structuredClone(identity));
    this.store = dependencies.store;
    this.herdr = dependencies.herdr;
    this.claims = dependencies.claims;
    this.progressQueue = dependencies.progressQueue;
  }

  private owns(run: RunRecord): boolean {
    return run.binding.crewleadSessionId === this.identity.crewleadSessionId &&
      run.binding.herdrWorkspaceId === this.identity.herdrWorkspaceId &&
      run.binding.canonicalProjectPath === this.identity.canonicalProjectPath;
  }

  private async blockerSummary(run: RunRecord): Promise<string | undefined> {
    if (!run.activeBlockerId) return undefined;
    const record = [...await this.store.readHistory(run.runId)].reverse().find((candidate) => {
      const payload = candidate.payload as { blockerId?: unknown; status?: unknown };
      return candidate.kind === "control" &&
        payload.blockerId === run.activeBlockerId &&
        payload.status === "open";
    });
    return record ? bounded((record.payload as { summary?: unknown }).summary) : undefined;
  }

  async snapshot(): Promise<ObservabilitySnapshot> {
    const runs = (await this.store.listRuns())
      .map(asRun)
      .filter((run): run is RunRecord => run !== undefined && this.owns(run));
    const current = new Map(runs.map((run) => [run.runId, run]));
    for (const record of await this.progressQueue.drain(this.identity as DeliveryIdentity)) {
      const run = current.get(record.runId);
      if (!run || run.fencingEpoch !== record.fencingEpoch || ["completed", "failed", "cancelled", "abandoned"].includes(run.state)) {
        this.progress.delete(record.runId);
        continue;
      }
      const prior = this.progress.get(record.runId);
      if (!prior || Number(record.frame.sequence) > Number(prior.sequence)) {
        this.progress.set(record.runId, Object.freeze(structuredClone(record.frame)));
      }
    }
    for (const [runId] of this.progress) {
      const run = current.get(runId);
      if (!run || ["completed", "failed", "cancelled", "abandoned"].includes(run.state)) this.progress.delete(runId);
    }

    let herdrSnapshot: HerdrSnapshot | undefined;
    let fallback = false;
    try {
      herdrSnapshot = await this.herdr.snapshot();
      if (herdrSnapshot.workspaces.every((workspace) => workspace.workspaceId !== this.identity.herdrWorkspaceId)) {
        herdrSnapshot = undefined;
        fallback = true;
      }
    } catch {
      fallback = true;
    }
    const undelivered = await this.claims.listUndeliveredRunIds({
      crewleadSessionId: this.identity.crewleadSessionId,
      herdrWorkspaceId: this.identity.herdrWorkspaceId,
    });
    const counts: ObservabilityCounts = {
      queued: 0,
      starting: 0,
      working: 0,
      blocked: 0,
      unfinalizedIdle: 0,
      terminalUndelivered: 0,
    };
    for (const run of runs) {
      if (run.state === "queued") counts.queued += 1;
      else if (run.state === "starting") counts.starting += 1;
      else if (run.state === "working") counts.working += 1;
      else if (run.state === "blocked") counts.blocked += 1;
      if (["starting", "working", "blocked"].includes(run.state) && ["idle", "done"].includes(observedState(run, herdrSnapshot))) {
        counts.unfinalizedIdle += 1;
      }
      if (undelivered.has(run.runId)) counts.terminalUndelivered += 1;
    }
    const visible = runs
      .filter((run) => ["queued", "starting", "working", "blocked"].includes(run.state) || undelivered.has(run.runId))
      .sort((left, right) =>
        priority(left, undelivered) - priority(right, undelivered) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.runId.localeCompare(right.runId));
    const rows: ObservabilityRow[] = [];
    for (const run of visible.slice(0, LIMITS.uiRows)) {
      const blocker = run.state === "blocked" ? await this.blockerSummary(run) : undefined;
      const observation = observedState(run, herdrSnapshot);
      const activity = progressText(this.progress.get(run.runId));
      rows.push({
        runId: run.runId,
        text: truncate([
          `${run.role} ${bounded(run.purposeLabel, LIMITS.labelLength)} #${run.runId.slice(-6)}`,
          `${run.state}/${observation}`,
          activity,
          ...(blocker ? [`blocked: ${blocker}`] : []),
          ...(undelivered.has(run.runId) ? ["terminal result pending delivery"] : []),
        ].join(" | ")),
      });
    }
    const active = counts.starting + counts.working + counts.blocked;
    const status = truncate(
      `DB11 Crew: ${active} active, ${counts.blocked} blocked, ${counts.queued} queued, ${counts.unfinalizedIdle} idle-unfinalized, ${counts.terminalUndelivered} undelivered${fallback ? " (Herdr details unavailable)" : ""}`,
    );
    return Object.freeze({
      status,
      rows: Object.freeze(rows),
      omittedRows: Math.max(0, visible.length - rows.length),
      fallback,
      counts: Object.freeze(counts),
    });
  }

  clearTransient(): void {
    this.progress.clear();
  }
}

/** Isolates transient TUI failures from durable delivery and later refreshes. */
export class CrewleadUIController {
  private readonly ui: Pick<ExtensionUIContext, "setStatus" | "setWidget">;

  constructor(ui: Pick<ExtensionUIContext, "setStatus" | "setWidget">) {
    this.ui = ui;
  }

  render(snapshot: ObservabilitySnapshot): boolean {
    let rendered = true;
    try {
      this.ui.setStatus("db11-crew", snapshot.status);
    } catch {
      rendered = false;
    }
    const lines = snapshot.rows.map((row) => row.text);
    if (snapshot.omittedRows > 0) lines.push(`… ${snapshot.omittedRows} more DB11 Crew run(s); use db11_crew_list.`);
    try {
      this.ui.setWidget("db11-crew-runs", lines.length > 0 ? lines : undefined);
    } catch {
      rendered = false;
    }
    return rendered;
  }

  clear(): void {
    try { this.ui.setStatus("db11-crew", undefined); } catch {}
    try { this.ui.setWidget("db11-crew-runs", undefined); } catch {}
  }
}
