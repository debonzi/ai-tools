import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveConfiguration, type RoleId } from "../../src/config/config.ts";
import {
  COMPATIBILITY_DESCRIPTOR,
  resolveCompatibility,
} from "../../src/protocol/compatibility.ts";
import {
  BUILT_IN_ROLE_MANIFEST,
  resolveRoleReadiness,
  validateBuiltInRoleManifest,
  type ManifestResource,
  type ManifestRole,
  type RoleReadinessInput,
} from "../../src/roles/resolve.ts";

interface TestManifest {
  schemaVersion: number;
  resources: ManifestResource[];
  roles: ManifestRole[];
}

const manifest = BUILT_IN_ROLE_MANIFEST as TestManifest;

function compatibilityObservation() {
  return {
    schemaVersion: 1,
    platform: "linux",
    pi: { version: "0.84.1", capabilities: [...COMPATIBILITY_DESCRIPTOR.pi.requiredCapabilities] },
    herdr: {
      version: "0.7.5",
      protocol: 17,
      apiSchema: 1,
      capabilities: [...COMPATIBILITY_DESCRIPTOR.herdr.requiredCapabilities],
    },
    wyrd: { version: "0.2.0", capabilities: [...COMPATIBILITY_DESCRIPTOR.wyrd.requiredCapabilities] },
    git: { version: "2.43.0", capabilities: [...COMPATIBILITY_DESCRIPTOR.git.requiredCapabilities] },
  };
}

function readyInput(role: RoleId): RoleReadinessInput {
  const profile = manifest.roles.find((candidate) => candidate.id === role)!;
  const config = resolveConfiguration({ schemaVersion: 2 });
  assert.equal(config.ok, true);
  if (!config.ok) throw new Error("test configuration rejected");
  return {
    role,
    configuration: config.value,
    compatibility: resolveCompatibility(compatibilityObservation()),
    profile: {
      profileVersion: profile.profileVersion,
      profilePath: profile.profilePath,
      profileSha256: profile.profileSha256,
    },
    resources: structuredClone(manifest.resources),
    availableRuntimes: [
      { provider: "crew-provider", model: "crew-model", thinkingLevels: ["off", "medium", "high"] },
    ],
    crewleadRuntime: { provider: "crew-provider", model: "crew-model", thinking: "medium" },
  };
}

test("the member profile manifest is strict, compact, and contains only built-in profiles", () => {
  const validation = validateBuiltInRoleManifest();
  assert.equal(validation.ok, true);
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.roles.map((role) => role.id), ["scout", "planner", "builder"]);
  assert.deepEqual(manifest.resources.map((resource) => resource.id), [
    "member_companion",
    "member_companion_runtime",
    "member_companion_protocol",
    "member_progress_transport",
  ]);
  for (const role of manifest.roles) {
    for (const field of [
      "requiredCapabilities",
      "optionalCapabilities",
      "resources",
      "tools",
      "approvedProviderVariants",
      "readinessChecks",
    ]) {
      assert.equal(Object.hasOwn(role, field), false, `${role.id}.${field}`);
    }
  }
  assert.equal(Object.isFrozen(BUILT_IN_ROLE_MANIFEST), true);
  assert.equal(Object.isFrozen(manifest.resources), true);
});

test("profile and common companion digests match package-owned files", async () => {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  for (const profile of manifest.roles) {
    const bytes = await readFile(resolve(packageRoot, profile.profilePath));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), profile.profileSha256, profile.id);
  }
  for (const resource of manifest.resources) {
    const bytes = await readFile(resolve(packageRoot, resource.resourcePath));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), resource.sha256, resource.id);
    assert.equal(resource.packageName, "@debonzi/db11-crew");
    assert.equal(resource.packageVersion, "0.2.0");
  }
});

test("all built-in roles resolve from compatibility, runtime, and exact provenance only", () => {
  for (const role of ["scout", "planner", "builder"] as const) {
    const receipt = resolveRoleReadiness(readyInput(role));
    assert.equal(receipt.ready, true, role);
    assert.equal(receipt.runtime?.provider, "crew-provider");
    assert.equal(receipt.runtime?.sources.provider, "crewlead");
    assert.equal(receipt.profile?.profileVersion, 2);
    assert.equal(receipt.resources.length, 4);
    assert.deepEqual(receipt.checks.map((check) => check.id), ["compatibility", "provenance", "runtime"]);
    for (const field of ["capabilities", "activeTools", "providerVariant", "tools", "readinessChecks"]) {
      assert.equal(Object.hasOwn(receipt, field), false, `${role}.${field}`);
    }
  }
});

test("runtime precedence is dispatch, configuration, then Crewlead fallback per field", () => {
  const input = readyInput("scout");
  const config = resolveConfiguration({
    schemaVersion: 2,
    runtimes: {
      scout: { provider: "configured-provider", model: "configured-model", thinking: "high" },
    },
  });
  assert.equal(config.ok, true);
  if (!config.ok) return;
  input.configuration = config.value;
  input.explicitRuntime = { model: "dispatch-model" };
  input.availableRuntimes = [
    { provider: "configured-provider", model: "dispatch-model", thinkingLevels: ["high"] },
  ];
  const receipt = resolveRoleReadiness(input);
  assert.equal(receipt.ready, true);
  assert.deepEqual(receipt.runtime, {
    provider: "configured-provider",
    model: "dispatch-model",
    thinking: "high",
    sources: {
      provider: "configuration",
      model: "dispatch",
      thinking: "configuration",
    },
  });
});

test("profile and common-resource provenance mismatches fail closed", () => {
  const badProfile = readyInput("scout");
  badProfile.profile.profileSha256 = "b".repeat(64);
  const profileReceipt = resolveRoleReadiness(badProfile);
  assert.equal(profileReceipt.ready, false);
  assert.equal(profileReceipt.checks.find((check) => check.id === "provenance")?.code, "provenance_mismatch");

  const badResource = readyInput("planner");
  badResource.resources[0]!.sha256 = "b".repeat(64);
  const resourceReceipt = resolveRoleReadiness(badResource);
  assert.equal(resourceReceipt.ready, false);
  assert.deepEqual(resourceReceipt.resources, []);
});

test("compatibility failures remain role-scoped", () => {
  const observation = compatibilityObservation();
  observation.wyrd.capabilities = [];
  const compatibility = resolveCompatibility(observation);

  const plannerInput = readyInput("planner");
  plannerInput.compatibility = compatibility;
  assert.equal(resolveRoleReadiness(plannerInput).ready, false);

  const scoutInput = readyInput("scout");
  scoutInput.compatibility = compatibility;
  assert.equal(resolveRoleReadiness(scoutInput).ready, true);
});

test("unavailable or malformed runtime choices fail closed without a fallback", () => {
  const unavailable = readyInput("builder");
  unavailable.explicitRuntime = { model: "missing-model" };
  assert.equal(resolveRoleReadiness(unavailable).ready, false);

  const malformed = readyInput("builder");
  malformed.explicitRuntime = { provider: "provider with spaces" };
  const receipt = resolveRoleReadiness(malformed);
  assert.equal(receipt.ready, false);
  assert.equal(JSON.stringify(receipt).includes("provider with spaces"), false);
});

test("custom role identifiers cannot enter the built-in resolver", () => {
  const input = readyInput("scout");
  (input as unknown as { role: string }).role = "reviewer";
  const receipt = resolveRoleReadiness(input);
  assert.equal(receipt.ready, false);
  assert.deepEqual(receipt.resources, []);
});
