import assert from "node:assert/strict";
import test from "node:test";

import { StateSecurityError } from "../../src/security/errors.ts";
import { DurableDeliveryClaims } from "../../src/state/claims.ts";
import { SecureStateRoot } from "../../src/state/filesystem.ts";
import { deliveryEnvelope, temporaryAccountHome } from "./helpers.ts";

const destination = {
  crewleadSessionId: "crewlead-session",
  herdrWorkspaceId: "workspace-1",
};

test("delivery claims support exact-destination claim, restore, recovery, and acknowledgement", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const root = await SecureStateRoot.openAtAccountHome(home.path);
  const claims = new DurableDeliveryClaims(root, { now: () => Date.parse("2026-08-20T12:00:00Z") });
  const envelope = deliveryEnvelope();

  assert.equal((await claims.enqueue(envelope)).idempotent, false);
  assert.equal((await claims.enqueue(envelope)).idempotent, true);
  const claimed = await claims.claim("delivery-1", destination);
  assert.equal(claimed.envelope.deliveryId, "delivery-1");

  await assert.rejects(claims.claim("delivery-1", destination), (error) => {
    return error instanceof StateSecurityError && error.code === "claim_conflict";
  });
  await claims.restore("delivery-1", claimed.claimId, destination);
  const reclaimed = await claims.claim("delivery-1", destination);
  assert.equal(reclaimed.claimId, claimed.claimId);
  assert.equal(await claims.recoverClaims(destination), 1);

  const finalClaim = await claims.claim("delivery-1", destination);
  assert.equal((await claims.acknowledge("delivery-1", finalClaim.claimId, destination)).idempotent, false);
  assert.equal((await claims.acknowledge("delivery-1", finalClaim.claimId, destination)).idempotent, true);
  assert.equal(await claims.deliveredAtForRun(destination, "run-1"), "2026-08-20T12:00:00.000Z");
  assert.equal(await claims.deliveredAtForRun(destination, "other-run"), undefined);
});

test("claim destination mismatches fail closed and preserve the pending envelope", async (context) => {
  const home = await temporaryAccountHome();
  context.after(home.cleanup);
  const claims = new DurableDeliveryClaims(await SecureStateRoot.openAtAccountHome(home.path));
  await claims.enqueue(deliveryEnvelope());

  await assert.rejects(
    claims.claim("delivery-1", { ...destination, crewleadSessionId: "other-session" }),
    (error) => error instanceof StateSecurityError && error.code === "claim_invalid",
  );
  const claimed = await claims.claim("delivery-1", destination);
  assert.equal(claimed.envelope.deliveryId, "delivery-1");
});
