import { randomBytes } from "node:crypto";
import { constants as nodeConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { CANONICAL_RESOURCE_IDENTITY, LIMITS, SCHEMA_VERSION } from "../protocol/limits.ts";
import { parseBoundedJson } from "../security/json.ts";
import { stateError } from "../security/errors.ts";

// Linux O_CLOEXEC; Node/libuv also applies close-on-exec when opening descriptors.
const constants = { ...nodeConstants, O_CLOEXEC: 0o2000000 } as const;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const STATE_DIRECTORY = CANONICAL_RESOURCE_IDENTITY.stateDirectory;
const MARKER_STORE = CANONICAL_RESOURCE_IDENTITY.stateMarkerStore;
const MARKER_FILE = "store.json";
const ROOT_DIRECTORIES = [
  "batches",
  "bootstrap",
  "capabilities",
  "claims",
  "deliveries",
  "history",
  "idempotency",
  "leases",
  "locks",
  "progress",
  "snapshots",
  "transactions",
] as const;
const OPTIONAL_ROOT_DIRECTORIES = ["runtime"] as const;
const RUNTIME_DIRECTORIES = ["runtime/sessions", "runtime/workspaces"] as const;
const INTERNAL_DIRECTORIES = [
  "bootstrap/pending",
  "bootstrap/claimed",
  "bootstrap/receipts",
  "capabilities/issued",
  "capabilities/receipts",
  "capabilities/revoked",
  "deliveries/pending",
  "deliveries/claimed",
  "deliveries/delivered",
  "claims/notifications",
  "progress/pending",
  "history/runs",
] as const;

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

interface StoreMarker {
  schemaVersion: typeof SCHEMA_VERSION;
  store: typeof MARKER_STORE;
  storeId: string;
  createdAt: string;
}

interface LockRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  lockId: string;
  pid: number;
  createdAt: number;
  expiresAt: number;
}

export interface SecureStateRootOptions {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export type CanonicalStateInspection = "missing_safe" | "recognized" | "blocked";

interface ProcessMutex {
  locked: boolean;
  waiters: Array<() => void>;
}

const PROCESS_STORE_MUTEXES = new Map<string, ProcessMutex>();

async function acquireProcessStoreMutex(path: string): Promise<() => void> {
  let mutex = PROCESS_STORE_MUTEXES.get(path);
  if (!mutex) {
    mutex = { locked: false, waiters: [] };
    PROCESS_STORE_MUTEXES.set(path, mutex);
  }
  if (mutex.locked) {
    await new Promise<void>((resolveWaiter) => mutex!.waiters.push(resolveWaiter));
  } else {
    mutex.locked = true;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = mutex!.waiters.shift();
    if (next) {
      next();
    } else {
      mutex!.locked = false;
      PROCESS_STORE_MUTEXES.delete(path);
    }
  };
}

function modeBits(mode: number): number {
  return mode & 0o777;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function fileIdentity(value: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}): FileIdentity {
  return { dev: value.dev, ino: value.ino, size: value.size, mtimeMs: value.mtimeMs };
}

function validateRelativePath(value: string): string[] {
  if (!value || isAbsolute(value) || value.includes("\0") || value.includes("\\")) {
    throw stateError("containment_violation");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.length > 255)) {
    throw stateError("containment_violation");
  }
  return parts;
}

function markerIsValid(value: unknown): value is StoreMarker {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return (
    Object.keys(marker).sort().join(",") === "createdAt,schemaVersion,store,storeId" &&
    marker.schemaVersion === SCHEMA_VERSION &&
    marker.store === MARKER_STORE &&
    typeof marker.storeId === "string" &&
    /^[a-f0-9]{32}$/.test(marker.storeId) &&
    typeof marker.createdAt === "string" &&
    !Number.isNaN(Date.parse(marker.createdAt))
  );
}

function lockIsValid(value: unknown): value is LockRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const lock = value as Record<string, unknown>;
  return (
    Object.keys(lock).sort().join(",") === "createdAt,expiresAt,lockId,pid,schemaVersion" &&
    lock.schemaVersion === SCHEMA_VERSION &&
    typeof lock.lockId === "string" &&
    /^[a-f0-9]{32}$/.test(lock.lockId) &&
    Number.isSafeInteger(lock.pid) &&
    (lock.pid as number) > 0 &&
    Number.isFinite(lock.createdAt) &&
    Number.isFinite(lock.expiresAt) &&
    (lock.expiresAt as number) >= (lock.createdAt as number)
  );
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifyDirectory(path: string, uid: number, exactPrivate: boolean): Promise<void> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    throw stateError("unsafe_path", error);
  }
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    before.uid !== uid ||
    (exactPrivate ? modeBits(before.mode) !== DIRECTORY_MODE : (modeBits(before.mode) & 0o022) !== 0)
  ) {
    throw stateError("unsafe_path");
  }

  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
    );
    const after = await handle.stat();
    if (
      !after.isDirectory() ||
      after.uid !== uid ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      (exactPrivate ? modeBits(after.mode) !== DIRECTORY_MODE : (modeBits(after.mode) & 0o022) !== 0)
    ) {
      throw stateError("unsafe_path");
    }
  } catch (error) {
    if (error instanceof Error && error.name === "StateSecurityError") throw error;
    throw stateError("unsafe_path", error);
  } finally {
    await handle?.close();
  }
}

async function verifyRegularFile(path: string, uid: number): Promise<FileIdentity> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (isMissing(error)) throw error;
    throw stateError("unsafe_path", error);
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== uid ||
    before.nlink !== 1 ||
    modeBits(before.mode) !== FILE_MODE
  ) {
    throw stateError("unsafe_path");
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.uid !== uid ||
      after.nlink !== 1 ||
      modeBits(after.mode) !== FILE_MODE ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      throw stateError("unsafe_path");
    }
  } catch (error) {
    if (error instanceof Error && error.name === "StateSecurityError") throw error;
    throw stateError("unsafe_path", error);
  } finally {
    await handle?.close();
  }
  return fileIdentity(before);
}

async function verifyAccountHome(accountHome: string): Promise<number> {
  if (!isAbsolute(accountHome) || resolve(accountHome) !== accountHome) {
    throw stateError("containment_violation");
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw stateError("unsafe_path");
  await verifyDirectory(accountHome, uid, false);
  const canonicalHome = await realpath(accountHome);
  if (canonicalHome !== accountHome) throw stateError("containment_violation");
  return uid;
}

async function verifyRootPath(accountHome: string, rootPath: string, uid: number): Promise<void> {
  await verifyDirectory(accountHome, uid, false);
  await verifyDirectory(rootPath, uid, true);
  const canonical = await realpath(rootPath);
  if (canonical !== rootPath || !canonical.startsWith(`${accountHome}${sep}`)) {
    throw stateError("containment_violation");
  }
}

async function verifyPrivateRelativeDirectory(
  rootPath: string,
  accountHome: string,
  uid: number,
  relativeDirectory: string,
): Promise<void> {
  const parts = validateRelativePath(relativeDirectory);
  await verifyRootPath(accountHome, rootPath, uid);
  let path = rootPath;
  for (const part of parts) {
    path = join(path, part);
    await verifyDirectory(path, uid, true);
  }
}

async function recognizeCanonicalStore(
  rootPath: string,
  accountHome: string,
  uid: number,
): Promise<StoreMarker> {
  const markerPath = join(rootPath, MARKER_FILE);
  let markerValue: unknown;
  try {
    const markerIdentity = await verifyRegularFile(markerPath, uid);
    if (markerIdentity.size > LIMITS.stateMarkerBytes) throw stateError("oversized");
    const markerHandle = await open(
      markerPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
    );
    try {
      const opened = await markerHandle.stat();
      if (
        !opened.isFile() ||
        opened.uid !== uid ||
        opened.nlink !== 1 ||
        modeBits(opened.mode) !== FILE_MODE ||
        !sameIdentity(markerIdentity, fileIdentity(opened))
      ) {
        throw stateError("unsafe_path");
      }
      markerValue = parseBoundedJson(await markerHandle.readFile(), LIMITS.stateMarkerBytes);
    } finally {
      await markerHandle.close();
    }
  } catch (error) {
    if (isMissing(error)) throw stateError("foreign_state", error);
    throw error;
  }
  if (!markerIsValid(markerValue)) throw stateError("foreign_state");

  const requiredRootEntries = new Set<string>([MARKER_FILE, ...ROOT_DIRECTORIES]);
  const allowedRootEntries = new Set<string>([...requiredRootEntries, ...OPTIONAL_ROOT_DIRECTORIES]);
  const existing = await readdir(rootPath);
  if (
    [...requiredRootEntries].some((entry) => !existing.includes(entry)) ||
    existing.some((entry) => !allowedRootEntries.has(entry))
  ) {
    throw stateError("foreign_state");
  }

  for (const directory of ROOT_DIRECTORIES) {
    await verifyPrivateRelativeDirectory(rootPath, accountHome, uid, directory);
  }
  for (const directory of INTERNAL_DIRECTORIES) {
    await verifyPrivateRelativeDirectory(rootPath, accountHome, uid, directory);
  }
  if (existing.includes("runtime")) {
    await verifyPrivateRelativeDirectory(rootPath, accountHome, uid, "runtime");
    const runtimeEntries = await readdir(join(rootPath, "runtime"));
    const allowedRuntimeEntries = new Set(RUNTIME_DIRECTORIES.map((directory) => directory.split("/").at(-1)!));
    if (runtimeEntries.some((entry) => !allowedRuntimeEntries.has(entry))) {
      throw stateError("foreign_state");
    }
    for (const directory of RUNTIME_DIRECTORIES) {
      if (runtimeEntries.includes(directory.split("/").at(-1)!)) {
        await verifyPrivateRelativeDirectory(rootPath, accountHome, uid, directory);
      }
    }
  }
  return markerValue;
}

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class SecureStateRoot {
  readonly path: string;
  readonly storeId: string;

  private readonly uid: number;
  private readonly accountHome: string;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  private constructor(
    path: string,
    accountHome: string,
    uid: number,
    marker: StoreMarker,
    options: SecureStateRootOptions,
  ) {
    this.path = path;
    this.accountHome = accountHome;
    this.uid = uid;
    this.storeId = marker.storeId;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  }

  static defaultPath(): string {
    return join(userInfo().homedir, ".local", "state", STATE_DIRECTORY);
  }

  static async inspectDefault(): Promise<CanonicalStateInspection> {
    return SecureStateRoot.inspectAtAccountHome(userInfo().homedir);
  }

  /** Testable read-only primitive; production callers use inspectDefault and cannot override the canonical root. */
  static async inspectAtAccountHome(accountHome: string): Promise<CanonicalStateInspection> {
    try {
      const uid = await verifyAccountHome(accountHome);
      let parent = accountHome;
      for (const name of [".local", "state"] as const) {
        const child = join(parent, name);
        try {
          await verifyDirectory(child, uid, false);
        } catch (error) {
          if (isMissing((error as ErrorOptions).cause)) return "missing_safe";
          throw error;
        }
        parent = child;
      }

      const rootPath = join(parent, STATE_DIRECTORY);
      try {
        await verifyDirectory(rootPath, uid, true);
      } catch (error) {
        if (isMissing((error as ErrorOptions).cause)) return "missing_safe";
        throw error;
      }
      await recognizeCanonicalStore(rootPath, accountHome, uid);
      return "recognized";
    } catch {
      return "blocked";
    }
  }

  static async openDefault(options: SecureStateRootOptions = {}): Promise<SecureStateRoot> {
    return SecureStateRoot.openAtAccountHome(userInfo().homedir, options);
  }

  /** Testable account-home primitive; production callers use openDefault and cannot override the canonical root. */
  static async openAtAccountHome(
    accountHome: string,
    options: SecureStateRootOptions = {},
  ): Promise<SecureStateRoot> {
    const uid = await verifyAccountHome(accountHome);

    let parent = accountHome;
    for (const name of [".local", "state"] as const) {
      const child = join(parent, name);
      try {
        await verifyDirectory(child, uid, false);
      } catch (error) {
        if (!isMissing((error as ErrorOptions).cause)) throw error;
        try {
          await mkdir(child, { mode: DIRECTORY_MODE });
          await syncDirectory(parent);
        } catch (createError) {
          if (!isExists(createError)) throw stateError("unsafe_path", createError);
        }
        await verifyDirectory(child, uid, false);
      }
      parent = child;
    }

    const rootPath = join(parent, STATE_DIRECTORY);
    let created = false;
    try {
      await verifyDirectory(rootPath, uid, true);
    } catch (error) {
      if (!isMissing((error as ErrorOptions).cause)) throw error;
      try {
        await mkdir(rootPath, { mode: DIRECTORY_MODE });
        created = true;
        await syncDirectory(parent);
      } catch (createError) {
        if (!isExists(createError)) throw stateError("unsafe_path", createError);
      }
      await verifyDirectory(rootPath, uid, true);
    }

    const markerPath = join(rootPath, MARKER_FILE);
    if (created) {
      const marker: StoreMarker = {
        schemaVersion: SCHEMA_VERSION,
        store: MARKER_STORE,
        storeId: randomBytes(16).toString("hex"),
        createdAt: new Date((options.now ?? Date.now)()).toISOString(),
      };
      await SecureStateRoot.writeInitialFile(markerPath, JSON.stringify(marker), uid);
      await syncDirectory(rootPath);

      const root = new SecureStateRoot(rootPath, accountHome, uid, marker, options);
      for (const directory of ROOT_DIRECTORIES) await root.ensurePrivateDirectory(directory);
      for (const directory of INTERNAL_DIRECTORIES) await root.ensurePrivateDirectory(directory);
      return root;
    }

    const marker = await recognizeCanonicalStore(rootPath, accountHome, uid);
    return new SecureStateRoot(rootPath, accountHome, uid, marker, options);
  }

  private static async writeInitialFile(path: string, text: string, uid: number): Promise<void> {
    let handle;
    try {
      handle = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_CLOEXEC,
        FILE_MODE,
      );
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.uid !== uid ||
        opened.nlink !== 1 ||
        modeBits(opened.mode) !== FILE_MODE
      ) {
        throw stateError("unsafe_path");
      }
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } catch (error) {
      if (error instanceof Error && error.name === "StateSecurityError") throw error;
      throw stateError("unsafe_path", error);
    } finally {
      await handle?.close();
    }
  }

  absolutePath(relativePath: string): string {
    const parts = validateRelativePath(relativePath);
    const absolute = join(this.path, ...parts);
    const relation = relative(this.path, absolute);
    if (!relation || relation.startsWith(`..${sep}`) || relation === ".." || isAbsolute(relation)) {
      throw stateError("containment_violation");
    }
    return absolute;
  }

  private async verifyRoot(): Promise<void> {
    await verifyRootPath(this.accountHome, this.path, this.uid);
  }

  async ensurePrivateDirectory(relativePath: string): Promise<void> {
    const parts = validateRelativePath(relativePath);
    await this.verifyRoot();
    let parent = this.path;
    for (const part of parts) {
      const child = join(parent, part);
      try {
        await verifyDirectory(child, this.uid, true);
      } catch (error) {
        if (!isMissing((error as ErrorOptions).cause)) throw error;
        try {
          await mkdir(child, { mode: DIRECTORY_MODE });
          await syncDirectory(parent);
        } catch (createError) {
          if (!isExists(createError)) throw stateError("unsafe_path", createError);
        }
        await verifyDirectory(child, this.uid, true);
      }
      parent = child;
    }
  }

  private async verifyParent(relativePath: string): Promise<string> {
    const parts = validateRelativePath(relativePath);
    await this.verifyRoot();
    let parent = this.path;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      await verifyDirectory(parent, this.uid, true);
    }
    return join(parent, parts.at(-1)!);
  }

  async fileExists(relativePath: string): Promise<boolean> {
    const path = await this.verifyParent(relativePath);
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw stateError("unsafe_path", error);
    }
  }

  async verifyPrivateDirectory(relativeDirectory: string): Promise<void> {
    await verifyPrivateRelativeDirectory(this.path, this.accountHome, this.uid, relativeDirectory);
  }

  async listFiles(relativeDirectory: string, maximum = LIMITS.stateDirectoryEntries): Promise<string[]> {
    await this.verifyPrivateDirectory(relativeDirectory);
    const path = this.absolutePath(relativeDirectory);
    const entries = await readdir(path);
    if (entries.length > maximum) throw stateError("oversized");
    if (entries.some((entry) => !entry || entry.includes("/") || entry.includes("\0"))) {
      throw stateError("unsafe_path");
    }
    return entries.sort();
  }

  async readPrivateFile(relativePath: string, maximumBytes: number): Promise<Buffer> {
    const path = await this.verifyParent(relativePath);
    let before: FileIdentity;
    try {
      before = await verifyRegularFile(path, this.uid);
    } catch (error) {
      if (isMissing(error)) throw stateError("not_found", error);
      throw error;
    }
    if (before.size > maximumBytes) throw stateError("oversized");

    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
    try {
      const openedStat = await handle.stat();
      const opened = fileIdentity(openedStat);
      if (
        !openedStat.isFile() ||
        openedStat.uid !== this.uid ||
        openedStat.nlink !== 1 ||
        modeBits(openedStat.mode) !== FILE_MODE ||
        !sameIdentity(before, opened)
      ) {
        throw stateError("unsafe_path");
      }
      const value = await handle.readFile();
      const afterStat = await handle.stat();
      const after = fileIdentity(afterStat);
      if (
        value.byteLength > maximumBytes ||
        !afterStat.isFile() ||
        afterStat.uid !== this.uid ||
        afterStat.nlink !== 1 ||
        modeBits(afterStat.mode) !== FILE_MODE ||
        !sameIdentity(opened, after) ||
        opened.size !== after.size ||
        opened.mtimeMs !== after.mtimeMs
      ) {
        throw stateError(value.byteLength > maximumBytes ? "oversized" : "unsafe_path");
      }
      return value;
    } finally {
      await handle.close();
    }
  }

  async readPrivateJson(relativePath: string, maximumBytes: number): Promise<unknown> {
    return parseBoundedJson(await this.readPrivateFile(relativePath, maximumBytes), maximumBytes);
  }

  async atomicWrite(
    relativePath: string,
    content: string | Buffer,
    maximumBytes: number,
    replaceExisting = true,
  ): Promise<void> {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    if (bytes.byteLength > maximumBytes) throw stateError("oversized");
    const targetPath = await this.verifyParent(relativePath);
    const parentPath = dirname(targetPath);
    let targetBefore: FileIdentity | undefined;
    try {
      targetBefore = await verifyRegularFile(targetPath, this.uid);
      if (!replaceExisting) throw stateError("foreign_state");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    const temporaryName = `.tmp-${process.pid}-${randomBytes(16).toString("hex")}`;
    const temporaryPath = join(parentPath, temporaryName);
    let handle;
    let renamed = false;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_CLOEXEC,
        FILE_MODE,
      );
      const temporaryStat = await handle.stat();
      if (
        !temporaryStat.isFile() ||
        temporaryStat.uid !== this.uid ||
        temporaryStat.nlink !== 1 ||
        modeBits(temporaryStat.mode) !== FILE_MODE
      ) {
        throw stateError("unsafe_path");
      }
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;

      await verifyDirectory(parentPath, this.uid, true);
      if (targetBefore) {
        const current = await verifyRegularFile(targetPath, this.uid);
        if (!sameIdentity(targetBefore, current)) throw stateError("unsafe_path");
      } else {
        try {
          await lstat(targetPath);
          throw stateError("foreign_state");
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      await rename(temporaryPath, targetPath);
      renamed = true;
      await syncDirectory(parentPath);
      const finalIdentity = await verifyRegularFile(targetPath, this.uid);
      if (finalIdentity.size !== bytes.byteLength) throw stateError("unsafe_path");
    } finally {
      await handle?.close();
      if (!renamed) {
        try {
          await verifyRegularFile(temporaryPath, this.uid);
          await unlink(temporaryPath);
          await syncDirectory(parentPath);
        } catch (error) {
          if (!isMissing(error)) {
            // Preserve the original error and leave suspicious temporary state untouched.
          }
        }
      }
    }
  }

  async writeImmutable(relativePath: string, content: string | Buffer, maximumBytes: number): Promise<void> {
    return this.atomicWrite(relativePath, content, maximumBytes, false);
  }

  async renameExclusive(sourceRelativePath: string, destinationRelativePath: string): Promise<void> {
    const source = await this.verifyParent(sourceRelativePath);
    const destination = await this.verifyParent(destinationRelativePath);
    const sourceIdentity = await verifyRegularFile(source, this.uid).catch((error) => {
      if (isMissing(error)) throw stateError("not_found", error);
      throw error;
    });
    try {
      await lstat(destination);
      throw stateError("claim_conflict");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const current = await verifyRegularFile(source, this.uid);
    if (!sameIdentity(sourceIdentity, current)) throw stateError("unsafe_path");
    await rename(source, destination);
    await syncDirectory(dirname(source));
    if (dirname(destination) !== dirname(source)) await syncDirectory(dirname(destination));
    await verifyRegularFile(destination, this.uid);
  }

  async removePrivateFile(relativePath: string, missingOk = false): Promise<void> {
    const path = await this.verifyParent(relativePath);
    let identity: FileIdentity;
    try {
      identity = await verifyRegularFile(path, this.uid);
    } catch (error) {
      if (missingOk && isMissing(error)) return;
      if (isMissing(error)) throw stateError("not_found", error);
      throw error;
    }
    const current = await verifyRegularFile(path, this.uid);
    if (!sameIdentity(identity, current)) throw stateError("unsafe_path");
    await unlink(path);
    await syncDirectory(dirname(path));
  }

  private async createLock(lockId: string): Promise<FileIdentity> {
    const lockPath = this.absolutePath("locks/store.lock");
    const now = this.now();
    const record: LockRecord = {
      schemaVersion: SCHEMA_VERSION,
      lockId,
      pid: process.pid,
      createdAt: now,
      expiresAt: now + LIMITS.storeLockLeaseMilliseconds,
    };
    const handle = await open(
      lockPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_CLOEXEC,
      FILE_MODE,
    );
    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.uid !== this.uid ||
        opened.nlink !== 1 ||
        modeBits(opened.mode) !== FILE_MODE
      ) {
        throw stateError("unsafe_path");
      }
      return fileIdentity(opened);
    } finally {
      await handle.close();
      await syncDirectory(dirname(lockPath));
    }
  }

  private async reapStaleLock(): Promise<boolean> {
    const relativePath = "locks/store.lock";
    let identity: FileIdentity;
    try {
      const path = await this.verifyParent(relativePath);
      identity = await verifyRegularFile(path, this.uid);
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }
    // File mtime is a real filesystem clock. Comparing it with an injected
    // protocol/test clock can misclassify a lock that is still being written as
    // stale and steal it from an active same-process transaction.
    if (identity.mtimeMs + LIMITS.storeLockLeaseMilliseconds > Date.now()) return false;

    let value: unknown;
    try {
      value = await this.readPrivateJson(relativePath, LIMITS.stateReceiptBytes);
    } catch {
      value = undefined;
    }
    if (lockIsValid(value) && (value.expiresAt > this.now() || (await processExists(value.pid)))) {
      return false;
    }

    const quarantine = `locks/stale-${randomBytes(16).toString("hex")}.lock`;
    let current: FileIdentity;
    try {
      const currentPath = await this.verifyParent(relativePath);
      current = await verifyRegularFile(currentPath, this.uid);
    } catch (error) {
      // The legitimate owner may release the lock between our first identity
      // check and this recheck. A missing path means acquisition can continue;
      // it is not foreign state and must not escape as a raw ENOENT.
      if (isMissing(error)) return true;
      throw error;
    }
    if (!sameIdentity(identity, current)) return false;
    try {
      await this.renameExclusive(relativePath, quarantine);
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }
    await this.removePrivateFile(quarantine);
    return true;
  }

  async withStoreLock<Value>(operation: () => Promise<Value>): Promise<Value> {
    const releaseProcessMutex = await acquireProcessStoreMutex(this.path);
    try {
      await this.ensurePrivateDirectory("locks");
      const deadline = this.now() + LIMITS.storeLockAcquireMilliseconds;
      const lockId = randomBytes(16).toString("hex");
      let identity: FileIdentity | undefined;
      while (!identity) {
        try {
          identity = await this.createLock(lockId);
        } catch (error) {
          if (!isExists(error)) throw stateError("unsafe_path", error);
          if (this.now() >= deadline) throw stateError("lock_busy");
          await this.reapStaleLock();
          await this.sleep(10);
        }
      }

      try {
        return await operation();
      } finally {
        const lockPath = await this.verifyParent("locks/store.lock");
        const current = await verifyRegularFile(lockPath, this.uid).catch(() => undefined);
        const value = await this.readPrivateJson("locks/store.lock", LIMITS.stateReceiptBytes).catch(
          () => undefined,
        );
        if (!current || !sameIdentity(identity, current) || !lockIsValid(value) || value.lockId !== lockId) {
          throw stateError("lock_busy");
        }
        await this.removePrivateFile("locks/store.lock");
      }
    } finally {
      releaseProcessMutex();
    }
  }
}
