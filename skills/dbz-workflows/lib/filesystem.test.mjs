import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
	LockError,
	PathBoundaryError,
	RevisionConflictError,
} from "./errors.mjs";
import {
	assertMutationPathWithinRoot,
	atomicWriteFile,
	markdownBodySha256,
	mutateFileAtomically,
	readFileWithDigest,
	resolveWithinRoot,
	sha256Hex,
	withLocalMutationLock,
} from "./filesystem.mjs";

async function withTemporaryDirectory(run) {
	const directory = await mkdtemp(resolve(tmpdir(), "dbz-workflows-foundation-test-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function wait(milliseconds) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

test("rejects absolute paths, traversal, and root-prefix escapes", () => {
	const root = "/tmp/dbz-workflows-root";
	assert.equal(resolveWithinRoot(root, "tickets/T-0001.md"), `${root}/tickets/T-0001.md`);
	for (const candidate of ["../escape.md", "tickets/../escape.md", "./ticket.md", "/tmp/escape.md"]) {
		assert.throws(() => resolveWithinRoot(root, candidate), PathBoundaryError, candidate);
	}
	assert.throws(
		() => resolveWithinRoot(root, ""),
		PathBoundaryError,
	);
});

test("rejects mutation paths whose symlinked parent escapes the root", async () => {
	await withTemporaryDirectory(async (directory) => {
		const root = resolve(directory, "root");
		const outside = resolve(directory, "outside");
		await mkdir(root);
		await mkdir(outside);
		await symlink(outside, resolve(root, "linked"));
		await assert.rejects(
			assertMutationPathWithinRoot(root, resolve(root, "linked", "artifact.md")),
			PathBoundaryError,
		);
	});
});

test("normalizes Markdown bodies before calculating baseline digests", () => {
	const expected = sha256Hex("Line one\nLine two\n");
	assert.equal(markdownBodySha256("Line one\r\nLine two\r\n\r\n"), expected);
	assert.equal(markdownBodySha256("Line one\nLine two"), expected);
	assert.equal(sha256Hex(new TextEncoder().encode("Line one\nLine two\n").buffer), expected);
});

test("creates and replaces regular files atomically with revision guards", async () => {
	await withTemporaryDirectory(async (directory) => {
		const path = resolve(directory, "artifact.md");
		const created = await atomicWriteFile(path, "first\n", { expectedDigest: null, mode: 0o640 });
		assert.equal(created.created, true);
		assert.equal(created.previousDigest, null);
		assert.equal(await readFile(path, "utf8"), "first\n");

		const first = await readFileWithDigest(path, { encoding: "utf8" });
		assert.equal(first.mode, 0o640);
		const updated = await atomicWriteFile(path, "second\n", { expectedDigest: first.digest });
		assert.equal(updated.created, false);
		assert.equal(updated.previousDigest, first.digest);
		assert.equal(await readFile(path, "utf8"), "second\n");

		await assert.rejects(
			atomicWriteFile(path, "stale\n", { expectedDigest: first.digest }),
			RevisionConflictError,
		);
		assert.equal(await readFile(path, "utf8"), "second\n");
	});
});

test("requires an explicit expected revision before overwriting", async () => {
	await withTemporaryDirectory(async (directory) => {
		const path = resolve(directory, "artifact.md");
		await writeFile(path, "original\n");
		await assert.rejects(atomicWriteFile(path, "unexpected\n"), RevisionConflictError);
		assert.equal(await readFile(path, "utf8"), "original\n");
	});
});

test("preserves the original and removes its temporary file when an atomic write fails", async () => {
	await withTemporaryDirectory(async (directory) => {
		const path = resolve(directory, "artifact.md");
		await writeFile(path, "original\n");
		const { digest } = await readFileWithDigest(path);
		await assert.rejects(
			atomicWriteFile(path, "replacement\n", {
				expectedDigest: digest,
				beforeCommit() {
					throw new Error("simulated failure before rename");
				},
			}),
			/simulated failure|Atomic write failed/u,
		);
		assert.equal(await readFile(path, "utf8"), "original\n");
		assert.deepEqual(await readdir(directory), ["artifact.md"]);
	});
});

test("never follows a destination symlink during an atomic write", async () => {
	await withTemporaryDirectory(async (directory) => {
		const outside = resolve(directory, "outside.md");
		const link = resolve(directory, "artifact.md");
		await writeFile(outside, "outside\n");
		await symlink(outside, link);
		await assert.rejects(atomicWriteFile(link, "replacement\n"), PathBoundaryError);
		assert.equal(await readFile(outside, "utf8"), "outside\n");
	});
});

test("serializes concurrent local mutation lock callbacks", async () => {
	await withTemporaryDirectory(async (directory) => {
		const lockPath = resolve(directory, "mutation.lock");
		let active = 0;
		let maximumActive = 0;
		const visits = [];
		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				withLocalMutationLock(lockPath, async () => {
					active += 1;
					maximumActive = Math.max(maximumActive, active);
					await wait(5);
					visits.push(index);
					active -= 1;
				}),
			),
		);
		assert.equal(maximumActive, 1);
		assert.equal(visits.length, 8);
		assert.deepEqual(await readdir(directory), []);
	});
});

test("rejects unsafe and unavailable local lock paths", async () => {
	await withTemporaryDirectory(async (directory) => {
		const target = resolve(directory, "target");
		const unsafeLock = resolve(directory, "unsafe.lock");
		await mkdir(target);
		await symlink(target, unsafeLock);
		await assert.rejects(withLocalMutationLock(unsafeLock, async () => {}), LockError);

		const occupiedLock = resolve(directory, "occupied.lock");
		await mkdir(occupiedLock);
		await assert.rejects(
			withLocalMutationLock(occupiedLock, async () => {}, { timeoutMs: 10, pollIntervalMs: 2 }),
			(error) => error instanceof LockError && error.code === "lock_timeout",
		);
	});
});

test("concurrent mutations serialize and reject a stale expected revision", async () => {
	await withTemporaryDirectory(async (directory) => {
		const path = resolve(directory, "artifact.md");
		const lockPath = resolve(directory, "mutation.lock");
		await atomicWriteFile(path, "initial\n", { expectedDigest: null });
		const { digest } = await readFileWithDigest(path);
		const results = await Promise.allSettled([
			mutateFileAtomically(path, async () => {
				await wait(10);
				return "first\n";
			}, { lockPath, expectedDigest: digest }),
			mutateFileAtomically(path, () => "second\n", { lockPath, expectedDigest: digest }),
		]);

		assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
		const rejected = results.find(({ status }) => status === "rejected");
		assert.ok(rejected.reason instanceof RevisionConflictError);
		assert.match(await readFile(path, "utf8"), /^(first|second)\n$/u);
	});
});
