import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  GitIsolationService,
  assertNoMutableScopeOverlap,
} from "../../src/adapters/git/isolation.ts";
import { AdapterError } from "../../src/adapters/process.ts";

const execute = promisify(execFile);

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
  const result = await execute("git", arguments_, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
  });
  return result.stdout.trim();
}

async function initializeRepository(root: string): Promise<void> {
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "DB11 Test");
  await git(root, "config", "user.email", "db11@example.invalid");
  await writeFile(join(root, ".gitignore"), "generated/\n");
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git(root, "add", ".gitignore", "tracked.txt");
  await git(root, "commit", "-m", "test: create fixture");
}

function expectAdapterCode(code: AdapterError["code"]) {
  return (error: unknown): boolean => error instanceof AdapterError && error.code === code;
}

type BuilderInput = Omit<
  Parameters<GitIsolationService["planBuilderAllocation"]>[0],
  "sessionDirectory"
> & { sessionDirectory?: string };

async function createBuilderWorktree(service: GitIsolationService, input: BuilderInput) {
  const plan = await service.planBuilderAllocation({
    ...input,
    sessionDirectory: input.sessionDirectory ?? `${input.destinationPath}-session`,
  });
  return service.createBuilderWorktree(plan);
}

test("dirty detached snapshots capture tracked and safe untracked content and detect all later writes", async (context) => {
  const fixture = await temporaryDirectory("db11-git-snapshot-");
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const repository = join(fixture, "repository");
  const snapshot = join(fixture, "snapshot");
  await mkdir(repository);
  await initializeRepository(repository);
  await writeFile(join(repository, "tracked.txt"), "dirty\n");
  await writeFile(join(repository, "untracked.txt"), "captured\n");
  await symlink("tracked.txt", join(repository, "safe-link"));
  await mkdir(join(repository, "generated"));
  await writeFile(join(repository, "generated", "ignored.txt"), "excluded\n");

  const service = new GitIsolationService();
  const record = await service.createReadSnapshot({
    runId: "snapshot-1",
    sourcePath: repository,
    destinationPath: snapshot,
  });
  assert.equal(await readFile(join(snapshot, "tracked.txt"), "utf8"), "dirty\n");
  assert.equal(await readFile(join(snapshot, "untracked.txt"), "utf8"), "captured\n");
  assert.equal(await readlink(join(snapshot, "safe-link")), "tracked.txt");
  await assert.rejects(readFile(join(snapshot, "generated", "ignored.txt")), { code: "ENOENT" });
  assert.equal(record.baselineManifest.attachedBranch, undefined);
  assert.equal(await git(snapshot, "rev-parse", "HEAD"), record.sourceHead);
  await service.validateReadSnapshot(record);

  await git(snapshot, "add", "tracked.txt");
  await assert.rejects(service.validateReadSnapshot(record), expectAdapterCode("snapshot_violation"));
  await git(snapshot, "reset", "--mixed", "HEAD");
  await service.validateReadSnapshot(record);

  await mkdir(join(snapshot, "generated"));
  await writeFile(join(snapshot, "generated", "late.txt"), "mutation\n");
  await assert.rejects(service.validateReadSnapshot(record), expectAdapterCode("snapshot_violation"));
});

test("snapshot capture races fail closed after deterministic source mutation", async (context) => {
  const fixture = await temporaryDirectory("db11-git-race-");
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const repository = join(fixture, "repository");
  await mkdir(repository);
  await initializeRepository(repository);
  await writeFile(join(repository, "tracked.txt"), "first dirty view\n");

  const service = new GitIsolationService({
    afterInitialCapture: () => writeFile(join(repository, "tracked.txt"), "raced dirty view\n"),
  });
  await assert.rejects(
    service.createReadSnapshot({
      runId: "snapshot-race",
      sourcePath: repository,
      destinationPath: join(fixture, "snapshot"),
    }),
    expectAdapterCode("capture_race"),
  );
  assert.equal(await readFile(join(repository, "tracked.txt"), "utf8"), "raced dirty view\n");
});

test("Builder preflight, collisions, and mutable overlap guards preserve foreign resources", async (context) => {
  const fixture = await temporaryDirectory("db11-git-guards-");
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const repository = join(fixture, "repository");
  await mkdir(repository);
  await initializeRepository(repository);
  const service = new GitIsolationService();

  await writeFile(join(repository, "dirty.txt"), "requester content\n");
  await assert.rejects(
    createBuilderWorktree(service, {
      runId: "dirty",
      sourcePath: repository,
      destinationPath: join(fixture, "dirty-worktree"),
      targetBranch: "main",
      mutablePaths: ["src"],
    }),
    expectAdapterCode("repository_dirty"),
  );
  const committedBase = await git(repository, "rev-parse", "HEAD");
  const explicitBase = await createBuilderWorktree(service, {
    runId: "committed-base",
    sourcePath: repository,
    destinationPath: join(fixture, "committed-base-worktree"),
    targetBranch: "main",
    baseCommit: committedBase,
    allowDirtyCommittedBase: true,
    mutablePaths: ["docs"],
  });
  assert.equal(explicitBase.automaticIntegrationEligible, false);
  await assert.rejects(readFile(join(explicitBase.path, "dirty.txt")), { code: "ENOENT" });
  await rm(join(repository, "dirty.txt"));

  await git(repository, "branch", "db11-crew-v2/untouched-sentinel");
  await git(repository, "branch", "db11-crew/collision");
  const foreignWorktree = join(fixture, "foreign-worktree");
  await git(repository, "worktree", "add", "-b", "foreign/owned", foreignWorktree, "HEAD");
  await assert.rejects(
    createBuilderWorktree(service, {
      runId: "collision",
      sourcePath: repository,
      destinationPath: join(fixture, "collision-worktree"),
      targetBranch: "main",
      mutablePaths: ["src"],
    }),
    expectAdapterCode("repository_collision"),
  );
  assert.equal(await git(repository, "rev-parse", "--verify", "refs/heads/db11-crew/collision"), await git(repository, "rev-parse", "HEAD"));
  assert.equal(await git(repository, "rev-parse", "--verify", "refs/heads/db11-crew-v2/untouched-sentinel"), await git(repository, "rev-parse", "HEAD"));
  assert.equal(await readFile(join(foreignWorktree, "tracked.txt"), "utf8"), "base\n");

  const identity = (await service.discover(repository)).identity.canonicalRootDigest;
  assert.throws(
    () => assertNoMutableScopeOverlap(identity, ["src/api"], [{ runId: "other", repositoryDigest: identity, mutablePaths: ["src"] }]),
    expectAdapterCode("scope_conflict"),
  );
  assert.throws(
    () => assertNoMutableScopeOverlap(identity, undefined, [{ runId: "other", repositoryDigest: identity, mutablePaths: ["docs"] }]),
    expectAdapterCode("scope_unknown"),
  );
  assert.doesNotThrow(() =>
    assertNoMutableScopeOverlap(
      identity,
      ["src/api"],
      [{ runId: "other", repositoryDigest: identity, mutablePaths: ["src"] }],
      { approvedBy: "human", evidenceRef: "request:overlap-approved" },
    ),
  );
});

test("Builder allocation rejects exact namespace and destination collisions before Git mutation", async (context) => {
  const cases = [
    { name: "exact ref", ref: "refs/heads/db11-crew/candidate" },
    { name: "namespace ancestor", ref: "refs/heads/db11-crew" },
    { name: "namespace descendant", ref: "refs/heads/db11-crew/candidate/child" },
  ] as const;
  for (const collisionCase of cases) {
    const fixture = await temporaryDirectory(`db11-builder-${collisionCase.name.replace(/ /gu, "-")}-`);
    context.after(() => rm(fixture, { recursive: true, force: true }));
    const repository = join(fixture, "repository");
    await mkdir(repository);
    await initializeRepository(repository);
    await git(repository, "update-ref", collisionCase.ref, "HEAD");
    const before = await git(repository, "for-each-ref", "--format=%(refname)%00%(objectname)");
    const service = new GitIsolationService();
    await assert.rejects(
      service.planBuilderAllocation({
        runId: "candidate",
        sourcePath: repository,
        destinationPath: join(fixture, "worktree"),
        sessionDirectory: join(fixture, "session"),
        targetBranch: "main",
      }),
      expectAdapterCode("repository_collision"),
      collisionCase.name,
    );
    assert.equal(await git(repository, "for-each-ref", "--format=%(refname)%00%(objectname)"), before);
    assert.equal(await git(repository, "worktree", "list", "--porcelain"), `worktree ${repository}\nHEAD ${await git(repository, "rev-parse", "HEAD")}\nbranch refs/heads/main`);
  }

  for (const kind of ["worktree-file", "worktree-directory", "worktree-symlink", "session-file", "session-directory", "session-symlink"] as const) {
    const fixture = await temporaryDirectory(`db11-builder-${kind}-`);
    context.after(() => rm(fixture, { recursive: true, force: true }));
    const repository = join(fixture, "repository");
    await mkdir(repository);
    await initializeRepository(repository);
    const worktree = join(fixture, "worktree");
    const session = join(fixture, "session");
    const destination = kind.startsWith("worktree") ? worktree : session;
    const untouchedDestination = destination === worktree ? session : worktree;
    if (kind.endsWith("file")) await writeFile(destination, "foreign\n");
    if (kind.endsWith("directory")) await mkdir(destination);
    if (kind.endsWith("symlink")) await symlink(repository, destination);
    const refsBefore = await git(repository, "for-each-ref", "--format=%(refname)%00%(objectname)");
    const worktreesBefore = await git(repository, "worktree", "list", "--porcelain");
    const service = new GitIsolationService();
    await assert.rejects(
      service.planBuilderAllocation({
        runId: "candidate",
        sourcePath: repository,
        destinationPath: worktree,
        sessionDirectory: session,
        targetBranch: "main",
      }),
      expectAdapterCode("repository_collision"),
      kind,
    );
    await assert.rejects(git(repository, "rev-parse", "--verify", "refs/heads/db11-crew/candidate"));
    assert.equal(await git(repository, "for-each-ref", "--format=%(refname)%00%(objectname)"), refsBefore, kind);
    assert.equal(await git(repository, "worktree", "list", "--porcelain"), worktreesBefore, kind);
    assert.equal((await lstat(destination)).isSymbolicLink(), kind.endsWith("symlink"), kind);
    await assert.rejects(lstat(untouchedDestination), { code: "ENOENT" }, kind);
  }
});

test("Builder allocation preserves unrelated refs and promotes the exact protected-ref baseline", async (context) => {
  const fixture = await temporaryDirectory("db11-builder-protected-refs-");
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const repository = join(fixture, "repository");
  await mkdir(repository);
  await initializeRepository(repository);
  await git(repository, "branch", "db11-crew/sibling");
  await git(repository, "branch", "foreign/branch");
  await git(repository, "tag", "foreign-tag");
  await git(repository, "update-ref", "refs/remotes/origin/foreign", "HEAD");
  const before = await git(repository, "for-each-ref", "--format=%(refname)%00%(objectname)");
  const service = new GitIsolationService();
  const plan = await service.planBuilderAllocation({
    runId: "candidate",
    sourcePath: repository,
    destinationPath: join(fixture, "worktree"),
    sessionDirectory: join(fixture, "session"),
    targetBranch: "main",
  });
  assert.match(plan.protectedRefDigest, /^[a-f0-9]{64}$/u);
  const record = await service.createBuilderWorktree(plan);
  assert.equal(record.protectedRefDigest, plan.protectedRefDigest);
  const evidence = await service.validateBuilderOutcome(record, { noChange: true });
  assert.equal(evidence.noChange, true);
  const after = await git(repository, "for-each-ref", "--format=%(refname)%00%(objectname)");
  assert.deepEqual(
    after.split("\n").filter((line) => !line.startsWith("refs/heads/db11-crew/candidate\0")),
    before.split("\n"),
  );
});

test("active Builder evidence requires the exact durable baseline while permitting bounded dirty recovery state", async (context) => {
  const fixture = await temporaryDirectory("db11-builder-active-evidence-");
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const repository = join(fixture, "repository");
  await mkdir(repository);
  await initializeRepository(repository);
  const service = new GitIsolationService();
  const record = await createBuilderWorktree(service, {
    runId: "active-builder",
    sourcePath: repository,
    destinationPath: join(fixture, "worktree"),
    targetBranch: "main",
  });

  await writeFile(join(record.path, "tracked.txt"), "bounded interrupted work\n");
  const evidence = await service.validateActiveBuilderResource(record);
  assert.equal(evidence.clean, false);
  assert.equal(evidence.headCommit, record.baseCommit);
  assert.equal(evidence.repository.canonicalRoot, repository);
  await assert.rejects(
    service.validateActiveBuilderResource({ ...record, protectedRefDigest: undefined }),
    expectAdapterCode("repository_state"),
  );
  await git(record.path, "checkout", "--detach");
  await assert.rejects(
    service.validateActiveBuilderResource(record),
    expectAdapterCode("repository_state"),
  );
});

test("Builder creation repeats the exact plan and leaves raced resources untouched", async (context) => {
  for (const race of ["protected-ref", "session-path"] as const) {
    const fixture = await temporaryDirectory(`db11-builder-race-${race}-`);
    context.after(() => rm(fixture, { recursive: true, force: true }));
    const repository = join(fixture, "repository");
    await mkdir(repository);
    await initializeRepository(repository);
    const service = new GitIsolationService();
    const sessionDirectory = join(fixture, "session");
    const plan = await service.planBuilderAllocation({
      runId: "candidate",
      sourcePath: repository,
      destinationPath: join(fixture, "worktree"),
      sessionDirectory,
      targetBranch: "main",
    });
    if (race === "protected-ref") await git(repository, "branch", "foreign/raced");
    else await writeFile(sessionDirectory, "foreign\n");
    await assert.rejects(
      service.createBuilderWorktree(plan),
      expectAdapterCode(race === "protected-ref" ? "repository_state" : "repository_collision"),
      race,
    );
    await assert.rejects(git(repository, "rev-parse", "--verify", plan.branchRef));
    if (race === "protected-ref") {
      assert.equal(await git(repository, "rev-parse", "--verify", "refs/heads/foreign/raced"), plan.targetCommit);
    } else {
      assert.equal(await readFile(sessionDirectory, "utf8"), "foreign\n");
    }
  }
});

test("Builder outcome validation protects canonical siblings, foreign refs, tags, and remote refs", async (context) => {
  const mutations = [
    {
      name: "canonical sibling movement",
      mutate: (repository: string, alternate: string) => git(repository, "update-ref", "refs/heads/db11-crew/sibling", alternate),
    },
    {
      name: "foreign local deletion",
      mutate: (repository: string) => git(repository, "update-ref", "-d", "refs/heads/foreign/branch"),
    },
    {
      name: "tag addition",
      mutate: (repository: string) => git(repository, "tag", "late-tag"),
    },
    {
      name: "remote-tracking movement",
      mutate: (repository: string, alternate: string) => git(repository, "update-ref", "refs/remotes/origin/foreign", alternate),
    },
  ] as const;

  for (const mutation of mutations) {
    const fixture = await temporaryDirectory(`db11-builder-protected-${mutation.name.replace(/ /gu, "-")}-`);
    context.after(() => rm(fixture, { recursive: true, force: true }));
    const repository = join(fixture, "repository");
    await mkdir(repository);
    await initializeRepository(repository);
    await git(repository, "branch", "db11-crew/sibling");
    await git(repository, "branch", "foreign/branch");
    await git(repository, "tag", "baseline-tag");
    await git(repository, "update-ref", "refs/remotes/origin/foreign", "HEAD");
    const alternate = await git(
      repository,
      "commit-tree",
      await git(repository, "rev-parse", "HEAD^{tree}"),
      "-p",
      "HEAD",
      "-m",
      "test: alternate protected object",
    );
    const service = new GitIsolationService();
    const record = await createBuilderWorktree(service, {
      runId: "protected-builder",
      sourcePath: repository,
      destinationPath: join(fixture, "worktree"),
      targetBranch: "main",
    });
    await mutation.mutate(repository, alternate);
    await assert.rejects(
      service.validateBuilderOutcome(record, { noChange: true }),
      expectAdapterCode("repository_state"),
      mutation.name,
    );
  }
});

test("Builder outcomes require committed clean work and support explicit no_change", async (context) => {
  const fixture = await temporaryDirectory("db11-git-builder-");
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const repository = join(fixture, "repository");
  await mkdir(repository);
  await initializeRepository(repository);
  const service = new GitIsolationService();

  const record = await createBuilderWorktree(service, {
    runId: "builder-1",
    sourcePath: repository,
    destinationPath: join(fixture, "builder-1"),
    targetBranch: "main",
    mutablePaths: ["tracked.txt"],
  });
  assert.equal(record.branch, "db11-crew/builder-1");
  assert.equal(record.branchRef, "refs/heads/db11-crew/builder-1");
  await writeFile(join(record.path, "tracked.txt"), "implemented\n");
  await assert.rejects(
    service.validateBuilderOutcome(record, { noChange: false }),
    expectAdapterCode("repository_dirty"),
  );
  await git(record.path, "add", "tracked.txt");
  await git(record.path, "commit", "-m", "feat: implement fixture");
  await mkdir(join(record.path, "generated"));
  await writeFile(join(record.path, "generated", "evidence.log"), "local evidence\n");
  await git(record.path, "branch", "foreign/mutation", record.baseCommit);
  await assert.rejects(
    service.validateBuilderOutcome(record, { noChange: false }),
    expectAdapterCode("repository_state"),
  );
  await git(record.path, "branch", "-d", "foreign/mutation");
  const evidence = await service.validateBuilderOutcome(record, {
    noChange: false,
    commitSubjectPattern: /^(?:feat|fix|test|docs|chore)(?:\([^)]*\))?!?: /,
  });
  assert.equal(evidence.commits.length, 1);
  assert.deepEqual(evidence.changedPaths, ["tracked.txt"]);
  assert.deepEqual(evidence.ignoredPaths, ["generated/evidence.log"]);
  assert.equal(evidence.finalManifest.headCommit, evidence.headCommit);

  const unchanged = await createBuilderWorktree(service, {
    runId: "builder-2",
    sourcePath: repository,
    destinationPath: join(fixture, "builder-2"),
    targetBranch: "main",
    mutablePaths: ["README.md"],
  });
  const noChange = await service.validateBuilderOutcome(unchanged, { noChange: true });
  assert.deepEqual(noChange.commits, []);
  assert.deepEqual(noChange.changedPaths, []);
  assert.equal(noChange.noChange, true);
});
