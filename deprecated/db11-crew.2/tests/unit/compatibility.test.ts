import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPATIBILITY_DESCRIPTOR,
  resolveCompatibility,
} from "../../src/protocol/compatibility.ts";

function observation() {
  return {
    schemaVersion: 1,
    platform: "linux",
    pi: {
      version: "0.84.1",
      capabilities: [...COMPATIBILITY_DESCRIPTOR.pi.requiredCapabilities],
    },
    herdr: {
      version: "0.7.5",
      protocol: 17,
      apiSchema: 1,
      capabilities: [...COMPATIBILITY_DESCRIPTOR.herdr.requiredCapabilities],
    },
    wyrd: {
      version: "0.2.0",
      capabilities: [...COMPATIBILITY_DESCRIPTOR.wyrd.requiredCapabilities],
    },
    git: {
      version: "2.43.0",
      capabilities: [...COMPATIBILITY_DESCRIPTOR.git.requiredCapabilities],
    },
  };
}

test("reference runtime observations satisfy the capability-backed descriptor", () => {
  const resolved = resolveCompatibility(observation());
  assert.equal(resolved.ready, true);
  assert.deepEqual(resolved.roles, { scout: true, planner: true, builder: true });
  assert.equal(resolved.diagnostics.length, 0);
});

test("unlisted Pi minor lines fail the package closed", () => {
  const value = observation();
  value.pi.version = "0.85.0";
  const resolved = resolveCompatibility(value);
  assert.equal(resolved.ready, false);
  assert.equal(resolved.components.pi.code, "unsupported_version");
  assert.deepEqual(resolved.roles, { scout: false, planner: false, builder: false });
});

test("Pi readiness requires the activation and designation capabilities", () => {
  const activationCapabilities = [
    "extension.active_tools",
    "extension.custom_entries",
    "extension.input",
    "extension.session_id",
    "extension.session_shutdown",
    "extension.session_start",
    "extension.session_tree",
  ];
  const required = new Set<string>(COMPATIBILITY_DESCRIPTOR.pi.requiredCapabilities);
  assert.equal(activationCapabilities.every((capability) => required.has(capability)), true);

  const value = observation();
  value.pi.capabilities = value.pi.capabilities.filter((item) => item !== "extension.input");
  const resolved = resolveCompatibility(value);
  assert.equal(resolved.ready, false);
  assert.equal(resolved.components.pi.code, "missing_capability");
  assert.equal(resolved.components.pi.missingCapabilities, 1);
  assert.deepEqual(resolved.roles, { scout: false, planner: false, builder: false });
});

test("Herdr stable versions are adapter-backed rather than artificially capped to 0.7", () => {
  const value = observation();
  value.herdr.version = "1.4.0";
  assert.equal(resolveCompatibility(value).components.herdr.ready, true);

  value.herdr.protocol = 18;
  const rejected = resolveCompatibility(value);
  assert.equal(rejected.components.herdr.code, "unsupported_protocol");
  assert.equal(rejected.ready, false);
});

test("Wyrd capability failures disable only Planner", () => {
  const value = observation();
  value.wyrd.capabilities = value.wyrd.capabilities.filter((item) => item !== "optimistic_revision");
  const resolved = resolveCompatibility(value);
  assert.equal(resolved.ready, true);
  assert.equal(resolved.components.wyrd.code, "missing_capability");
  assert.deepEqual(resolved.roles, { scout: true, planner: false, builder: true });
});

test("Git behavior failures disable every snapshot-backed built-in role", () => {
  const value = observation();
  value.git.capabilities = [];
  const resolved = resolveCompatibility(value);
  assert.equal(resolved.ready, true);
  assert.deepEqual(resolved.roles, { scout: false, planner: false, builder: false });
});

test("unknown observation versions and fields fail closed", () => {
  const unknownVersion = { ...observation(), schemaVersion: 2 };
  assert.equal(resolveCompatibility(unknownVersion).ready, false);

  const extended = { ...observation(), executablePath: "/sensitive/runtime/path" };
  const resolved = resolveCompatibility(extended);
  assert.equal(resolved.ready, false);
  assert.equal(JSON.stringify(resolved).includes("/sensitive/runtime/path"), false);
});

test("diagnostics are bounded and do not echo observed values", () => {
  const value = observation();
  value.pi.version = "0.85.999999";
  value.pi.capabilities = [];
  const resolved = resolveCompatibility(value);
  const serialized = JSON.stringify(resolved.diagnostics);
  assert.equal(serialized.includes("0.85.999999"), false);
  assert.equal(resolved.diagnostics.every((item) => item.message.length <= 256), true);
});
