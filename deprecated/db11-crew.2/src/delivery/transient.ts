import { LIMITS, SCHEMA_VERSION } from "../protocol/limits.ts";
import { validateContract } from "../protocol/validate.ts";
import type { RunCapabilityBinding } from "../security/binding.ts";
import { canonicalJson, sha256 } from "../security/json.ts";
import { stateError } from "../security/errors.ts";
import { assertStoredContract, serializeStoredContract } from "../state/contracts.ts";
import type { SecureStateRoot } from "../state/filesystem.ts";

export interface ProgressDestination {
  crewleadSessionId: string;
  herdrWorkspaceId: string;
  canonicalProjectPath: string;
}

export interface TransientProgressRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  recordId: string;
  destination: ProgressDestination;
  runId: string;
  fencingEpoch: number;
  createdAt: number;
  frame: Record<string, unknown>;
}

function recordPath(recordId: string): string {
  return `progress/pending/${sha256(recordId)}.json`;
}

function exactDestination(record: TransientProgressRecord, destination: ProgressDestination): boolean {
  return record.destination.crewleadSessionId === destination.crewleadSessionId &&
    record.destination.herdrWorkspaceId === destination.herdrWorkspaceId &&
    record.destination.canonicalProjectPath === destination.canonicalProjectPath;
}

function asRecord(value: unknown): TransientProgressRecord {
  assertStoredContract("transientProgress", value);
  return value as TransientProgressRecord;
}

/**
 * Best-effort private cross-process spool for sanitized progress. Records are
 * short-lived, latest-only per run, and never become lifecycle or model context.
 */
export class TransientProgressQueue {
  readonly root: SecureStateRoot;
  private readonly now: () => number;

  constructor(root: SecureStateRoot, options: { now?: () => number } = {}) {
    this.root = root;
    this.now = options.now ?? Date.now;
  }

  async enqueue(
    binding: RunCapabilityBinding,
    frameValue: Record<string, unknown>,
  ): Promise<void> {
    const validation = validateContract("progressFrame", frameValue);
    if (!validation.ok) throw stateError("invalid_record");
    if (
      frameValue.runId !== binding.runId ||
      frameValue.fencingEpoch !== binding.fencingEpoch
    ) {
      throw stateError("invalid_binding");
    }
    const progressId = frameValue.progressId;
    if (typeof progressId !== "string") throw stateError("invalid_record");
    const record: TransientProgressRecord = {
      schemaVersion: SCHEMA_VERSION,
      recordId: `transient-${sha256([
        binding.crewleadSessionId,
        binding.herdrWorkspaceId,
        binding.canonicalProjectPath,
        binding.runId,
        progressId,
      ].join("\0")).slice(0, 40)}`,
      destination: {
        crewleadSessionId: binding.crewleadSessionId,
        herdrWorkspaceId: binding.herdrWorkspaceId,
        canonicalProjectPath: binding.canonicalProjectPath,
      },
      runId: binding.runId,
      fencingEpoch: binding.fencingEpoch,
      createdAt: this.now(),
      frame: structuredClone(frameValue),
    };
    assertStoredContract("transientProgress", record);

    await this.root.withStoreLock(async () => {
      const names = await this.root.listFiles("progress/pending", LIMITS.stateDirectoryEntries);
      for (const name of names) {
        if (name.startsWith(".tmp-")) continue;
        if (!/^[a-f0-9]{64}\.json$/u.test(name)) throw stateError("foreign_state");
        const existing = asRecord(await this.root.readPrivateJson(
          `progress/pending/${name}`,
          LIMITS.progressRecordBytes,
        ));
        if (name !== recordPath(existing.recordId).split("/").at(-1)) throw stateError("foreign_state");
        if (
          exactDestination(existing, record.destination) &&
          existing.runId === record.runId
        ) {
          if (existing.recordId === record.recordId) {
            if (canonicalJson(existing, LIMITS.progressRecordBytes) !== canonicalJson(record, LIMITS.progressRecordBytes)) {
              throw stateError("idempotency_conflict");
            }
            return;
          }
          await this.root.removePrivateFile(`progress/pending/${name}`);
        }
      }
      await this.root.writeImmutable(
        recordPath(record.recordId),
        serializeStoredContract("transientProgress", record, LIMITS.progressRecordBytes),
        LIMITS.progressRecordBytes,
      );
    });
  }

  async drain(destination: ProgressDestination): Promise<readonly TransientProgressRecord[]> {
    return this.root.withStoreLock(async () => {
      const names = await this.root.listFiles("progress/pending", LIMITS.stateDirectoryEntries);
      const records: TransientProgressRecord[] = [];
      for (const name of names) {
        if (name.startsWith(".tmp-")) continue;
        if (!/^[a-f0-9]{64}\.json$/u.test(name)) throw stateError("foreign_state");
        const relative = `progress/pending/${name}`;
        const record = asRecord(await this.root.readPrivateJson(relative, LIMITS.progressRecordBytes));
        if (name !== recordPath(record.recordId).split("/").at(-1)) throw stateError("foreign_state");
        if (!exactDestination(record, destination)) continue;
        await this.root.removePrivateFile(relative);
        if (this.now() - record.createdAt <= LIMITS.progressMaximumAgeMilliseconds) {
          records.push(record);
        }
      }
      return records
        .sort((left, right) => left.createdAt - right.createdAt || left.recordId.localeCompare(right.recordId))
        .slice(-LIMITS.progressDrainFrames)
        .map((record) => structuredClone(record));
    });
  }

  async discard(destination: ProgressDestination): Promise<void> {
    await this.root.withStoreLock(async () => {
      const names = await this.root.listFiles("progress/pending", LIMITS.stateDirectoryEntries);
      for (const name of names) {
        if (name.startsWith(".tmp-")) continue;
        if (!/^[a-f0-9]{64}\.json$/u.test(name)) throw stateError("foreign_state");
        const relative = `progress/pending/${name}`;
        const record = asRecord(await this.root.readPrivateJson(relative, LIMITS.progressRecordBytes));
        if (name !== recordPath(record.recordId).split("/").at(-1)) throw stateError("foreign_state");
        if (exactDestination(record, destination)) await this.root.removePrivateFile(relative);
      }
    });
  }
}
