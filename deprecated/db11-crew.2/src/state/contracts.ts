import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import Type, { type TObjectOptions, type TProperties, type TSchema } from "typebox";
import type SchemaModule from "typebox/schema";

import {
  AmendmentSchema,
  BlockerSchema,
  CancellationCheckpointSchema,
  CompanionConfigurationSchema,
  DeliveryEnvelopeSchema,
  EventSchema,
  ProgressFrameSchema,
  ResultSchema,
  RunSchema,
  TaskPacketSchema,
} from "../protocol/contracts.ts";
import { LIMITS, SCHEMA_VERSION } from "../protocol/limits.ts";
import { canonicalJson } from "../security/json.ts";
import { stateError } from "../security/errors.ts";

const require = createRequire(import.meta.url);
const typeboxBuild = dirname(require.resolve("typebox"));
const Schema = require(join(typeboxBuild, "schema", "index.mjs")).default as typeof SchemaModule;

function closed<const Properties extends TProperties>(
  properties: Properties,
  options: TObjectOptions = {},
) {
  return Type.Object(properties, { ...options, additionalProperties: false });
}

const Identifier = Type.String({
  minLength: 1,
  maxLength: 160,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});
const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Revision = Type.Integer({ minimum: 0, maximum: 2_147_483_647 });
const Sequence = Type.Integer({ minimum: 1, maximum: 2_147_483_647 });
const Timestamp = Type.String({
  minLength: 20,
  maxLength: 32,
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,6})?Z$",
});
const Summary = Type.String({ minLength: 1, maxLength: LIMITS.summaryLength });
const ReferenceList = Type.Array(Type.String({ minLength: 1, maxLength: LIMITS.referenceLength }), {
  maxItems: LIMITS.listItems,
  uniqueItems: true,
});

export const ControlActionSchema = closed({
  schemaVersion: Type.Literal(SCHEMA_VERSION),
  controlId: Identifier,
  runId: Identifier,
  type: Type.Union(
    [
      "cancel_requested",
      "cancel_acknowledged",
      "force_requested",
      "abandon_requested",
      "cleanup_requested",
      "cleanup_completed",
      "recovery_requested",
      "capabilities_rotated",
      "result_acknowledged",
    ].map((value) => Type.Literal(value)),
  ),
  actor: Type.Union(
    ["crewlead", "companion", "human", "recovery"].map((value) => Type.Literal(value)),
  ),
  reason: Summary,
  expectedRevision: Revision,
  fencingEpoch: Revision,
  timestamp: Timestamp,
  evidenceRefs: ReferenceList,
});

export const DeliveryActionSchema = closed({
  schemaVersion: Type.Literal(SCHEMA_VERSION),
  deliveryId: Identifier,
  runId: Identifier,
  type: Type.Union(
    ["enqueued", "claimed", "restored", "acknowledged"].map((value) => Type.Literal(value)),
  ),
  revision: Revision,
  actorId: Identifier,
  envelopeDigest: Digest,
  timestamp: Timestamp,
});

const ControlPayload = Type.Union([
  TaskPacketSchema,
  AmendmentSchema,
  BlockerSchema,
  CancellationCheckpointSchema,
  ControlActionSchema,
]);
const DeliveryPayload = Type.Union([DeliveryEnvelopeSchema, DeliveryActionSchema]);
const HistoryBase = {
  schemaVersion: Type.Literal(SCHEMA_VERSION),
  recordId: Identifier,
  runId: Identifier,
  sequence: Sequence,
  operationId: Identifier,
  operationDigest: Digest,
  previousDigest: Digest,
  expectedRevision: Revision,
  resultingRevision: Sequence,
  fencingEpoch: Revision,
  timestamp: Timestamp,
  resultingRun: RunSchema,
};

export const HistoryRecordSchema = Type.Union([
  closed({ ...HistoryBase, kind: Type.Literal("lifecycle"), payload: EventSchema }),
  closed({ ...HistoryBase, kind: Type.Literal("control"), payload: ControlPayload }),
  closed({ ...HistoryBase, kind: Type.Literal("result"), payload: ResultSchema }),
  closed({ ...HistoryBase, kind: Type.Literal("delivery"), payload: DeliveryPayload }),
]);

export const RunSnapshotSchema = closed({
  schemaVersion: Type.Literal(SCHEMA_VERSION),
  run: RunSchema,
  historySequence: Sequence,
  historyDigest: Digest,
});

export const IdempotencyReceiptSchema = closed({
  schemaVersion: Type.Literal(SCHEMA_VERSION),
  operationId: Identifier,
  operationDigest: Digest,
  runId: Identifier,
  resultingRevision: Sequence,
  snapshotDigest: Digest,
  committedAt: Timestamp,
});

export const TransactionSchema = closed({
  schemaVersion: Type.Literal(SCHEMA_VERSION),
  transactionId: Identifier,
  operationId: Identifier,
  operationDigest: Digest,
  runId: Identifier,
  expectedRevision: Revision,
  resultingRevision: Sequence,
  records: Type.Array(HistoryRecordSchema, {
    minItems: 1,
    maxItems: LIMITS.stateTransactionRecords,
  }),
  snapshot: RunSnapshotSchema,
  receipt: IdempotencyReceiptSchema,
  createdAt: Timestamp,
});

export const BatchTransactionSchema = closed({
  schemaVersion: Type.Literal(SCHEMA_VERSION),
  batchId: Identifier,
  transactions: Type.Array(TransactionSchema, {
    minItems: 1,
    maxItems: LIMITS.stateBatchTransactions,
  }),
  createdAt: Timestamp,
});

export const DeliveryClaimSchema = closed({
  schemaVersion: Type.Literal(SCHEMA_VERSION),
  claimId: Identifier,
  envelopeDigest: Digest,
  envelope: DeliveryEnvelopeSchema,
  deliveredAt: Type.Optional(Timestamp),
});

const NotificationDestinationSchema = closed({
  crewleadSessionId: Identifier,
  herdrWorkspaceId: Identifier,
  canonicalProjectPath: Type.String({ minLength: 1, maxLength: LIMITS.pathLength, pattern: "^/" }),
});
export const NotificationReceiptSchema = closed({
  schemaVersion: Type.Literal(SCHEMA_VERSION),
  notificationId: Identifier,
  destination: NotificationDestinationSchema,
  runId: Identifier,
  kind: Type.Union([Type.Literal("terminal"), Type.Literal("blocker")]),
  sourceId: Identifier,
  createdAt: Timestamp,
});
export const TransientProgressSchema = closed({
  schemaVersion: Type.Literal(SCHEMA_VERSION),
  recordId: Identifier,
  destination: NotificationDestinationSchema,
  runId: Identifier,
  fencingEpoch: Revision,
  createdAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  frame: ProgressFrameSchema,
});

const LeaseBindingBase = {
  protocolVersion: Type.Literal(SCHEMA_VERSION),
  crewleadSessionId: Identifier,
  herdrWorkspaceId: Identifier,
  canonicalProjectPath: Type.String({ minLength: 1, maxLength: LIMITS.pathLength, pattern: "^/" }),
};
const LeaseBindingSchema = Type.Union([
  closed({ ...LeaseBindingBase, scope: Type.Literal("supervisor") }),
  closed({
    ...LeaseBindingBase,
    scope: Type.Literal("companion"),
    runId: Identifier,
    memberSessionId: Identifier,
    role: Type.Union(["scout", "planner", "builder"].map((value) => Type.Literal(value))),
  }),
]);
export const LeaseRecordSchema = closed({
  schemaVersion: Type.Literal(SCHEMA_VERSION),
  leaseId: Identifier,
  tokenDigest: Digest,
  binding: LeaseBindingSchema,
  fencingEpoch: Sequence,
  status: Type.Union([Type.Literal("active"), Type.Literal("released")]),
  acquiredAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  renewedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  expiresAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});

const CapabilityBindingSchema = closed({
  protocolVersion: Type.Literal(SCHEMA_VERSION),
  crewleadSessionId: Identifier,
  herdrWorkspaceId: Identifier,
  canonicalProjectPath: Type.String({ minLength: 1, maxLength: LIMITS.pathLength, pattern: "^/" }),
  runId: Identifier,
  memberSessionId: Identifier,
  role: Type.Union(["scout", "planner", "builder"].map((value) => Type.Literal(value))),
  fencingEpoch: Sequence,
});
const CapabilityPlane = Type.Union(
  ["finalization", "control", "progress"].map((value) => Type.Literal(value)),
);
export const CapabilityRecordSchema = closed({
  schemaVersion: Type.Literal(SCHEMA_VERSION),
  capabilityId: Identifier,
  bootstrapId: Identifier,
  plane: CapabilityPlane,
  tokenDigest: Digest,
  binding: CapabilityBindingSchema,
  issuedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  expiresAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});
export const CapabilityReceiptSchema = closed({
  schemaVersion: Type.Literal(SCHEMA_VERSION),
  capabilityId: Identifier,
  messageId: Identifier,
  payloadDigest: Digest,
  sequence: Sequence,
  expectedRevision: Revision,
  fencingEpoch: Sequence,
  acceptedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});
export const CapabilityRevocationSchema = closed({
  schemaVersion: Type.Literal(SCHEMA_VERSION),
  capabilityId: Identifier,
  runId: Identifier,
  fencingEpoch: Sequence,
  reason: Type.String({ minLength: 1, maxLength: LIMITS.diagnosticLength }),
  revokedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});
const BootstrapCapability = closed({
  plane: CapabilityPlane,
  capabilityId: Identifier,
  token: Type.String({ minLength: 80, maxLength: 128, pattern: "^cap-[a-f0-9]{32}\\.[A-Za-z0-9_-]{43}$" }),
});
export const BootstrapRecordSchema = closed({
  schemaVersion: Type.Literal(SCHEMA_VERSION),
  bootstrapId: Identifier,
  binding: CapabilityBindingSchema,
  capabilities: Type.Array(BootstrapCapability, { minItems: 3, maxItems: 3 }),
  configuration: Type.Optional(CompanionConfigurationSchema),
  issuedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  expiresAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});
export const BootstrapReceiptSchema = closed({
  schemaVersion: Type.Literal(SCHEMA_VERSION),
  bootstrapId: Identifier,
  runId: Identifier,
  fencingEpoch: Sequence,
  capabilityIds: Type.Array(Identifier, { minItems: 3, maxItems: 3, uniqueItems: true }),
  claimedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});

export const STORED_SCHEMAS = {
  historyRecord: HistoryRecordSchema,
  runSnapshot: RunSnapshotSchema,
  idempotencyReceipt: IdempotencyReceiptSchema,
  transaction: TransactionSchema,
  batchTransaction: BatchTransactionSchema,
  deliveryClaim: DeliveryClaimSchema,
  notificationReceipt: NotificationReceiptSchema,
  transientProgress: TransientProgressSchema,
  leaseRecord: LeaseRecordSchema,
  capabilityRecord: CapabilityRecordSchema,
  capabilityReceipt: CapabilityReceiptSchema,
  capabilityRevocation: CapabilityRevocationSchema,
  bootstrapRecord: BootstrapRecordSchema,
  bootstrapReceipt: BootstrapReceiptSchema,
  controlAction: ControlActionSchema,
  deliveryAction: DeliveryActionSchema,
} as const satisfies Record<string, TSchema>;

export type StoredContractKind = keyof typeof STORED_SCHEMAS;

const validators = Object.fromEntries(
  Object.entries(STORED_SCHEMAS).map(([key, schema]) => [key, Schema.Compile(schema)]),
) as Record<StoredContractKind, ReturnType<typeof Schema.Compile>>;

export function assertStoredContract<Kind extends StoredContractKind>(
  kind: Kind,
  value: unknown,
): void {
  if (!validators[kind].Check(value)) throw stateError("invalid_record");
}

export function serializeStoredContract<Kind extends StoredContractKind>(
  kind: Kind,
  value: unknown,
  maximumBytes: number,
): string {
  assertStoredContract(kind, value);
  return canonicalJson(value, maximumBytes);
}
