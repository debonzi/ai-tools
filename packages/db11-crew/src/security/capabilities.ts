import { randomBytes } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";

import type { Static } from "typebox";

import { CompanionConfigurationSchema } from "../protocol/contracts.ts";
import { validateContract } from "../protocol/validate.ts";

import { LIMITS, SCHEMA_VERSION } from "../protocol/limits.ts";
import {
  bindingsEqual,
  type RunCapabilityBinding,
  validateIdentifier,
  validateRunBinding,
} from "./binding.ts";
import { digestJson, equalDigest, sha256 } from "./json.ts";
import { redactDiagnostic } from "./redaction.ts";
import { StateSecurityError, stateError } from "./errors.ts";
import { assertStoredContract, serializeStoredContract } from "../state/contracts.ts";
import { SecureStateRoot } from "../state/filesystem.ts";

export type CapabilityPlane = "finalization" | "control" | "progress";

interface CapabilityRecordValue {
  schemaVersion: typeof SCHEMA_VERSION;
  capabilityId: string;
  bootstrapId: string;
  plane: CapabilityPlane;
  tokenDigest: string;
  binding: RunCapabilityBinding;
  issuedAt: number;
  expiresAt: number;
}

interface CapabilityReceiptValue {
  schemaVersion: typeof SCHEMA_VERSION;
  capabilityId: string;
  messageId: string;
  payloadDigest: string;
  sequence: number;
  expectedRevision: number;
  fencingEpoch: number;
  acceptedAt: number;
}

interface CapabilityRevocationValue {
  schemaVersion: typeof SCHEMA_VERSION;
  capabilityId: string;
  runId: string;
  fencingEpoch: number;
  reason: string;
  revokedAt: number;
}

interface BootstrapEntry {
  plane: CapabilityPlane;
  capabilityId: string;
  token: string;
}

export type CompanionConfiguration = Static<typeof CompanionConfigurationSchema>;

interface BootstrapRecordValue {
  schemaVersion: typeof SCHEMA_VERSION;
  bootstrapId: string;
  binding: RunCapabilityBinding;
  capabilities: BootstrapEntry[];
  configuration?: CompanionConfiguration;
  issuedAt: number;
  expiresAt: number;
}

interface BootstrapReceiptValue {
  schemaVersion: typeof SCHEMA_VERSION;
  bootstrapId: string;
  runId: string;
  fencingEpoch: number;
  capabilityIds: string[];
  claimedAt: number;
}

export interface BootstrapLocator {
  bootstrapId: string;
  bootstrapPath: string;
  expiresAt: number;
}

export interface ClaimedRunCapabilities {
  finalization: string;
  control: string;
  progress: string;
}

export interface ClaimedCompanionBootstrap {
  binding: RunCapabilityBinding;
  capabilities: ClaimedRunCapabilities;
  configuration: CompanionConfiguration;
}

export interface CapabilityMessage {
  token: string;
  plane: CapabilityPlane;
  binding: RunCapabilityBinding;
  messageId: string;
  sequence: number;
  expectedRevision: number;
  currentRevision: number;
  payload: unknown;
}

export interface CapabilityAuthorization {
  capabilityId: string;
  payloadDigest: string;
  duplicate: boolean;
}

export type CapabilityHealthCode =
  | "healthy"
  | "missing"
  | "binding_mismatch"
  | "unclaimed"
  | "revoked"
  | "expired"
  | "conflicting"
  | "malformed"
  | "foreign_state";

/** Bounded observation only: no capability identifiers, digests, or tokens. */
export interface CapabilitySetHealth {
  healthy: boolean;
  code: CapabilityHealthCode;
  finalization: boolean;
  control: boolean;
  progress: boolean;
}

export interface CapabilityManagerOptions {
  now?: () => number;
  capabilityLifetimeMilliseconds?: number;
  bootstrapLifetimeMilliseconds?: number;
}

const PLANES: readonly CapabilityPlane[] = ["finalization", "control", "progress"];

function issuedPath(capabilityId: string): string {
  return `capabilities/issued/${sha256(capabilityId)}.json`;
}

function revokedPath(capabilityId: string): string {
  return `capabilities/revoked/${sha256(capabilityId)}.json`;
}

function receiptDirectory(capabilityId: string): string {
  return `capabilities/receipts/${sha256(capabilityId)}`;
}

function receiptPath(capabilityId: string, messageId: string): string {
  return `${receiptDirectory(capabilityId)}/${sha256(messageId)}.json`;
}

function bootstrapPath(state: "pending" | "claimed", bootstrapId: string): string {
  return `bootstrap/${state}/${sha256(bootstrapId)}.json`;
}

function bootstrapReceiptPath(bootstrapId: string): string {
  return `bootstrap/receipts/${sha256(bootstrapId)}.json`;
}

function asCapability(value: unknown): CapabilityRecordValue {
  assertStoredContract("capabilityRecord", value);
  const record = value as CapabilityRecordValue;
  validateRunBinding(record.binding);
  return record;
}

function asCapabilityReceipt(value: unknown): CapabilityReceiptValue {
  assertStoredContract("capabilityReceipt", value);
  return value as CapabilityReceiptValue;
}

function asRevocation(value: unknown): CapabilityRevocationValue {
  assertStoredContract("capabilityRevocation", value);
  return value as CapabilityRevocationValue;
}

function asBootstrap(value: unknown): BootstrapRecordValue {
  assertStoredContract("bootstrapRecord", value);
  const record = value as BootstrapRecordValue;
  validateRunBinding(record.binding);
  const planes = record.capabilities.map((entry) => entry.plane).sort();
  if (planes.join(",") !== [...PLANES].sort().join(",")) throw stateError("invalid_record");
  if (new Set(record.capabilities.map((entry) => entry.capabilityId)).size !== PLANES.length) {
    throw stateError("invalid_record");
  }
  return record;
}

function asBootstrapReceipt(value: unknown): BootstrapReceiptValue {
  assertStoredContract("bootstrapReceipt", value);
  return value as BootstrapReceiptValue;
}

function parseToken(token: string): string {
  if (typeof token !== "string") throw stateError("capability_invalid");
  const [capabilityId, secret, extra] = token.split(".");
  if (
    extra !== undefined ||
    !/^cap-[a-f0-9]{32}$/.test(capabilityId ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(secret ?? "")
  ) {
    throw stateError("capability_invalid");
  }
  return capabilityId;
}

function messageMaximum(plane: CapabilityPlane): number {
  if (plane === "progress") return LIMITS.progressFrameBytes;
  if (plane === "control") return Math.max(LIMITS.amendmentBytes, LIMITS.blockerBytes);
  return LIMITS.resultBytes;
}

export class RunCapabilityManager {
  readonly root: SecureStateRoot;
  private readonly now: () => number;
  private readonly capabilityLifetime: number;
  private readonly bootstrapLifetime: number;

  constructor(root: SecureStateRoot, options: CapabilityManagerOptions = {}) {
    this.root = root;
    this.now = options.now ?? Date.now;
    this.capabilityLifetime =
      options.capabilityLifetimeMilliseconds ?? 24 * 60 * 60_000;
    this.bootstrapLifetime =
      options.bootstrapLifetimeMilliseconds ?? LIMITS.bootstrapLifetimeDefaultMilliseconds;
    if (
      !Number.isSafeInteger(this.capabilityLifetime) ||
      this.capabilityLifetime < LIMITS.leaseLifetimeMinimumMilliseconds ||
      this.capabilityLifetime > LIMITS.capabilityLifetimeMaximumMilliseconds ||
      !Number.isSafeInteger(this.bootstrapLifetime) ||
      this.bootstrapLifetime < LIMITS.leaseLifetimeMinimumMilliseconds ||
      this.bootstrapLifetime > LIMITS.bootstrapLifetimeMaximumMilliseconds ||
      this.bootstrapLifetime > this.capabilityLifetime
    ) {
      throw stateError("invalid_record");
    }
  }

  private async readCapabilityUnlocked(capabilityId: string): Promise<CapabilityRecordValue | undefined> {
    const path = issuedPath(capabilityId);
    if (!(await this.root.fileExists(path))) return undefined;
    const record = asCapability(
      await this.root.readPrivateJson(path, LIMITS.stateCapabilityBytes),
    );
    if (record.capabilityId !== capabilityId) throw stateError("foreign_state");
    return record;
  }

  private async isRevokedUnlocked(capability: CapabilityRecordValue): Promise<boolean> {
    const path = revokedPath(capability.capabilityId);
    if (!(await this.root.fileExists(path))) return false;
    const record = asRevocation(
      await this.root.readPrivateJson(path, LIMITS.stateCapabilityBytes),
    );
    if (
      record.capabilityId !== capability.capabilityId ||
      record.runId !== capability.binding.runId ||
      record.fencingEpoch !== capability.binding.fencingEpoch
    ) {
      throw stateError("foreign_state");
    }
    return true;
  }

  private async capabilitiesForRunUnlocked(runId: string): Promise<CapabilityRecordValue[]> {
    const names = await this.root.listFiles("capabilities/issued", LIMITS.stateDirectoryEntries);
    const records: CapabilityRecordValue[] = [];
    for (const name of names) {
      if (name.startsWith(".tmp-")) continue;
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw stateError("foreign_state");
      const record = asCapability(
        await this.root.readPrivateJson(
          `capabilities/issued/${name}`,
          LIMITS.stateCapabilityBytes,
        ),
      );
      if (name !== `${sha256(record.capabilityId)}.json`) throw stateError("foreign_state");
      if (record.binding.runId === runId) records.push(record);
    }
    return records;
  }

  private async revokeCapabilityUnlocked(
    record: CapabilityRecordValue,
    reason: string,
  ): Promise<void> {
    const path = revokedPath(record.capabilityId);
    if (await this.root.fileExists(path)) {
      const existing = asRevocation(
        await this.root.readPrivateJson(path, LIMITS.stateCapabilityBytes),
      );
      if (existing.capabilityId !== record.capabilityId) throw stateError("foreign_state");
      return;
    }
    const revocation: CapabilityRevocationValue = {
      schemaVersion: SCHEMA_VERSION,
      capabilityId: record.capabilityId,
      runId: record.binding.runId,
      fencingEpoch: record.binding.fencingEpoch,
      reason: redactDiagnostic(reason),
      revokedAt: this.now(),
    };
    await this.root.writeImmutable(
      path,
      serializeStoredContract(
        "capabilityRevocation",
        revocation,
        LIMITS.stateCapabilityBytes,
      ),
      LIMITS.stateCapabilityBytes,
    );
  }

  private async provisionUnlocked(
    binding: RunCapabilityBinding,
    configuration?: CompanionConfiguration,
  ): Promise<BootstrapLocator> {
    const existing = await this.capabilitiesForRunUnlocked(binding.runId);
    for (const record of existing) {
      if (!(await this.isRevokedUnlocked(record))) {
        throw stateError("capability_conflict");
      }
    }

    const now = this.now();
    const bootstrapId = `bootstrap-${randomBytes(16).toString("hex")}`;
    const entries: BootstrapEntry[] = [];
    const records: CapabilityRecordValue[] = [];
    for (const plane of PLANES) {
      const capabilityId = `cap-${randomBytes(16).toString("hex")}`;
      const token = `${capabilityId}.${randomBytes(32).toString("base64url")}`;
      entries.push({ plane, capabilityId, token });
      records.push({
        schemaVersion: SCHEMA_VERSION,
        capabilityId,
        bootstrapId,
        plane,
        tokenDigest: sha256(token),
        binding,
        issuedAt: now,
        expiresAt: now + this.capabilityLifetime,
      });
    }
    if (configuration !== undefined) {
      const validation = validateContract("companionConfiguration", configuration);
      if (!validation.ok) throw stateError("invalid_record");
      if (
        configuration.packet.role !== binding.role ||
        configuration.assignedRoot.length < 1 ||
        configuration.sourceCanonicalProjectPath !== binding.canonicalProjectPath
      ) {
        throw stateError("invalid_binding");
      }
    }
    const bootstrap: BootstrapRecordValue = {
      schemaVersion: SCHEMA_VERSION,
      bootstrapId,
      binding,
      capabilities: entries,
      ...(configuration === undefined ? {} : { configuration: structuredClone(configuration) }),
      issuedAt: now,
      expiresAt: now + this.bootstrapLifetime,
    };

    try {
      for (const record of records) {
        await this.root.writeImmutable(
          issuedPath(record.capabilityId),
          serializeStoredContract(
            "capabilityRecord",
            record,
            LIMITS.stateCapabilityBytes,
          ),
          LIMITS.stateCapabilityBytes,
        );
      }
      const relative = bootstrapPath("pending", bootstrapId);
      await this.root.writeImmutable(
        relative,
        serializeStoredContract("bootstrapRecord", bootstrap, LIMITS.stateBootstrapBytes),
        LIMITS.stateBootstrapBytes,
      );
      return {
        bootstrapId,
        bootstrapPath: this.root.absolutePath(relative),
        expiresAt: bootstrap.expiresAt,
      };
    } catch (error) {
      for (const record of records) {
        if (await this.root.fileExists(issuedPath(record.capabilityId))) {
          await this.revokeCapabilityUnlocked(record, "bootstrap provisioning did not complete");
        }
      }
      throw error;
    }
  }

  async provision(
    binding: RunCapabilityBinding,
    configuration?: CompanionConfiguration,
  ): Promise<BootstrapLocator> {
    validateRunBinding(binding);
    return this.root.withStoreLock(() => this.provisionUnlocked(binding, configuration));
  }

  private async claimBootstrapUnlocked(
    bootstrapId: string,
    binding: RunCapabilityBinding,
  ): Promise<{ capabilities: ClaimedRunCapabilities; bootstrap: BootstrapRecordValue }> {
      const pending = bootstrapPath("pending", bootstrapId);
      const claimed = bootstrapPath("claimed", bootstrapId);
      if (!(await this.root.fileExists(pending))) {
        if (
          (await this.root.fileExists(claimed)) ||
          (await this.root.fileExists(bootstrapReceiptPath(bootstrapId)))
        ) {
          throw stateError("bootstrap_used");
        }
        throw stateError("bootstrap_invalid");
      }
      const bootstrap = asBootstrap(
        await this.root.readPrivateJson(pending, LIMITS.stateBootstrapBytes),
      );
      if (bootstrap.bootstrapId !== bootstrapId || !bindingsEqual(bootstrap.binding, binding)) {
        throw stateError("bootstrap_invalid");
      }
      if (bootstrap.expiresAt <= this.now()) {
        for (const entry of bootstrap.capabilities) {
          const record = await this.readCapabilityUnlocked(entry.capabilityId);
          if (record) await this.revokeCapabilityUnlocked(record, "bootstrap expired");
        }
        await this.root.removePrivateFile(pending);
        throw stateError("bootstrap_expired");
      }

      await this.root.renameExclusive(pending, claimed);
      const receipt: BootstrapReceiptValue = {
        schemaVersion: SCHEMA_VERSION,
        bootstrapId,
        runId: binding.runId,
        fencingEpoch: binding.fencingEpoch,
        capabilityIds: bootstrap.capabilities.map((entry) => entry.capabilityId),
        claimedAt: this.now(),
      };
      try {
        await this.root.writeImmutable(
          bootstrapReceiptPath(bootstrapId),
          serializeStoredContract(
            "bootstrapReceipt",
            receipt,
            LIMITS.stateReceiptBytes,
          ),
          LIMITS.stateReceiptBytes,
        );
        await this.root.removePrivateFile(claimed);
      } catch (error) {
        for (const entry of bootstrap.capabilities) {
          const record = await this.readCapabilityUnlocked(entry.capabilityId);
          if (record) await this.revokeCapabilityUnlocked(record, "bootstrap claim did not complete");
        }
        throw error;
      }

    return {
      capabilities: Object.fromEntries(
        bootstrap.capabilities.map((entry) => [entry.plane, entry.token]),
      ) as unknown as ClaimedRunCapabilities,
      bootstrap,
    };
  }

  async claimBootstrap(
    bootstrapId: string,
    binding: RunCapabilityBinding,
  ): Promise<ClaimedRunCapabilities> {
    validateIdentifier(bootstrapId);
    validateRunBinding(binding);
    return this.root.withStoreLock(async () =>
      (await this.claimBootstrapUnlocked(bootstrapId, binding)).capabilities
    );
  }

  async claimCompanionBootstrap(
    absolutePath: string,
    expected: { memberSessionId: string; role: RunCapabilityBinding["role"] },
  ): Promise<ClaimedCompanionBootstrap> {
    if (!isAbsolute(absolutePath)) throw stateError("bootstrap_invalid");
    const relativePath = relative(this.root.path, absolutePath);
    if (
      relativePath.startsWith(`..${sep}`) ||
      relativePath === ".." ||
      !/^bootstrap\/pending\/[a-f0-9]{64}\.json$/u.test(relativePath)
    ) {
      throw stateError("bootstrap_invalid");
    }
    return this.root.withStoreLock(async () => {
      let raw: unknown;
      try {
        raw = await this.root.readPrivateJson(relativePath, LIMITS.stateBootstrapBytes);
      } catch (error) {
        if ((error as { code?: unknown }).code === "not_found") throw stateError("bootstrap_invalid");
        throw error;
      }
      const value = asBootstrap(raw);
      if (
        bootstrapPath("pending", value.bootstrapId) !== relativePath ||
        value.binding.memberSessionId !== expected.memberSessionId ||
        value.binding.role !== expected.role ||
        value.configuration === undefined
      ) {
        throw stateError("bootstrap_invalid");
      }
      const claimed = await this.claimBootstrapUnlocked(value.bootstrapId, value.binding);
      if (claimed.bootstrap.configuration === undefined) throw stateError("bootstrap_invalid");
      return {
        binding: structuredClone(claimed.bootstrap.binding),
        capabilities: claimed.capabilities,
        configuration: structuredClone(claimed.bootstrap.configuration),
      };
    });
  }

  private async bootstrapWasClaimedUnlocked(record: CapabilityRecordValue): Promise<boolean> {
    const path = bootstrapReceiptPath(record.bootstrapId);
    if (!(await this.root.fileExists(path))) return false;
    const receipt = asBootstrapReceipt(
      await this.root.readPrivateJson(path, LIMITS.stateReceiptBytes),
    );
    return (
      receipt.bootstrapId === record.bootstrapId &&
      receipt.runId === record.binding.runId &&
      receipt.fencingEpoch === record.binding.fencingEpoch &&
      receipt.capabilityIds.includes(record.capabilityId)
    );
  }

  async inspectExactBinding(binding: RunCapabilityBinding): Promise<CapabilitySetHealth> {
    validateRunBinding(binding);
    const unhealthy = (code: CapabilityHealthCode): CapabilitySetHealth => ({
      healthy: false,
      code,
      finalization: false,
      control: false,
      progress: false,
    });

    return this.root.withStoreLock(async () => {
      try {
        const records = await this.capabilitiesForRunUnlocked(binding.runId);
        if (records.length === 0) return unhealthy("missing");

        const unrevoked: CapabilityRecordValue[] = [];
        for (const record of records) {
          if (!(await this.isRevokedUnlocked(record))) unrevoked.push(record);
        }
        if (unrevoked.some((record) => !bindingsEqual(record.binding, binding))) {
          return unhealthy("binding_mismatch");
        }

        const matching = unrevoked.filter((record) => bindingsEqual(record.binding, binding));
        if (matching.length === 0) {
          return records.some((record) => bindingsEqual(record.binding, binding))
            ? unhealthy("revoked")
            : unhealthy("binding_mismatch");
        }

        const byPlane = new Map<CapabilityPlane, CapabilityRecordValue[]>();
        for (const plane of PLANES) byPlane.set(plane, []);
        for (const record of matching) byPlane.get(record.plane)!.push(record);
        if (PLANES.some((plane) => byPlane.get(plane)!.length !== 1)) {
          return unhealthy("conflicting");
        }

        let hasUnclaimed = false;
        let hasExpired = false;
        const active = Object.fromEntries(PLANES.map((plane) => [plane, false])) as Record<CapabilityPlane, boolean>;
        for (const plane of PLANES) {
          const record = byPlane.get(plane)![0]!;
          if (!(await this.bootstrapWasClaimedUnlocked(record))) hasUnclaimed = true;
          else if (record.expiresAt <= this.now()) hasExpired = true;
          else active[plane] = true;
        }
        const code: CapabilityHealthCode = hasUnclaimed
          ? "unclaimed"
          : hasExpired
            ? "expired"
            : "healthy";
        return {
          healthy: code === "healthy",
          code,
          finalization: active.finalization,
          control: active.control,
          progress: active.progress,
        };
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

  async authorizeMessage(message: CapabilityMessage): Promise<CapabilityAuthorization> {
    validateRunBinding(message.binding);
    validateIdentifier(message.messageId);
    if (
      !Number.isSafeInteger(message.sequence) ||
      message.sequence < 1 ||
      !Number.isSafeInteger(message.expectedRevision) ||
      message.expectedRevision < 0 ||
      !Number.isSafeInteger(message.currentRevision) ||
      message.currentRevision < 0
    ) {
      throw stateError("revision_conflict");
    }
    if (message.binding.fencingEpoch < 1) throw stateError("epoch_conflict");
    const capabilityId = parseToken(message.token);
    const payloadDigest = digestJson(message.payload, messageMaximum(message.plane));

    return this.root.withStoreLock(async () => {
      const record = await this.readCapabilityUnlocked(capabilityId);
      if (
        !record ||
        record.plane !== message.plane ||
        !equalDigest(record.tokenDigest, sha256(message.token))
      ) {
        throw stateError("capability_invalid");
      }
      if (record.binding.fencingEpoch !== message.binding.fencingEpoch) {
        throw stateError("epoch_conflict");
      }
      if (!bindingsEqual(record.binding, message.binding)) throw stateError("capability_invalid");
      if (await this.isRevokedUnlocked(record)) throw stateError("capability_revoked");
      if (record.expiresAt <= this.now()) throw stateError("capability_expired");
      if (!(await this.bootstrapWasClaimedUnlocked(record))) throw stateError("capability_invalid");

      const directory = receiptDirectory(capabilityId);
      await this.root.ensurePrivateDirectory(directory);
      const existingPath = receiptPath(capabilityId, message.messageId);
      if (await this.root.fileExists(existingPath)) {
        const existing = asCapabilityReceipt(
          await this.root.readPrivateJson(existingPath, LIMITS.stateReceiptBytes),
        );
        if (
          existing.capabilityId === capabilityId &&
          existing.messageId === message.messageId &&
          equalDigest(existing.payloadDigest, payloadDigest) &&
          existing.sequence === message.sequence &&
          existing.expectedRevision === message.expectedRevision &&
          existing.fencingEpoch === message.binding.fencingEpoch
        ) {
          return { capabilityId, payloadDigest, duplicate: true };
        }
        throw stateError("replay_conflict");
      }
      if (message.expectedRevision !== message.currentRevision) {
        throw stateError("revision_conflict");
      }

      const names = await this.root.listFiles(directory, LIMITS.capabilityReceipts);
      const sequences = new Set<number>();
      let maximumSequence = 0;
      let recentProgressReceipts = 0;
      const now = this.now();
      for (const name of names) {
        if (name.startsWith(".tmp-")) continue;
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw stateError("foreign_state");
        const receipt = asCapabilityReceipt(
          await this.root.readPrivateJson(`${directory}/${name}`, LIMITS.stateReceiptBytes),
        );
        if (receipt.capabilityId !== capabilityId || sequences.has(receipt.sequence)) {
          throw stateError("foreign_state");
        }
        sequences.add(receipt.sequence);
        maximumSequence = Math.max(maximumSequence, receipt.sequence);
        if (message.plane === "progress" && receipt.acceptedAt > now - 1_000) {
          recentProgressReceipts += 1;
        }
      }
      if (names.length >= LIMITS.capabilityReceipts) throw stateError("capability_exhausted");
      if (message.sequence !== maximumSequence + 1) throw stateError("stale_sequence");
      if (
        message.plane === "progress" &&
        recentProgressReceipts >= LIMITS.progressEventsPerSecond
      ) {
        throw stateError("rate_limited");
      }

      const receipt: CapabilityReceiptValue = {
        schemaVersion: SCHEMA_VERSION,
        capabilityId,
        messageId: message.messageId,
        payloadDigest,
        sequence: message.sequence,
        expectedRevision: message.expectedRevision,
        fencingEpoch: message.binding.fencingEpoch,
        acceptedAt: this.now(),
      };
      await this.root.writeImmutable(
        existingPath,
        serializeStoredContract(
          "capabilityReceipt",
          receipt,
          LIMITS.stateReceiptBytes,
        ),
        LIMITS.stateReceiptBytes,
      );
      return { capabilityId, payloadDigest, duplicate: false };
    });
  }

  async nextSequence(
    token: string,
    plane: CapabilityPlane,
    binding: RunCapabilityBinding,
  ): Promise<number> {
    validateRunBinding(binding);
    const capabilityId = parseToken(token);
    return this.root.withStoreLock(async () => {
      const record = await this.readCapabilityUnlocked(capabilityId);
      if (
        !record ||
        record.plane !== plane ||
        !equalDigest(record.tokenDigest, sha256(token)) ||
        !bindingsEqual(record.binding, binding) ||
        await this.isRevokedUnlocked(record) ||
        !(await this.bootstrapWasClaimedUnlocked(record))
      ) {
        throw stateError("capability_invalid");
      }
      if (record.expiresAt <= this.now()) throw stateError("capability_expired");
      await this.root.ensurePrivateDirectory(receiptDirectory(capabilityId));
      let maximum = 0;
      for (const name of await this.root.listFiles(receiptDirectory(capabilityId), LIMITS.capabilityReceipts)) {
        if (name.startsWith(".tmp-")) continue;
        if (!/^[a-f0-9]{64}\.json$/u.test(name)) throw stateError("foreign_state");
        const receipt = asCapabilityReceipt(
          await this.root.readPrivateJson(`${receiptDirectory(capabilityId)}/${name}`, LIMITS.stateReceiptBytes),
        );
        if (receipt.capabilityId !== capabilityId) throw stateError("foreign_state");
        maximum = Math.max(maximum, receipt.sequence);
      }
      return maximum + 1;
    });
  }

  async revokeClaimedCapabilities(
    binding: RunCapabilityBinding,
    capabilities: Readonly<ClaimedRunCapabilities>,
    reason: string,
  ): Promise<number> {
    validateRunBinding(binding);
    const selected = PLANES.map((plane) => ({
      plane,
      token: capabilities[plane],
      capabilityId: parseToken(capabilities[plane]),
    }));
    if (new Set(selected.map((entry) => entry.capabilityId)).size !== PLANES.length) {
      throw stateError("capability_invalid");
    }

    return this.root.withStoreLock(async () => {
      const authenticated: CapabilityRecordValue[] = [];
      for (const entry of selected) {
        const record = await this.readCapabilityUnlocked(entry.capabilityId);
        if (
          !record ||
          record.plane !== entry.plane ||
          !equalDigest(record.tokenDigest, sha256(entry.token)) ||
          !bindingsEqual(record.binding, binding)
        ) {
          throw stateError("capability_invalid");
        }
        authenticated.push(record);
      }

      const bootstrapIds = new Set(authenticated.map((record) => record.bootstrapId));
      if (bootstrapIds.size !== 1) throw stateError("capability_invalid");
      const bootstrapId = authenticated[0]!.bootstrapId;
      const receiptPath = bootstrapReceiptPath(bootstrapId);
      if (!(await this.root.fileExists(receiptPath))) throw stateError("capability_invalid");
      const receipt = asBootstrapReceipt(
        await this.root.readPrivateJson(receiptPath, LIMITS.stateReceiptBytes),
      );
      const selectedIds = authenticated.map((record) => record.capabilityId).sort();
      const receiptIds = [...receipt.capabilityIds].sort();
      if (
        receipt.bootstrapId !== bootstrapId ||
        receipt.runId !== binding.runId ||
        receipt.fencingEpoch !== binding.fencingEpoch ||
        new Set(receiptIds).size !== PLANES.length ||
        receiptIds.length !== PLANES.length ||
        receiptIds.some((capabilityId, index) => capabilityId !== selectedIds[index])
      ) {
        throw stateError("capability_invalid");
      }

      const revocationState: boolean[] = [];
      for (const record of authenticated) {
        revocationState.push(await this.isRevokedUnlocked(record));
      }
      let revoked = 0;
      for (let index = 0; index < authenticated.length; index += 1) {
        if (!revocationState[index]) {
          await this.revokeCapabilityUnlocked(authenticated[index]!, reason);
          revoked += 1;
        }
      }
      return revoked;
    });
  }

  async revokeRun(runId: string, reason: string): Promise<number> {
    validateIdentifier(runId);
    return this.root.withStoreLock(async () => {
      const records = await this.capabilitiesForRunUnlocked(runId);
      let revoked = 0;
      for (const record of records) {
        if (!(await this.isRevokedUnlocked(record))) {
          await this.revokeCapabilityUnlocked(record, reason);
          revoked += 1;
        }
      }
      return revoked;
    });
  }

  async rotate(
    binding: RunCapabilityBinding,
    reason: string,
    configuration?: CompanionConfiguration,
  ): Promise<BootstrapLocator> {
    validateRunBinding(binding);
    return this.root.withStoreLock(async () => {
      for (const record of await this.capabilitiesForRunUnlocked(binding.runId)) {
        if (!(await this.isRevokedUnlocked(record))) {
          await this.revokeCapabilityUnlocked(record, reason);
        }
      }
      return this.provisionUnlocked(binding, configuration);
    });
  }

  async recoverOneTimeBootstraps(): Promise<number> {
    return this.root.withStoreLock(async () => {
      let recovered = 0;
      for (const state of ["claimed", "pending"] as const) {
        const directory = `bootstrap/${state}`;
        const names = await this.root.listFiles(directory, LIMITS.stateDirectoryEntries);
        for (const name of names) {
          if (name.startsWith(".tmp-")) continue;
          if (!/^[a-f0-9]{64}\.json$/.test(name)) throw stateError("foreign_state");
          const relative = `${directory}/${name}`;
          const bootstrap = asBootstrap(
            await this.root.readPrivateJson(relative, LIMITS.stateBootstrapBytes),
          );
          if (name !== `${sha256(bootstrap.bootstrapId)}.json`) throw stateError("foreign_state");
          if (state === "pending" && bootstrap.expiresAt > this.now()) continue;
          for (const entry of bootstrap.capabilities) {
            const record = await this.readCapabilityUnlocked(entry.capabilityId);
            if (record) await this.revokeCapabilityUnlocked(record, "one-time bootstrap recovery");
          }
          await this.root.removePrivateFile(relative);
          recovered += 1;
        }
      }
      return recovered;
    });
  }
}
