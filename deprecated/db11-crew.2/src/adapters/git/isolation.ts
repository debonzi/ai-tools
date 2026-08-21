import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  opendir,
  readFile,
  readlink,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, posix, relative, resolve, sep } from "node:path";

import {
  LIMITS,
  SCHEMA_VERSION,
  builderBranchForRun,
  builderRefForRun,
} from "../../protocol/limits.ts";
import {
  AdapterError,
  adapterError,
  minimalCommandEnvironment,
  runBoundedCommand,
} from "../process.ts";

const GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface RepositoryIdentity {
  canonicalRoot: string;
  canonicalRootDigest: string;
  commonGitDirectory: string;
  commonGitDirectoryDigest: string;
  commonGitDevice: string;
  commonGitInode: string;
}

export interface RepositoryObservation {
  identity: RepositoryIdentity;
  headCommit: string;
  attachedBranch?: string;
  operation?: string;
  statusDigest: string;
  clean: boolean;
}

export interface ManifestEntry {
  path: string;
  kind: "directory" | "file" | "symlink";
  mode: number;
  size: number;
  digest: string;
}

export interface RepositoryManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  headCommit: string;
  attachedBranch?: string;
  indexDigest: string;
  entries: readonly ManifestEntry[];
  digest: string;
}

export interface ReadSnapshotRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: "read_snapshot";
  runId: string;
  source: RepositoryIdentity;
  sourceHead: string;
  sourceStatusDigest: string;
  captureDigest: string;
  path: string;
  baselineManifest: RepositoryManifest;
}

export interface MutableScopeOwner {
  runId: string;
  repositoryDigest: string;
  mutablePaths?: readonly string[];
}

export interface OverlapApproval {
  approvedBy: "human";
  evidenceRef: string;
}

export interface RepositoryRef {
  ref: string;
  objectId: string;
}

export interface BuilderAllocationPlan {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: "builder_allocation";
  runId: string;
  source: RepositoryIdentity;
  sourceStatusDigest: string;
  path: string;
  sessionDirectory: string;
  branch: string;
  branchRef: string;
  baseCommit: string;
  targetBranch: string;
  targetRef: string;
  targetCommit: string;
  protectedRefDigest: string;
  initialRefs: readonly RepositoryRef[];
  mutablePaths?: readonly string[];
  automaticIntegrationEligible: boolean;
  overlapApproval?: OverlapApproval;
}

export interface BuilderWorktreeRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: "builder_worktree";
  runId: string;
  source: RepositoryIdentity;
  path: string;
  branch: string;
  branchRef: string;
  baseCommit: string;
  initialHead: string;
  targetBranch: string;
  targetRef: string;
  targetCommit: string;
  protectedRefDigest: string;
  initialRefs: readonly RepositoryRef[];
  mutablePaths?: readonly string[];
  automaticIntegrationEligible: boolean;
  overlapApproval?: OverlapApproval;
  initialManifest: RepositoryManifest;
}

export interface BuilderResourceBinding {
  kind: "builder_worktree";
  runId: string;
  source: RepositoryIdentity;
  path: string;
  branch: string;
  branchRef: string;
  baseCommit: string;
  targetBranch: string;
  targetRef: string;
  targetCommit: string;
  protectedRefDigest?: string;
}

export interface ActiveBuilderEvidence {
  schemaVersion: typeof SCHEMA_VERSION;
  valid: true;
  repository: RepositoryIdentity;
  worktree: RepositoryIdentity;
  baseCommit: string;
  headCommit: string;
  targetCommit: string;
  clean: boolean;
}

export interface BuilderValidationEvidence {
  schemaVersion: typeof SCHEMA_VERSION;
  valid: true;
  repository: RepositoryIdentity;
  worktree: RepositoryIdentity;
  baseCommit: string;
  headCommit: string;
  commits: readonly string[];
  commitSubjects: readonly string[];
  changedPaths: readonly string[];
  noChange: boolean;
  worktreeClean: true;
  ignoredPaths: readonly string[];
  finalManifest: RepositoryManifest;
}

interface CapturedEntry {
  path: string;
  kind: "file" | "symlink";
  mode: number;
  data: Buffer;
}

interface DirtyCapture {
  headCommit: string;
  patch: Buffer;
  untracked: readonly CapturedEntry[];
  digest: string;
  statusDigest: string;
}

export interface GitIsolationDependencies {
  gitExecutable?: string;
  /** Deterministic race injection used by disposable adapter tests. */
  afterInitialCapture?: () => Promise<void>;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashParts(parts: readonly (string | Buffer)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const value = Buffer.isBuffer(part) ? part : Buffer.from(part, "utf8");
    hash.update(String(value.length));
    hash.update("\0");
    hash.update(value);
  }
  return hash.digest("hex");
}

function decoded(buffer: Buffer): string {
  const value = buffer.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(buffer)) throw adapterError("invalid_argument");
  return value;
}

function trimmed(buffer: Buffer): string {
  const value = decoded(buffer).replace(/\n$/, "");
  if (!value || CONTROL.test(value)) throw adapterError("invalid_argument");
  return value;
}

function validateRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw adapterError("invalid_argument");
}

function builderIdentity(runId: string): { branch: string; branchRef: string } {
  try {
    return { branch: builderBranchForRun(runId), branchRef: builderRefForRun(runId) };
  } catch (error) {
    if (error instanceof TypeError) throw adapterError("invalid_argument");
    throw error;
  }
}

function validateRelativePath(value: string, allowRoot = false): string {
  if (
    (!allowRoot && value === ".") ||
    !value ||
    isAbsolute(value) ||
    value.includes("\\") ||
    CONTROL.test(value)
  ) {
    throw adapterError("invalid_argument");
  }
  const normalized = posix.normalize(value.replace(/^\.\//, ""));
  if (
    (!allowRoot && normalized === ".") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.length > LIMITS.pathLength
  ) {
    throw adapterError("invalid_argument");
  }
  return normalized;
}

function validateBranch(value: string): void {
  if (
    !value ||
    value.startsWith("-") ||
    value.length > LIMITS.pathLength ||
    CONTROL.test(value) ||
    /(?:\.\.|@\{|[ ~^:?*\\\[])/.test(value) ||
    value.endsWith(".") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw adapterError("invalid_argument");
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function parseNulPaths(output: Buffer): string[] {
  if (output.length === 0) return [];
  const pieces = output.subarray(0, output.at(-1) === 0 ? -1 : undefined).toString("binary").split("\0");
  return pieces.map((piece) => {
    const bytes = Buffer.from(piece, "binary");
    return validateRelativePath(decoded(bytes));
  });
}

async function hashFile(path: string): Promise<{ digest: string; size: number }> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw adapterError("repository_state");
  const hash = createHash("sha256");
  let size = 0;
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += bytes.length;
      hash.update(bytes);
    });
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  const after = await lstat(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    size !== after.size
  ) {
    throw adapterError("capture_race");
  }
  return { digest: hash.digest("hex"), size };
}

async function assertSafeSymlinkTarget(root: string, linkPath: string, target: string): Promise<void> {
  if (isAbsolute(target) || CONTROL.test(target)) throw adapterError("repository_scope");
  const candidate = resolve(dirname(linkPath), target);
  if (!isWithin(root, candidate)) throw adapterError("repository_scope");
  let existing = candidate;
  for (;;) {
    try {
      const resolvedExisting = await realpath(existing);
      if (!isWithin(root, resolvedExisting)) throw adapterError("repository_scope");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw adapterError("repository_scope");
      existing = parent;
    }
  }
}

async function readStableFile(path: string): Promise<{ data: Buffer; mode: number }> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw adapterError("repository_state");
  if (before.size > LIMITS.repositoryCaptureBytes) throw adapterError("output_oversized");
  const data = await readFile(path);
  const after = await lstat(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw adapterError("capture_race");
  }
  return { data, mode: before.mode & 0o777 };
}

export function normalizeMutableScopes(paths: readonly string[] | undefined): readonly string[] | undefined {
  if (paths === undefined) return undefined;
  if (paths.length === 0 || paths.length > LIMITS.repositoryPathEntries) {
    throw adapterError("invalid_argument");
  }
  return [...new Set(paths.map((path) => validateRelativePath(path, true)))].sort();
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === "." ||
    right === "." ||
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

/** Reject unknown or intersecting mutable ownership unless exact human approval is recorded. */
export function assertNoMutableScopeOverlap(
  repositoryDigest: string,
  candidatePaths: readonly string[] | undefined,
  existing: readonly MutableScopeOwner[],
  approval?: OverlapApproval,
): void {
  const candidate = normalizeMutableScopes(candidatePaths);
  const conflicts = existing.filter((owner) => {
    if (owner.repositoryDigest !== repositoryDigest) return false;
    const owned = normalizeMutableScopes(owner.mutablePaths);
    if (candidate === undefined || owned === undefined) return true;
    return candidate.some((left) => owned.some((right) => pathsOverlap(left, right)));
  });
  if (conflicts.length === 0) return;
  if (approval?.approvedBy === "human" && approval.evidenceRef.length > 0) return;
  if (candidate === undefined || conflicts.some((owner) => owner.mutablePaths === undefined)) {
    throw adapterError("scope_unknown");
  }
  throw adapterError("scope_conflict");
}

export class GitIsolationService {
  readonly #git: string;
  readonly #afterInitialCapture?: () => Promise<void>;

  constructor(dependencies: GitIsolationDependencies = {}) {
    this.#git = dependencies.gitExecutable ?? "git";
    this.#afterInitialCapture = dependencies.afterInitialCapture;
  }

  async #gitCommand(
    cwd: string,
    arguments_: readonly string[],
    options: { acceptedExitCodes?: readonly number[]; maximumOutputBytes?: number; input?: Buffer } = {},
  ) {
    return runBoundedCommand(this.#git, arguments_, {
      cwd,
      input: options.input,
      acceptedExitCodes: options.acceptedExitCodes,
      maximumOutputBytes: options.maximumOutputBytes,
      environment: minimalCommandEnvironment({ GIT_OPTIONAL_LOCKS: "0" }),
    });
  }

  async discover(path: string): Promise<RepositoryObservation> {
    const start = await realpath(path).catch((error) => {
      throw adapterError("repository_identity", undefined, error);
    });
    const rootResult = await this.#gitCommand(start, ["rev-parse", "--show-toplevel"]);
    const canonicalRoot = await realpath(trimmed(rootResult.stdout));
    if (canonicalRoot.length > LIMITS.pathLength || CONTROL.test(canonicalRoot)) {
      throw adapterError("repository_identity");
    }
    const commonResult = await this.#gitCommand(canonicalRoot, ["rev-parse", "--git-common-dir"]);
    const commonRaw = trimmed(commonResult.stdout);
    const commonGitDirectory = await realpath(
      isAbsolute(commonRaw) ? commonRaw : resolve(canonicalRoot, commonRaw),
    );
    const commonStats = await stat(commonGitDirectory);
    if (!commonStats.isDirectory()) throw adapterError("repository_identity");
    const headCommit = trimmed((await this.#gitCommand(canonicalRoot, ["rev-parse", "--verify", "HEAD"])).stdout);
    if (!GIT_OBJECT.test(headCommit)) throw adapterError("repository_identity");
    const branchResult = await this.#gitCommand(
      canonicalRoot,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { acceptedExitCodes: [0, 1] },
    );
    const attachedBranch = branchResult.exitCode === 0 ? trimmed(branchResult.stdout) : undefined;
    const operation = await this.#operation(canonicalRoot);
    const status = await this.#gitCommand(canonicalRoot, [
      "status",
      "--porcelain=v2",
      "--untracked-files=all",
      "--ignore-submodules=none",
      "-z",
    ]);
    return {
      identity: {
        canonicalRoot,
        canonicalRootDigest: sha256(canonicalRoot),
        commonGitDirectory,
        commonGitDirectoryDigest: sha256(commonGitDirectory),
        commonGitDevice: String(commonStats.dev),
        commonGitInode: String(commonStats.ino),
      },
      headCommit,
      ...(attachedBranch === undefined ? {} : { attachedBranch }),
      ...(operation === undefined ? {} : { operation }),
      statusDigest: hashParts([headCommit, status.stdout]),
      clean: status.stdout.length === 0,
    };
  }

  async #refs(root: string): Promise<readonly RepositoryRef[]> {
    const result = await this.#gitCommand(root, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00",
    ]);
    const lines = decoded(result.stdout).split("\n").filter(Boolean);
    if (lines.length > LIMITS.repositoryPathEntries) throw adapterError("output_oversized");
    return lines
      .map((line) => {
        const [ref, objectId, remainder] = line.split("\0");
        if (
          remainder !== "" ||
          !ref?.startsWith("refs/") ||
          CONTROL.test(ref) ||
          ref.length > LIMITS.pathLength ||
          !GIT_OBJECT.test(objectId ?? "")
        ) {
          throw adapterError("repository_state");
        }
        return { ref, objectId };
      })
      .sort((left, right) => left.ref.localeCompare(right.ref, "en"));
  }

  async #operation(root: string): Promise<string | undefined> {
    const names = [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-apply",
      "rebase-merge",
      "sequencer",
    ] as const;
    for (const name of names) {
      const rawPath = trimmed((await this.#gitCommand(root, ["rev-parse", "--git-path", name])).stdout);
      const path = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath);
      if (!(await missing(path))) return name;
    }
    return undefined;
  }

  async #assertIdentity(path: string, expected: RepositoryIdentity): Promise<RepositoryObservation> {
    const observed = await this.discover(path);
    const identity = observed.identity;
    if (
      identity.canonicalRoot !== (await realpath(path)) ||
      identity.commonGitDirectory !== expected.commonGitDirectory ||
      identity.commonGitDirectoryDigest !== expected.commonGitDirectoryDigest ||
      identity.commonGitDevice !== expected.commonGitDevice ||
      identity.commonGitInode !== expected.commonGitInode
    ) {
      throw adapterError("repository_identity");
    }
    return observed;
  }

  async #captureDirty(root: string): Promise<DirtyCapture> {
    const observation = await this.discover(root);
    if (observation.operation !== undefined) throw adapterError("repository_operation");
    const patch = (
      await this.#gitCommand(
        root,
        ["diff", "--binary", "--full-index", "--no-ext-diff", "HEAD", "--"],
        { maximumOutputBytes: LIMITS.repositoryCaptureBytes },
      )
    ).stdout;
    const untrackedOutput = (
      await this.#gitCommand(root, ["ls-files", "--others", "--exclude-standard", "-z"], {
        maximumOutputBytes: LIMITS.repositoryCaptureBytes,
      })
    ).stdout;
    const paths = parseNulPaths(untrackedOutput);
    if (paths.length > LIMITS.repositoryCaptureEntries) throw adapterError("output_oversized");

    let bytes = patch.length;
    const entries: CapturedEntry[] = [];
    for (const relativePath of paths) {
      if (relativePath.split("/").includes(".git")) throw adapterError("repository_state");
      let parent = dirname(relativePath);
      while (parent !== ".") {
        if (!(await missing(join(root, parent, ".git")))) throw adapterError("repository_state");
        parent = dirname(parent);
      }
      const absolutePath = join(root, ...relativePath.split("/"));
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        await assertSafeSymlinkTarget(root, absolutePath, target);
        const data = Buffer.from(target, "utf8");
        bytes += data.length;
        entries.push({ path: relativePath, kind: "symlink", mode: info.mode & 0o777, data });
      } else if (info.isFile()) {
        const stable = await readStableFile(absolutePath);
        bytes += stable.data.length;
        entries.push({ path: relativePath, kind: "file", mode: stable.mode, data: stable.data });
      } else {
        throw adapterError("repository_state");
      }
      if (bytes > LIMITS.repositoryCaptureBytes) throw adapterError("output_oversized");
    }
    entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
    const digestParts: (string | Buffer)[] = [observation.headCommit, patch];
    for (const entry of entries) {
      digestParts.push(entry.path, entry.kind, String(entry.mode), entry.data);
    }
    return {
      headCommit: observation.headCommit,
      patch,
      untracked: entries,
      digest: hashParts(digestParts),
      statusDigest: observation.statusDigest,
    };
  }

  async createReadSnapshot(input: {
    runId: string;
    sourcePath: string;
    destinationPath: string;
  }): Promise<ReadSnapshotRecord> {
    validateRunId(input.runId);
    if (!isAbsolute(input.destinationPath) || !(await missing(input.destinationPath))) {
      throw adapterError("repository_collision");
    }
    const source = await this.discover(input.sourcePath);
    if (
      isWithin(source.identity.canonicalRoot, resolve(input.destinationPath)) ||
      isWithin(source.identity.commonGitDirectory, resolve(input.destinationPath))
    ) {
      throw adapterError("repository_scope");
    }
    if (source.operation !== undefined) throw adapterError("repository_operation");
    const first = await this.#captureDirty(source.identity.canonicalRoot);
    await this.#afterInitialCapture?.();

    await this.#gitCommand(source.identity.canonicalRoot, [
      "worktree",
      "add",
      "--detach",
      "--",
      input.destinationPath,
      first.headCommit,
    ]);
    if (first.patch.length > 0) {
      await this.#gitCommand(
        input.destinationPath,
        ["apply", "--binary", "--whitespace=nowarn", "--"],
        { input: first.patch, maximumOutputBytes: LIMITS.repositoryCaptureBytes },
      );
    }
    for (const entry of first.untracked) {
      const destination = join(input.destinationPath, ...entry.path.split("/"));
      const parent = dirname(destination);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const parentReal = await realpath(parent);
      if (!isWithin(await realpath(input.destinationPath), parentReal)) {
        throw adapterError("repository_scope");
      }
      if (entry.kind === "symlink") {
        if (!(await missing(destination))) throw adapterError("repository_collision");
        await symlink(entry.data.toString("utf8"), destination);
      } else {
        await writeFile(destination, entry.data, { flag: "wx", mode: entry.mode });
      }
    }

    const second = await this.#captureDirty(source.identity.canonicalRoot);
    if (first.digest !== second.digest || first.headCommit !== second.headCommit) {
      throw adapterError("capture_race");
    }
    const baselineManifest = await this.createManifest(input.destinationPath);
    if (baselineManifest.headCommit !== first.headCommit || baselineManifest.attachedBranch !== undefined) {
      throw adapterError("repository_state");
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      kind: "read_snapshot",
      runId: input.runId,
      source: source.identity,
      sourceHead: first.headCommit,
      sourceStatusDigest: first.statusDigest,
      captureDigest: first.digest,
      path: await realpath(input.destinationPath),
      baselineManifest,
    };
  }

  async createManifest(path: string): Promise<RepositoryManifest> {
    const observation = await this.discover(path);
    const root = observation.identity.canonicalRoot;
    const entries: ManifestEntry[] = [];

    const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
      const stream = await opendir(directory);
      const children = [];
      for await (const child of stream) children.push(child.name);
      children.sort((left, right) => left.localeCompare(right, "en"));
      for (const name of children) {
        if (relativeDirectory === "" && name === ".git") continue;
        const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        validateRelativePath(relativePath);
        const absolutePath = join(directory, name);
        const info = await lstat(absolutePath);
        if (info.isDirectory() && !info.isSymbolicLink()) {
          entries.push({
            path: relativePath,
            kind: "directory",
            mode: info.mode & 0o777,
            size: 0,
            digest: sha256("directory"),
          });
          if (entries.length > LIMITS.repositoryManifestEntries) throw adapterError("output_oversized");
          await walk(absolutePath, relativePath);
        } else if (info.isFile() && !info.isSymbolicLink()) {
          const value = await hashFile(absolutePath);
          entries.push({
            path: relativePath,
            kind: "file",
            mode: info.mode & 0o777,
            size: value.size,
            digest: value.digest,
          });
        } else if (info.isSymbolicLink()) {
          const target = await readlink(absolutePath);
          entries.push({
            path: relativePath,
            kind: "symlink",
            mode: info.mode & 0o777,
            size: Buffer.byteLength(target),
            digest: sha256(target),
          });
        } else {
          throw adapterError("repository_state");
        }
        if (entries.length > LIMITS.repositoryManifestEntries) throw adapterError("output_oversized");
      }
    };
    await walk(root, "");
    const index = await this.#gitCommand(root, ["ls-files", "--stage", "-z"], {
      maximumOutputBytes: LIMITS.repositoryCaptureBytes,
    });
    const indexDigest = sha256(index.stdout);
    const parts: string[] = [observation.headCommit, observation.attachedBranch ?? "detached", indexDigest];
    for (const entry of entries) {
      parts.push(entry.path, entry.kind, String(entry.mode), String(entry.size), entry.digest);
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      headCommit: observation.headCommit,
      ...(observation.attachedBranch === undefined ? {} : { attachedBranch: observation.attachedBranch }),
      indexDigest,
      entries,
      digest: hashParts(parts),
    };
  }

  async validateReadSnapshot(record: ReadSnapshotRecord): Promise<RepositoryManifest> {
    const observation = await this.#assertIdentity(record.path, record.source);
    if (observation.attachedBranch !== undefined || observation.headCommit !== record.sourceHead) {
      throw adapterError("snapshot_violation");
    }
    const finalManifest = await this.createManifest(record.path);
    if (finalManifest.digest !== record.baselineManifest.digest) {
      throw adapterError("snapshot_violation");
    }
    return finalManifest;
  }

  #protectedRefDigest(refs: readonly RepositoryRef[], branchRef: string): string {
    const protectedRefs = refs.filter((entry) => entry.ref !== branchRef);
    return sha256(protectedRefs.map((entry) => `${entry.ref}\0${entry.objectId}\n`).join(""));
  }

  #assertNoRefNamespaceCollision(refs: readonly RepositoryRef[], branchRef: string): void {
    if (refs.some((entry) =>
      entry.ref === branchRef ||
      entry.ref.startsWith(`${branchRef}/`) ||
      branchRef.startsWith(`${entry.ref}/`))) {
      throw adapterError("repository_collision");
    }
  }

  async #assertAbsentDestination(path: string): Promise<void> {
    if (!isAbsolute(path) || normalize(path) !== path || !(await missing(path))) {
      throw adapterError("repository_collision");
    }
  }

  /** Observe and bind one exact Builder allocation without mutating Git or either destination. */
  async planBuilderAllocation(input: {
    runId: string;
    sourcePath: string;
    destinationPath: string;
    sessionDirectory: string;
    targetBranch: string;
    baseCommit?: string;
    allowDirtyCommittedBase?: boolean;
    mutablePaths?: readonly string[];
    existingOwners?: readonly MutableScopeOwner[];
    overlapApproval?: OverlapApproval;
  }): Promise<BuilderAllocationPlan> {
    validateRunId(input.runId);
    validateBranch(input.targetBranch);
    await this.#assertAbsentDestination(input.destinationPath);
    await this.#assertAbsentDestination(input.sessionDirectory);
    const source = await this.discover(input.sourcePath);
    if (
      isWithin(source.identity.canonicalRoot, input.destinationPath) ||
      isWithin(source.identity.commonGitDirectory, input.destinationPath) ||
      isWithin(source.identity.canonicalRoot, input.sessionDirectory) ||
      isWithin(source.identity.commonGitDirectory, input.sessionDirectory) ||
      isWithin(input.destinationPath, input.sessionDirectory) ||
      isWithin(input.sessionDirectory, input.destinationPath)
    ) {
      throw adapterError("repository_scope");
    }
    if (source.operation !== undefined) throw adapterError("repository_operation");
    if (source.attachedBranch === undefined || source.attachedBranch !== input.targetBranch) {
      throw adapterError("repository_state");
    }
    const explicitBase = input.baseCommit !== undefined;
    const baseCommit = input.baseCommit ?? source.headCommit;
    if (!GIT_OBJECT.test(baseCommit)) throw adapterError("invalid_argument");
    const verifiedBase = trimmed(
      (await this.#gitCommand(source.identity.canonicalRoot, ["rev-parse", "--verify", `${baseCommit}^{commit}`])).stdout,
    );
    if (verifiedBase !== baseCommit) throw adapterError("repository_state");
    if (!source.clean && !(explicitBase && input.allowDirtyCommittedBase === true)) {
      throw adapterError("repository_dirty");
    }

    const { branch, branchRef } = builderIdentity(input.runId);
    validateBranch(branch);
    const targetRef = `refs/heads/${input.targetBranch}`;
    const initialRefs = await this.#refs(source.identity.canonicalRoot);
    this.#assertNoRefNamespaceCollision(initialRefs, branchRef);
    const targetCommit = initialRefs.find((entry) => entry.ref === targetRef)?.objectId;
    if (targetCommit !== source.headCommit) throw adapterError("repository_state");

    const mutablePaths = normalizeMutableScopes(input.mutablePaths);
    assertNoMutableScopeOverlap(
      source.identity.canonicalRootDigest,
      mutablePaths,
      input.existingOwners ?? [],
      input.overlapApproval,
    );
    return {
      schemaVersion: SCHEMA_VERSION,
      kind: "builder_allocation",
      runId: input.runId,
      source: source.identity,
      sourceStatusDigest: source.statusDigest,
      path: input.destinationPath,
      sessionDirectory: input.sessionDirectory,
      branch,
      branchRef,
      baseCommit,
      targetBranch: input.targetBranch,
      targetRef,
      targetCommit,
      protectedRefDigest: this.#protectedRefDigest(initialRefs, branchRef),
      initialRefs,
      ...(mutablePaths === undefined ? {} : { mutablePaths }),
      automaticIntegrationEligible: source.clean && baseCommit === source.headCommit,
      ...(input.overlapApproval === undefined ? {} : { overlapApproval: input.overlapApproval }),
    };
  }

  /** Repeat exact preflight, create only the planned worktree, and freshly verify promotion evidence. */
  async createBuilderWorktree(plan: BuilderAllocationPlan): Promise<BuilderWorktreeRecord> {
    validateRunId(plan.runId);
    validateBranch(plan.branch);
    validateBranch(plan.targetBranch);
    const expectedIdentity = builderIdentity(plan.runId);
    if (
      plan.schemaVersion !== SCHEMA_VERSION ||
      plan.kind !== "builder_allocation" ||
      plan.branch !== expectedIdentity.branch ||
      plan.branchRef !== expectedIdentity.branchRef ||
      plan.targetRef !== `refs/heads/${plan.targetBranch}` ||
      !GIT_OBJECT.test(plan.baseCommit) ||
      !GIT_OBJECT.test(plan.targetCommit) ||
      !/^[a-f0-9]{64}$/.test(plan.protectedRefDigest)
    ) {
      throw adapterError("invalid_argument");
    }
    await this.#assertAbsentDestination(plan.path);
    await this.#assertAbsentDestination(plan.sessionDirectory);
    const source = await this.discover(plan.source.canonicalRoot);
    if (
      source.identity.canonicalRoot !== plan.source.canonicalRoot ||
      source.identity.canonicalRootDigest !== plan.source.canonicalRootDigest ||
      source.identity.commonGitDirectory !== plan.source.commonGitDirectory ||
      source.identity.commonGitDirectoryDigest !== plan.source.commonGitDirectoryDigest ||
      source.identity.commonGitDevice !== plan.source.commonGitDevice ||
      source.identity.commonGitInode !== plan.source.commonGitInode ||
      source.attachedBranch !== plan.targetBranch ||
      source.headCommit !== plan.targetCommit ||
      source.statusDigest !== plan.sourceStatusDigest ||
      source.operation !== undefined
    ) {
      throw adapterError("repository_state");
    }
    const refs = await this.#refs(source.identity.canonicalRoot);
    this.#assertNoRefNamespaceCollision(refs, plan.branchRef);
    if (this.#protectedRefDigest(refs, plan.branchRef) !== plan.protectedRefDigest) {
      throw adapterError("repository_state");
    }

    await this.#gitCommand(source.identity.canonicalRoot, [
      "worktree",
      "add",
      "-b",
      plan.branch,
      "--",
      plan.path,
      plan.baseCommit,
    ]);
    const path = await realpath(plan.path);
    if (path !== plan.path) throw adapterError("repository_identity");
    const observation = await this.#assertIdentity(path, plan.source);
    const finalRefs = await this.#refs(path);
    const branchHead = finalRefs.find((entry) => entry.ref === plan.branchRef)?.objectId;
    const targetHead = finalRefs.find((entry) => entry.ref === plan.targetRef)?.objectId;
    if (
      observation.attachedBranch !== plan.branch ||
      observation.headCommit !== plan.baseCommit ||
      branchHead !== plan.baseCommit ||
      targetHead !== plan.targetCommit ||
      this.#protectedRefDigest(finalRefs, plan.branchRef) !== plan.protectedRefDigest
    ) {
      throw adapterError("repository_state");
    }
    const initialManifest = await this.createManifest(path);
    if (initialManifest.headCommit !== plan.baseCommit || initialManifest.attachedBranch !== plan.branch) {
      throw adapterError("repository_state");
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      kind: "builder_worktree",
      runId: plan.runId,
      source: structuredClone(plan.source),
      path,
      branch: plan.branch,
      branchRef: plan.branchRef,
      baseCommit: plan.baseCommit,
      initialHead: plan.baseCommit,
      targetBranch: plan.targetBranch,
      targetRef: plan.targetRef,
      targetCommit: plan.targetCommit,
      protectedRefDigest: plan.protectedRefDigest,
      initialRefs: structuredClone(plan.initialRefs),
      ...(plan.mutablePaths === undefined ? {} : { mutablePaths: [...plan.mutablePaths] }),
      automaticIntegrationEligible: plan.automaticIntegrationEligible,
      ...(plan.overlapApproval === undefined ? {} : { overlapApproval: structuredClone(plan.overlapApproval) }),
      initialManifest,
    };
  }

  /** Verify the exact durable Builder resource without requiring a clean in-progress worktree. */
  async validateActiveBuilderResource(record: BuilderResourceBinding): Promise<ActiveBuilderEvidence> {
    validateRunId(record.runId);
    validateBranch(record.branch);
    validateBranch(record.targetBranch);
    const expected = builderIdentity(record.runId);
    if (
      record.kind !== "builder_worktree" ||
      record.branch !== expected.branch ||
      record.branchRef !== expected.branchRef ||
      record.targetRef !== `refs/heads/${record.targetBranch}` ||
      !isAbsolute(record.path) ||
      normalize(record.path) !== record.path ||
      !GIT_OBJECT.test(record.baseCommit) ||
      !GIT_OBJECT.test(record.targetCommit) ||
      !record.protectedRefDigest ||
      !/^[a-f0-9]{64}$/u.test(record.protectedRefDigest)
    ) {
      throw adapterError("repository_state");
    }

    const source = await this.discover(record.source.canonicalRoot);
    if (
      source.identity.canonicalRoot !== record.source.canonicalRoot ||
      source.identity.canonicalRootDigest !== record.source.canonicalRootDigest ||
      source.identity.commonGitDirectory !== record.source.commonGitDirectory ||
      source.identity.commonGitDirectoryDigest !== record.source.commonGitDirectoryDigest ||
      source.identity.commonGitDevice !== record.source.commonGitDevice ||
      source.identity.commonGitInode !== record.source.commonGitInode
    ) {
      throw adapterError("repository_identity");
    }

    const observation = await this.#assertIdentity(record.path, record.source);
    if (observation.attachedBranch !== record.branch || observation.operation !== undefined) {
      throw adapterError("repository_state");
    }
    const refs = await this.#refs(record.path);
    if (
      refs.find((entry) => entry.ref === record.branchRef)?.objectId !== observation.headCommit ||
      refs.find((entry) => entry.ref === record.targetRef)?.objectId !== record.targetCommit ||
      this.#protectedRefDigest(refs, record.branchRef) !== record.protectedRefDigest
    ) {
      throw adapterError("repository_state");
    }
    const ancestry = await this.#gitCommand(
      record.path,
      ["merge-base", "--is-ancestor", record.baseCommit, observation.headCommit],
      { acceptedExitCodes: [0, 1] },
    );
    if (ancestry.exitCode !== 0) throw adapterError("repository_state");
    return {
      schemaVersion: SCHEMA_VERSION,
      valid: true,
      repository: source.identity,
      worktree: observation.identity,
      baseCommit: record.baseCommit,
      headCommit: observation.headCommit,
      targetCommit: record.targetCommit,
      clean: observation.clean,
    };
  }

  async validateBuilderOutcome(
    record: BuilderResourceBinding,
    input: { noChange?: boolean; commitSubjectPattern?: RegExp } = {},
  ): Promise<BuilderValidationEvidence> {
    const observation = await this.validateActiveBuilderResource(record);
    if (!observation.clean) throw adapterError("repository_dirty");

    const commitOutput = await this.#gitCommand(record.path, [
      "rev-list",
      "--reverse",
      `${record.baseCommit}..${observation.headCommit}`,
    ]);
    const commits = decoded(commitOutput.stdout)
      .trim()
      .split("\n")
      .filter(Boolean);
    if (commits.length > LIMITS.repositoryCommitEntries || commits.some((commit) => !GIT_OBJECT.test(commit))) {
      throw adapterError("output_oversized");
    }
    const noChange = commits.length === 0;
    if (input.noChange !== undefined && input.noChange !== noChange) throw adapterError("repository_state");

    const subjects: string[] = [];
    for (const commit of commits) {
      const subject = trimmed((await this.#gitCommand(record.path, ["show", "-s", "--format=%s", commit])).stdout);
      if (input.commitSubjectPattern !== undefined) {
        input.commitSubjectPattern.lastIndex = 0;
        if (!input.commitSubjectPattern.test(subject)) throw adapterError("repository_state");
      }
      subjects.push(subject);
    }
    const changedOutput = await this.#gitCommand(record.path, [
      "diff",
      "--name-only",
      "--diff-filter=ACDMRTUXB",
      "-z",
      record.baseCommit,
      observation.headCommit,
      "--",
    ]);
    const changedPaths = parseNulPaths(changedOutput.stdout);
    if (changedPaths.length > LIMITS.repositoryPathEntries) throw adapterError("output_oversized");
    const ignoredOutput = await this.#gitCommand(record.path, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ]);
    const ignoredPaths = parseNulPaths(ignoredOutput.stdout);
    if (ignoredPaths.length > LIMITS.repositoryPathEntries) throw adapterError("output_oversized");
    const finalManifest = await this.createManifest(record.path);
    const confirmed = await this.validateActiveBuilderResource(record);
    if (
      finalManifest.headCommit !== observation.headCommit ||
      finalManifest.attachedBranch !== record.branch ||
      confirmed.headCommit !== observation.headCommit ||
      !confirmed.clean
    ) {
      throw adapterError("repository_state");
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      valid: true,
      repository: confirmed.repository,
      worktree: confirmed.worktree,
      baseCommit: record.baseCommit,
      headCommit: confirmed.headCommit,
      commits,
      commitSubjects: subjects,
      changedPaths,
      noChange,
      worktreeClean: true,
      ignoredPaths,
      finalManifest,
    };
  }
}

export { AdapterError };
