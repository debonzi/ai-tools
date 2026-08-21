import assert from "node:assert/strict";
import test from "node:test";

import {
  CONFIGURATION_RELATIVE_PATH,
  DEFAULT_CONFIGURATION,
  configurationPath,
  parseConfigurationText,
  resolveConfiguration,
} from "../../src/config/config.ts";
import { LIMITS } from "../../src/protocol/limits.ts";

const minimal = { schemaVersion: 2 };

test("configuration applies the accepted independent defaults", () => {
  const resolved = resolveConfiguration(minimal);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.deepEqual(resolved.value, DEFAULT_CONFIGURATION);
  assert.deepEqual(resolved.value.limits, {
    maxActiveMembers: 4,
    maxOpenMemberResources: 6,
    maxQueuedDelegations: 6,
  });
  assert.equal(resolved.value.retention.policy, "auto_close");
  assert.equal(resolved.value.retention.inspectionGraceMilliseconds, 300_000);
  assert.equal(resolved.value.progress.enabled, true);
  assert.equal(Object.hasOwn(resolved.value, "scoutWeb"), false);
});

test("each admission limit can be tightened or raised independently to its hard ceiling", () => {
  const cases = [
    ["maxActiveMembers", 6],
    ["maxOpenMemberResources", 1],
    ["maxQueuedDelegations", 0],
  ] as const;
  for (const [name, value] of cases) {
    const resolved = resolveConfiguration({ schemaVersion: 2, limits: { [name]: value } });
    assert.equal(resolved.ok, true, name);
    if (!resolved.ok) continue;
    assert.equal(resolved.value.limits[name], value);
    for (const other of Object.keys(DEFAULT_CONFIGURATION.limits) as Array<keyof typeof DEFAULT_CONFIGURATION.limits>) {
      if (other !== name) assert.equal(resolved.value.limits[other], DEFAULT_CONFIGURATION.limits[other]);
    }
  }
});

test("configuration rejects every admission value beyond six", () => {
  for (const name of [
    "maxActiveMembers",
    "maxOpenMemberResources",
    "maxQueuedDelegations",
  ] as const) {
    const resolved = resolveConfiguration({ schemaVersion: 2, limits: { [name]: 7 } });
    assert.equal(resolved.ok, false, name);
  }
});

test("configuration accepts bounded role runtime choices without arbitrary roles", () => {
  const resolved = resolveConfiguration({
    schemaVersion: 2,
    runtimes: {
      scout: { provider: "provider-a", model: "model-a", thinking: "high" },
      builder: { thinking: "medium" },
    },
  });
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.deepEqual(resolved.value.runtimes.scout, {
      provider: "provider-a",
      model: "model-a",
      thinking: "high",
    });
  }

  const custom = resolveConfiguration({
    schemaVersion: 2,
    runtimes: { reviewer: { provider: "provider-a", model: "model-a" } },
  });
  assert.equal(custom.ok, false);
});

test("configuration rejects secrets, arbitrary extension paths, and empty runtime overrides", () => {
  for (const value of [
    { schemaVersion: 2, apiKey: "secret" },
    { schemaVersion: 2, roles: { custom: {} } },
    { schemaVersion: 2, extensionPath: "/tmp/extension.ts" },
    { schemaVersion: 2, runtimes: { scout: {} } },
    { schemaVersion: 2, scoutWeb: { providerVariant: "exa" } },
  ]) {
    assert.equal(resolveConfiguration(value).ok, false);
  }
});

test("configuration parser bounds input before parsing and sanitizes JSON errors", () => {
  const oversized = parseConfigurationText("x".repeat(LIMITS.configurationBytes + 1));
  assert.equal(oversized.ok, false);
  if (!oversized.ok) {
    assert.equal(oversized.error.code, "configuration_too_large");
    assert.equal(oversized.error.message.includes("x".repeat(100)), false);
  }

  const invalidText = "{\"apiKey\":\"super-secret-value\"";
  const invalid = parseConfigurationText(invalidText);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(JSON.stringify(invalid.error).includes("super-secret-value"), false);
});

test("configuration path is fixed beneath the account home", () => {
  assert.equal(CONFIGURATION_RELATIVE_PATH, ".config/db11-crew/config.json");
  assert.equal(configurationPath("/home/member"), "/home/member/.config/db11-crew/config.json");
});

test("inspection grace bounds are enforced", () => {
  for (const value of [
    LIMITS.inspectionGraceMinimumMilliseconds - 1,
    LIMITS.inspectionGraceMaximumMilliseconds + 1,
  ]) {
    assert.equal(
      resolveConfiguration({
        schemaVersion: 2,
        retention: { inspectionGraceMilliseconds: value },
      }).ok,
      false,
    );
  }
});
