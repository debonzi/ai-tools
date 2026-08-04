import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { GitIdentityError, ValidationError } from "./errors.mjs";
import {
	deriveProjectKey,
	inspectGitProject,
	parseProjectKey,
	runGit,
} from "./git-identity.mjs";

const execFileAsync = promisify(execFile);
const commitEnvironment = {
	...process.env,
	GIT_AUTHOR_NAME: "DBZ Workflows Test",
	GIT_AUTHOR_EMAIL: "workflows-test@example.invalid",
	GIT_COMMITTER_NAME: "DBZ Workflows Test",
	GIT_COMMITTER_EMAIL: "workflows-test@example.invalid",
};

async function withTemporaryDirectory(run) {
	const directory = await mkdtemp(resolve(tmpdir(), "dbz-workflows-git-identity-test-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function git(cwd, ...args) {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		encoding: "utf8",
		env: commitEnvironment,
	});
	return stdout.trim();
}

async function initializeRepository(parent, name, { objectFormat = "sha1" } = {}) {
	const repository = resolve(parent, name);
	const formatArgument = objectFormat === "sha1" ? [] : [`--object-format=${objectFormat}`];
	await execFileAsync("git", ["init", "--quiet", ...formatArgument, repository], {
		cwd: parent,
		encoding: "utf8",
		env: commitEnvironment,
	});
	return repository;
}

async function commitFile(repository, name, content, message) {
	await writeFile(resolve(repository, name), content);
	await git(repository, "add", "--", name);
	await git(repository, "commit", "--quiet", "-m", message);
	return git(repository, "rev-parse", "HEAD");
}

test("detects a normal Git worktree and derives identity from the full root commit", async () => {
	await withTemporaryDirectory(async (directory) => {
		const repository = await initializeRepository(directory, "project;not-a-shell-command");
		const rootCommit = await commitFile(repository, "one.txt", "one\n", "first");
		const headCommit = await commitFile(repository, "two.txt", "two\n", "second");
		const nested = resolve(repository, "nested", "directory");
		await mkdir(nested, { recursive: true });

		const identity = await inspectGitProject(nested);
		assert.equal(identity.projectRoot, repository);
		assert.equal(identity.objectFormat, "sha1");
		assert.equal(identity.rootCommit, rootCommit);
		assert.equal(identity.headCommit, headCommit);
		assert.equal(identity.projectKey, `git-sha1-${rootCommit}`);
		assert.equal(identity.projectKey.length, "git-sha1-".length + 40);
		assert.equal(identity.shallow, false);
		assert.equal(identity.detached, false);
		assert.ok(identity.headRef.length > 0);
	});
});

test("clones and linked worktrees that retain the root commit share project identity", async () => {
	await withTemporaryDirectory(async (directory) => {
		const source = await initializeRepository(directory, "lineage-source");
		await commitFile(source, "one.txt", "one\n", "first");
		await commitFile(source, "two.txt", "two\n", "second");
		const clone = resolve(directory, "lineage-clone");
		const worktree = resolve(directory, "lineage-worktree");
		await execFileAsync("git", ["clone", "--quiet", pathToFileURL(source).href, clone], {
			cwd: directory,
			encoding: "utf8",
			env: commitEnvironment,
		});
		await git(source, "worktree", "add", "--quiet", "-b", "linked-worktree-test", worktree);

		const identities = await Promise.all([
			inspectGitProject(source),
			inspectGitProject(clone),
			inspectGitProject(worktree),
		]);
		assert.equal(new Set(identities.map(({ projectKey }) => projectKey)).size, 1);
		assert.equal(new Set(identities.map(({ rootCommit }) => rootCommit)).size, 1);
	});
});

test("accepts detached HEAD while retaining the exact commit identity", async () => {
	await withTemporaryDirectory(async (directory) => {
		const repository = await initializeRepository(directory, "detached");
		const commit = await commitFile(repository, "file.txt", "content\n", "initial");
		await git(repository, "checkout", "--quiet", "--detach", commit);

		const identity = await inspectGitProject(repository);
		assert.equal(identity.headCommit, commit);
		assert.equal(identity.rootCommit, commit);
		assert.equal(identity.detached, true);
		assert.equal(identity.headRef, null);
	});
});

test("rejects shallow repositories with an actionable diagnostic", async () => {
	await withTemporaryDirectory(async (directory) => {
		const source = await initializeRepository(directory, "source");
		await commitFile(source, "one.txt", "one\n", "first");
		await commitFile(source, "two.txt", "two\n", "second");
		const shallow = resolve(directory, "shallow");
		await execFileAsync(
			"git",
			["clone", "--quiet", "--depth", "1", pathToFileURL(source).href, shallow],
			{ cwd: directory, encoding: "utf8", env: commitEnvironment },
		);

		await assert.rejects(inspectGitProject(shallow), (error) => {
			assert.ok(error instanceof GitIdentityError);
			assert.equal(error.code, "unsupported_git_repository");
			assert.match(error.message, /does not support shallow repositories/u);
			assert.equal(error.details.shallow, true);
			return true;
		});
	});
});

test("rejects repositories without a commit instead of creating one", async () => {
	await withTemporaryDirectory(async (directory) => {
		const repository = await initializeRepository(directory, "empty");
		await assert.rejects(inspectGitProject(repository), (error) => {
			assert.ok(error instanceof GitIdentityError);
			assert.match(error.message, /requires HEAD to resolve to a commit/u);
			assert.match(error.message, /Create an initial commit/u);
			return true;
		});
		assert.equal(await git(repository, "rev-list", "--all", "--count"), "0");
	});
});

test("rejects non-Git paths explicitly", async () => {
	await withTemporaryDirectory(async (directory) => {
		await assert.rejects(inspectGitProject(directory), (error) => {
			assert.ok(error instanceof GitIdentityError);
			assert.equal(error.code, "unsupported_git_repository");
			assert.match(error.message, /requires a Git worktree/u);
			return true;
		});
	});
});

test("rejects a HEAD with multiple reachable root commits", async () => {
	await withTemporaryDirectory(async (directory) => {
		const repository = await initializeRepository(directory, "multiple-roots");
		const firstRoot = await commitFile(repository, "first.txt", "first\n", "first root");
		await git(repository, "checkout", "--quiet", "--orphan", "unrelated");
		await git(repository, "rm", "--quiet", "-rf", "--ignore-unmatch", ".");
		await commitFile(repository, "second.txt", "second\n", "second root");
		await git(
			repository,
			"merge",
			"--quiet",
			"--no-ff",
			"--allow-unrelated-histories",
			"-m",
			"join roots",
			firstRoot,
		);

		await assert.rejects(inspectGitProject(repository), (error) => {
			assert.ok(error instanceof GitIdentityError);
			assert.match(error.message, /exactly one root commit/u);
			assert.equal(error.details.root_count, 2);
			assert.equal(error.details.root_commits.length, 2);
			return true;
		});
	});
});

test("distinguishes SHA-1 and SHA-256 project keys and never shortens object IDs", async () => {
	await withTemporaryDirectory(async (directory) => {
		const sha1Repository = await initializeRepository(directory, "sha1");
		const sha256Repository = await initializeRepository(directory, "sha256", { objectFormat: "sha256" });
		await commitFile(sha1Repository, "file.txt", "sha1\n", "sha1 root");
		await commitFile(sha256Repository, "file.txt", "sha256\n", "sha256 root");

		const sha1 = await inspectGitProject(sha1Repository);
		const sha256 = await inspectGitProject(sha256Repository);
		assert.equal(sha1.rootCommit.length, 40);
		assert.equal(sha256.rootCommit.length, 64);
		assert.equal(sha1.projectKey, deriveProjectKey("sha1", sha1.rootCommit));
		assert.equal(sha256.projectKey, deriveProjectKey("sha256", sha256.rootCommit));
		assert.deepEqual(parseProjectKey(sha256.projectKey), {
			objectFormat: "sha256",
			rootCommit: sha256.rootCommit,
			projectKey: sha256.projectKey,
		});
		assert.throws(() => deriveProjectKey("sha1", sha1.rootCommit.slice(0, 12)), GitIdentityError);
	});
});

test("Git process execution accepts only argument arrays and does not invoke a shell", async () => {
	await withTemporaryDirectory(async (directory) => {
		const repository = await initializeRepository(directory, "argument safety;exit 99");
		await commitFile(repository, "file.txt", "safe\n", "initial");
		const result = await runGit(["rev-parse", "--show-toplevel"], { cwd: repository });
		assert.equal(result.stdout.trim(), repository);
		await assert.rejects(runGit(["rev-parse\0unsafe"], { cwd: repository }), ValidationError);
	});
});
