import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
	GitCommandError,
	GitIdentityError,
	ValidationError,
} from "./errors.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;
const DEFAULT_MAX_OUTPUT_LINES = 2_000;
const OBJECT_ID_LENGTHS = Object.freeze({ sha1: 40, sha256: 64 });

function assertNonEmptyString(value, name) {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
		throw new ValidationError(`${name} must be a non-empty string without NUL bytes.`);
	}
}

function validateOutputBound(name, value) {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new ValidationError(`${name} must be a positive integer.`);
	}
}

function outputLineCount(output) {
	if (output.length === 0) return 0;
	let lines = 1;
	for (const character of output) {
		if (character === "\n") lines += 1;
	}
	return output.endsWith("\n") ? lines - 1 : lines;
}

function assertBoundedOutput(output, maxOutputLines, stream) {
	const lines = outputLineCount(output);
	if (lines > maxOutputLines) {
		throw new GitCommandError(`Git ${stream} exceeded the output limit of ${maxOutputLines} lines.`, {
			details: { stream, lines, max_lines: maxOutputLines },
		});
	}
}

function commandFailure(args, cwd, error) {
	const exitCode = Number.isInteger(error?.code) ? error.code : null;
	const standardError = typeof error?.stderr === "string" ? error.stderr.trim() : "";
	const reason = standardError.split("\n", 1)[0];
	return new GitCommandError(
		reason.length > 0 ? `Git command failed: ${reason}` : "Git command failed without a diagnostic.",
		{
			details: {
				cwd,
				args: [...args],
				exit_code: exitCode,
				...(typeof error?.code === "string" ? { process_code: error.code } : {}),
			},
			cause: error instanceof Error ? error : undefined,
		},
	);
}

export async function runGit(
	args,
	{
		cwd = process.cwd(),
		gitBinary = "git",
		env,
		allowNonZero = false,
		maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
		maxOutputLines = DEFAULT_MAX_OUTPUT_LINES,
	} = {},
) {
	if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
		throw new ValidationError("Git arguments must be an array of strings without NUL bytes.");
	}
	assertNonEmptyString(cwd, "cwd");
	assertNonEmptyString(gitBinary, "gitBinary");
	validateOutputBound("maxOutputBytes", maxOutputBytes);
	validateOutputBound("maxOutputLines", maxOutputLines);
	if (env !== undefined && (env === null || typeof env !== "object" || Array.isArray(env))) {
		throw new ValidationError("Git environment overrides must be an object when provided.");
	}

	const options = {
		cwd,
		encoding: "utf8",
		maxBuffer: maxOutputBytes,
		env: {
			...process.env,
			...env,
			GIT_TERMINAL_PROMPT: "0",
			LC_ALL: "C",
		},
		windowsHide: true,
	};
	try {
		const { stdout = "", stderr = "" } = await execFileAsync(gitBinary, args, options);
		assertBoundedOutput(stdout, maxOutputLines, "stdout");
		assertBoundedOutput(stderr, maxOutputLines, "stderr");
		return { exitCode: 0, stdout, stderr };
	} catch (error) {
		const stdout = typeof error?.stdout === "string" ? error.stdout : "";
		const stderr = typeof error?.stderr === "string" ? error.stderr : "";
		assertBoundedOutput(stdout, maxOutputLines, "stdout");
		assertBoundedOutput(stderr, maxOutputLines, "stderr");
		if (allowNonZero && Number.isInteger(error?.code)) {
			return { exitCode: error.code, stdout, stderr };
		}
		throw commandFailure(args, cwd, error);
	}
}

function oneLine(output, description) {
	const value = output.replace(/\r?\n$/u, "");
	if (value.length === 0 || value.includes("\n") || value.includes("\r") || value.includes("\0")) {
		throw new GitIdentityError(`Git returned an invalid ${description}.`, {
			details: { description },
		});
	}
	return value;
}

export function validateObjectId(objectFormat, objectId, { name = "object ID" } = {}) {
	const length = OBJECT_ID_LENGTHS[objectFormat];
	if (length === undefined) {
		throw new GitIdentityError(`Git object format '${String(objectFormat)}' is not supported.`, {
			details: { object_format: objectFormat, supported_formats: Object.keys(OBJECT_ID_LENGTHS) },
		});
	}
	if (typeof objectId !== "string" || !new RegExp(`^[0-9a-f]{${length}}$`, "u").test(objectId)) {
		throw new GitIdentityError(`${name} must be a full ${objectFormat} object ID.`, {
			details: { object_format: objectFormat, expected_length: length },
		});
	}
	return objectId;
}

export function deriveProjectKey(objectFormat, rootCommit) {
	validateObjectId(objectFormat, rootCommit, { name: "Root commit" });
	return `git-${objectFormat}-${rootCommit}`;
}

export function parseProjectKey(projectKey) {
	if (typeof projectKey !== "string") {
		throw new GitIdentityError("Project key must be a string.");
	}
	const match = /^git-(sha1|sha256)-([0-9a-f]+)$/u.exec(projectKey);
	if (!match) {
		throw new GitIdentityError("Project key must use 'git-<object-format>-<full-root-commit-oid>'.", {
			details: { project_key: projectKey },
		});
	}
	validateObjectId(match[1], match[2], { name: "Project-key root commit" });
	return { objectFormat: match[1], rootCommit: match[2], projectKey };
}

function unsupportedRepository(message, details) {
	return new GitIdentityError(message, { details });
}

export async function inspectGitProject(
	startPath = process.cwd(),
	{ runGitCommand = runGit, gitBinary, env } = {},
) {
	assertNonEmptyString(startPath, "startPath");
	if (typeof runGitCommand !== "function") {
		throw new ValidationError("runGitCommand must be a function.");
	}
	const cwd = resolve(startPath);
	const gitOptions = {
		cwd,
		...(gitBinary === undefined ? {} : { gitBinary }),
		...(env === undefined ? {} : { env }),
	};

	let worktreeCheck;
	try {
		worktreeCheck = await runGitCommand(["rev-parse", "--is-inside-work-tree"], {
			...gitOptions,
			allowNonZero: true,
		});
	} catch (error) {
		if (error instanceof GitCommandError && error.details?.process_code === "ENOENT") {
			throw unsupportedRepository("DBZ Workflows requires Git, but the Git executable was not found.", {
				start_path: cwd,
			});
		}
		throw error;
	}
	if (worktreeCheck.exitCode !== 0 || worktreeCheck.stdout.trim() !== "true") {
		throw unsupportedRepository("DBZ Workflows requires a Git worktree; the current path is not inside one.", {
			start_path: cwd,
		});
	}

	const projectRootResult = await runGitCommand(["rev-parse", "--show-toplevel"], gitOptions);
	const projectRoot = resolve(oneLine(projectRootResult.stdout, "worktree root"));
	const objectFormatResult = await runGitCommand(["rev-parse", "--show-object-format"], gitOptions);
	const objectFormat = oneLine(objectFormatResult.stdout, "object format");
	if (OBJECT_ID_LENGTHS[objectFormat] === undefined) {
		throw unsupportedRepository(`Git object format '${objectFormat}' is not supported by DBZ Workflows.`, {
			object_format: objectFormat,
			supported_formats: Object.keys(OBJECT_ID_LENGTHS),
		});
	}

	const shallowResult = await runGitCommand(["rev-parse", "--is-shallow-repository"], gitOptions);
	const shallowValue = oneLine(shallowResult.stdout, "shallow-repository state");
	if (shallowValue !== "true" && shallowValue !== "false") {
		throw unsupportedRepository("Git returned an invalid shallow-repository state.", {
			value: shallowValue,
		});
	}
	if (shallowValue === "true") {
		throw unsupportedRepository(
			"DBZ Workflows does not support shallow repositories. Fetch the complete history (for example, with 'git fetch --unshallow') and try again.",
			{ project_root: projectRoot, shallow: true },
		);
	}

	const headResult = await runGitCommand(["rev-parse", "--verify", "HEAD^{commit}"], {
		...gitOptions,
		allowNonZero: true,
	});
	if (headResult.exitCode !== 0) {
		throw unsupportedRepository(
			"DBZ Workflows requires HEAD to resolve to a commit. Create an initial commit (an empty commit is acceptable) and try again.",
			{ project_root: projectRoot },
		);
	}
	const headCommit = oneLine(headResult.stdout, "HEAD commit");
	validateObjectId(objectFormat, headCommit, { name: "HEAD commit" });

	const rootsResult = await runGitCommand(["rev-list", "--max-parents=0", "HEAD"], gitOptions);
	const rootCommits = rootsResult.stdout.trim().length === 0
		? []
		: rootsResult.stdout.trim().split(/\s+/u);
	for (const rootCommit of rootCommits) {
		validateObjectId(objectFormat, rootCommit, { name: "Reachable root commit" });
	}
	if (rootCommits.length !== 1) {
		throw unsupportedRepository(
			`DBZ Workflows requires exactly one root commit reachable from HEAD; found ${rootCommits.length}.`,
			{ project_root: projectRoot, root_count: rootCommits.length, root_commits: rootCommits },
		);
	}

	const branchResult = await runGitCommand(["symbolic-ref", "--quiet", "--short", "HEAD"], {
		...gitOptions,
		allowNonZero: true,
	});
	if (branchResult.exitCode !== 0 && branchResult.exitCode !== 1) {
		throw new GitCommandError("Git could not determine whether HEAD is detached.", {
			details: { project_root: projectRoot, exit_code: branchResult.exitCode },
		});
	}
	const headRef = branchResult.exitCode === 0 ? oneLine(branchResult.stdout, "HEAD branch") : null;
	const rootCommit = rootCommits[0];
	return {
		projectRoot,
		objectFormat,
		headCommit,
		headRef,
		detached: headRef === null,
		shallow: false,
		rootCommit,
		rootCommits: [rootCommit],
		projectKey: deriveProjectKey(objectFormat, rootCommit),
	};
}
