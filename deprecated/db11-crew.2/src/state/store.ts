import { validateContract } from "../protocol/validate.ts";
import { LIMITS, SCHEMA_VERSION } from "../protocol/limits.ts";
import { validateIdentifier } from "../security/binding.ts";
import { canonicalJson, digestJson, equalDigest, sha256 } from "../security/json.ts";
import { stateError } from "../security/errors.ts";
import {
  assertStoredContract,
  serializeStoredContract,
  type StoredContractKind,
} from "./contracts.ts";
import {
  SecureStateRoot,
  type SecureStateRootOptions,
} from "./filesystem.ts";

const EMPTY_HISTORY_DIGEST = "0".repeat(64);

export type HistoryKind = "lifecycle" | "control" | "result" | "delivery";

export interface HistoryInput {
  kind: HistoryKind;
  payload: unknown;
}

export interface CommitRunRequest {
  operationId: string;
  expectedRevision: number;
  expectedFencingEpoch: number;
  run: Record<string, unknown>;
  history: HistoryInput[];
}

export interface CommitRunResult {
  run: Record<string, unknown>;
  idempotent: boolean;
}

export type TransactionFaultPhase =
  | "after_prepare"
  | "after_batch_prepare"
  | "after_batch_transaction"
  | "after_history_record"
  | "after_history"
  | "after_snapshot"
  | "after_receipt";

export interface DurableStateStoreOptions extends SecureStateRootOptions {
  faultInjector?: (phase: TransactionFaultPhase, detail?: number) => void | Promise<void>;
}

export interface AtomicRunMutation<Value> {
  requests: readonly CommitRunRequest[];
  value: Value;
}

interface RunSnapshotValue {
  schemaVersion: typeof SCHEMA_VERSION;
  run: Record<string, unknown>;
  historySequence: number;
  historyDigest: string;
}

interface HistoryRecordValue {
  schemaVersion: typeof SCHEMA_VERSION;
  recordId: string;
  runId: string;
  sequence: number;
  operationId: string;
  operationDigest: string;
  previousDigest: string;
  expectedRevision: number;
  resultingRevision: number;
  fencingEpoch: number;
  timestamp: string;
  kind: HistoryKind;
  payload: unknown;
  resultingRun: Record<string, unknown>;
}

interface ReceiptValue {
  schemaVersion: typeof SCHEMA_VERSION;
  operationId: string;
  operationDigest: string;
  runId: string;
  resultingRevision: number;
  snapshotDigest: string;
  committedAt: string;
}

interface TransactionValue {
  schemaVersion: typeof SCHEMA_VERSION;
  transactionId: string;
  operationId: string;
  operationDigest: string;
  runId: string;
  expectedRevision: number;
  resultingRevision: number;
  records: HistoryRecordValue[];
  snapshot: RunSnapshotValue;
  receipt: ReceiptValue;
  createdAt: string;
}

interface BatchTransactionValue {
  schemaVersion: typeof SCHEMA_VERSION;
  batchId: string;
  transactions: TransactionValue[];
  createdAt: string;
}

function runKey(runId: string): string {
  validateIdentifier(runId);
  return sha256(runId);
}

function operationKey(runId: string, operationId: string): string {
  validateIdentifier(operationId);
  return sha256(`${runId}\0${operationId}`);
}

function snapshotPath(runId: string): string {
  return `snapshots/${runKey(runId)}.json`;
}

function historyDirectory(runId: string): string {
  return `history/runs/${runKey(runId)}`;
}

function historyPath(record: HistoryRecordValue): string {
  const sequence = record.sequence.toString().padStart(10, "0");
  return `${historyDirectory(record.runId)}/${sequence}-${sha256(record.recordId).slice(0, 24)}.json`;
}

function receiptPath(runId: string, operationId: string): string {
  return `idempotency/${operationKey(runId, operationId)}.json`;
}

function transactionPath(runId: string, operationId: string): string {
  return `transactions/${operationKey(runId, operationId)}.json`;
}

function batchPath(batchId: string): string {
  validateIdentifier(batchId);
  return `batches/${sha256(batchId)}.json`;
}

function successful(result: ReturnType<typeof validateContract>): boolean {
  return result.ok;
}

function assertRun(value: unknown): asserts value is Record<string, unknown> {
  if (!successful(validateContract("run", value))) throw stateError("invalid_record");
}

function assertHistoryPayload(kind: HistoryKind, payload: unknown): void {
  if (kind === "lifecycle") {
    if (!successful(validateContract("event", payload))) throw stateError("invalid_record");
    return;
  }
  if (kind === "result") {
    if (!successful(validateContract("result", payload))) throw stateError("invalid_record");
    return;
  }
  if (kind === "delivery") {
    if (
      !successful(validateContract("deliveryEnvelope", payload)) &&
      !storedCheck("deliveryAction", payload)
    ) {
      throw stateError("invalid_record");
    }
    return;
  }
  if (
    !successful(validateContract("taskPacket", payload)) &&
    !successful(validateContract("amendment", payload)) &&
    !successful(validateContract("blocker", payload)) &&
    !successful(validateContract("cancellationCheckpoint", payload)) &&
    !storedCheck("controlAction", payload)
  ) {
    throw stateError("invalid_record");
  }
}

function storedCheck(kind: StoredContractKind, value: unknown): boolean {
  try {
    assertStoredContract(kind, value);
    return true;
  } catch {
    return false;
  }
}

function recordRunId(kind: HistoryKind, payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const value = payload as Record<string, unknown>;
  return typeof value.runId === "string" ? value.runId : undefined;
}

function asSnapshot(value: unknown): RunSnapshotValue {
  assertStoredContract("runSnapshot", value);
  return value as RunSnapshotValue;
}

function asReceipt(value: unknown): ReceiptValue {
  assertStoredContract("idempotencyReceipt", value);
  return value as ReceiptValue;
}

function asTransaction(value: unknown): TransactionValue {
  assertStoredContract("transaction", value);
  return value as TransactionValue;
}

function asBatchTransaction(value: unknown): BatchTransactionValue {
  assertStoredContract("batchTransaction", value);
  return value as BatchTransactionValue;
}

function asHistoryRecord(value: unknown): HistoryRecordValue {
  assertStoredContract("historyRecord", value);
  return value as HistoryRecordValue;
}

function exactTimestamp(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw stateError("invalid_record");
  return value;
}

export class DurableStateStore {
  readonly root: SecureStateRoot;
  private readonly faultInjector?: DurableStateStoreOptions["faultInjector"];

  private constructor(root: SecureStateRoot, options: DurableStateStoreOptions) {
    this.root = root;
    this.faultInjector = options.faultInjector;
  }

  static async openRoot(
    root: SecureStateRoot,
    options: DurableStateStoreOptions = {},
  ): Promise<DurableStateStore> {
    const store = new DurableStateStore(root, options);
    await store.recoverTransactions();
    return store;
  }

  static async openDefault(options: DurableStateStoreOptions = {}): Promise<DurableStateStore> {
    return DurableStateStore.openRoot(await SecureStateRoot.openDefault(options), options);
  }

  static async openAtAccountHome(
    accountHome: string,
    options: DurableStateStoreOptions = {},
  ): Promise<DurableStateStore> {
    return DurableStateStore.openRoot(
      await SecureStateRoot.openAtAccountHome(accountHome, options),
      options,
    );
  }

  private async fault(phase: TransactionFaultPhase, detail?: number): Promise<void> {
    await this.faultInjector?.(phase, detail);
  }

  private async readSnapshotUnlocked(runId: string): Promise<RunSnapshotValue | undefined> {
    const path = snapshotPath(runId);
    if (!(await this.root.fileExists(path))) return undefined;
    const snapshot = asSnapshot(await this.root.readPrivateJson(path, LIMITS.stateSnapshotBytes));
    if (snapshot.run.runId !== runId) throw stateError("foreign_state");
    return snapshot;
  }

  private async readReceiptUnlocked(
    runId: string,
    operationId: string,
  ): Promise<ReceiptValue | undefined> {
    const path = receiptPath(runId, operationId);
    if (!(await this.root.fileExists(path))) return undefined;
    const receipt = asReceipt(await this.root.readPrivateJson(path, LIMITS.stateReceiptBytes));
    if (receipt.runId !== runId || receipt.operationId !== operationId) throw stateError("foreign_state");
    return receipt;
  }

  private validateRequest(request: CommitRunRequest): void {
    validateIdentifier(request.operationId);
    if (request.operationId.length > 128) throw stateError("invalid_record");
    assertRun(request.run);
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 0 ||
      !Number.isSafeInteger(request.expectedFencingEpoch) ||
      request.expectedFencingEpoch < 0 ||
      request.run.revision !== request.expectedRevision + 1
    ) {
      throw stateError("revision_conflict");
    }
    const nextEpoch = request.run.fencingEpoch;
    if (
      typeof nextEpoch !== "number" ||
      nextEpoch < 1 ||
      nextEpoch < request.expectedFencingEpoch ||
      nextEpoch > request.expectedFencingEpoch + 1
    ) {
      throw stateError("epoch_conflict");
    }
    if (
      request.history.length < 1 ||
      request.history.length > LIMITS.stateTransactionRecords
    ) {
      throw stateError("oversized");
    }

    const runId = request.run.runId;
    if (typeof runId !== "string") throw stateError("invalid_record");
    let lifecycleCount = 0;
    for (const input of request.history) {
      assertHistoryPayload(input.kind, input.payload);
      const payloadRunId = recordRunId(input.kind, input.payload);
      const admissionPacket =
        input.kind === "control" &&
        payloadRunId === undefined &&
        request.expectedRevision === 0 &&
        successful(validateContract("taskPacket", input.payload)) &&
        (input.payload as Record<string, unknown>).packetId === request.run.packetId;
      if (payloadRunId !== runId && !admissionPacket) throw stateError("invalid_record");
      if (input.kind === "lifecycle") {
        lifecycleCount += 1;
        const event = input.payload as Record<string, unknown>;
        if (
          event.expectedRevision !== request.expectedRevision ||
          event.resultingRevision !== request.run.revision ||
          event.resultingState !== request.run.state ||
          event.fencingEpoch !== request.run.fencingEpoch
        ) {
          throw stateError("invalid_record");
        }
      }
      if (input.kind === "control" && !admissionPacket) {
        const control = input.payload as Record<string, unknown>;
        if (control.expectedRevision !== request.expectedRevision) throw stateError("invalid_record");
      }
      if (input.kind === "result") {
        const result = input.payload as Record<string, unknown>;
        if (
          request.run.resultId !== result.resultId ||
          request.run.resultDigest !== digestJson(result, LIMITS.resultBytes)
        ) {
          throw stateError("invalid_record");
        }
      }
    }
    if (lifecycleCount !== 1) throw stateError("invalid_record");
  }

  private buildTransaction(
    request: CommitRunRequest,
    previous: RunSnapshotValue | undefined,
  ): TransactionValue {
    const runId = request.run.runId as string;
    const timestamp = exactTimestamp(request.run.updatedAt);
    const operationDigest = digestJson(
      {
        expectedRevision: request.expectedRevision,
        expectedFencingEpoch: request.expectedFencingEpoch,
        run: request.run,
        history: request.history,
      },
      LIMITS.stateTransactionBytes,
    );
    let previousDigest = previous?.historyDigest ?? EMPTY_HISTORY_DIGEST;
    let sequence = previous?.historySequence ?? 0;
    const records: HistoryRecordValue[] = [];
    for (const [index, input] of request.history.entries()) {
      sequence += 1;
      if (sequence > LIMITS.stateHistoryRecordsPerRun) throw stateError("oversized");
      const record: HistoryRecordValue = {
        schemaVersion: SCHEMA_VERSION,
        recordId: `${request.operationId}:${index + 1}`,
        runId,
        sequence,
        operationId: request.operationId,
        operationDigest,
        previousDigest,
        expectedRevision: request.expectedRevision,
        resultingRevision: request.expectedRevision + 1,
        fencingEpoch: request.run.fencingEpoch as number,
        timestamp,
        kind: input.kind,
        payload: input.payload,
        resultingRun: structuredClone(request.run),
      };
      assertStoredContract("historyRecord", record);
      previousDigest = digestJson(record, LIMITS.stateHistoryRecordBytes);
      records.push(record);
    }
    const snapshot: RunSnapshotValue = {
      schemaVersion: SCHEMA_VERSION,
      run: structuredClone(request.run),
      historySequence: sequence,
      historyDigest: previousDigest,
    };
    assertStoredContract("runSnapshot", snapshot);
    const snapshotDigest = digestJson(snapshot, LIMITS.stateSnapshotBytes);
    const receipt: ReceiptValue = {
      schemaVersion: SCHEMA_VERSION,
      operationId: request.operationId,
      operationDigest,
      runId,
      resultingRevision: request.expectedRevision + 1,
      snapshotDigest,
      committedAt: timestamp,
    };
    assertStoredContract("idempotencyReceipt", receipt);
    const transaction: TransactionValue = {
      schemaVersion: SCHEMA_VERSION,
      transactionId: `tx-${sha256(`${runId}\0${request.operationId}\0${operationDigest}`).slice(0, 32)}`,
      operationId: request.operationId,
      operationDigest,
      runId,
      expectedRevision: request.expectedRevision,
      resultingRevision: request.expectedRevision + 1,
      records,
      snapshot,
      receipt,
      createdAt: timestamp,
    };
    assertStoredContract("transaction", transaction);
    return transaction;
  }

  private async materializeRecord(record: HistoryRecordValue): Promise<void> {
    const path = historyPath(record);
    const serialized = serializeStoredContract(
      "historyRecord",
      record,
      LIMITS.stateHistoryRecordBytes,
    );
    if (await this.root.fileExists(path)) {
      const existing = asHistoryRecord(
        await this.root.readPrivateJson(path, LIMITS.stateHistoryRecordBytes),
      );
      if (canonicalJson(existing, LIMITS.stateHistoryRecordBytes) !== serialized) {
        throw stateError("transaction_conflict");
      }
      return;
    }
    await this.root.writeImmutable(path, serialized, LIMITS.stateHistoryRecordBytes);
  }

  private async applyTransactionUnlocked(
    transaction: TransactionValue,
    injectFaults: boolean,
  ): Promise<void> {
    assertStoredContract("transaction", transaction);
    await this.root.ensurePrivateDirectory(historyDirectory(transaction.runId));
    const current = await this.readSnapshotUnlocked(transaction.runId);
    const currentRevision = (current?.run.revision as number | undefined) ?? 0;
    const targetSnapshot = serializeStoredContract(
      "runSnapshot",
      transaction.snapshot,
      LIMITS.stateSnapshotBytes,
    );

    if (currentRevision === transaction.expectedRevision) {
      for (const [index, record] of transaction.records.entries()) {
        await this.materializeRecord(record);
        if (injectFaults) await this.fault("after_history_record", index + 1);
      }
      if (injectFaults) await this.fault("after_history");
      if (current) {
        await this.root.atomicWrite(
          snapshotPath(transaction.runId),
          targetSnapshot,
          LIMITS.stateSnapshotBytes,
        );
      } else {
        await this.root.writeImmutable(
          snapshotPath(transaction.runId),
          targetSnapshot,
          LIMITS.stateSnapshotBytes,
        );
      }
      if (injectFaults) await this.fault("after_snapshot");
    } else if (
      currentRevision !== transaction.resultingRevision ||
      canonicalJson(current, LIMITS.stateSnapshotBytes) !== targetSnapshot
    ) {
      throw stateError("transaction_conflict");
    } else {
      for (const record of transaction.records) await this.materializeRecord(record);
    }

    const receiptFile = receiptPath(transaction.runId, transaction.operationId);
    const receiptText = serializeStoredContract(
      "idempotencyReceipt",
      transaction.receipt,
      LIMITS.stateReceiptBytes,
    );
    if (await this.root.fileExists(receiptFile)) {
      const existing = asReceipt(
        await this.root.readPrivateJson(receiptFile, LIMITS.stateReceiptBytes),
      );
      if (canonicalJson(existing, LIMITS.stateReceiptBytes) !== receiptText) {
        throw stateError("transaction_conflict");
      }
    } else {
      await this.root.writeImmutable(receiptFile, receiptText, LIMITS.stateReceiptBytes);
    }
    if (injectFaults) await this.fault("after_receipt");
    await this.root.removePrivateFile(
      transactionPath(transaction.runId, transaction.operationId),
      true,
    );
  }

  private async applyBatchTransactionUnlocked(batch: BatchTransactionValue): Promise<void> {
    assertStoredContract("batchTransaction", batch);
    for (const transaction of batch.transactions) {
      await this.applyTransactionUnlocked(transaction, false);
    }
    await this.root.removePrivateFile(batchPath(batch.batchId), true);
  }

  private async recoverTransactionsUnlocked(): Promise<number> {
    let recovered = 0;
    const batchNames = await this.root.listFiles("batches", LIMITS.stateDirectoryEntries);
    for (const name of batchNames) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) {
        if (name.startsWith(".tmp-")) continue;
        throw stateError("foreign_state");
      }
      const batch = asBatchTransaction(
        await this.root.readPrivateJson(`batches/${name}`, LIMITS.stateBatchTransactionBytes),
      );
      if (name !== batchPath(batch.batchId).split("/").at(-1)) throw stateError("foreign_state");
      await this.applyBatchTransactionUnlocked(batch);
      recovered += batch.transactions.length;
    }

    const names = await this.root.listFiles("transactions", LIMITS.stateDirectoryEntries);
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) {
        if (name.startsWith(".tmp-")) continue;
        throw stateError("foreign_state");
      }
      const transaction = asTransaction(
        await this.root.readPrivateJson(`transactions/${name}`, LIMITS.stateTransactionBytes),
      );
      if (name !== `${operationKey(transaction.runId, transaction.operationId)}.json`) {
        throw stateError("foreign_state");
      }
      await this.applyTransactionUnlocked(transaction, false);
      recovered += 1;
    }
    return recovered;
  }

  async recoverTransactions(): Promise<number> {
    return this.root.withStoreLock(() => this.recoverTransactionsUnlocked());
  }

  private async listRunsUnlocked(): Promise<Record<string, unknown>[]> {
    const names = await this.root.listFiles("snapshots", LIMITS.stateDirectoryEntries);
    const runs: Record<string, unknown>[] = [];
    for (const name of names) {
      if (name.startsWith(".tmp-")) continue;
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw stateError("foreign_state");
      const snapshot = asSnapshot(
        await this.root.readPrivateJson(`snapshots/${name}`, LIMITS.stateSnapshotBytes),
      );
      const runId = snapshot.run.runId;
      if (typeof runId !== "string" || name !== `${runKey(runId)}.json`) {
        throw stateError("foreign_state");
      }
      runs.push((await this.deriveRunSnapshotUnlocked(runId)).run);
    }
    return runs.sort((left, right) => String(left.runId).localeCompare(String(right.runId)));
  }

  private async commitBatchUnlocked(requests: readonly CommitRunRequest[]): Promise<void> {
    if (requests.length < 1 || requests.length > LIMITS.stateBatchTransactions) {
      throw stateError("oversized");
    }
    const runIds = new Set<string>();
    const transactions: TransactionValue[] = [];
    for (const request of requests) {
      this.validateRequest(request);
      const runId = request.run.runId as string;
      if (runIds.has(runId)) throw stateError("transaction_conflict");
      runIds.add(runId);
      const previous = await this.readSnapshotUnlocked(runId);
      const currentRevision = (previous?.run.revision as number | undefined) ?? 0;
      const currentEpoch = (previous?.run.fencingEpoch as number | undefined) ?? 0;
      if (currentRevision !== request.expectedRevision) throw stateError("revision_conflict");
      if (currentEpoch !== request.expectedFencingEpoch) throw stateError("epoch_conflict");
      if (await this.readReceiptUnlocked(runId, request.operationId)) {
        throw stateError("idempotency_conflict");
      }
      transactions.push(this.buildTransaction(request, previous));
    }

    const batchId = `batch-${sha256(canonicalJson(
      transactions.map((transaction) => transaction.transactionId),
      LIMITS.stateBatchTransactionBytes,
    )).slice(0, 32)}`;
    const batch: BatchTransactionValue = {
      schemaVersion: SCHEMA_VERSION,
      batchId,
      transactions,
      createdAt: transactions[0]!.createdAt,
    };
    assertStoredContract("batchTransaction", batch);
    await this.root.writeImmutable(
      batchPath(batchId),
      serializeStoredContract(
        "batchTransaction",
        batch,
        LIMITS.stateBatchTransactionBytes,
      ),
      LIMITS.stateBatchTransactionBytes,
    );
    await this.fault("after_batch_prepare");
    for (const [index, transaction] of transactions.entries()) {
      await this.applyTransactionUnlocked(transaction, true);
      await this.fault("after_batch_transaction", index + 1);
    }
    await this.root.removePrivateFile(batchPath(batchId), true);
  }

  async listRuns(): Promise<readonly Record<string, unknown>[]> {
    return this.root.withStoreLock(async () => {
      await this.recoverTransactionsUnlocked();
      return (await this.listRunsUnlocked()).map((run) => structuredClone(run));
    });
  }

  async atomicMutateRuns<Value>(
    build: (runs: readonly Readonly<Record<string, unknown>>[]) => AtomicRunMutation<Value>,
  ): Promise<Value> {
    return this.root.withStoreLock(async () => {
      await this.recoverTransactionsUnlocked();
      const runs = (await this.listRunsUnlocked()).map((run) => Object.freeze(structuredClone(run)));
      const mutation = build(Object.freeze(runs));
      if (mutation.requests.length > 0) await this.commitBatchUnlocked(mutation.requests);
      return mutation.value;
    });
  }

  async commitRun(request: CommitRunRequest): Promise<CommitRunResult> {
    this.validateRequest(request);
    return this.root.withStoreLock(async () => {
      await this.recoverTransactionsUnlocked();
      const runId = request.run.runId as string;
      const previous = await this.readSnapshotUnlocked(runId);
      const transaction = this.buildTransaction(request, previous);
      const existingReceipt = await this.readReceiptUnlocked(runId, request.operationId);
      if (existingReceipt) {
        if (!equalDigest(existingReceipt.operationDigest, transaction.operationDigest)) {
          throw stateError("idempotency_conflict");
        }
        const current = await this.deriveRunSnapshotUnlocked(runId);
        if ((current.run.revision as number) < existingReceipt.resultingRevision) {
          throw stateError("transaction_conflict");
        }
        const operationRecords = (await this.readHistoryRecordsUnlocked(runId)).filter(
          (record) => record.operationId === request.operationId,
        );
        const lastRecord = operationRecords.at(-1);
        if (
          !lastRecord ||
          operationRecords.some(
            (record) =>
              record.resultingRevision !== existingReceipt.resultingRevision ||
              !equalDigest(record.operationDigest, existingReceipt.operationDigest),
          )
        ) {
          throw stateError("transaction_conflict");
        }
        const historicalSnapshot: RunSnapshotValue = {
          schemaVersion: SCHEMA_VERSION,
          run: lastRecord.resultingRun,
          historySequence: lastRecord.sequence,
          historyDigest: digestJson(lastRecord, LIMITS.stateHistoryRecordBytes),
        };
        if (
          !equalDigest(
            digestJson(historicalSnapshot, LIMITS.stateSnapshotBytes),
            existingReceipt.snapshotDigest,
          )
        ) {
          throw stateError("transaction_conflict");
        }
        return { run: current.run, idempotent: true };
      }

      const currentRevision = (previous?.run.revision as number | undefined) ?? 0;
      const currentEpoch = (previous?.run.fencingEpoch as number | undefined) ?? 0;
      if (currentRevision !== request.expectedRevision) throw stateError("revision_conflict");
      if (currentEpoch !== request.expectedFencingEpoch) throw stateError("epoch_conflict");

      const path = transactionPath(runId, request.operationId);
      await this.root.writeImmutable(
        path,
        serializeStoredContract("transaction", transaction, LIMITS.stateTransactionBytes),
        LIMITS.stateTransactionBytes,
      );
      await this.fault("after_prepare");
      await this.applyTransactionUnlocked(transaction, true);
      return { run: transaction.snapshot.run, idempotent: false };
    });
  }

  private async readHistoryRecordsUnlocked(runId: string): Promise<HistoryRecordValue[]> {
    let names: string[];
    try {
      names = await this.root.listFiles(
        historyDirectory(runId),
        LIMITS.stateHistoryRecordsPerRun,
      );
    } catch (error) {
      throw stateError("foreign_state", error);
    }
    const records: HistoryRecordValue[] = [];
    for (const name of names) {
      if (name.startsWith(".tmp-")) continue;
      if (!/^[0-9]{10}-[a-f0-9]{24}\.json$/.test(name)) throw stateError("foreign_state");
      const record = asHistoryRecord(
        await this.root.readPrivateJson(
          `${historyDirectory(runId)}/${name}`,
          LIMITS.stateHistoryRecordBytes,
        ),
      );
      if (record.runId !== runId || name !== historyPath(record).split("/").at(-1)) {
        throw stateError("foreign_state");
      }
      records.push(record);
    }
    return records.sort((left, right) => left.sequence - right.sequence);
  }

  private async deriveRunSnapshotUnlocked(runId: string): Promise<RunSnapshotValue> {
    const cached = await this.readSnapshotUnlocked(runId);
    if (!cached) throw stateError("not_found");
    const records = await this.readHistoryRecordsUnlocked(runId);
    if (records.length < 1) throw stateError("foreign_state");

    let sequence = 0;
    let digest = EMPTY_HISTORY_DIGEST;
    let latestRun: Record<string, unknown> | undefined;
    let lastRevision = 0;
    let lastOperation = "";
    for (const record of records) {
      if (record.sequence !== sequence + 1 || record.previousDigest !== digest) {
        throw stateError("foreign_state");
      }
      if (record.operationId !== lastOperation) {
        if (record.expectedRevision !== lastRevision || record.resultingRevision !== lastRevision + 1) {
          throw stateError("foreign_state");
        }
        lastRevision = record.resultingRevision;
        lastOperation = record.operationId;
      } else if (record.resultingRevision !== lastRevision) {
        throw stateError("foreign_state");
      }
      sequence = record.sequence;
      digest = digestJson(record, LIMITS.stateHistoryRecordBytes);
      latestRun = record.resultingRun;
    }

    const derived: RunSnapshotValue = {
      schemaVersion: SCHEMA_VERSION,
      run: latestRun!,
      historySequence: sequence,
      historyDigest: digest,
    };
    assertStoredContract("runSnapshot", derived);
    if (
      canonicalJson(derived, LIMITS.stateSnapshotBytes) !==
      canonicalJson(cached, LIMITS.stateSnapshotBytes)
    ) {
      throw stateError("foreign_state");
    }
    return derived;
  }

  async readRun(runId: string): Promise<Record<string, unknown>> {
    validateIdentifier(runId);
    return this.root.withStoreLock(async () => {
      await this.recoverTransactionsUnlocked();
      return (await this.deriveRunSnapshotUnlocked(runId)).run;
    });
  }

  async readHistory(runId: string): Promise<readonly Record<string, unknown>[]> {
    validateIdentifier(runId);
    return this.root.withStoreLock(async () => {
      await this.recoverTransactionsUnlocked();
      await this.deriveRunSnapshotUnlocked(runId);
      return (await this.readHistoryRecordsUnlocked(runId)).map(
        (record) => record as unknown as Record<string, unknown>,
      );
    });
  }
}
