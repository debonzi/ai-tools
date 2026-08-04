import { createHash, randomUUID } from "node:crypto";
import {
	constants,
	lstat,
	mkdir,
	open,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, win32 } from "node:path";
import {
	AtomicWriteError,
	ERROR_CODES,
	LockError,
	PathBoundaryError,
	RevisionConflictError,
	ValidationError,
} from "./errors.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function assertStringPath(value, name) {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
		throw new PathBoundaryError(`${name} must be a non-empty path without NUL bytes.`, {
			code: ERROR_CODES.INVALID_PATH,
		});
	}
}

function assertAbsolutePath(value, name) {
	assertStringPath(value, name);
	if (!isAbsolute(value)) {
		throw new PathBoundaryError(`${name} must be absolute.`, {
			code: ERROR_CODES.INVALID_PATH,
			details: { [name]: value },
		});
	}
}

export function validateRelativePath(relativePath) {
	assertStringPath(relativePath, "relative_path");
	if (isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
		throw new PathBoundaryError("A path relative to a storage root must not be absolute.", {
			code: ERROR_CODES.INVALID_PATH,
			details: { relative_path: relativePath },
		});
	}
	const parts = relativePath.split(/[\\/]/u);
	if (parts.some((part) => part === ".." || part === "." || part.length === 0)) {
		throw new PathBoundaryError("Relative paths must not contain traversal or empty segments.", {
			code: ERROR_CODES.INVALID_PATH,
			details: { relative_path: relativePath },
		});
	}
	return relativePath;
}

export function isPathWithinRoot(root, candidate, { allowRoot = false } = {}) {
	assertAbsolutePath(root, "root");
	assertAbsolutePath(candidate, "candidate");
	const rootPath = resolve(root);
	const candidatePath = resolve(candidate);
	const difference = relative(rootPath, candidatePath);
	if (difference === "") return allowRoot;
	return difference !== ".." && !difference.startsWith(`..${win32.sep}`) && !difference.startsWith("../") && !isAbsolute(difference);
}

export function assertPathWithinRoot(root, candidate, options = {}) {
	if (!isPathWithinRoot(root, candidate, options)) {
		throw new PathBoundaryError("Resolved path escapes the intended root.", {
			details: { root: resolve(root), candidate: resolve(candidate) },
		});
	}
	return resolve(candidate);
}

export function resolveWithinRoot(root, relativePath, { allowRoot = false } = {}) {
	assertAbsolutePath(root, "root");
	validateRelativePath(relativePath);
	const candidate = resolve(root, relativePath);
	return assertPathWithinRoot(root, candidate, { allowRoot });
}

export async function assertRealPathWithinRoot(root, candidate, options = {}) {
	assertAbsolutePath(root, "root");
	assertAbsolutePath(candidate, "candidate");
	const [effectiveRoot, effectiveCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
	assertPathWithinRoot(effectiveRoot, effectiveCandidate, options);
	return effectiveCandidate;
}

export async function assertMutationPathWithinRoot(root, candidate) {
	assertAbsolutePath(root, "root");
	assertAbsolutePath(candidate, "candidate");
	assertPathWithinRoot(root, candidate);
	const [effectiveRoot, effectiveParent] = await Promise.all([realpath(root), realpath(dirname(candidate))]);
	assertPathWithinRoot(effectiveRoot, effectiveParent, { allowRoot: true });
	try {
		const target = await lstat(candidate);
		if (target.isSymbolicLink()) {
			throw new PathBoundaryError("Mutation target must not be a symbolic link.", {
				code: ERROR_CODES.UNSAFE_FILESYSTEM_ENTRY,
				details: { candidate },
			});
		}
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	return candidate;
}

export function sha256Hex(value) {
	if (typeof value !== "string" && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) {
		throw new ValidationError("A SHA-256 input must be a string, Buffer, or byte array.");
	}
	const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
	return createHash("sha256").update(bytes).digest("hex");
}

export function normalizeMarkdownBody(body) {
	if (typeof body !== "string") throw new ValidationError("Markdown body must be a string.");
	return `${body.replace(/\r\n?/gu, "\n").replace(/\n*$/u, "")}\n`;
}

export function markdownBodySha256(body) {
	return sha256Hex(normalizeMarkdownBody(body));
}

function unsafeEntry(path, kind) {
	return new PathBoundaryError(`Expected '${path}' to be ${kind}.`, {
		code: ERROR_CODES.UNSAFE_FILESYSTEM_ENTRY,
		details: { path, expected: kind },
	});
}

async function readRegularFileSnapshot(path, { includeData = true } = {}) {
	let pathStat;
	try {
		pathStat = await lstat(path);
	} catch (error) {
		if (error?.code === "ENOENT") return { exists: false, digest: null };
		throw error;
	}
	if (pathStat.isSymbolicLink()) throw unsafeEntry(path, "a regular file, not a symbolic link");
	if (!pathStat.isFile()) throw unsafeEntry(path, "a regular file");

	const noFollow = constants.O_NOFOLLOW ?? 0;
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | noFollow);
		const openedStat = await handle.stat();
		if (!openedStat.isFile()) throw unsafeEntry(path, "a regular file");
		if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
			throw new RevisionConflictError(`File '${path}' changed while it was being inspected.`, {
				details: { path },
			});
		}
		const data = await handle.readFile();
		const currentStat = await lstat(path);
		if (
			currentStat.isSymbolicLink() ||
			currentStat.dev !== openedStat.dev ||
			currentStat.ino !== openedStat.ino
		) {
			throw new RevisionConflictError(`File '${path}' changed while it was being inspected.`, {
				details: { path },
			});
		}
		return {
			exists: true,
			digest: sha256Hex(data),
			mode: openedStat.mode & 0o777,
			...(includeData ? { data } : {}),
		};
	} catch (error) {
		if (error?.code === "ELOOP") throw unsafeEntry(path, "a regular file, not a symbolic link");
		throw error;
	} finally {
		await handle?.close();
	}
}

export async function readFileWithDigest(path, { encoding = null } = {}) {
	assertAbsolutePath(path, "path");
	const snapshot = await readRegularFileSnapshot(path);
	if (!snapshot.exists) {
		const error = new Error(`File '${path}' does not exist.`);
		error.code = "ENOENT";
		throw error;
	}
	return {
		digest: snapshot.digest,
		mode: snapshot.mode,
		data: encoding === null ? snapshot.data : snapshot.data.toString(encoding),
	};
}

function normalizeExpectedDigest(expectedDigest) {
	if (expectedDigest === null || expectedDigest === undefined) return expectedDigest;
	if (typeof expectedDigest !== "string" || !SHA256_PATTERN.test(expectedDigest)) {
		throw new ValidationError("expectedDigest must be null or a lowercase SHA-256 digest.");
	}
	return expectedDigest;
}

function assertExpectedRevision(path, snapshot, expectedDigest) {
	if (expectedDigest === null) {
		if (snapshot.exists) {
			throw new RevisionConflictError(`File '${path}' already exists; creation revision is stale.`, {
				details: { path, expected_digest: null, actual_digest: snapshot.digest },
			});
		}
		return;
	}
	if (expectedDigest === undefined) {
		if (snapshot.exists) {
			throw new RevisionConflictError(
				`An expected digest is required before replacing existing file '${path}'.`,
				{ details: { path, actual_digest: snapshot.digest } },
			);
		}
		return;
	}
	if (!snapshot.exists || snapshot.digest !== expectedDigest) {
		throw new RevisionConflictError(`File '${path}' does not match the expected revision.`, {
			details: {
				path,
				expected_digest: expectedDigest,
				actual_digest: snapshot.digest,
			},
		});
	}
}

function asBytes(value) {
	if (typeof value === "string") return Buffer.from(value, "utf8");
	if (Buffer.isBuffer(value)) return value;
	if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	if (value instanceof ArrayBuffer) return Buffer.from(value);
	throw new ValidationError("Atomic write content must be a string, Buffer, or byte array.");
}

async function syncDirectory(directory) {
	let handle;
	try {
		handle = await open(directory, constants.O_RDONLY);
		await handle.sync();
	} catch (error) {
		if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error?.code)) throw error;
	} finally {
		await handle?.close();
	}
}

export async function atomicWriteFile(
	path,
	content,
	{
		expectedDigest,
		mode,
		root,
		beforeCommit,
	} = {},
) {
	assertAbsolutePath(path, "path");
	if (root !== undefined) await assertMutationPathWithinRoot(root, path);
	if (mode !== undefined && (!Number.isInteger(mode) || mode < 0 || mode > 0o777)) {
		throw new ValidationError("Atomic write mode must be an integer between 0000 and 0777.");
	}
	if (beforeCommit !== undefined && typeof beforeCommit !== "function") {
		throw new ValidationError("beforeCommit must be a function when provided.");
	}
	const normalizedExpectedDigest = normalizeExpectedDigest(expectedDigest);
	const initial = await readRegularFileSnapshot(path, { includeData: false });
	assertExpectedRevision(path, initial, normalizedExpectedDigest);

	const bytes = asBytes(content);
	const directory = dirname(path);
	const temporaryPath = resolve(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let temporaryHandle;
	let renamed = false;
	try {
		const targetMode = mode ?? initial.mode ?? 0o600;
		temporaryHandle = await open(
			temporaryPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
			targetMode,
		);
		await temporaryHandle.writeFile(bytes);
		await temporaryHandle.sync();
		await temporaryHandle.close();
		temporaryHandle = undefined;

		if (beforeCommit) await beforeCommit({ path, temporaryPath });
		const current = await readRegularFileSnapshot(path, { includeData: false });
		if (current.exists !== initial.exists || current.digest !== initial.digest) {
			throw new RevisionConflictError(`File '${path}' changed before the atomic replacement.`, {
				details: {
					path,
					initial_digest: initial.digest,
					actual_digest: current.digest,
				},
			});
		}
		await rename(temporaryPath, path);
		renamed = true;
		await syncDirectory(directory);
		return {
			created: !initial.exists,
			previousDigest: initial.digest,
			digest: sha256Hex(bytes),
		};
	} catch (error) {
		if (error instanceof RevisionConflictError || error instanceof ValidationError) throw error;
		if (renamed) {
			throw new AtomicWriteError(
				`Atomic replacement for '${path}' committed, but its directory could not be synchronized.`,
				{ details: { path, committed: true }, cause: error },
			);
		}
		throw new AtomicWriteError(`Atomic write failed for '${path}'; the destination was not replaced.`, {
			details: { path, committed: false },
			cause: error,
		});
	} finally {
		await temporaryHandle?.close();
		if (!renamed) await rm(temporaryPath, { force: true });
	}
}

function delay(milliseconds, signal) {
	return new Promise((resolvePromise, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("Lock acquisition was aborted."));
			return;
		}
		let abort;
		const timer = setTimeout(() => {
			if (abort) signal.removeEventListener("abort", abort);
			resolvePromise();
		}, milliseconds);
		if (signal) {
			abort = () => {
				clearTimeout(timer);
				reject(signal.reason ?? new Error("Lock acquisition was aborted."));
			};
			signal.addEventListener("abort", abort, { once: true });
		}
	});
}

async function assertExistingLockIsSafe(lockPath) {
	const entry = await lstat(lockPath);
	if (entry.isSymbolicLink() || !entry.isDirectory()) {
		throw new LockError(`Lock path '${lockPath}' is not a safe lock directory.`, {
			details: { lock_path: lockPath },
		});
	}
}

export async function acquireLocalMutationLock(
	lockPath,
	{ timeoutMs = 10_000, pollIntervalMs = 25, signal } = {},
) {
	assertAbsolutePath(lockPath, "lock_path");
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
		throw new ValidationError("Lock timeoutMs must be a non-negative integer.");
	}
	if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
		throw new ValidationError("Lock pollIntervalMs must be a positive integer.");
	}
	const startedAt = Date.now();
	const token = randomUUID();
	while (true) {
		if (signal?.aborted) throw signal.reason ?? new Error("Lock acquisition was aborted.");
		try {
			await mkdir(lockPath, { mode: 0o700 });
			try {
				await writeFile(
					resolve(lockPath, "owner.json"),
					`${JSON.stringify({ pid: process.pid, hostname: hostname(), token, acquired_at: new Date().toISOString() })}\n`,
					{ encoding: "utf8", flag: "wx", mode: 0o600 },
				);
			} catch (error) {
				await rm(lockPath, { recursive: true, force: true });
				throw error;
			}
			let released = false;
			return async function release() {
				if (released) return;
				released = true;
				let owner;
				try {
					const ownerSnapshot = await readRegularFileSnapshot(resolve(lockPath, "owner.json"));
					if (!ownerSnapshot.exists) throw new Error("Lock owner metadata is missing.");
					owner = JSON.parse(ownerSnapshot.data.toString("utf8"));
				} catch (error) {
					throw new LockError(`Cannot verify ownership before releasing lock '${lockPath}'.`, {
						details: { lock_path: lockPath },
						cause: error,
					});
				}
				if (owner?.token !== token) {
					throw new LockError(`Lock '${lockPath}' is owned by another process.`, {
						details: { lock_path: lockPath },
					});
				}
				const releasedPath = `${lockPath}.released-${token}`;
				try {
					await rename(lockPath, releasedPath);
					await rm(releasedPath, { recursive: true, force: true });
				} catch (error) {
					throw new LockError(`Failed to release mutation lock '${lockPath}'.`, {
						details: { lock_path: lockPath },
						cause: error,
					});
				}
			};
		} catch (error) {
			if (error?.code !== "EEXIST") {
				if (error instanceof LockError) throw error;
				throw new LockError(`Failed to acquire mutation lock '${lockPath}'.`, {
					details: { lock_path: lockPath },
					cause: error,
				});
			}
			try {
				await assertExistingLockIsSafe(lockPath);
			} catch (inspectionError) {
				if (inspectionError?.code === "ENOENT") continue;
				throw inspectionError;
			}
			if (Date.now() - startedAt >= timeoutMs) {
				throw new LockError(`Timed out waiting for mutation lock '${lockPath}'.`, {
					code: ERROR_CODES.LOCK_TIMEOUT,
					details: { lock_path: lockPath, timeout_ms: timeoutMs },
				});
			}
			await delay(Math.min(pollIntervalMs, Math.max(1, timeoutMs - (Date.now() - startedAt))), signal);
		}
	}
}

export async function withLocalMutationLock(lockPath, callback, options = {}) {
	if (typeof callback !== "function") throw new ValidationError("Lock callback must be a function.");
	const release = await acquireLocalMutationLock(lockPath, options);
	try {
		return await callback();
	} finally {
		await release();
	}
}

export async function mutateFileAtomically(
	path,
	mutator,
	{ lockPath, expectedDigest, encoding = "utf8", ...writeOptions } = {},
) {
	if (typeof mutator !== "function") throw new ValidationError("File mutator must be a function.");
	assertAbsolutePath(lockPath, "lock_path");
	return withLocalMutationLock(lockPath, async () => {
		const current = await readFileWithDigest(path, { encoding });
		const normalizedExpected = normalizeExpectedDigest(expectedDigest);
		assertExpectedRevision(path, { exists: true, digest: current.digest }, normalizedExpected);
		const replacement = await mutator(current.data, { digest: current.digest });
		return atomicWriteFile(path, replacement, {
			...writeOptions,
			expectedDigest: current.digest,
		});
	});
}
