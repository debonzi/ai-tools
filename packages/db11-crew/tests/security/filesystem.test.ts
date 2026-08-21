import assert from "node:assert/strict";
import {
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { StateSecurityError } from "../../src/security/errors.ts";
import { SecureStateRoot } from "../../src/state/filesystem.ts";
import { temporaryAccountHome } from "./helpers.ts";

const CANONICAL_DIRECTORY = "db11-crew";
const NONCANONICAL_DIRECTORY = "db11-crew-v2";
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

function mode(value: number): number {
  return value & 0o777;
}

interface SnapshotEntry {
  path: string;
  type: "directory" | "file" | "symlink" | "other";
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  size: number;
  content?: string;
  target?: string;
}

async function snapshotTree(rootPath: string): Promise<SnapshotEntry[]> {
  const entries: SnapshotEntry[] = [];

  async function visit(path: string, relativePath: string): Promise<void> {
    const metadata = await lstat(path);
    const type = metadata.isDirectory()
      ? "directory"
      : metadata.isFile()
        ? "file"
        : metadata.isSymbolicLink()
          ? "symlink"
          : "other";
    const entry: SnapshotEntry = {
      path: relativePath,
      type,
      mode: mode(metadata.mode),
      uid: metadata.uid,
      gid: metadata.gid,
      nlink: metadata.nlink,
      size: metadata.size,
    };
    if (type === "file") entry.content = (await readFile(path)).toString("base64");
    if (type === "symlink") entry.target = await readlink(path);
    entries.push(entry);

    if (type === "directory") {
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name), relativePath === "." ? name : `${relativePath}/${name}`);
      }
    }
  }

  await visit(rootPath, ".");
  return entries;
}

async function assertRejectedWithoutMutation(
  homePath: string,
  expectedCode: StateSecurityError["code"],
): Promise<void> {
  const before = await snapshotTree(homePath);
  assert.equal(await SecureStateRoot.inspectAtAccountHome(homePath), "blocked");
  assert.deepEqual(await snapshotTree(homePath), before);
  await assert.rejects(SecureStateRoot.openAtAccountHome(homePath), (error) => {
    return error instanceof StateSecurityError && error.code === expectedCode;
  });
  assert.deepEqual(await snapshotTree(homePath), before);
}

async function initializedRoot(homePath: string): Promise<string> {
  return (await SecureStateRoot.openAtAccountHome(homePath)).path;
}

test("read-only inspection classifies missing canonical state without creating account paths", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const before = await snapshotTree(home.path);

  assert.equal(await SecureStateRoot.inspectAtAccountHome(home.path), "missing_safe");
  assert.deepEqual(await snapshotTree(home.path), before);
});

test("the canonical store initializes privately and reopens with its immutable store ID", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const noncanonical = join(home.path, ".local/state", NONCANONICAL_DIRECTORY);
  await mkdir(noncanonical, { recursive: true, mode: 0o700 });
  await writeFile(join(noncanonical, "sentinel"), "noncanonical-state", { mode: 0o600 });
  const noncanonicalBefore = await snapshotTree(noncanonical);
  const missingBefore = await snapshotTree(home.path);
  assert.equal(await SecureStateRoot.inspectAtAccountHome(home.path), "missing_safe");
  assert.deepEqual(await snapshotTree(home.path), missingBefore);

  const created = await SecureStateRoot.openAtAccountHome(home.path, {
    now: () => Date.parse("2026-08-19T00:00:00.000Z"),
  });
  assert.equal(created.path, join(home.path, ".local/state", CANONICAL_DIRECTORY));
  assert.match(created.storeId, /^[a-f0-9]{32}$/u);
  assert.equal(mode((await stat(created.path)).mode), 0o700);
  assert.deepEqual((await readdir(created.path)).sort(), ["store.json", ...ROOT_DIRECTORIES].sort());
  for (const directory of [...ROOT_DIRECTORIES, ...INTERNAL_DIRECTORIES]) {
    const metadata = await stat(join(created.path, directory));
    assert.equal(metadata.isDirectory(), true, directory);
    assert.equal(mode(metadata.mode), 0o700, directory);
  }

  const markerPath = join(created.path, "store.json");
  assert.equal(mode((await stat(markerPath)).mode), 0o600);
  assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), {
    schemaVersion: 1,
    store: "db11-crew",
    storeId: created.storeId,
    createdAt: "2026-08-19T00:00:00.000Z",
  });

  const recognizedBefore = await snapshotTree(home.path);
  assert.equal(await SecureStateRoot.inspectAtAccountHome(home.path), "recognized");
  assert.deepEqual(await snapshotTree(home.path), recognizedBefore);
  assert.deepEqual(await readdir(join(created.path, "locks")), []);
  assert.deepEqual(await readdir(join(created.path, "leases")), []);

  const reopened = await SecureStateRoot.openAtAccountHome(home.path);
  assert.equal(reopened.storeId, created.storeId);
  assert.deepEqual(await snapshotTree(noncanonical), noncanonicalBefore);

  await reopened.writeImmutable("idempotency/example.json", "{}", 16);
  assert.equal(mode((await stat(join(reopened.path, "idempotency/example.json"))).mode), 0o600);
  assert.equal((await reopened.readPrivateFile("idempotency/example.json", 16)).toString(), "{}");
  assert.throws(() => reopened.absolutePath(`../${NONCANONICAL_DIRECTORY}/sentinel`), (error) => {
    return error instanceof StateSecurityError && error.code === "containment_violation";
  });
});

test("lazily materialized runtime resources remain canonical across independent opens", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const root = await SecureStateRoot.openAtAccountHome(home.path);

  await root.ensurePrivateDirectory("runtime/workspaces/run-scout");
  assert.equal(await SecureStateRoot.inspectAtAccountHome(home.path), "recognized");
  const reopenedWithWorkspace = await SecureStateRoot.openAtAccountHome(home.path);
  assert.equal(reopenedWithWorkspace.storeId, root.storeId);

  await reopenedWithWorkspace.ensurePrivateDirectory("runtime/sessions/run-scout");
  assert.equal(await SecureStateRoot.inspectAtAccountHome(home.path), "recognized");
  const reopenedWithCompleteRuntime = await SecureStateRoot.openAtAccountHome(home.path);
  assert.equal(reopenedWithCompleteRuntime.storeId, root.storeId);
  assert.equal(mode((await stat(join(root.path, "runtime"))).mode), 0o700);
  assert.equal(mode((await stat(join(root.path, "runtime/workspaces"))).mode), 0o700);
  assert.equal(mode((await stat(join(root.path, "runtime/sessions"))).mode), 0o700);
});

test("canonical collisions fail closed without changing any fixture entry", async (context) => {
  const cases: Array<{
    name: string;
    expectedCode: StateSecurityError["code"];
    prepare: (homePath: string) => Promise<void>;
  }> = [
    {
      name: "empty existing root",
      expectedCode: "foreign_state",
      async prepare(homePath) {
        const stateParent = join(homePath, ".local/state");
        await mkdir(join(stateParent, CANONICAL_DIRECTORY), {
          recursive: true,
          mode: 0o700,
        });
        const noncanonical = join(stateParent, NONCANONICAL_DIRECTORY);
        await mkdir(noncanonical, { mode: 0o700 });
        await writeFile(join(noncanonical, "sentinel"), "must-not-be-used", { mode: 0o600 });
      },
    },
    {
      name: "root regular file",
      expectedCode: "unsafe_path",
      async prepare(homePath) {
        const parent = join(homePath, ".local/state");
        await mkdir(parent, { recursive: true, mode: 0o700 });
        await writeFile(join(parent, CANONICAL_DIRECTORY), "occupied", { mode: 0o600 });
      },
    },
    {
      name: "root symbolic link",
      expectedCode: "unsafe_path",
      async prepare(homePath) {
        const parent = join(homePath, ".local/state");
        const foreign = join(homePath, "foreign-root");
        await mkdir(parent, { recursive: true, mode: 0o700 });
        await mkdir(foreign, { mode: 0o700 });
        await writeFile(join(foreign, "sentinel"), "unchanged", { mode: 0o600 });
        await symlink(foreign, join(parent, CANONICAL_DIRECTORY));
      },
    },
    {
      name: "non-private root mode",
      expectedCode: "unsafe_path",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        await chmod(root, 0o755);
      },
    },
    {
      name: "missing marker",
      expectedCode: "foreign_state",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        await rm(join(root, "store.json"));
      },
    },
    {
      name: "marker with a foreign store identity",
      expectedCode: "foreign_state",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        const markerPath = join(root, "store.json");
        const marker = JSON.parse(await readFile(markerPath, "utf8"));
        marker.store = NONCANONICAL_DIRECTORY;
        await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
      },
    },
    {
      name: "marker with a foreign schema version",
      expectedCode: "foreign_state",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        const markerPath = join(root, "store.json");
        const marker = JSON.parse(await readFile(markerPath, "utf8"));
        marker.schemaVersion = 2;
        await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
      },
    },
    {
      name: "marker with an invalid store ID",
      expectedCode: "foreign_state",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        const markerPath = join(root, "store.json");
        const marker = JSON.parse(await readFile(markerPath, "utf8"));
        marker.storeId = "not-a-store-id";
        await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
      },
    },
    {
      name: "marker with an invalid creation timestamp",
      expectedCode: "foreign_state",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        const markerPath = join(root, "store.json");
        const marker = JSON.parse(await readFile(markerPath, "utf8"));
        marker.createdAt = "not-a-timestamp";
        await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
      },
    },
    {
      name: "marker with an unexpected field",
      expectedCode: "foreign_state",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        const markerPath = join(root, "store.json");
        const marker = JSON.parse(await readFile(markerPath, "utf8"));
        marker.generation = 2;
        await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
      },
    },
    {
      name: "marker is a directory",
      expectedCode: "unsafe_path",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        await rm(join(root, "store.json"));
        await mkdir(join(root, "store.json"), { mode: 0o700 });
      },
    },
    {
      name: "malformed marker",
      expectedCode: "invalid_record",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        await writeFile(join(root, "store.json"), "{", { mode: 0o600 });
      },
    },
    {
      name: "oversized marker",
      expectedCode: "oversized",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        await writeFile(join(root, "store.json"), "x".repeat(2_049), { mode: 0o600 });
      },
    },
    {
      name: "marker symbolic link",
      expectedCode: "unsafe_path",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        const markerPath = join(root, "store.json");
        const foreignMarker = join(homePath, "foreign-marker");
        await writeFile(foreignMarker, await readFile(markerPath), { mode: 0o600 });
        await rm(markerPath);
        await symlink(foreignMarker, markerPath);
      },
    },
    {
      name: "hard-linked marker",
      expectedCode: "unsafe_path",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        await link(join(root, "store.json"), join(homePath, "marker-alias"));
      },
    },
    {
      name: "non-private marker mode",
      expectedCode: "unsafe_path",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        await chmod(join(root, "store.json"), 0o644);
      },
    },
    {
      name: "unexpected root entry",
      expectedCode: "foreign_state",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        await writeFile(join(root, "foreign.json"), "foreign", { mode: 0o600 });
      },
    },
    {
      name: "unexpected runtime entry",
      expectedCode: "foreign_state",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        await mkdir(join(root, "runtime"), { mode: 0o700 });
        await mkdir(join(root, "runtime/foreign"), { mode: 0o700 });
      },
    },
    {
      name: "runtime root is a link",
      expectedCode: "unsafe_path",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        const foreign = join(homePath, "foreign-runtime");
        await mkdir(foreign, { mode: 0o700 });
        await symlink(foreign, join(root, "runtime"));
      },
    },
    {
      name: "runtime child has a non-private mode",
      expectedCode: "unsafe_path",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        await mkdir(join(root, "runtime/workspaces"), { recursive: true, mode: 0o700 });
        await chmod(join(root, "runtime/workspaces"), 0o755);
      },
    },
    {
      name: "missing required root directory",
      expectedCode: "foreign_state",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        await rm(join(root, "batches"), { recursive: true });
      },
    },
    {
      name: "required root entry is a file",
      expectedCode: "unsafe_path",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        await rm(join(root, "batches"), { recursive: true });
        await writeFile(join(root, "batches"), "occupied", { mode: 0o600 });
      },
    },
    {
      name: "required root directory is a link",
      expectedCode: "unsafe_path",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        const foreign = join(homePath, "foreign-directory");
        await mkdir(foreign, { mode: 0o700 });
        await rm(join(root, "batches"), { recursive: true });
        await symlink(foreign, join(root, "batches"));
      },
    },
    {
      name: "required root directory has a non-private mode",
      expectedCode: "unsafe_path",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        await chmod(join(root, "batches"), 0o755);
      },
    },
    {
      name: "missing required internal directory",
      expectedCode: "unsafe_path",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        await rm(join(root, "bootstrap/pending"), { recursive: true });
      },
    },
    {
      name: "required internal directory is a file",
      expectedCode: "unsafe_path",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        await rm(join(root, "bootstrap/pending"), { recursive: true });
        await writeFile(join(root, "bootstrap/pending"), "occupied", { mode: 0o600 });
      },
    },
    {
      name: "required internal directory is a link",
      expectedCode: "unsafe_path",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        const foreign = join(homePath, "foreign-internal-directory");
        await mkdir(foreign, { mode: 0o700 });
        await rm(join(root, "bootstrap/pending"), { recursive: true });
        await symlink(foreign, join(root, "bootstrap/pending"));
      },
    },
    {
      name: "required internal directory has a non-private mode",
      expectedCode: "unsafe_path",
      async prepare(homePath) {
        const root = await initializedRoot(homePath);
        await chmod(join(root, "bootstrap/pending"), 0o755);
      },
    },
  ];

  for (const collision of cases) {
    await context.test(collision.name, async (collisionContext) => {
      const home = await temporaryAccountHome();
      collisionContext.after(home.cleanup);
      await collision.prepare(home.path);
      await assertRejectedWithoutMutation(home.path, collision.expectedCode);
    });
  }
});

test(
  "a canonical root owned by another account fails closed without ownership repair",
  { skip: process.getuid?.() !== 0 ? "Changing fixture ownership requires root privileges." : false },
  async (context) => {
    const home = await temporaryAccountHome();
    context.after(home.cleanup);
    const root = await initializedRoot(home.path);
    await chown(root, 1, 1);
    await assertRejectedWithoutMutation(home.path, "unsafe_path");
  },
);

test("hard-linked state files remain rejected after canonical reopen", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const root = await SecureStateRoot.openAtAccountHome(home.path);
  const original = join(root.path, "idempotency/original.json");
  const alias = join(root.path, "idempotency/alias.json");
  await root.writeImmutable("idempotency/original.json", "{}", 16);
  await link(original, alias);

  await assert.rejects(root.readPrivateFile("idempotency/original.json", 16), (error) => {
    return error instanceof StateSecurityError && error.code === "unsafe_path";
  });
  assert.equal(await readFile(alias, "utf8"), "{}");
});
