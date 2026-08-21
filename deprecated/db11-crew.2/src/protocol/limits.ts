export const SCHEMA_VERSION = 1 as const;
export const RESULT_CONTRACT_VERSION = 1 as const;
export const ACCOUNT_CONFIGURATION_VERSION = 2 as const;
export const MEMBER_PROFILE_MANIFEST_VERSION = 2 as const;
export const COMPANION_CONFIGURATION_VERSION = 2 as const;
export const ROLE_PROFILE_VERSION = 2 as const;

export const CANONICAL_RESOURCE_IDENTITY = Object.freeze({
  stateDirectory: "db11-crew",
  stateMarkerStore: "db11-crew",
  builderBranchPrefix: "db11-crew/",
  builderRefPrefix: "refs/heads/db11-crew/",
  herdrMetadataSource: "db11-crew",
} as const);

const BUILDER_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function isSafeBuilderRunId(value: string): boolean {
  return BUILDER_RUN_ID.test(value) && !value.includes("..") && !value.endsWith(".") && !value.endsWith(".lock");
}

function assertSafeBuilderRunId(runId: string): void {
  if (!isSafeBuilderRunId(runId)) throw new TypeError("Builder run ID is invalid.");
}

export function builderBranchForRun(runId: string): string {
  assertSafeBuilderRunId(runId);
  return `${CANONICAL_RESOURCE_IDENTITY.builderBranchPrefix}${runId}`;
}

export function builderRefForRun(runId: string): string {
  assertSafeBuilderRunId(runId);
  return `${CANONICAL_RESOURCE_IDENTITY.builderRefPrefix}${runId}`;
}

export function isCanonicalBuilderBranch(value: string): boolean {
  if (!value.startsWith(CANONICAL_RESOURCE_IDENTITY.builderBranchPrefix)) return false;
  return isSafeBuilderRunId(value.slice(CANONICAL_RESOURCE_IDENTITY.builderBranchPrefix.length));
}

export function isCanonicalBuilderRef(value: string): boolean {
  if (!value.startsWith(CANONICAL_RESOURCE_IDENTITY.builderRefPrefix)) return false;
  return isSafeBuilderRunId(value.slice(CANONICAL_RESOURCE_IDENTITY.builderRefPrefix.length));
}

/** Concrete MVP limits chosen where the accepted plan intentionally left bounds open. */
export const LIMITS = Object.freeze({
  jsonDepth: 10,
  jsonNodes: 4_096,
  validationIssues: 8,
  idLength: 128,
  labelLength: 80,
  pathLength: 512,
  referenceLength: 1_024,
  shortTextLength: 256,
  summaryLength: 2_048,
  objectiveLength: 4_096,
  amendmentTextLength: 4_096,
  diagnosticLength: 256,
  listItems: 32,
  resultItems: 64,
  amendmentItems: 16,
  progressFrameBytes: 4 * 1_024,
  eventBytes: 16 * 1_024,
  amendmentBytes: 16 * 1_024,
  blockerBytes: 16 * 1_024,
  deliveryEnvelopeBytes: 24 * 1_024,
  taskPacketBytes: 32 * 1_024,
  companionConfigurationBytes: 64 * 1_024,
  runBytes: 32 * 1_024,
  configurationBytes: 16 * 1_024,
  compatibilityBytes: 32 * 1_024,
  roleManifestBytes: 64 * 1_024,
  resultBytes: 64 * 1_024,
  cancellationCheckpointBytes: 32 * 1_024,
  stateMarkerBytes: 2 * 1_024,
  stateHistoryRecordBytes: 128 * 1_024,
  stateSnapshotBytes: 48 * 1_024,
  stateTransactionBytes: 512 * 1_024,
  stateBatchTransactionBytes: 4 * 1_024 * 1_024,
  stateBatchTransactions: 6,
  stateReceiptBytes: 4 * 1_024,
  stateLeaseBytes: 8 * 1_024,
  stateCapabilityBytes: 16 * 1_024,
  stateBootstrapBytes: 96 * 1_024,
  stateClaimBytes: 32 * 1_024,
  stateNotificationBytes: 4 * 1_024,
  progressRecordBytes: 8 * 1_024,
  stateDirectoryEntries: 4_096,
  adapterCommandMilliseconds: 60_000,
  adapterOutputBytes: 32 * 1_024 * 1_024,
  repositoryManifestEntries: 100_000,
  repositoryCaptureEntries: 4_096,
  repositoryCaptureBytes: 16 * 1_024 * 1_024,
  repositoryCommitEntries: 64,
  repositoryPathEntries: 4_096,
  stateHistoryRecordsPerRun: 4_096,
  stateTransactionRecords: 8,
  capabilityReceipts: 4_096,
  capabilityLifetimeMaximumMilliseconds: 7 * 24 * 60 * 60_000,
  bootstrapLifetimeDefaultMilliseconds: 60_000,
  bootstrapLifetimeMaximumMilliseconds: 5 * 60_000,
  leaseLifetimeMinimumMilliseconds: 1_000,
  leaseLifetimeDefaultMilliseconds: 15_000,
  leaseLifetimeMaximumMilliseconds: 60_000,
  storeLockAcquireMilliseconds: 2_000,
  storeLockLeaseMilliseconds: 30_000,
  maxActiveMembers: 6,
  maxOpenMemberResources: 6,
  maxQueuedDelegations: 6,
  progressEventsPerSecond: 4,
  progressCoalesceMilliseconds: 250,
  progressMaximumAgeMilliseconds: 2_000,
  progressDrainFrames: 32,
  deliveryBatchDelayMilliseconds: 500,
  deliveryBatchResults: 6,
  deliveryBatchEnvelopes: 32,
  deliveryOverflowIds: 26,
  deliveryContextReferences: 3,
  deliveryContextFieldCharacters: 128,
  deliverySummaryCharacters: 256,
  deliveryContextBytes: 12 * 1_024,
  uiRows: 6,
  uiLineCharacters: 192,
  inspectionGraceMinimumMilliseconds: 30_000,
  inspectionGraceDefaultMilliseconds: 5 * 60_000,
  inspectionGraceMaximumMilliseconds: 24 * 60 * 60_000,
} as const);

export const CONTRACT_BYTE_LIMITS = Object.freeze({
  taskPacket: LIMITS.taskPacketBytes,
  companionConfiguration: LIMITS.companionConfigurationBytes,
  amendment: LIMITS.amendmentBytes,
  blocker: LIMITS.blockerBytes,
  result: LIMITS.resultBytes,
  cancellationCheckpoint: LIMITS.cancellationCheckpointBytes,
  run: LIMITS.runBytes,
  event: LIMITS.eventBytes,
  deliveryEnvelope: LIMITS.deliveryEnvelopeBytes,
  progressFrame: LIMITS.progressFrameBytes,
  configuration: LIMITS.configurationBytes,
  compatibilityObservation: LIMITS.compatibilityBytes,
  roleManifest: LIMITS.roleManifestBytes,
} as const);
