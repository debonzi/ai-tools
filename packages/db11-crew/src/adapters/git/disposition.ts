import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { LIMITS, isCanonicalBuilderRef } from "../../protocol/limits.ts";
import type { RepositoryResource } from "../../orchestration/lifecycle.ts";
import { adapterError, minimalCommandEnvironment, runBoundedCommand } from "../process.ts";
import { GitIsolationService } from "./isolation.ts";

const CONTROL = /[\u0000-\u001f\u007f]/u;
const GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_REF = /^refs\/(?:heads\/[A-Za-z0-9][A-Za-z0-9._\/-]*|[A-Za-z0-9][A-Za-z0-9._\/-]*)$/;

export type BuilderRepositoryResource = Extract<RepositoryResource, { kind: "builder_worktree" }>;
export type ReadRepositoryResource = Extract<RepositoryResource, { kind: "read_snapshot" }>;

export interface IntegrationPreflight {
  baseCommit: string;
  headCommit: string;
  targetCommit: string;
  targetBranch: string;
  targetRef: string;
}

export interface IntegrationCommandResult extends IntegrationPreflight {
  commandExitCode: number;
  commandDiagnostic?: string;
}

export interface GitDispositionDependencies {
  gitExecutable?: string;
}

interface WorktreeRegistration {
  path: string;
  headCommit: string;
  branchRef?: string;
}

function safeObject(value: string): void {
  if (!GIT_OBJECT.test(value)) throw adapterError("invalid_argument");
}

function safeRef(value: string): void {
  if (
    !SAFE_REF.test(value) || value.startsWith("-") || value.includes("..") || value.includes("@{") ||
    value.includes("//") || /[\u0000-\u0020\u007f~^:?*\\\[]/u.test(value)
  ) {
    throw adapterError("invalid_argument");
  }
}

function decoded(value: Buffer): string {
  const text = value.toString("utf8").replace(/\n$/u, "");
  if (!text || !Buffer.from(text, "utf8").equals(value.subarray(0, value.at(-1) === 10 ? -1 : undefined))) {
    throw adapterError("repository_state");
  }
  return text;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Exact-ref Git integration and cleanup primitives. No command searches, prunes, resets, stashes, or cleans. */
export class GitDispositionAdapter {
  readonly #git: string;
  readonly #isolation: GitIsolationService;

  constructor(dependencies: GitDispositionDependencies = {}) {
    this.#git = dependencies.gitExecutable ?? "git";
    this.#isolation = new GitIsolationService({ gitExecutable: this.#git });
  }

  #assertBuilderRecord(resource: BuilderRepositoryResource): void {
    safeRef(resource.branchRef);
    safeRef(resource.targetRef);
    if (
      !isCanonicalBuilderRef(resource.branchRef) ||
      resource.branchRef !== `refs/heads/${resource.branch}` ||
      resource.targetRef !== `refs/heads/${resource.targetBranch}` ||
      resource.branch.startsWith("-") || resource.targetBranch.startsWith("-")
    ) throw adapterError("invalid_argument");
    safeObject(resource.baseCommit);
    safeObject(resource.targetCommit);
  }

  async #command(cwd: string, args: readonly string[], acceptedExitCodes: readonly number[] = [0]) {
    return runBoundedCommand(this.#git, args, {
      cwd,
      acceptedExitCodes,
      maximumOutputBytes: LIMITS.adapterOutputBytes,
      environment: minimalCommandEnvironment({ GIT_OPTIONAL_LOCKS: "0" }),
    });
  }

  async #assertIdentity(path: string, resource: RepositoryResource): Promise<void> {
    const info = await lstat(path).catch((error) => {
      throw adapterError("repository_identity", undefined, error);
    });
    const resolved = await realpath(path);
    if (!info.isDirectory() || info.isSymbolicLink() || resolved !== path) throw adapterError("repository_identity");
    const observed = await this.#isolation.discover(path);
    const identity = observed.identity;
    if (
      identity.canonicalRoot !== resolved ||
      identity.commonGitDirectory !== resource.source.commonGitDirectory ||
      identity.commonGitDirectoryDigest !== resource.source.commonGitDirectoryDigest ||
      identity.commonGitDevice !== resource.source.commonGitDevice ||
      identity.commonGitInode !== resource.source.commonGitInode
    ) {
      throw adapterError("repository_identity");
    }
  }

  async #ref(cwd: string, ref: string): Promise<string | undefined> {
    safeRef(ref);
    const present = await this.#command(cwd, ["show-ref", "--verify", "--quiet", ref], [0, 1]);
    if (present.exitCode === 1) return undefined;
    const result = await this.#command(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
    const objectId = decoded(result.stdout);
    safeObject(objectId);
    return objectId;
  }

  async #isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    safeObject(ancestor);
    safeObject(descendant);
    return (await this.#command(cwd, ["merge-base", "--is-ancestor", ancestor, descendant], [0, 1])).exitCode === 0;
  }

  async #worktrees(cwd: string): Promise<readonly WorktreeRegistration[]> {
    const result = await this.#command(cwd, ["worktree", "list", "--porcelain", "-z"]);
    const records = decoded(result.stdout).split("\0\0").filter(Boolean);
    if (records.length > LIMITS.repositoryPathEntries) throw adapterError("output_oversized");
    return records.map((record) => {
      let path: string | undefined;
      let headCommit: string | undefined;
      let branchRef: string | undefined;
      for (const field of record.split("\0").filter(Boolean)) {
        if (field.startsWith("worktree ")) path = field.slice("worktree ".length);
        else if (field.startsWith("HEAD ")) headCommit = field.slice("HEAD ".length);
        else if (field.startsWith("branch ")) branchRef = field.slice("branch ".length);
        else if (field !== "detached" && field !== "bare" && !field.startsWith("locked") && !field.startsWith("prunable")) {
          throw adapterError("repository_state");
        }
      }
      if (!path || !isAbsolute(path) || path.length > LIMITS.pathLength || CONTROL.test(path) || !headCommit) {
        throw adapterError("repository_state");
      }
      safeObject(headCommit);
      if (branchRef !== undefined) safeRef(branchRef);
      return { path, headCommit, ...(branchRef === undefined ? {} : { branchRef }) };
    });
  }

  async #builderRegistration(resource: BuilderRepositoryResource, expectedHead: string): Promise<boolean> {
    const registrations = await this.#worktrees(resource.source.canonicalRoot);
    const byPath = registrations.filter((candidate) => candidate.path === resource.path);
    const byBranch = registrations.filter((candidate) => candidate.branchRef === resource.branchRef);
    if (
      byPath.length > 1 || byBranch.length > 1 ||
      byPath.some((candidate) => candidate.branchRef !== resource.branchRef) ||
      byBranch.some((candidate) => candidate.path !== resource.path)
    ) {
      throw adapterError("repository_state");
    }
    const registration = byPath[0];
    if (registration && registration.headCommit !== expectedHead) throw adapterError("repository_state");
    return registration !== undefined;
  }

  async #readRegistration(resource: ReadRepositoryResource): Promise<boolean> {
    const registrations = await this.#worktrees(resource.source.canonicalRoot);
    const byPath = registrations.filter((candidate) => candidate.path === resource.path);
    if (
      byPath.length > 1 ||
      byPath.some((candidate) => candidate.branchRef !== undefined || candidate.headCommit !== resource.sourceHead)
    ) {
      throw adapterError("snapshot_violation");
    }
    return byPath.length === 1;
  }

  async integrationPreflight(resource: BuilderRepositoryResource, expectedHead: string): Promise<IntegrationPreflight> {
    if (resource.runId.length < 1) throw adapterError("invalid_argument");
    this.#assertBuilderRecord(resource);
    safeObject(expectedHead);
    if (!resource.automaticIntegrationEligible || resource.targetCommit !== resource.baseCommit) {
      throw adapterError("repository_state");
    }

    await this.#assertIdentity(resource.source.canonicalRoot, resource);
    if (!await this.#builderRegistration(resource, expectedHead)) throw adapterError("repository_state");
    await this.#assertIdentity(resource.path, resource);
    const builder = await this.#isolation.discover(resource.path);
    if (
      builder.attachedBranch !== resource.branch || builder.operation !== undefined || !builder.clean ||
      builder.headCommit !== expectedHead || await this.#ref(resource.path, resource.branchRef) !== expectedHead
    ) {
      throw adapterError("repository_state");
    }

    const target = await this.#isolation.discover(resource.source.canonicalRoot);
    if (
      target.attachedBranch !== resource.targetBranch || target.operation !== undefined || !target.clean ||
      target.headCommit !== resource.baseCommit || await this.#ref(resource.source.canonicalRoot, resource.targetRef) !== resource.baseCommit
    ) {
      throw adapterError("repository_state");
    }
    if (!await this.#isAncestor(resource.source.canonicalRoot, resource.baseCommit, expectedHead)) {
      throw adapterError("repository_state");
    }
    return {
      baseCommit: resource.baseCommit,
      headCommit: expectedHead,
      targetCommit: target.headCommit,
      targetBranch: resource.targetBranch,
      targetRef: resource.targetRef,
    };
  }

  async integrateFastForward(
    resource: BuilderRepositoryResource,
    expectedHead: string,
    authorizeEffect: () => Promise<void> = async () => {},
  ): Promise<IntegrationCommandResult> {
    const preflight = await this.integrationPreflight(resource, expectedHead);
    await authorizeEffect();
    const result = await this.#command(
      resource.source.canonicalRoot,
      ["merge", "--ff-only", expectedHead],
      Array.from({ length: 256 }, (_value, index) => index),
    );
    const after = await this.#isolation.discover(resource.source.canonicalRoot);
    const targetRef = await this.#ref(resource.source.canonicalRoot, resource.targetRef);
    if (
      after.attachedBranch !== resource.targetBranch || after.operation !== undefined || !after.clean ||
      after.headCommit !== expectedHead || targetRef !== expectedHead
    ) {
      throw adapterError(result.exitCode === 0 ? "repository_state" : "command_failed", result.stderr.toString("utf8"));
    }
    return {
      ...preflight,
      targetCommit: expectedHead,
      commandExitCode: result.exitCode,
      ...(result.exitCode === 0 ? {} : { commandDiagnostic: "Git reported a hook or command failure after the exact fast-forward was verified." }),
    };
  }

  async integrationAlreadyApplied(resource: BuilderRepositoryResource, expectedHead: string): Promise<boolean> {
    this.#assertBuilderRecord(resource);
    safeObject(expectedHead);
    await this.builderResourceState(resource, expectedHead);
    const target = await this.#isolation.discover(resource.source.canonicalRoot);
    return target.attachedBranch === resource.targetBranch && target.operation === undefined && target.clean &&
      target.headCommit === expectedHead && await this.#ref(resource.source.canonicalRoot, resource.targetRef) === expectedHead;
  }

  async builderResourceState(resource: BuilderRepositoryResource, expectedHead: string, allowAcknowledgedDirty = false): Promise<{
    worktreePresent: boolean;
    branchPresent: boolean;
    branchHead?: string;
  }> {
    this.#assertBuilderRecord(resource);
    safeObject(expectedHead);
    await this.#assertIdentity(resource.source.canonicalRoot, resource);
    const pathPresent = await exists(resource.path);
    const registered = await this.#builderRegistration(resource, expectedHead);
    if (pathPresent !== registered) throw adapterError("repository_state");
    if (pathPresent) {
      await this.#assertIdentity(resource.path, resource);
      const observation = await this.#isolation.discover(resource.path);
      if (
        observation.attachedBranch !== resource.branch || observation.operation !== undefined ||
        (!allowAcknowledgedDirty && !observation.clean) || observation.headCommit !== expectedHead
      ) {
        throw adapterError("repository_state");
      }
    }
    const branchHead = await this.#ref(resource.source.canonicalRoot, resource.branchRef);
    if (branchHead !== undefined && branchHead !== expectedHead) throw adapterError("repository_state");
    if (registered && branchHead === undefined) throw adapterError("repository_state");
    return { worktreePresent: registered, branchPresent: branchHead !== undefined, ...(branchHead ? { branchHead } : {}) };
  }

  async removeBuilderWorktree(
    resource: BuilderRepositoryResource,
    expectedHead: string,
    destructiveDiscard: boolean,
    authorizeEffect: () => Promise<void> = async () => {},
  ): Promise<void> {
    const state = await this.builderResourceState(resource, expectedHead, destructiveDiscard);
    if (!state.worktreePresent) return;
    await authorizeEffect();
    const args = ["worktree", "remove", ...(destructiveDiscard ? ["--force"] : []), "--", resource.path];
    await this.#command(resource.source.canonicalRoot, args);
  }

  async removeBuilderBranch(
    resource: BuilderRepositoryResource,
    expectedHead: string,
    destructiveDiscard: boolean,
    authorizeEffect: () => Promise<void> = async () => {},
  ): Promise<void> {
    this.#assertBuilderRecord(resource);
    safeObject(expectedHead);
    await this.#assertIdentity(resource.source.canonicalRoot, resource);
    if (await this.#ref(resource.source.canonicalRoot, resource.branchRef) !== expectedHead) {
      throw adapterError("repository_state");
    }
    if (!destructiveDiscard) await this.assertHeadReachableFromTarget(resource, expectedHead);
    await authorizeEffect();
    await this.#command(resource.source.canonicalRoot, ["update-ref", "-d", resource.branchRef, expectedHead]);
  }

  async targetHead(resource: BuilderRepositoryResource): Promise<string> {
    this.#assertBuilderRecord(resource);
    await this.#assertIdentity(resource.source.canonicalRoot, resource);
    const target = await this.#isolation.discover(resource.source.canonicalRoot);
    const targetHead = await this.#ref(resource.source.canonicalRoot, resource.targetRef);
    if (
      target.attachedBranch !== resource.targetBranch || target.operation !== undefined || !target.clean ||
      targetHead !== target.headCommit
    ) throw adapterError("repository_state");
    return target.headCommit;
  }

  async assertHeadReachableFromTarget(resource: BuilderRepositoryResource, expectedHead: string): Promise<void> {
    safeObject(expectedHead);
    const targetHead = await this.targetHead(resource);
    if (!await this.#isAncestor(resource.source.canonicalRoot, expectedHead, targetHead)) {
      throw adapterError("repository_state");
    }
  }

  async readSnapshotState(resource: ReadRepositoryResource): Promise<{ present: boolean }> {
    await this.#assertIdentity(resource.source.canonicalRoot, resource);
    const pathPresent = await exists(resource.path);
    const registered = await this.#readRegistration(resource);
    if (pathPresent !== registered) throw adapterError("snapshot_violation");
    if (!registered) return { present: false };
    await this.#assertIdentity(resource.path, resource);
    const observation = await this.#isolation.discover(resource.path);
    const manifest = await this.#isolation.createManifest(resource.path);
    if (
      observation.attachedBranch !== undefined || observation.operation !== undefined ||
      observation.headCommit !== resource.sourceHead || manifest.digest !== resource.baselineManifestDigest
    ) {
      throw adapterError("snapshot_violation");
    }
    return { present: true };
  }

  async removeReadSnapshot(
    resource: ReadRepositoryResource,
    authorizeEffect: () => Promise<void> = async () => {},
  ): Promise<void> {
    if (!(await this.readSnapshotState(resource)).present) return;
    await authorizeEffect();
    await this.#command(resource.source.canonicalRoot, ["worktree", "remove", "--", resource.path]);
  }
}
