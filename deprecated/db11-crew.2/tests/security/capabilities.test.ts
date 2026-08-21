import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { RunCapabilityManager } from "../../src/security/capabilities.ts";
import { bindingKey } from "../../src/security/binding.ts";
import { StateSecurityError } from "../../src/security/errors.ts";
import { sha256 } from "../../src/security/json.ts";
import { redactDiagnostic } from "../../src/security/redaction.ts";
import { SecureStateRoot } from "../../src/state/filesystem.ts";
import { FencedLeaseManager } from "../../src/state/leases.ts";
import { capabilityBinding, temporaryAccountHome } from "./helpers.ts";

async function allFileText(path: string): Promise<string> {
  const entries = await readdir(path, { withFileTypes: true });
  const values: string[] = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) values.push(await allFileText(child));
    else if (entry.isFile()) values.push(await readFile(child, "utf8"));
  }
  return values.join("\n");
}

test("one-time bootstrap activates separate exact-bound capability planes without persisting tokens", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const root = await SecureStateRoot.openAtAccountHome(home.path);
  const manager = new RunCapabilityManager(root);
  const binding = capabilityBinding();
  const locator = await manager.provision(binding);
  assert.ok(locator.bootstrapPath.startsWith(root.path));

  const capabilities = await manager.claimBootstrap(locator.bootstrapId, binding);
  assert.notEqual(capabilities.finalization, capabilities.control);
  assert.notEqual(capabilities.control, capabilities.progress);
  await assert.rejects(manager.claimBootstrap(locator.bootstrapId, binding), (error) => {
    return error instanceof StateSecurityError && error.code === "bootstrap_used";
  });

  const durableText = await allFileText(root.path);
  for (const token of Object.values(capabilities)) assert.equal(durableText.includes(token), false);

  const accepted = await manager.authorizeMessage({
    token: capabilities.finalization,
    plane: "finalization",
    binding,
    messageId: "message-finish-1",
    sequence: 1,
    expectedRevision: 2,
    currentRevision: 2,
    payload: { resultId: "result-1", summary: "Bounded result." },
  });
  assert.equal(accepted.duplicate, false);
  const duplicate = await manager.authorizeMessage({
    token: capabilities.finalization,
    plane: "finalization",
    binding,
    messageId: "message-finish-1",
    sequence: 1,
    expectedRevision: 2,
    currentRevision: 2,
    payload: { summary: "Bounded result.", resultId: "result-1" },
  });
  assert.equal(duplicate.duplicate, true);

  await assert.rejects(
    manager.authorizeMessage({
      token: capabilities.finalization,
      plane: "finalization",
      binding,
      messageId: "message-finish-1",
      sequence: 1,
      expectedRevision: 2,
      currentRevision: 2,
      payload: { resultId: "result-2" },
    }),
    (error) => error instanceof StateSecurityError && error.code === "replay_conflict",
  );
  await assert.rejects(
    manager.authorizeMessage({
      token: capabilities.finalization,
      plane: "finalization",
      binding,
      messageId: "message-finish-2",
      sequence: 1,
      expectedRevision: 2,
      currentRevision: 2,
      payload: { resultId: "result-2" },
    }),
    (error) => error instanceof StateSecurityError && error.code === "stale_sequence",
  );
  assert.equal(
    (
      await manager.authorizeMessage({
        token: capabilities.finalization,
        plane: "finalization",
        binding,
        messageId: "message-finish-2",
        sequence: 2,
        expectedRevision: 2,
        currentRevision: 2,
        payload: { resultId: "result-2" },
      })
    ).duplicate,
    false,
  );

  await assert.rejects(
    manager.authorizeMessage({
      token: capabilities.progress,
      plane: "finalization",
      binding,
      messageId: "message-cross-plane",
      sequence: 1,
      expectedRevision: 2,
      currentRevision: 2,
      payload: {},
    }),
    (error) => error instanceof StateSecurityError && error.code === "capability_invalid",
  );
});

test("exact capability health is bounded and rejects stale authorization state", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  let now = 1_000_000;
  const root = await SecureStateRoot.openAtAccountHome(home.path, { now: () => now });
  const manager = new RunCapabilityManager(root, {
    now: () => now,
    capabilityLifetimeMilliseconds: 1_000,
    bootstrapLifetimeMilliseconds: 1_000,
  });
  const binding = capabilityBinding();

  assert.deepEqual(await manager.inspectExactBinding(binding), {
    healthy: false,
    code: "missing",
    finalization: false,
    control: false,
    progress: false,
  });
  const locator = await manager.provision(binding);
  assert.equal((await manager.inspectExactBinding(binding)).code, "unclaimed");
  await manager.claimBootstrap(locator.bootstrapId, binding);
  const healthy = await manager.inspectExactBinding(binding);
  assert.deepEqual(healthy, {
    healthy: true,
    code: "healthy",
    finalization: true,
    control: true,
    progress: true,
  });
  assert.deepEqual(Object.keys(healthy).sort(), ["code", "control", "finalization", "healthy", "progress"]);

  now += 1_001;
  assert.equal((await manager.inspectExactBinding(binding)).code, "expired");
  await manager.revokeRun(binding.runId, "test cleanup");
  assert.equal((await manager.inspectExactBinding(binding)).code, "revoked");

  const replacement = capabilityBinding({ fencingEpoch: 2 });
  const replacementLocator = await manager.provision(replacement);
  await manager.claimBootstrap(replacementLocator.bootstrapId, replacement);
  assert.equal((await manager.inspectExactBinding(binding)).code, "binding_mismatch");
  assert.equal((await manager.inspectExactBinding(replacement)).code, "healthy");
});

test("selected-attempt cleanup authenticates all three planes before exact idempotent revocation", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const root = await SecureStateRoot.openAtAccountHome(home.path);
  const manager = new RunCapabilityManager(root);
  const binding = capabilityBinding();
  const locator = await manager.provision(binding);
  const capabilities = await manager.claimBootstrap(locator.bootstrapId, binding);
  const alteredProgress = `${capabilities.progress.slice(0, -1)}${capabilities.progress.endsWith("A") ? "B" : "A"}`;

  await assert.rejects(
    manager.revokeClaimedCapabilities(
      binding,
      { ...capabilities, progress: alteredProgress },
      "failed companion startup",
    ),
    (error) => error instanceof StateSecurityError && error.code === "capability_invalid",
  );
  assert.equal((await manager.inspectExactBinding(binding)).code, "healthy");

  assert.equal(
    await manager.revokeClaimedCapabilities(binding, capabilities, "failed companion startup"),
    3,
  );
  assert.equal((await manager.inspectExactBinding(binding)).code, "revoked");
  assert.equal(
    await manager.revokeClaimedCapabilities(binding, capabilities, "repeated cleanup"),
    0,
  );
});

test("selected-attempt cleanup rejects mixed foreign tokens without partial revocation", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const root = await SecureStateRoot.openAtAccountHome(home.path);
  const manager = new RunCapabilityManager(root);
  const binding = capabilityBinding();
  const foreignBinding = capabilityBinding({ runId: "run-foreign", memberSessionId: "member-foreign" });
  const locator = await manager.provision(binding);
  const foreignLocator = await manager.provision(foreignBinding);
  const capabilities = await manager.claimBootstrap(locator.bootstrapId, binding);
  const foreignCapabilities = await manager.claimBootstrap(foreignLocator.bootstrapId, foreignBinding);

  await assert.rejects(
    manager.revokeClaimedCapabilities(
      binding,
      { ...capabilities, progress: foreignCapabilities.progress },
      "mixed cleanup",
    ),
    (error) => error instanceof StateSecurityError && error.code === "capability_invalid",
  );
  assert.equal((await manager.inspectExactBinding(binding)).code, "healthy");
  assert.equal((await manager.inspectExactBinding(foreignBinding)).code, "healthy");
});

test("delayed cleanup preserves a rotated replacement at a new fencing epoch", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const root = await SecureStateRoot.openAtAccountHome(home.path);
  const manager = new RunCapabilityManager(root);
  const binding = capabilityBinding();
  const locator = await manager.provision(binding);
  const capabilities = await manager.claimBootstrap(locator.bootstrapId, binding);
  const replacementBinding = capabilityBinding({ fencingEpoch: 2 });
  const replacementLocator = await manager.rotate(replacementBinding, "rotate before cleanup");
  await manager.claimBootstrap(replacementLocator.bootstrapId, replacementBinding);

  assert.equal(await manager.revokeClaimedCapabilities(binding, capabilities, "delayed cleanup"), 0);
  assert.equal((await manager.inspectExactBinding(binding)).code, "binding_mismatch");
  assert.equal((await manager.inspectExactBinding(replacementBinding)).code, "healthy");
});

test("cleanup before same-binding rotation leaves the replacement healthy", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const root = await SecureStateRoot.openAtAccountHome(home.path);
  const manager = new RunCapabilityManager(root);
  const binding = capabilityBinding();
  const locator = await manager.provision(binding);
  const capabilities = await manager.claimBootstrap(locator.bootstrapId, binding);

  assert.equal(await manager.revokeClaimedCapabilities(binding, capabilities, "cleanup before rotation"), 3);
  const replacementLocator = await manager.rotate(binding, "same-binding replacement");
  const replacement = await manager.claimBootstrap(replacementLocator.bootstrapId, binding);
  assert.equal((await manager.inspectExactBinding(binding)).code, "healthy");
  assert.notEqual(replacement.finalization, capabilities.finalization);
  assert.equal(await manager.revokeClaimedCapabilities(binding, capabilities, "delayed repeat"), 0);
  assert.equal((await manager.inspectExactBinding(binding)).code, "healthy");
});

test("capability health rejects an unrevoked foreign binding beside a replacement", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const root = await SecureStateRoot.openAtAccountHome(home.path);
  const manager = new RunCapabilityManager(root);
  const binding = capabilityBinding();
  const locator = await manager.provision(binding);
  const capabilities = await manager.claimBootstrap(locator.bootstrapId, binding);
  const replacementBinding = capabilityBinding({ fencingEpoch: 2 });
  const replacementLocator = await manager.rotate(replacementBinding, "replacement");
  await manager.claimBootstrap(replacementLocator.bootstrapId, replacementBinding);

  const oldCapabilityId = capabilities.finalization.split(".")[0]!;
  await root.removePrivateFile(`capabilities/revoked/${sha256(oldCapabilityId)}.json`);
  assert.equal((await manager.inspectExactBinding(replacementBinding)).code, "binding_mismatch");
});

test("capability health rejects duplicate and foreign records without exposing inventory", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const root = await SecureStateRoot.openAtAccountHome(home.path);
  const manager = new RunCapabilityManager(root);
  const binding = capabilityBinding();
  const locator = await manager.provision(binding);
  await manager.claimBootstrap(locator.bootstrapId, binding);

  const names = await root.listFiles("capabilities/issued", 4_096);
  const original = await root.readPrivateJson(`capabilities/issued/${names[0]}`, 16_384) as Record<string, unknown>;
  const duplicateId = "cap-00000000000000000000000000000000";
  await root.writeImmutable(
    `capabilities/issued/${sha256(duplicateId)}.json`,
    `${JSON.stringify({ ...original, capabilityId: duplicateId })}\n`,
    16_384,
  );
  assert.equal((await manager.inspectExactBinding(binding)).code, "conflicting");

  await root.writeImmutable("capabilities/issued/not-a-record.json", "{}\n", 16_384);
  assert.equal((await manager.inspectExactBinding(binding)).code, "foreign_state");
});

test("capability health maps malformed durable records to a stable code", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const root = await SecureStateRoot.openAtAccountHome(home.path);
  const manager = new RunCapabilityManager(root);
  await root.writeImmutable(`capabilities/issued/${"0".repeat(64)}.json`, "{}\n", 16_384);
  assert.equal((await manager.inspectExactBinding(capabilityBinding())).code, "malformed");
});

test("capabilities reject stale revisions, epochs, oversized frames, and revoked tokens", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const manager = new RunCapabilityManager(
    await SecureStateRoot.openAtAccountHome(home.path),
    { now: () => 1_000_000 },
  );
  const binding = capabilityBinding();
  const locator = await manager.provision(binding);
  const capabilities = await manager.claimBootstrap(locator.bootstrapId, binding);

  await assert.rejects(
    manager.authorizeMessage({
      token: capabilities.control,
      plane: "control",
      binding,
      messageId: "control-stale-revision",
      sequence: 1,
      expectedRevision: 2,
      currentRevision: 3,
      payload: {},
    }),
    (error) => error instanceof StateSecurityError && error.code === "revision_conflict",
  );
  await assert.rejects(
    manager.authorizeMessage({
      token: capabilities.control,
      plane: "control",
      binding: capabilityBinding({ fencingEpoch: 2 }),
      messageId: "control-stale-epoch",
      sequence: 1,
      expectedRevision: 2,
      currentRevision: 2,
      payload: {},
    }),
    (error) => error instanceof StateSecurityError && error.code === "epoch_conflict",
  );
  await assert.rejects(
    manager.authorizeMessage({
      token: capabilities.progress,
      plane: "progress",
      binding,
      messageId: "progress-oversized",
      sequence: 1,
      expectedRevision: 2,
      currentRevision: 2,
      payload: { summary: "x".repeat(8_192) },
    }),
    (error) => error instanceof StateSecurityError && error.code === "oversized",
  );
  for (let sequence = 1; sequence <= 4; sequence += 1) {
    await manager.authorizeMessage({
      token: capabilities.progress,
      plane: "progress",
      binding,
      messageId: `progress-${sequence}`,
      sequence,
      expectedRevision: 2,
      currentRevision: 2,
      payload: { kind: "phase", sequence },
    });
  }
  await assert.rejects(
    manager.authorizeMessage({
      token: capabilities.progress,
      plane: "progress",
      binding,
      messageId: "progress-5",
      sequence: 5,
      expectedRevision: 2,
      currentRevision: 2,
      payload: { kind: "phase", sequence: 5 },
    }),
    (error) => error instanceof StateSecurityError && error.code === "rate_limited",
  );

  const replacement = capabilityBinding({ fencingEpoch: 2 });
  const rotated = await manager.rotate(replacement, "replacement ownership acquired");
  await assert.rejects(
    manager.authorizeMessage({
      token: capabilities.finalization,
      plane: "finalization",
      binding,
      messageId: "finish-after-rotation",
      sequence: 1,
      expectedRevision: 2,
      currentRevision: 2,
      payload: {},
    }),
    (error) => error instanceof StateSecurityError && error.code === "capability_revoked",
  );
  const replacementCapabilities = await manager.claimBootstrap(rotated.bootstrapId, replacement);
  assert.notEqual(replacementCapabilities.finalization, capabilities.finalization);
});

test("fenced leases increment epochs and reject stale ownership", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  let now = 1_000_000;
  const root = await SecureStateRoot.openAtAccountHome(home.path, { now: () => now });
  const leases = new FencedLeaseManager(root, { now: () => now });
  const binding = {
    protocolVersion: 1 as const,
    scope: "companion" as const,
    crewleadSessionId: "crewlead-session",
    herdrWorkspaceId: "workspace-1",
    canonicalProjectPath: "/work/project",
    runId: "run-1",
    memberSessionId: "member-session",
    role: "scout" as const,
  };

  const first = await leases.acquire(binding, 1_000);
  assert.equal(first.fencingEpoch, 1);
  await assert.rejects(leases.acquire(binding, 1_000), (error) => {
    return error instanceof StateSecurityError && error.code === "lease_busy";
  });
  now += 1_001;
  const second = await leases.acquire(binding, 1_000);
  assert.equal(second.fencingEpoch, 2);
  await assert.rejects(leases.assertActive(binding, second.leaseToken, 1), (error) => {
    return error instanceof StateSecurityError && error.code === "epoch_conflict";
  });
  await leases.renew(binding, second.leaseToken, 2, 1_000);
  await leases.release(binding, second.leaseToken, 2);
  await assert.rejects(leases.assertActive(binding, second.leaseToken, 2), (error) => {
    return error instanceof StateSecurityError && error.code === "lease_expired";
  });
});

test("exact lease health reports only bounded binding and fencing status", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  let now = 1_000_000;
  const root = await SecureStateRoot.openAtAccountHome(home.path, { now: () => now });
  const leases = new FencedLeaseManager(root, { now: () => now });
  const binding = {
    protocolVersion: 1 as const,
    scope: "companion" as const,
    crewleadSessionId: "crewlead-session",
    herdrWorkspaceId: "workspace-1",
    canonicalProjectPath: "/work/project",
    runId: "run-1",
    memberSessionId: "member-session",
    role: "scout" as const,
  };

  assert.equal((await leases.inspectExactBinding(binding, 1)).code, "missing");
  const lease = await leases.acquire(binding, 1_000);
  const healthy = await leases.inspectExactBinding(binding, lease.fencingEpoch);
  assert.deepEqual(healthy, { healthy: true, code: "healthy", active: true, currentEpoch: true });
  assert.deepEqual(Object.keys(healthy).sort(), ["active", "code", "currentEpoch", "healthy"]);
  assert.equal((await leases.inspectExactBinding(binding, 2)).code, "epoch_mismatch");
  now += 1_001;
  assert.equal((await leases.inspectExactBinding(binding, 1)).code, "expired");
  const replacement = await leases.acquire(binding, 1_000);
  assert.equal(replacement.fencingEpoch, 2);
  assert.equal((await leases.inspectExactBinding(binding, 1)).code, "epoch_mismatch");
  await leases.release(binding, replacement.leaseToken, 2);
  assert.equal((await leases.inspectExactBinding(binding, 2)).code, "released");
});

test("lease health rejects malformed and foreign records with stable codes", async (context) => {
  const malformedHome = await temporaryAccountHome();
  context.after(malformedHome.cleanup);
  const malformedRoot = await SecureStateRoot.openAtAccountHome(malformedHome.path);
  const binding = {
    protocolVersion: 1 as const,
    scope: "companion" as const,
    crewleadSessionId: "crewlead-session",
    herdrWorkspaceId: "workspace-1",
    canonicalProjectPath: "/work/project",
    runId: "run-1",
    memberSessionId: "member-session",
    role: "scout" as const,
  };
  await malformedRoot.writeImmutable(`leases/${sha256(bindingKey(binding))}.json`, "{}\n", 16_384);
  assert.equal((await new FencedLeaseManager(malformedRoot).inspectExactBinding(binding, 1)).code, "malformed");

  const foreignHome = await temporaryAccountHome();
  context.after(foreignHome.cleanup);
  const foreignRoot = await SecureStateRoot.openAtAccountHome(foreignHome.path);
  const leases = new FencedLeaseManager(foreignRoot);
  await leases.acquire(binding);
  const foreignBinding = { ...binding, memberSessionId: "foreign-member" };
  const source = `leases/${sha256(bindingKey(binding))}.json`;
  const target = `leases/${sha256(bindingKey(foreignBinding))}.json`;
  const raw = await foreignRoot.readPrivateJson(source, 16_384);
  await foreignRoot.writeImmutable(target, `${JSON.stringify(raw)}\n`, 16_384);
  assert.equal((await leases.inspectExactBinding(foreignBinding, 1)).code, "foreign_state");
});

test("diagnostics redact secrets, home paths, and control characters", () => {
  const value = redactDiagnostic(
    "authorization=Bearer abc123 token=sk-abcdefghijklmnopqrstuvwxyz /home/alice/project\u0007",
    { homeDirectory: "/home/alice" },
  );
  assert.equal(value.includes("abc123"), false);
  assert.equal(value.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(value.includes("/home/alice"), false);
  assert.equal(value.includes("\u0007"), false);
  assert.ok(value.length <= 256);
});
