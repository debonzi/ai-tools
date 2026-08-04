import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import dbzCrewEventsExtension, {
	completionEventDirectory,
	CREW_COMPLETION_EVENT_CHANNEL,
	resolveStateRoot,
	stableDigest,
	validateCompletionEvent,
} from "./index.ts";

interface FakeEntry {
	type: "custom";
	customType: string;
	data: unknown;
}

function makeHarness(sessionId: string, initialEntries: FakeEntry[] = [], homeDirectory?: string) {
	const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
	const sent: Array<{ message: any; options: any }> = [];
	const appended: FakeEntry[] = [...initialEntries];
	const notifications: Array<{ message: string; level: string }> = [];
	const busEvents: Array<{ channel: string; data: unknown }> = [];
	const pi = {
		events: {
			emit(channel: string, data: unknown) {
				busEvents.push({ channel, data });
			},
		},
		on(name: string, handler: (event: unknown, ctx: any) => unknown) {
			handlers.set(name, handler);
		},
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
		appendEntry(customType: string, data: unknown) {
			appended.push({ type: "custom", customType, data });
		},
	};
	const ctx = {
		hasUI: true,
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => appended,
		},
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
	};
	dbzCrewEventsExtension(pi as any, { homeDirectory });
	return { handlers, sent, appended, notifications, busEvents, ctx };
}

async function writeEvent(
	stateRoot: string,
	sessionId: string,
	id: string,
	message?: string,
): Promise<string> {
	const directory = completionEventDirectory(stateRoot, sessionId);
	const result = resolve(stateRoot, "results", stableDigest("pane"), `${id}.md`);
	await mkdir(dirname(result), { recursive: true });
	await writeFile(result, "DBZ-CREW RESULT: done\n");
	await mkdir(directory, { recursive: true });
	const path = resolve(directory, `${id}.json`);
	await writeFile(
		path,
		JSON.stringify({
			id,
			principal_session_id: sessionId,
			task_id: "worker-one",
			phase: "implementation",
			status: "done",
			result,
			created_at: Date.now(),
			...(message ? { message } : {}),
		}),
	);
	return path;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for event delivery");
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
	}
}

async function withRuntime(
	run: (stateRoot: string, homeDirectory: string) => Promise<void>,
): Promise<void> {
	const homeDirectory = await mkdtemp(resolve(tmpdir(), "dbz-crew-events-test-"));
	const stateRoot = resolveStateRoot(homeDirectory);
	await mkdir(resolve(homeDirectory, ".local"), { mode: 0o700 });
	await mkdir(resolve(homeDirectory, ".local", "state"), { mode: 0o700 });
	const previous = {
		state: process.env.DBZ_CREW_STATE_DIR,
		xdg: process.env.XDG_STATE_HOME,
		herdr: process.env.HERDR_ENV,
		socket: process.env.HERDR_SOCKET_PATH,
		pane: process.env.HERDR_PANE_ID,
		poll: process.env.DBZ_CREW_EVENT_POLL_MS,
	};
	process.env.DBZ_CREW_STATE_DIR = resolve(homeDirectory, "ignored-state");
	process.env.XDG_STATE_HOME = resolve(homeDirectory, "ignored-xdg");
	process.env.HERDR_ENV = "1";
	process.env.HERDR_SOCKET_PATH = "/tmp/fake-herdr.sock";
	process.env.HERDR_PANE_ID = "pane:test";
	process.env.DBZ_CREW_EVENT_POLL_MS = "10";
	try {
		await run(stateRoot, homeDirectory);
	} finally {
		for (const [key, value] of Object.entries({
			DBZ_CREW_STATE_DIR: previous.state,
			XDG_STATE_HOME: previous.xdg,
			HERDR_ENV: previous.herdr,
			HERDR_SOCKET_PATH: previous.socket,
			HERDR_PANE_ID: previous.pane,
			DBZ_CREW_EVENT_POLL_MS: previous.poll,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(homeDirectory, { recursive: true, force: true });
	}
}

test("uses the literal account state path without environment overrides", () => {
	const previousState = process.env.DBZ_CREW_STATE_DIR;
	const previousXdg = process.env.XDG_STATE_HOME;
	process.env.DBZ_CREW_STATE_DIR = "/tmp/ignored-state";
	process.env.XDG_STATE_HOME = "/tmp/ignored-xdg";
	try {
		assert.equal(resolveStateRoot("/home/example"), "/home/example/.local/state/dbz-crew");
		assert.equal(resolveStateRoot(), resolve(userInfo().homedir, ".local", "state", "dbz-crew"));
	} finally {
		if (previousState === undefined) delete process.env.DBZ_CREW_STATE_DIR;
		else process.env.DBZ_CREW_STATE_DIR = previousState;
		if (previousXdg === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = previousXdg;
	}
});

test("validates result paths inside the private state root", () => {
	const root = "/tmp/dbz-state";
	const base = {
		id: "event-1",
		principal_session_id: "session-1",
		task_id: "worker-one",
		phase: "implementation",
		status: "done",
		created_at: 1,
	};
	assert.ok(
		validateCompletionEvent(
			{ ...base, result: "/tmp/dbz-state/results/pane/result.md" },
			"session-1",
			root,
		),
	);
	assert.equal(
		validateCompletionEvent({ ...base, result: "/tmp/result.md" }, "session-1", root),
		undefined,
	);
});

test("recovers a pending event and always delivers it as a follow-up", { concurrency: false }, async () => {
	await withRuntime(async (stateRoot, homeDirectory) => {
		const sessionId = "session-recovery";
		await writeEvent(
			stateRoot,
			sessionId,
			"event-recovery",
			"DBZ-CREW EVENT: read-only worker worker-one implementation is done.",
		);
		const harness = makeHarness(sessionId, [], homeDirectory);
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		const readyPath = resolve(stateRoot, "principals", `${stableDigest(sessionId)}.json`);
		const ready = JSON.parse(await readFile(readyPath, "utf8")) as { session_id?: unknown; pid?: unknown };
		assert.equal(ready.session_id, sessionId);
		assert.equal(ready.pid, process.pid);
		await waitFor(() => harness.sent.length === 1);
		assert.deepEqual(harness.sent[0]?.options, { deliverAs: "followUp", triggerTurn: true });
		assert.match(harness.sent[0]?.message.content, /read-only worker worker-one implementation is done/u);
		assert.equal(harness.busEvents.length, 1);
		assert.equal(harness.busEvents[0]?.channel, CREW_COMPLETION_EVENT_CHANNEL);
		assert.equal((harness.busEvents[0]?.data as { id?: unknown }).id, "event-recovery");
		assert.equal(harness.appended.at(-1)?.customType, "dbz-crew-event-delivered");
		await harness.handlers.get("session_shutdown")?.({}, harness.ctx);
		await assert.rejects(readFile(readyPath, "utf8"), /ENOENT/u);
	});
});

test("does not deliver an event owned by another Pi session", { concurrency: false }, async () => {
	await withRuntime(async (stateRoot, homeDirectory) => {
		await writeEvent(stateRoot, "session-other", "event-other");
		const harness = makeHarness("session-current", [], homeDirectory);
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
		assert.equal(harness.sent.length, 0);
		await harness.handlers.get("session_shutdown")?.({}, harness.ctx);
	});
});

test("removes an already delivered pending event without redelivery", { concurrency: false }, async () => {
	await withRuntime(async (stateRoot, homeDirectory) => {
		const sessionId = "session-idempotent";
		const eventPath = await writeEvent(stateRoot, sessionId, "event-idempotent");
		const harness = makeHarness(sessionId, [
			{ type: "custom", customType: "dbz-crew-event-delivered", data: { id: "event-idempotent" } },
		], homeDirectory);
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		await waitFor(async () => {
			try {
				await readFile(eventPath);
				return false;
			} catch {
				return true;
			}
		});
		assert.equal(harness.sent.length, 0);
		await harness.handlers.get("session_shutdown")?.({}, harness.ctx);
	});
});

test("repairs safe state-root permissions", { concurrency: false }, async () => {
	await withRuntime(async (stateRoot, homeDirectory) => {
		await mkdir(stateRoot, { recursive: true });
		await chmod(stateRoot, 0o755);
		const harness = makeHarness("session-permissions", [], homeDirectory);
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		assert.equal((await stat(stateRoot)).mode & 0o777, 0o700);
		await harness.handlers.get("session_shutdown")?.({}, harness.ctx);
	});
});

test("disables delivery for a symlinked state root without altering its target", { concurrency: false }, async () => {
	await withRuntime(async (stateRoot, homeDirectory) => {
		await mkdir(dirname(stateRoot), { recursive: true });
		const target = resolve(homeDirectory, "unexpected-target");
		await mkdir(target, { mode: 0o755 });
		await chmod(target, 0o755);
		await symlink(target, stateRoot, "dir");
		const harness = makeHarness("session-symlink", [], homeDirectory);
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		assert.equal(harness.sent.length, 0);
		assert.match(harness.notifications.at(-1)?.message ?? "", /symbolic link/u);
		assert.equal((await stat(target)).mode & 0o777, 0o755);
	});
});

test("rejects a repository-local state root before creating it", { concurrency: false }, async () => {
	await withRuntime(async (stateRoot, homeDirectory) => {
		await mkdir(resolve(homeDirectory, ".git"));
		const harness = makeHarness("session-repository", [], homeDirectory);
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		assert.match(harness.notifications.at(-1)?.message ?? "", /inside a Git worktree/u);
		await assert.rejects(stat(stateRoot), /ENOENT/u);
	});
});

test("rejects a completion result symlink without reading its target", { concurrency: false }, async () => {
	await withRuntime(async (stateRoot, homeDirectory) => {
		const sessionId = "session-result-symlink";
		const eventId = "event-result-symlink";
		await writeEvent(stateRoot, sessionId, eventId);
		const resultPath = resolve(stateRoot, "results", stableDigest("pane"), `${eventId}.md`);
		const external = resolve(homeDirectory, "external-result.md");
		await writeFile(external, "preserve\n");
		await rm(resultPath);
		await symlink(external, resultPath);

		const harness = makeHarness(sessionId, [], homeDirectory);
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		await waitFor(() => harness.notifications.some(({ message }) => /invalid completion event/u.test(message)));
		assert.equal(harness.sent.length, 0);
		assert.equal(await readFile(external, "utf8"), "preserve\n");
		await harness.handlers.get("session_shutdown")?.({}, harness.ctx);
	});
});
