import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const EVENT_TYPE = "dbz-crew-event";
const DELIVERED_ENTRY_TYPE = "dbz-crew-event-delivered";
const DEFAULT_POLL_MS = 250;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const STATE_DIRECTORY_PARTS = [".local", "state", "dbz-crew"] as const;

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

interface StateLocation {
	homeDirectory: string;
	root: string;
}

interface ActiveRuntime {
	token: string;
	sessionId: string;
	location: StateLocation;
	readyPath: string;
	timer?: ReturnType<typeof setInterval>;
	processing: boolean;
	stopped: boolean;
	delivered: Set<string>;
	ctx: ExtensionContext;
}

interface ExtensionOptions {
	homeDirectory?: string;
}

export function stableDigest(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

export function resolveStateRoot(homeDirectory: string = userInfo().homedir): string {
	if (!isAbsolute(homeDirectory)) throw new Error(`The current account home is not absolute: ${homeDirectory}`);
	return resolve(homeDirectory, ...STATE_DIRECTORY_PARTS);
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

export default function dbzCrewEventsExtension(pi: ExtensionAPI, options: ExtensionOptions = {}) {
	let runtime: ActiveRuntime | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (!integrationEnabled(ctx)) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;

		try {
			const homeDirectory = options.homeDirectory ?? userInfo().homedir;
			const location = { homeDirectory, root: resolveStateRoot(homeDirectory) };
			await ensureStateDirectory(location.root, location, true);
			const token = randomUUID();
			const readyPath = resolve(location.root, "principals", `${stableDigest(sessionId)}.json`);
			runtime = {
				token,
				sessionId,
				location,
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
			}, location);
			await processPending(runtime);

			const pollMs = parsePollInterval(process.env.DBZ_CREW_EVENT_POLL_MS);
			runtime.timer = setInterval(() => {
				if (runtime) void processPending(runtime);
			}, pollMs);
			runtime.timer.unref?.();
		} catch (error) {
			runtime = undefined;
			ctx.ui.notify(`DBZ Crew event delivery is disabled: ${errorMessage(error)}`, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		const current = runtime;
		if (!current) return;
		current.stopped = true;
		if (current.timer) clearInterval(current.timer);
		runtime = undefined;
		await removeMatchingReadyMarker(current.readyPath, current.token, current.location);
	});

	async function processPending(current: ActiveRuntime): Promise<void> {
		if (current.processing || current.stopped) return;
		current.processing = true;
		try {
			const directory = completionEventDirectory(current.location.root, current.sessionId);
			await ensureStateDirectory(directory, current.location, true);
			const entries = await readdir(directory);
			for (const name of entries.filter((entry) => entry.endsWith(".json")).sort()) {
				if (current.stopped || runtime?.token !== current.token) return;
				const pendingPath = resolve(directory, name);
				const claimedPath = `${pendingPath}.claim-${current.token}`;
				try {
					await renamePrivateFile(pendingPath, claimedPath, current.location);
				} catch (error) {
					if (isMissing(error)) continue;
					throw error;
				}

				try {
					const raw = JSON.parse(await readPrivateText(claimedPath, current.location)) as unknown;
					const event = validateCompletionEvent(raw, current.sessionId, current.location.root);
					if (!event || !(await isSafeResultFile(event.result, current.location))) {
						await renamePrivateFile(
							claimedPath,
							`${pendingPath}.invalid-${current.token}`,
							current.location,
						);
						current.ctx.ui.notify("DBZ Crew ignored an invalid completion event.", "warning");
						continue;
					}
					if (current.delivered.has(event.id)) {
						await removePrivateFile(claimedPath, current.location);
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
					await removePrivateFile(claimedPath, current.location);
				} catch (error) {
					try {
						if (await stateEntryExists(claimedPath, current.location)) {
							await renamePrivateFile(claimedPath, pendingPath, current.location);
						}
					} catch (restoreError) {
						throw new Error(
							`${errorMessage(error)}; unable to restore claimed event: ${errorMessage(restoreError)}`,
						);
					}
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

function currentUid(): number {
	const uid = process.getuid?.();
	if (uid === undefined) throw new Error("Secure DBZ Crew state handling requires a POSIX user ID.");
	return uid;
}

function secureOpenFlags({
	directory = false,
	write = false,
	create = false,
	exclusive = false,
}: {
	directory?: boolean;
	write?: boolean;
	create?: boolean;
	exclusive?: boolean;
} = {}): number {
	for (const name of ["O_NOFOLLOW", ...(directory ? ["O_DIRECTORY"] : [])]) {
		if (typeof fsConstants[name as keyof typeof fsConstants] !== "number") {
			throw new Error(`Secure DBZ Crew state handling is unavailable: missing ${name}.`);
		}
	}
	let flags = write ? fsConstants.O_WRONLY : fsConstants.O_RDONLY;
	flags |= fsConstants.O_NOFOLLOW;
	if (directory) flags |= fsConstants.O_DIRECTORY;
	if (create) flags |= fsConstants.O_CREAT;
	if (exclusive) flags |= fsConstants.O_EXCL;
	return flags;
}

function assertOwnedDirectory(stats: Stats, path: string, privateDirectory: boolean): void {
	if (!stats.isDirectory()) throw new Error(`DBZ Crew state path is not a directory: ${path}`);
	if (stats.uid !== currentUid()) {
		throw new Error(`DBZ Crew state directory is not owned by the current user: ${path}`);
	}
	if (!privateDirectory && (stats.mode & 0o022) !== 0) {
		throw new Error(`DBZ Crew state parent is writable by other users: ${path}`);
	}
}

function assertOwnedFile(stats: Stats, path: string): void {
	if (!stats.isFile()) throw new Error(`DBZ Crew state path is not a regular file: ${path}`);
	if (stats.uid !== currentUid()) {
		throw new Error(`DBZ Crew state file is not owned by the current user: ${path}`);
	}
}

async function inspectPath(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path);
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

async function rejectRepositoryLocalStateRoot(root: string): Promise<void> {
	let current = root;
	while (true) {
		if (await inspectPath(resolve(current, ".git"))) {
			throw new Error(`DBZ Crew state directory cannot be inside a Git worktree: ${root}`);
		}
		const parent = dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

async function validateDirectoryHandle(
	handle: FileHandle,
	path: string,
	privateDirectory: boolean,
): Promise<void> {
	const stats = await handle.stat();
	assertOwnedDirectory(stats, path, privateDirectory);
	if (privateDirectory) await handle.chmod(PRIVATE_DIRECTORY_MODE);
}

async function ensureDirectoryComponent(path: string, create: boolean, privateDirectory: boolean): Promise<void> {
	let info = await inspectPath(path);
	if (!info && create) {
		try {
			await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw error;
		}
		info = await inspectPath(path);
	}
	if (!info) throw Object.assign(new Error(`DBZ Crew state directory is unavailable: ${path}`), { code: "ENOENT" });
	if (info.isSymbolicLink()) throw new Error(`DBZ Crew state directory cannot be a symbolic link: ${path}`);
	assertOwnedDirectory(info, path, privateDirectory);
	const handle = await open(path, secureOpenFlags({ directory: true }));
	try {
		await validateDirectoryHandle(handle, path, privateDirectory);
	} finally {
		await handle.close();
	}
}

function stateRelative(path: string, location: StateLocation): string {
	const normalized = resolve(path);
	if (normalized !== path) throw new Error(`DBZ Crew state path is not normalized: ${path}`);
	const result = relative(location.root, normalized);
	if (result.startsWith("..") || isAbsolute(result)) {
		throw new Error(`State path is outside the DBZ Crew state directory: ${path}`);
	}
	return result;
}

async function ensureStateRoot(location: StateLocation, create: boolean): Promise<void> {
	if (resolveStateRoot(location.homeDirectory) !== location.root) {
		throw new Error(`Unexpected DBZ Crew state root: ${location.root}`);
	}
	await rejectRepositoryLocalStateRoot(location.root);
	const homeHandle = await open(location.homeDirectory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
	try {
		await validateDirectoryHandle(homeHandle, location.homeDirectory, false);
	} finally {
		await homeHandle.close();
	}

	let current = location.homeDirectory;
	for (const [index, part] of STATE_DIRECTORY_PARTS.entries()) {
		current = resolve(current, part);
		await ensureDirectoryComponent(current, create, index === STATE_DIRECTORY_PARTS.length - 1);
	}
}

async function ensureStateDirectory(
	directory: string,
	location: StateLocation,
	create: boolean,
): Promise<void> {
	const statePath = stateRelative(directory, location);
	await ensureStateRoot(location, create);
	if (!statePath) return;
	let current = location.root;
	for (const part of statePath.split("/")) {
		if (!part || part === "." || part === "..") {
			throw new Error(`DBZ Crew state path contains an unsafe component: ${directory}`);
		}
		current = resolve(current, part);
		await ensureDirectoryComponent(current, create, true);
	}
}

async function openPrivateFile(path: string, location: StateLocation): Promise<FileHandle> {
	stateRelative(path, location);
	await ensureStateDirectory(dirname(path), location, false);
	const before = await inspectPath(path);
	if (!before) throw Object.assign(new Error(`DBZ Crew state file is unavailable: ${path}`), { code: "ENOENT" });
	if (before.isSymbolicLink()) throw new Error(`DBZ Crew state file cannot be a symbolic link: ${path}`);
	assertOwnedFile(before, path);
	const handle = await open(path, secureOpenFlags({}));
	try {
		const after = await handle.stat();
		assertOwnedFile(after, path);
		if (before.dev !== after.dev || before.ino !== after.ino) {
			throw new Error(`DBZ Crew state file changed while it was opened: ${path}`);
		}
		await handle.chmod(PRIVATE_FILE_MODE);
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function readPrivateText(path: string, location: StateLocation): Promise<string> {
	const handle = await openPrivateFile(path, location);
	try {
		return await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}

async function validateReplaceableFile(path: string, location: StateLocation): Promise<void> {
	stateRelative(path, location);
	const info = await inspectPath(path);
	if (!info) return;
	if (info.isSymbolicLink()) throw new Error(`DBZ Crew state file cannot be a symbolic link: ${path}`);
	assertOwnedFile(info, path);
}

async function writeJsonAtomic(path: string, value: unknown, location: StateLocation): Promise<void> {
	const directory = dirname(path);
	await ensureStateDirectory(directory, location, true);
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let handle: FileHandle | undefined;
	try {
		handle = await open(
			temporary,
			secureOpenFlags({ write: true, create: true, exclusive: true }),
			PRIVATE_FILE_MODE,
		);
		await handle.chmod(PRIVATE_FILE_MODE);
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await validateReplaceableFile(path, location);
		await ensureStateDirectory(directory, location, false);
		await rename(temporary, path);
	} finally {
		if (handle) await handle.close();
		await rm(temporary, { force: true });
	}
}

async function renamePrivateFile(source: string, destination: string, location: StateLocation): Promise<void> {
	if (dirname(source) !== dirname(destination)) {
		throw new Error("DBZ Crew state files can only be renamed within one directory.");
	}
	const sourceHandle = await openPrivateFile(source, location);
	await sourceHandle.close();
	if (await inspectPath(destination)) {
		throw new Error(`Refusing to replace an existing DBZ Crew state path: ${destination}`);
	}
	await ensureStateDirectory(dirname(source), location, false);
	await rename(source, destination);
	const destinationHandle = await openPrivateFile(destination, location);
	await destinationHandle.close();
}

async function removePrivateFile(path: string, location: StateLocation): Promise<void> {
	const handle = await openPrivateFile(path, location);
	await handle.close();
	await rm(path);
}

async function stateEntryExists(path: string, location: StateLocation): Promise<boolean> {
	stateRelative(path, location);
	try {
		await ensureStateDirectory(dirname(path), location, false);
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
	return Boolean(await inspectPath(path));
}

async function isSafeResultFile(path: string, location: StateLocation): Promise<boolean> {
	try {
		const handle = await openPrivateFile(path, location);
		await handle.close();
		return true;
	} catch {
		return false;
	}
}

async function removeMatchingReadyMarker(path: string, token: string, location: StateLocation): Promise<void> {
	try {
		const marker = JSON.parse(await readPrivateText(path, location)) as { token?: unknown };
		if (marker.token === token) await removePrivateFile(path, location);
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
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
