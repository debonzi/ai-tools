import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const EVENT_TYPE = "dbz-crew-event";
const DELIVERED_ENTRY_TYPE = "dbz-crew-event-delivered";
const DEFAULT_POLL_MS = 250;

export interface CrewCompletionEvent {
	id: string;
	principal_session_id: string;
	task_id: string;
	phase: "implementation" | "rebase";
	status: "done" | "blocked" | "failed";
	result: string;
	created_at: number;
	message?: string;
}

interface ActiveRuntime {
	token: string;
	sessionId: string;
	stateRoot: string;
	readyPath: string;
	timer?: ReturnType<typeof setInterval>;
	processing: boolean;
	stopped: boolean;
	delivered: Set<string>;
	ctx: ExtensionContext;
}

export function stableDigest(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

export function resolveStateRoot(env: NodeJS.ProcessEnv = process.env): string {
	if (env.DBZ_CREW_STATE_DIR?.trim()) return resolve(expandHome(env.DBZ_CREW_STATE_DIR.trim()));
	if (env.XDG_STATE_HOME?.trim()) return resolve(expandHome(env.XDG_STATE_HOME.trim()), "dbz-crew");
	return resolve(homedir(), ".local", "state", "dbz-crew");
}

export function completionEventDirectory(stateRoot: string, sessionId: string): string {
	return resolve(stateRoot, "events", stableDigest(sessionId));
}

export function validateCompletionEvent(
	value: unknown,
	expectedSessionId: string,
	stateRoot: string,
): CrewCompletionEvent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const event = value as Record<string, unknown>;
	if (
		typeof event.id !== "string" ||
		!event.id ||
		typeof event.principal_session_id !== "string" ||
		event.principal_session_id !== expectedSessionId ||
		typeof event.task_id !== "string" ||
		!event.task_id ||
		(event.phase !== "implementation" && event.phase !== "rebase") ||
		(event.status !== "done" && event.status !== "blocked" && event.status !== "failed") ||
		typeof event.result !== "string" ||
		!isAbsolute(event.result) ||
		typeof event.created_at !== "number" ||
		!Number.isFinite(event.created_at) ||
		(event.message !== undefined &&
			(typeof event.message !== "string" || !event.message.trim() || event.message.length > 2000))
	) {
		return undefined;
	}

	const resultsRoot = resolve(stateRoot, "results");
	const resultPath = resolve(event.result);
	const resultRelative = relative(resultsRoot, resultPath);
	if (resultRelative.startsWith("..") || isAbsolute(resultRelative)) return undefined;

	return event as unknown as CrewCompletionEvent;
}

export default function dbzCrewEventsExtension(pi: ExtensionAPI) {
	let runtime: ActiveRuntime | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (!integrationEnabled(ctx)) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;

		const stateRoot = resolveStateRoot();
		const token = randomUUID();
		const readyPath = resolve(stateRoot, "principals", `${stableDigest(sessionId)}.json`);
		runtime = {
			token,
			sessionId,
			stateRoot,
			readyPath,
			processing: false,
			stopped: false,
			delivered: deliveredEventIds(ctx),
			ctx,
		};

		await writeJsonAtomic(readyPath, {
			session_id: sessionId,
			pane_id: process.env.HERDR_PANE_ID,
			pid: process.pid,
			token,
			started_at: Date.now(),
		});
		await processPending(runtime);

		const pollMs = parsePollInterval(process.env.DBZ_CREW_EVENT_POLL_MS);
		runtime.timer = setInterval(() => {
			if (runtime) void processPending(runtime);
		}, pollMs);
		runtime.timer.unref?.();
	});

	pi.on("session_shutdown", async () => {
		const current = runtime;
		if (!current) return;
		current.stopped = true;
		if (current.timer) clearInterval(current.timer);
		runtime = undefined;
		await removeMatchingReadyMarker(current.readyPath, current.token);
	});

	async function processPending(current: ActiveRuntime): Promise<void> {
		if (current.processing || current.stopped) return;
		current.processing = true;
		try {
			const directory = completionEventDirectory(current.stateRoot, current.sessionId);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			await chmod(directory, 0o700);
			const entries = await readdir(directory);
			for (const name of entries.filter((entry) => entry.endsWith(".json")).sort()) {
				if (current.stopped || runtime?.token !== current.token) return;
				const pendingPath = resolve(directory, name);
				const claimedPath = `${pendingPath}.claim-${current.token}`;
				try {
					await rename(pendingPath, claimedPath);
				} catch (error) {
					if (isMissing(error)) continue;
					throw error;
				}

				try {
					const raw = JSON.parse(await readFile(claimedPath, "utf8")) as unknown;
					const event = validateCompletionEvent(raw, current.sessionId, current.stateRoot);
					if (!event) {
						await rename(claimedPath, `${pendingPath}.invalid`);
						current.ctx.ui.notify("DBZ Crew ignored an invalid completion event.", "warning");
						continue;
					}
					if (current.delivered.has(event.id)) {
						await rm(claimedPath, { force: true });
						continue;
					}

					pi.sendMessage(
						{
							customType: EVENT_TYPE,
							content: completionMessage(event),
							display: true,
							details: event,
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
					pi.appendEntry(DELIVERED_ENTRY_TYPE, { id: event.id, deliveredAt: Date.now() });
					current.delivered.add(event.id);
					await rm(claimedPath, { force: true });
				} catch (error) {
					if (await exists(claimedPath)) await rename(claimedPath, pendingPath);
					throw error;
				}
			}
		} catch (error) {
			if (!current.stopped) {
				current.ctx.ui.notify(`DBZ Crew event delivery failed: ${errorMessage(error)}`, "warning");
			}
		} finally {
			current.processing = false;
		}
	}
}

function integrationEnabled(ctx: ExtensionContext): boolean {
	return (
		ctx.hasUI === true &&
		process.env.HERDR_ENV === "1" &&
		Boolean(process.env.HERDR_SOCKET_PATH) &&
		Boolean(process.env.HERDR_PANE_ID)
	);
}

function deliveredEventIds(ctx: ExtensionContext): Set<string> {
	const delivered = new Set<string>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== DELIVERED_ENTRY_TYPE) continue;
		const id = (entry.data as { id?: unknown } | undefined)?.id;
		if (typeof id === "string" && id) delivered.add(id);
	}
	return delivered;
}

function completionMessage(event: CrewCompletionEvent): string {
	if (event.message) return event.message;
	return [
		`DBZ-CREW EVENT: worker ${event.task_id} ${event.phase} is ${event.status}.`,
		`Read ${event.result}, inspect the worker state with \`dbz-crew status\`, report it to the user,`,
		"and await an explicit user decision before rebase, merge, or cleanup.",
	].join(" ");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await chmod(temporary, 0o600);
		await rename(temporary, path);
		await chmod(path, 0o600);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function removeMatchingReadyMarker(path: string, token: string): Promise<void> {
	try {
		const marker = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
		if (marker.token === token) await rm(path, { force: true });
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return path;
}

function parsePollInterval(raw: string | undefined): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(parsed) && parsed >= 10 ? parsed : DEFAULT_POLL_MS;
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
