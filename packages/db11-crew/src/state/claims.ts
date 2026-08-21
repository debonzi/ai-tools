import { randomBytes } from "node:crypto";

import { LIMITS, SCHEMA_VERSION } from "../protocol/limits.ts";
import { validateContract } from "../protocol/validate.ts";
import { validateIdentifier } from "../security/binding.ts";
import { digestJson, equalDigest, sha256 } from "../security/json.ts";
import { stateError } from "../security/errors.ts";
import { assertStoredContract, serializeStoredContract } from "./contracts.ts";
import { SecureStateRoot } from "./filesystem.ts";

export interface DeliveryDestination {
  crewleadSessionId: string;
  herdrWorkspaceId: string;
}

export interface NotificationDestination extends DeliveryDestination {
  canonicalProjectPath: string;
}

export interface NotificationReceipt {
  schemaVersion: typeof SCHEMA_VERSION;
  notificationId: string;
  destination: NotificationDestination;
  runId: string;
  kind: "terminal" | "blocker";
  sourceId: string;
  createdAt: string;
}

interface DeliveryClaimValue {
  schemaVersion: typeof SCHEMA_VERSION;
  claimId: string;
  envelopeDigest: string;
  envelope: Record<string, unknown>;
  deliveredAt?: string;
}

export interface ClaimedDelivery {
  claimId: string;
  envelopeDigest: string;
  envelope: Record<string, unknown>;
}

function key(deliveryId: string): string {
  validateIdentifier(deliveryId);
  return sha256(deliveryId);
}

function path(state: "pending" | "claimed" | "delivered", deliveryId: string): string {
  return `deliveries/${state}/${key(deliveryId)}.json`;
}

function asClaim(value: unknown): DeliveryClaimValue {
  assertStoredContract("deliveryClaim", value);
  return value as DeliveryClaimValue;
}

function exactDestination(envelope: Record<string, unknown>, expected: DeliveryDestination): boolean {
  const destination = envelope.destination;
  if (destination === null || typeof destination !== "object" || Array.isArray(destination)) {
    return false;
  }
  const value = destination as Record<string, unknown>;
  return (
    value.crewleadSessionId === expected.crewleadSessionId &&
    value.herdrWorkspaceId === expected.herdrWorkspaceId
  );
}

export class DurableDeliveryClaims {
  readonly root: SecureStateRoot;
  readonly #now: () => number;

  constructor(root: SecureStateRoot, options: { now?: () => number } = {}) {
    this.root = root;
    this.#now = options.now ?? Date.now;
  }

  private async findUnlocked(
    deliveryId: string,
  ): Promise<{ state: "pending" | "claimed" | "delivered"; value: DeliveryClaimValue } | undefined> {
    for (const state of ["pending", "claimed", "delivered"] as const) {
      const candidate = path(state, deliveryId);
      if (await this.root.fileExists(candidate)) {
        const value = asClaim(
          await this.root.readPrivateJson(candidate, LIMITS.stateClaimBytes),
        );
        if (value.envelope.deliveryId !== deliveryId) throw stateError("foreign_state");
        return { state, value };
      }
    }
    return undefined;
  }

  async enqueue(envelope: Record<string, unknown>): Promise<{ idempotent: boolean }> {
    const validated = validateContract("deliveryEnvelope", envelope);
    if (!validated.ok) throw stateError("invalid_record");
    const deliveryId = envelope.deliveryId;
    if (typeof deliveryId !== "string") throw stateError("invalid_record");
    const envelopeDigest = digestJson(envelope, LIMITS.deliveryEnvelopeBytes);
    return this.root.withStoreLock(async () => {
      const existing = await this.findUnlocked(deliveryId);
      if (existing) {
        if (!equalDigest(existing.value.envelopeDigest, envelopeDigest)) {
          throw stateError("idempotency_conflict");
        }
        return { idempotent: true };
      }
      const claim: DeliveryClaimValue = {
        schemaVersion: SCHEMA_VERSION,
        claimId: `claim-${randomBytes(16).toString("hex")}`,
        envelopeDigest,
        envelope,
      };
      await this.root.writeImmutable(
        path("pending", deliveryId),
        serializeStoredContract("deliveryClaim", claim, LIMITS.stateClaimBytes),
        LIMITS.stateClaimBytes,
      );
      return { idempotent: false };
    });
  }

  async listPending(
    destination: DeliveryDestination,
    maximum = LIMITS.stateDirectoryEntries,
  ): Promise<readonly Record<string, unknown>[]> {
    validateIdentifier(destination.crewleadSessionId);
    validateIdentifier(destination.herdrWorkspaceId);
    return this.root.withStoreLock(async () => {
      const names = await this.root.listFiles("deliveries/pending", maximum);
      const envelopes: Record<string, unknown>[] = [];
      for (const name of names) {
        if (name.startsWith(".tmp-")) continue;
        if (!/^[a-f0-9]{64}\.json$/u.test(name)) throw stateError("foreign_state");
        const claim = asClaim(await this.root.readPrivateJson(
          `deliveries/pending/${name}`,
          LIMITS.stateClaimBytes,
        ));
        const deliveryId = claim.envelope.deliveryId;
        if (typeof deliveryId !== "string" || name !== `${key(deliveryId)}.json`) {
          throw stateError("foreign_state");
        }
        if (exactDestination(claim.envelope, destination)) envelopes.push(structuredClone(claim.envelope));
      }
      return envelopes.sort((left, right) =>
        String(left.createdAt).localeCompare(String(right.createdAt)) ||
        String(left.deliveryId).localeCompare(String(right.deliveryId)));
    });
  }

  async listUndeliveredRunIds(destination: DeliveryDestination): Promise<ReadonlySet<string>> {
    validateIdentifier(destination.crewleadSessionId);
    validateIdentifier(destination.herdrWorkspaceId);
    return this.root.withStoreLock(async () => {
      const runIds = new Set<string>();
      for (const state of ["pending", "claimed"] as const) {
        const names = await this.root.listFiles(`deliveries/${state}`, LIMITS.stateDirectoryEntries);
        for (const name of names) {
          if (name.startsWith(".tmp-")) continue;
          if (!/^[a-f0-9]{64}\.json$/u.test(name)) throw stateError("foreign_state");
          const claim = asClaim(await this.root.readPrivateJson(
            `deliveries/${state}/${name}`,
            LIMITS.stateClaimBytes,
          ));
          const deliveryId = claim.envelope.deliveryId;
          if (typeof deliveryId !== "string" || name !== `${key(deliveryId)}.json`) {
            throw stateError("foreign_state");
          }
          if (exactDestination(claim.envelope, destination) && typeof claim.envelope.runId === "string") {
            runIds.add(claim.envelope.runId);
          }
        }
      }
      return runIds;
    });
  }

  async deliveredAtForRun(
    destination: DeliveryDestination,
    runId: string,
  ): Promise<string | undefined> {
    validateIdentifier(destination.crewleadSessionId);
    validateIdentifier(destination.herdrWorkspaceId);
    validateIdentifier(runId);
    return this.root.withStoreLock(async () => {
      const names = await this.root.listFiles("deliveries/delivered", LIMITS.stateDirectoryEntries);
      let deliveredAt: string | undefined;
      for (const name of names) {
        if (name.startsWith(".tmp-")) continue;
        if (!/^[a-f0-9]{64}\.json$/u.test(name)) throw stateError("foreign_state");
        const claim = asClaim(await this.root.readPrivateJson(`deliveries/delivered/${name}`, LIMITS.stateClaimBytes));
        const deliveryId = claim.envelope.deliveryId;
        if (typeof deliveryId !== "string" || name !== `${key(deliveryId)}.json`) throw stateError("foreign_state");
        if (exactDestination(claim.envelope, destination) && claim.envelope.runId === runId) {
          if (!claim.deliveredAt) throw stateError("foreign_state");
          if (!deliveredAt || claim.deliveredAt > deliveredAt) deliveredAt = claim.deliveredAt;
        }
      }
      return deliveredAt;
    });
  }

  async claim(
    deliveryId: string,
    destination: DeliveryDestination,
  ): Promise<ClaimedDelivery> {
    validateIdentifier(destination.crewleadSessionId);
    validateIdentifier(destination.herdrWorkspaceId);
    return this.root.withStoreLock(async () => {
      const existing = await this.findUnlocked(deliveryId);
      if (!existing) throw stateError("not_found");
      if (existing.state !== "pending") throw stateError("claim_conflict");
      if (!exactDestination(existing.value.envelope, destination)) throw stateError("claim_invalid");
      await this.root.renameExclusive(path("pending", deliveryId), path("claimed", deliveryId));
      return {
        claimId: existing.value.claimId,
        envelopeDigest: existing.value.envelopeDigest,
        envelope: existing.value.envelope,
      };
    });
  }

  async restore(
    deliveryId: string,
    claimId: string,
    destination: DeliveryDestination,
  ): Promise<void> {
    validateIdentifier(claimId);
    return this.root.withStoreLock(async () => {
      const existing = await this.findUnlocked(deliveryId);
      if (!existing || existing.state !== "claimed") throw stateError("claim_invalid");
      if (
        existing.value.claimId !== claimId ||
        !exactDestination(existing.value.envelope, destination)
      ) {
        throw stateError("claim_invalid");
      }
      await this.root.renameExclusive(path("claimed", deliveryId), path("pending", deliveryId));
    });
  }

  async acknowledge(
    deliveryId: string,
    claimId: string,
    destination: DeliveryDestination,
  ): Promise<{ idempotent: boolean }> {
    validateIdentifier(claimId);
    return this.root.withStoreLock(async () => {
      const existing = await this.findUnlocked(deliveryId);
      if (!existing) throw stateError("claim_invalid");
      if (
        existing.value.claimId !== claimId ||
        !exactDestination(existing.value.envelope, destination)
      ) {
        throw stateError("claim_invalid");
      }
      if (existing.state === "delivered") return { idempotent: true };
      if (existing.state !== "claimed") throw stateError("claim_invalid");
      existing.value.deliveredAt = new Date(this.#now()).toISOString();
      await this.root.atomicWrite(
        path("claimed", deliveryId),
        serializeStoredContract("deliveryClaim", existing.value, LIMITS.stateClaimBytes),
        LIMITS.stateClaimBytes,
      );
      await this.root.renameExclusive(path("claimed", deliveryId), path("delivered", deliveryId));
      return { idempotent: false };
    });
  }

  async recoverClaims(destination: DeliveryDestination): Promise<number> {
    validateIdentifier(destination.crewleadSessionId);
    validateIdentifier(destination.herdrWorkspaceId);
    return this.root.withStoreLock(async () => {
      const names = await this.root.listFiles("deliveries/claimed", LIMITS.stateDirectoryEntries);
      let restored = 0;
      for (const name of names) {
        if (name.startsWith(".tmp-")) continue;
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw stateError("foreign_state");
        const relative = `deliveries/claimed/${name}`;
        const claim = asClaim(
          await this.root.readPrivateJson(relative, LIMITS.stateClaimBytes),
        );
        if (!exactDestination(claim.envelope, destination)) continue;
        const deliveryId = claim.envelope.deliveryId;
        if (typeof deliveryId !== "string" || name !== `${key(deliveryId)}.json`) {
          throw stateError("foreign_state");
        }
        await this.root.renameExclusive(relative, path("pending", deliveryId));
        restored += 1;
      }
      return restored;
    });
  }
}

function notificationPath(notificationId: string): string {
  validateIdentifier(notificationId);
  return `claims/notifications/${sha256(notificationId)}.json`;
}

function exactNotificationDestination(
  receipt: NotificationReceipt,
  destination: NotificationDestination,
): boolean {
  return receipt.destination.crewleadSessionId === destination.crewleadSessionId &&
    receipt.destination.herdrWorkspaceId === destination.herdrWorkspaceId &&
    receipt.destination.canonicalProjectPath === destination.canonicalProjectPath;
}

/** Durable suppression for one bounded human notification per stable source ID. */
export class DurableNotificationReceipts {
  readonly root: SecureStateRoot;

  constructor(root: SecureStateRoot) {
    this.root = root;
  }

  async reserve(receipt: NotificationReceipt): Promise<{ idempotent: boolean }> {
    assertStoredContract("notificationReceipt", receipt);
    const path = notificationPath(receipt.notificationId);
    const serialized = serializeStoredContract(
      "notificationReceipt",
      receipt,
      LIMITS.stateNotificationBytes,
    );
    return this.root.withStoreLock(async () => {
      if (await this.root.fileExists(path)) {
        const existing = await this.root.readPrivateJson(path, LIMITS.stateNotificationBytes);
        assertStoredContract("notificationReceipt", existing);
        const value = existing as NotificationReceipt;
        if (
          value.notificationId !== receipt.notificationId ||
          value.runId !== receipt.runId ||
          value.kind !== receipt.kind ||
          value.sourceId !== receipt.sourceId ||
          !exactNotificationDestination(value, receipt.destination)
        ) {
          throw stateError("idempotency_conflict");
        }
        return { idempotent: true };
      }
      await this.root.writeImmutable(path, serialized, LIMITS.stateNotificationBytes);
      return { idempotent: false };
    });
  }

  async release(notificationId: string, destination: NotificationDestination): Promise<void> {
    await this.root.withStoreLock(async () => {
      const path = notificationPath(notificationId);
      if (!(await this.root.fileExists(path))) return;
      const receipt = await this.root.readPrivateJson(path, LIMITS.stateNotificationBytes) as NotificationReceipt;
      assertStoredContract("notificationReceipt", receipt);
      if (!exactNotificationDestination(receipt, destination)) throw stateError("claim_invalid");
      await this.root.removePrivateFile(path);
    });
  }
}
