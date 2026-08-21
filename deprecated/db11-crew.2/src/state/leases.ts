import { randomBytes } from "node:crypto";

import { LIMITS, SCHEMA_VERSION } from "../protocol/limits.ts";
import {
  bindingKey,
  type LeaseBinding,
  validateLeaseBinding,
} from "../security/binding.ts";
import { equalDigest, sha256 } from "../security/json.ts";
import { StateSecurityError, stateError } from "../security/errors.ts";
import { assertStoredContract, serializeStoredContract } from "./contracts.ts";
import { SecureStateRoot } from "./filesystem.ts";

interface LeaseRecordValue {
  schemaVersion: typeof SCHEMA_VERSION;
  leaseId: string;
  tokenDigest: string;
  binding: LeaseBinding;
  fencingEpoch: number;
  status: "active" | "released";
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
}

export interface FencedLease {
  leaseToken: string;
  fencingEpoch: number;
  expiresAt: number;
}

export interface LeaseManagerOptions {
  now?: () => number;
}

export type LeaseHealthCode =
  | "healthy"
  | "missing"
  | "released"
  | "expired"
  | "epoch_mismatch"
  | "malformed"
  | "foreign_state";

/** Bounded observation only: no lease identifier, digest, or token. */
export interface LeaseHealth {
  healthy: boolean;
  code: LeaseHealthCode;
  active: boolean;
  currentEpoch: boolean;
}

function leasePath(binding: LeaseBinding): string {
  return `leases/${sha256(bindingKey(binding))}.json`;
}

function asLease(value: unknown): LeaseRecordValue {
  assertStoredContract("leaseRecord", value);
  return value as LeaseRecordValue;
}

function validateLifetime(milliseconds: number): void {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < LIMITS.leaseLifetimeMinimumMilliseconds ||
    milliseconds > LIMITS.leaseLifetimeMaximumMilliseconds
  ) {
    throw stateError("invalid_record");
  }
}

function parseLeaseToken(token: string): string {
  const [leaseId, secret, extra] = token.split(".");
  if (extra !== undefined || !/^lease-[a-f0-9]{32}$/.test(leaseId ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(secret ?? "")) {
    throw stateError("lease_invalid");
  }
  return leaseId;
}

export class FencedLeaseManager {
  readonly root: SecureStateRoot;
  private readonly now: () => number;

  constructor(root: SecureStateRoot, options: LeaseManagerOptions = {}) {
    this.root = root;
    this.now = options.now ?? Date.now;
  }

  private async readUnlocked(binding: LeaseBinding): Promise<LeaseRecordValue | undefined> {
    const path = leasePath(binding);
    if (!(await this.root.fileExists(path))) return undefined;
    const lease = asLease(await this.root.readPrivateJson(path, LIMITS.stateLeaseBytes));
    if (bindingKey(lease.binding) !== bindingKey(binding)) throw stateError("foreign_state");
    return lease;
  }

  async inspectExactBinding(
    binding: LeaseBinding,
    expectedEpoch: number,
  ): Promise<LeaseHealth> {
    validateLeaseBinding(binding);
    if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1 || expectedEpoch > 2_147_483_647) {
      throw stateError("epoch_conflict");
    }
    const unhealthy = (code: LeaseHealthCode): LeaseHealth => ({
      healthy: false,
      code,
      active: false,
      currentEpoch: false,
    });
    return this.root.withStoreLock(async () => {
      try {
        const current = await this.readUnlocked(binding);
        if (!current) return unhealthy("missing");
        if (current.fencingEpoch !== expectedEpoch) return unhealthy("epoch_mismatch");
        if (current.status === "released") {
          return { ...unhealthy("released"), currentEpoch: true };
        }
        if (current.expiresAt <= this.now()) {
          return { ...unhealthy("expired"), currentEpoch: true };
        }
        return { healthy: true, code: "healthy", active: true, currentEpoch: true };
      } catch (error) {
        if (error instanceof StateSecurityError && error.code === "foreign_state") {
          return unhealthy("foreign_state");
        }
        if (error instanceof StateSecurityError && error.code === "invalid_record") {
          return unhealthy("malformed");
        }
        throw error;
      }
    });
  }

  async acquire(
    binding: LeaseBinding,
    lifetimeMilliseconds: number = LIMITS.leaseLifetimeDefaultMilliseconds,
  ): Promise<FencedLease> {
    validateLeaseBinding(binding);
    validateLifetime(lifetimeMilliseconds);
    return this.root.withStoreLock(async () => {
      const current = await this.readUnlocked(binding);
      const now = this.now();
      if (current?.status === "active" && current.expiresAt > now) throw stateError("lease_busy");
      const fencingEpoch = (current?.fencingEpoch ?? 0) + 1;
      if (fencingEpoch > 2_147_483_647) throw stateError("epoch_conflict");
      const leaseId = `lease-${randomBytes(16).toString("hex")}`;
      const leaseToken = `${leaseId}.${randomBytes(32).toString("base64url")}`;
      const record: LeaseRecordValue = {
        schemaVersion: SCHEMA_VERSION,
        leaseId,
        tokenDigest: sha256(leaseToken),
        binding,
        fencingEpoch,
        status: "active",
        acquiredAt: now,
        renewedAt: now,
        expiresAt: now + lifetimeMilliseconds,
      };
      const path = leasePath(binding);
      const serialized = serializeStoredContract(
        "leaseRecord",
        record,
        LIMITS.stateLeaseBytes,
      );
      if (current) {
        await this.root.atomicWrite(path, serialized, LIMITS.stateLeaseBytes);
      } else {
        await this.root.writeImmutable(path, serialized, LIMITS.stateLeaseBytes);
      }
      return { leaseToken, fencingEpoch, expiresAt: record.expiresAt };
    });
  }

  private authenticate(
    current: LeaseRecordValue | undefined,
    leaseToken: string,
    expectedEpoch: number,
  ): LeaseRecordValue {
    const leaseId = parseLeaseToken(leaseToken);
    if (
      !current ||
      current.leaseId !== leaseId ||
      !equalDigest(current.tokenDigest, sha256(leaseToken))
    ) {
      throw stateError("lease_invalid");
    }
    if (current.fencingEpoch !== expectedEpoch) throw stateError("epoch_conflict");
    if (current.status !== "active" || current.expiresAt <= this.now()) {
      throw stateError("lease_expired");
    }
    return current;
  }

  async renew(
    binding: LeaseBinding,
    leaseToken: string,
    expectedEpoch: number,
    lifetimeMilliseconds: number = LIMITS.leaseLifetimeDefaultMilliseconds,
  ): Promise<FencedLease> {
    validateLeaseBinding(binding);
    validateLifetime(lifetimeMilliseconds);
    return this.root.withStoreLock(async () => {
      const current = this.authenticate(
        await this.readUnlocked(binding),
        leaseToken,
        expectedEpoch,
      );
      const renewed: LeaseRecordValue = {
        ...current,
        renewedAt: this.now(),
        expiresAt: this.now() + lifetimeMilliseconds,
      };
      await this.root.atomicWrite(
        leasePath(binding),
        serializeStoredContract("leaseRecord", renewed, LIMITS.stateLeaseBytes),
        LIMITS.stateLeaseBytes,
      );
      return {
        leaseToken,
        fencingEpoch: renewed.fencingEpoch,
        expiresAt: renewed.expiresAt,
      };
    });
  }

  async assertActive(
    binding: LeaseBinding,
    leaseToken: string,
    expectedEpoch: number,
  ): Promise<void> {
    validateLeaseBinding(binding);
    await this.root.withStoreLock(async () => {
      this.authenticate(await this.readUnlocked(binding), leaseToken, expectedEpoch);
    });
  }

  async release(
    binding: LeaseBinding,
    leaseToken: string,
    expectedEpoch: number,
  ): Promise<void> {
    validateLeaseBinding(binding);
    await this.root.withStoreLock(async () => {
      const current = this.authenticate(
        await this.readUnlocked(binding),
        leaseToken,
        expectedEpoch,
      );
      const released: LeaseRecordValue = {
        ...current,
        status: "released",
        renewedAt: this.now(),
        expiresAt: this.now(),
      };
      await this.root.atomicWrite(
        leasePath(binding),
        serializeStoredContract("leaseRecord", released, LIMITS.stateLeaseBytes),
        LIMITS.stateLeaseBytes,
      );
    });
  }
}
