import assert from "node:assert/strict";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { HERDR_ADAPTER_CAPABILITIES } from "../../src/adapters/herdr/contracts.ts";
import { parseConfigurationText } from "../../src/config/config.ts";
import { AccountConfigurationStore } from "../../src/config/store.ts";
import {
  applyHerdrPiIntegration,
  diagnoseSetup,
  parseHerdrIntegrationStatus,
  parseHerdrSchema,
  type SetupCommandRunner,
} from "../../src/setup/diagnostics.ts";
import { SecureStateRoot } from "../../src/state/filesystem.ts";
import { temporaryAccountHome } from "../security/helpers.ts";

const extensionPath = resolve("packages/db11-crew/agents/pi/extensions/db11-crew/index.ts");

function schema(): string {
  return JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Herdr API",
    protocol: 17,
    schema_version: 1,
    schemas: {
      request: {
        oneOf: HERDR_ADAPTER_CAPABILITIES.map((method) => ({
          properties: { method: { const: method } },
        })),
      },
    },
  });
}

test("Herdr bundled schema and integration status parsing is strict and bounded", () => {
  const parsed = parseHerdrSchema(schema());
  assert.equal(parsed.protocol, 17);
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual([...parsed.methods].sort(), [...HERDR_ADAPTER_CAPABILITIES].sort());
  assert.deepEqual(
    parseHerdrIntegrationStatus("pi: not installed (/home/test/.pi/agent/extensions/herdr-agent-state.ts)\n"),
    { status: "missing", targetPath: "/home/test/.pi/agent/extensions/herdr-agent-state.ts" },
  );
  assert.deepEqual(
    parseHerdrIntegrationStatus("pi: installed v1 (outdated) (/home/test/.pi/agent/extensions/herdr-agent-state.ts)"),
    { status: "outdated", targetPath: "/home/test/.pi/agent/extensions/herdr-agent-state.ts", version: 1 },
  );
  assert.equal(parseHerdrIntegrationStatus("pi: unexpected secret=do-not-echo").status, "unknown");
  assert.throws(() => parseHerdrSchema("{not-json"), /schema_invalid/u);
});

test("read-only setup diagnostics produce an exact plan without setup mutation", async (t) => {
  const home = await temporaryAccountHome();
  t.after(home.cleanup);
  const piDirectory = join(home.path, "pi-agent");
  await mkdir(piDirectory, { mode: 0o700 });
  const calls: Array<{ executable: string; arguments: readonly string[] }> = [];
  const runner: SetupCommandRunner = async (executable, arguments_) => {
    calls.push({ executable, arguments: [...arguments_] });
    const key = `${executable} ${arguments_.join(" ")}`;
    const outputs: Record<string, string> = {
      "herdr --version": "herdr 0.7.5\n",
      "herdr api schema --json": schema(),
      "herdr integration status": `pi: not installed (${piDirectory}/extensions/herdr-agent-state.ts)\n`,
      "git --version": "git version 2.43.0\n",
      "wyrd --version": "wyrd 0.2.0\n",
    };
    assert.ok(outputs[key], key);
    return { exitCode: 0, stdout: Buffer.from(outputs[key]), stderr: Buffer.alloc(0) };
  };
  const report = await diagnoseSetup({
    extensionPath,
    environment: { HOME: home.path, PATH: process.env.PATH, PI_CODING_AGENT_DIR: piDirectory },
    cwd: home.path,
    projectTrusted: false,
    runner,
  });
  assert.equal(report.integration.status, "missing", JSON.stringify({ calls, checks: report.checks }));
  assert.equal(report.canonicalState, "missing_safe");
  assert.equal(report.checks.some((check) => check.id === "canonical_state" && check.status === "ready"), true);
  assert.deepEqual(report.integrationPlan?.command, ["herdr", "integration", "install", "pi"]);
  assert.equal(report.integrationPlan?.targetPath, `${piDirectory}/extensions/herdr-agent-state.ts`);
  assert.equal(calls.some((call) => call.arguments.includes("install")), false);
  assert.deepEqual(calls, [
    { executable: "herdr", arguments: ["--version"] },
    { executable: "herdr", arguments: ["api", "schema", "--json"] },
    { executable: "herdr", arguments: ["integration", "status"] },
    { executable: "git", arguments: ["--version"] },
    { executable: "wyrd", arguments: ["--version"] },
  ]);
  await assert.rejects(lstat(join(home.path, ".local")), (error) => {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  });
  assert.equal(report.checks.some((check) => check.id === "project.trust" && check.status === "warning"), true);
  assert.equal(report.checks.some((check) => check.message.includes(home.path)), false);

  const root = await SecureStateRoot.openAtAccountHome(home.path);
  const recognized = await diagnoseSetup({
    extensionPath,
    environment: { HOME: home.path, PATH: process.env.PATH, PI_CODING_AGENT_DIR: piDirectory },
    cwd: home.path,
    runner,
  });
  assert.equal(recognized.canonicalState, "recognized");
  assert.equal(recognized.checks.some((check) => check.id === "canonical_state" && check.status === "ready"), true);

  const markerPath = join(root.path, "store.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  marker.storeId = "not-a-store-id";
  await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
  const blockedMarker = await readFile(markerPath, "utf8");
  const blocked = await diagnoseSetup({
    extensionPath,
    environment: { HOME: home.path, PATH: process.env.PATH, PI_CODING_AGENT_DIR: piDirectory },
    cwd: home.path,
    runner,
  });
  assert.equal(blocked.canonicalState, "blocked");
  assert.equal(blocked.ready, false);
  assert.equal(blocked.checks.some((check) => check.id === "canonical_state" && check.status === "blocked"), true);
  assert.equal(await readFile(markerPath, "utf8"), blockedMarker);
});

test("integration application executes only the reviewed argv vector", async (t) => {
  const home = await temporaryAccountHome();
  t.after(home.cleanup);
  const calls: Array<{ executable: string; arguments: readonly string[] }> = [];
  await applyHerdrPiIntegration({
    command: ["/opt/herdr", "integration", "install", "pi"],
    targetPath: join(home.path, ".pi/agent/extensions/herdr-agent-state.ts"),
    effects: [],
  }, {
    environment: { HOME: home.path, PATH: "/usr/bin:/bin" },
    runner: async (executable, arguments_) => {
      calls.push({ executable, arguments: [...arguments_] });
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  });
  assert.deepEqual(calls, [{ executable: "/opt/herdr", arguments: ["integration", "install", "pi"] }]);
});

test("account settings writes are validated, private, atomic, and refuse links", async (t) => {
  const home = await temporaryAccountHome();
  t.after(home.cleanup);
  const store = new AccountConfigurationStore(home.path);
  const receipt = await store.writeText(JSON.stringify({
    schemaVersion: 2,
    limits: { maxActiveMembers: 2 },
    runtimes: { scout: { provider: "openai", model: "gpt-test", thinking: "off" } },
  }));
  assert.equal(receipt.changed, true);
  assert.equal((await lstat(store.path)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(home.path, ".config/db11-crew"))).mode & 0o777, 0o700);
  assert.equal((await store.inspect()).status, "valid");
  assert.equal((await readFile(store.path, "utf8")).includes("gpt-test"), true);

  const secret = parseConfigurationText(JSON.stringify({
    schemaVersion: 2,
    runtimes: { scout: { model: `sk-${"x".repeat(24)}` } },
  }));
  assert.equal(secret.ok, false);
  if (!secret.ok) {
    assert.equal(secret.error.code, "configuration_secret_like");
    assert.equal(JSON.stringify(secret.error).includes("sk-"), false);
  }

  await rm(store.path);
  const foreign = join(home.path, "foreign.json");
  await writeFile(foreign, "{}", { mode: 0o600 });
  await symlink(foreign, store.path);
  const inspection = await store.inspect();
  assert.equal(inspection.status, "unsafe");
  await assert.rejects(() => store.writeText('{"schemaVersion":2}'), /unsafe/u);
});
