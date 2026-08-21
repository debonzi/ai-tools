import Type, {
  type TObject,
  type TObjectOptions,
  type TProperties,
  type TSchema,
} from "typebox";

import {
  ACCOUNT_CONFIGURATION_VERSION,
  COMPANION_CONFIGURATION_VERSION,
  LIMITS,
  MEMBER_PROFILE_MANIFEST_VERSION,
  RESULT_CONTRACT_VERSION,
  ROLE_PROFILE_VERSION,
  SCHEMA_VERSION,
} from "./limits.ts";

function closed<const Properties extends TProperties>(
  properties: Properties,
  options: TObjectOptions = {},
): TObject<Properties> {
  return Type.Object(properties, { ...options, additionalProperties: false });
}

function literals<const Values extends readonly (string | number | boolean)[]>(values: Values): TSchema {
  return Type.Union(values.map((value) => Type.Literal(value)));
}

const Identifier = Type.String({
  minLength: 1,
  maxLength: LIMITS.idLength,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});
const ShortText = Type.String({ minLength: 1, maxLength: LIMITS.shortTextLength });
const Summary = Type.String({ minLength: 1, maxLength: LIMITS.summaryLength });
const Objective = Type.String({ minLength: 1, maxLength: LIMITS.objectiveLength });
const Diagnostic = Type.String({ minLength: 1, maxLength: LIMITS.diagnosticLength });
const Reference = Type.String({ minLength: 1, maxLength: LIMITS.referenceLength });
const RelativePath = Type.String({
  minLength: 1,
  maxLength: LIMITS.pathLength,
  pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*[\\u0000-\\u001F\\u007F]).+$",
});
const AbsolutePath = Type.String({
  minLength: 1,
  maxLength: LIMITS.pathLength,
  pattern: "^/(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*[\\u0000-\\u001F\\u007F]).+$",
});
const GitRef = Type.String({
  minLength: 1,
  maxLength: LIMITS.pathLength,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._/@:+-]*$",
});
const Timestamp = Type.String({
  minLength: 20,
  maxLength: 32,
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,6})?Z$",
});
const Sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const GitObjectId = Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" });
const NpmIntegrity = Type.String({ minLength: 16, maxLength: 256, pattern: "^sha512-[A-Za-z0-9+/]+={0,2}$" });
const Role = literals(["scout", "planner", "builder"] as const);
const ThinkingLevel = literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
const RunState = literals([
  "queued",
  "starting",
  "working",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "abandoned",
] as const);

const Version = Type.Literal(SCHEMA_VERSION);
const ConfigurationVersion = Type.Literal(ACCOUNT_CONFIGURATION_VERSION);
const CompanionConfigurationVersion = Type.Literal(COMPANION_CONFIGURATION_VERSION);
const MemberProfileManifestVersion = Type.Literal(MEMBER_PROFILE_MANIFEST_VERSION);
const Revision = Type.Integer({ minimum: 0, maximum: 2_147_483_647 });
const Sequence = Type.Integer({ minimum: 1, maximum: 2_147_483_647 });
const stringList = (maximum: number = LIMITS.listItems) =>
  Type.Array(Summary, { maxItems: maximum, uniqueItems: true });
const referenceList = (maximum: number = LIMITS.listItems) =>
  Type.Array(Reference, { maxItems: maximum, uniqueItems: true });

const TaskInput = Type.Union([
  closed({ kind: Type.Literal("path"), value: RelativePath, purpose: ShortText }),
  closed({ kind: Type.Literal("git_ref"), value: GitRef, purpose: ShortText }),
  closed({ kind: Type.Literal("text"), value: Objective, purpose: ShortText }),
  closed({
    kind: Type.Literal("public_url"),
    value: Type.String({ minLength: 8, maxLength: LIMITS.referenceLength, pattern: "^https?://[^\\s]+$" }),
    purpose: ShortText,
  }),
  closed({ kind: Type.Literal("wyrd"), value: Identifier, purpose: ShortText }),
]);

const DeliverableDefinition = closed({
  id: Identifier,
  description: Summary,
  required: Type.Boolean(),
});
const CriterionDefinition = closed({
  id: Identifier,
  description: Summary,
  required: Type.Boolean(),
});
const WyrdScope = closed({
  ticketId: Sequence,
  taskIds: Type.Array(Type.String({ pattern: "^[1-9][0-9]*\\.[1-9][0-9]*$" }), {
    minItems: 1,
    maxItems: LIMITS.listItems,
    uniqueItems: true,
  }),
});
const TaskScope = closed({
  readPaths: Type.Array(RelativePath, {
    minItems: 1,
    maxItems: LIMITS.listItems,
    uniqueItems: true,
  }),
  mutablePaths: Type.Optional(
    Type.Array(RelativePath, { minItems: 1, maxItems: LIMITS.listItems, uniqueItems: true }),
  ),
  wyrd: Type.Optional(WyrdScope),
  externalTargets: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: LIMITS.referenceLength }), {
      maxItems: LIMITS.listItems,
      uniqueItems: true,
    }),
  ),
});
const ExecutionGrant = closed({
  id: Identifier,
  executable: Type.String({ minLength: 1, maxLength: LIMITS.pathLength, pattern: "^[^\\s\\u0000-\\u001F]+$" }),
  argumentPrefixes: Type.Optional(
    Type.Array(
      Type.Array(Type.String({ minLength: 1, maxLength: 4_096, pattern: "^[^\\u0000-\\u001F\\u007F]+$" }), {
        maxItems: 64,
      }),
      { maxItems: LIMITS.listItems },
    ),
  ),
  maximumMilliseconds: Type.Optional(
    Type.Integer({ minimum: 1_000, maximum: LIMITS.adapterCommandMilliseconds }),
  ),
});

export const TaskPacketSchema = closed({
  schemaVersion: Version,
  packetId: Identifier,
  resultContractVersion: Type.Literal(RESULT_CONTRACT_VERSION),
  role: Role,
  objective: Objective,
  scope: TaskScope,
  inputs: Type.Array(TaskInput, { maxItems: LIMITS.listItems }),
  constraints: stringList(),
  nonGoals: stringList(),
  deliverables: Type.Array(DeliverableDefinition, {
    minItems: 1,
    maxItems: LIMITS.listItems,
  }),
  validation: Type.Array(CriterionDefinition, { maxItems: LIMITS.listItems }),
  completionCriteria: Type.Array(CriterionDefinition, {
    minItems: 1,
    maxItems: LIMITS.listItems,
  }),
  escalationConditions: Type.Array(Summary, {
    minItems: 1,
    maxItems: LIMITS.listItems,
    uniqueItems: true,
  }),
  executionGrants: Type.Optional(Type.Array(ExecutionGrant, {
    minItems: 1,
    maxItems: LIMITS.listItems,
  })),
});

const AmendmentCriterion = closed({ id: Identifier, description: Summary, required: Type.Boolean() });

export const CompanionConfigurationSchema = closed({
  schemaVersion: CompanionConfigurationVersion,
  packageName: Type.Literal("@debonzi/db11-crew"),
  packageVersion: Type.Literal("0.2.0"),
  memberExtensionPath: RelativePath,
  memberExtensionSha256: Sha256,
  roleProfileVersion: Type.Literal(ROLE_PROFILE_VERSION),
  roleProfilePath: RelativePath,
  roleProfileSha256: Sha256,
  assignedRoot: AbsolutePath,
  sourceCanonicalProjectPath: AbsolutePath,
  packet: TaskPacketSchema,
  progressEnabled: Type.Boolean(),
});

export const AmendmentSchema = closed({
  schemaVersion: Version,
  amendmentId: Identifier,
  runId: Identifier,
  sequence: Type.Integer({ minimum: 1, maximum: LIMITS.amendmentItems }),
  expectedRevision: Revision,
  author: literals(["human", "crewlead", "recovery"] as const),
  timestamp: Timestamp,
  kind: literals(["correction", "clarification", "input", "narrowing", "recovery"] as const),
  summary: Type.String({ minLength: 1, maxLength: LIMITS.amendmentTextLength }),
  inputs: Type.Optional(Type.Array(TaskInput, { maxItems: LIMITS.amendmentItems })),
  constraints: Type.Optional(stringList(LIMITS.amendmentItems)),
  nonGoals: Type.Optional(stringList(LIMITS.amendmentItems)),
  completionCriteria: Type.Optional(
    Type.Array(AmendmentCriterion, { maxItems: LIMITS.amendmentItems }),
  ),
});

const BlockerOption = closed({ id: Identifier, label: ShortText, consequences: Summary });
export const BlockerSchema = closed({
  schemaVersion: Version,
  blockerId: Identifier,
  blockerRevision: Sequence,
  runId: Identifier,
  expectedRevision: Revision,
  status: literals(["open", "cleared", "superseded"] as const),
  category: literals([
    "missing_input",
    "authorization",
    "scope_conflict",
    "unsafe_state",
    "runtime_unavailable",
    "material_decision",
    "other",
  ] as const),
  summary: Summary,
  requiredDecision: Summary,
  options: Type.Array(BlockerOption, { maxItems: 8 }),
  evidenceRefs: referenceList(),
  decisionOwner: literals(["human", "crewlead"] as const),
  recommendedOptionId: Type.Optional(Identifier),
  supersedesBlockerId: Type.Optional(Identifier),
});

const DeliverableResult = closed({
  id: Identifier,
  status: literals(["produced", "unchanged", "not_produced"] as const),
  references: referenceList(),
  note: Type.Optional(Summary),
});
const CriterionResult = closed({
  id: Identifier,
  status: literals(["passed", "not_met", "not_applicable"] as const),
  evidenceRefs: referenceList(),
  note: Type.Optional(Summary),
});
const ValidationResult = closed({
  id: Identifier,
  status: literals(["passed", "failed", "not_applicable"] as const),
  evidenceRefs: referenceList(),
  summary: Summary,
});
const WyrdRevision = closed({ id: Identifier, beforeRevision: Revision, afterRevision: Revision });
const RepositoryIdentity = closed({
  rootDigest: Sha256,
  baseCommit: GitObjectId,
  headCommit: GitObjectId,
});
const RoleDetails = Type.Union([
  closed({
    role: Type.Literal("scout"),
    repositoryManifestDigest: Sha256,
    evidenceRefs: referenceList(LIMITS.resultItems),
  }),
  closed({
    role: Type.Literal("planner"),
    repositoryManifestDigest: Sha256,
    wyrdRevisions: Type.Array(WyrdRevision, { maxItems: LIMITS.resultItems }),
  }),
  closed({
    role: Type.Literal("builder"),
    repository: RepositoryIdentity,
    commits: Type.Array(GitObjectId, { maxItems: LIMITS.resultItems, uniqueItems: true }),
    changedPaths: Type.Array(RelativePath, { maxItems: LIMITS.resultItems, uniqueItems: true }),
    noChange: Type.Boolean(),
    worktreeClean: Type.Boolean(),
  }),
]);

const FailureDetails = closed({
  classification: literals(["task", "validation", "runtime", "unsafe_state", "scope", "other"] as const),
  summary: Summary,
  evidenceRefs: referenceList(LIMITS.resultItems),
});
export const ResultSchema = closed({
  schemaVersion: Version,
  resultContractVersion: Type.Literal(RESULT_CONTRACT_VERSION),
  resultId: Identifier,
  runId: Identifier,
  packetId: Identifier,
  role: Role,
  profileVersion: Type.Literal(ROLE_PROFILE_VERSION),
  outcome: literals(["completed", "failed"] as const),
  summary: Summary,
  failure: Type.Optional(FailureDetails),
  deliverables: Type.Array(DeliverableResult, {
    minItems: 1,
    maxItems: LIMITS.resultItems,
  }),
  completionCriteria: Type.Array(CriterionResult, {
    minItems: 1,
    maxItems: LIMITS.resultItems,
  }),
  validation: Type.Array(ValidationResult, { maxItems: LIMITS.resultItems }),
  unresolvedBlockerIds: Type.Array(Identifier, {
    maxItems: LIMITS.resultItems,
    uniqueItems: true,
  }),
  unresolvedDecisions: stringList(LIMITS.resultItems),
  stateChanges: stringList(LIMITS.resultItems),
  durableReferences: referenceList(LIMITS.resultItems),
  recommendedNextSteps: stringList(LIMITS.resultItems),
  roleDetails: RoleDetails,
});

const RunBinding = closed({
  crewleadSessionId: Identifier,
  memberSessionId: Type.Optional(Identifier),
  herdrWorkspaceId: Identifier,
  canonicalProjectPath: AbsolutePath,
});
const RunResources = closed({
  tabId: Identifier,
  paneId: Identifier,
  agentId: Identifier,
});
const PartialRunResources = closed({
  tabId: Type.Optional(Identifier),
  paneId: Type.Optional(Identifier),
  agentId: Type.Optional(Identifier),
});
const DispatchRuntimeOverride = closed({
  provider: Type.Optional(Type.String({ minLength: 1, maxLength: LIMITS.labelLength, pattern: "^[^\\s\\u0000-\\u001F]+$" })),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: LIMITS.idLength, pattern: "^[^\\s\\u0000-\\u001F]+$" })),
  thinking: Type.Optional(ThinkingLevel),
});
const RunStartup = closed({
  phase: literals([
    "admitted",
    "workspace_prepared",
    "bootstrap_provisioned",
    "prompt_acknowledged",
    "partial_failure",
  ] as const),
  assignedRoot: Type.Optional(AbsolutePath),
  sessionDirectory: Type.Optional(AbsolutePath),
  bootstrapId: Type.Optional(Identifier),
  partialResources: Type.Optional(PartialRunResources),
  diagnostic: Type.Optional(Diagnostic),
});
const RunAdmission = closed({
  mode: literals(["start", "queue"] as const),
  actor: literals(["crewlead", "human"] as const),
  evidenceRefs: referenceList(),
});
const RunObservation = closed({
  state: literals(["working", "blocked", "done", "idle", "unknown"] as const),
  observedAt: Timestamp,
  sourceSequence: Type.Optional(Revision),
});
const RunHealth = closed({
  status: literals([
    "healthy",
    "degraded",
    "unreachable",
    "recovery_required",
    "orphan_suspected",
    "inconsistent",
  ] as const),
  reconciliationRequired: Type.Boolean(),
  reason: Type.Optional(Diagnostic),
  evidenceRefs: referenceList(),
  updatedAt: Timestamp,
});
const QueueMetadata = closed({
  enqueuedAt: Timestamp,
  enqueueSequence: Sequence,
  startBlockedReason: Type.Optional(Diagnostic),
});
const CompactRepositoryIdentity = closed({
  canonicalRoot: AbsolutePath,
  canonicalRootDigest: Sha256,
  commonGitDirectory: AbsolutePath,
  commonGitDirectoryDigest: Sha256,
  commonGitDevice: Type.String({ minLength: 1, maxLength: 32, pattern: "^[0-9]+$" }),
  commonGitInode: Type.String({ minLength: 1, maxLength: 32, pattern: "^[0-9]+$" }),
});
const RepositoryResource = Type.Union([
  closed({
    kind: Type.Literal("read_snapshot"),
    runId: Identifier,
    source: CompactRepositoryIdentity,
    path: AbsolutePath,
    sourceHead: GitObjectId,
    baselineManifestDigest: Sha256,
  }),
  closed({
    kind: Type.Literal("builder_worktree"),
    runId: Identifier,
    source: CompactRepositoryIdentity,
    path: AbsolutePath,
    branch: Type.String({ minLength: 1, maxLength: LIMITS.pathLength }),
    branchRef: Type.String({ minLength: 1, maxLength: LIMITS.pathLength }),
    baseCommit: GitObjectId,
    targetBranch: Type.String({ minLength: 1, maxLength: LIMITS.pathLength }),
    targetRef: Type.String({ minLength: 1, maxLength: LIMITS.pathLength }),
    targetCommit: GitObjectId,
    protectedRefDigest: Type.Optional(Sha256),
    automaticIntegrationEligible: Type.Boolean(),
  }),
]);
const RepositoryAllocation = closed({
  status: literals(["prepared", "created", "failed"] as const),
  runId: Identifier,
  source: CompactRepositoryIdentity,
  sourceStatusDigest: Sha256,
  path: AbsolutePath,
  sessionDirectory: AbsolutePath,
  branch: Type.String({ minLength: 1, maxLength: LIMITS.pathLength }),
  branchRef: Type.String({ minLength: 1, maxLength: LIMITS.pathLength }),
  baseCommit: GitObjectId,
  targetBranch: Type.String({ minLength: 1, maxLength: LIMITS.pathLength }),
  targetRef: Type.String({ minLength: 1, maxLength: LIMITS.pathLength }),
  targetCommit: GitObjectId,
  protectedRefDigest: Sha256,
  automaticIntegrationEligible: Type.Boolean(),
  expectedRevision: Revision,
  fencingEpoch: Revision,
  preparedAt: Timestamp,
  updatedAt: Timestamp,
  diagnostic: Type.Optional(Diagnostic),
});
const InspectionLease = closed({
  leaseId: Identifier,
  actor: Type.Literal("human"),
  acquiredAt: Timestamp,
  expiresAt: Timestamp,
});
const RuntimeCleanupIntent = closed({
  requestId: Identifier,
  source: literals(["automatic", "capacity", "human"] as const),
  status: literals(["prepared", "failed", "completed"] as const),
  expectedTabId: Identifier,
  expectedPaneId: Identifier,
  preparedAt: Timestamp,
  updatedAt: Timestamp,
  diagnostic: Type.Optional(Diagnostic),
});
const RuntimeCleanup = closed({
  graceStartedAt: Type.Optional(Timestamp),
  pinnedAt: Type.Optional(Timestamp),
  unpinnedAt: Type.Optional(Timestamp),
  lastInteractionAt: Type.Optional(Timestamp),
  inspectionLease: Type.Optional(InspectionLease),
  intent: Type.Optional(RuntimeCleanupIntent),
  closedAt: Type.Optional(Timestamp),
  closeProvenance: Type.Optional(literals(["automatic", "capacity", "human", "external"] as const)),
  externalEvidenceRef: Type.Optional(Type.String({ minLength: 1, maxLength: LIMITS.referenceLength })),
});
const IntegrationIntent = closed({
  requestId: Identifier,
  mode: Type.Literal("ff_only"),
  status: literals(["prepared", "completed", "failed"] as const),
  targetRef: Type.String({ minLength: 1, maxLength: LIMITS.pathLength }),
  expectedBase: GitObjectId,
  expectedHead: GitObjectId,
  preparedAt: Timestamp,
  updatedAt: Timestamp,
  integratedAt: Type.Optional(Timestamp),
  commandExitCode: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })),
  diagnostic: Type.Optional(Diagnostic),
  evidenceRefs: referenceList(),
});
const RepositoryCleanupIntent = closed({
  requestId: Identifier,
  authorization: literals(["integrated", "superseded", "discard", "read_snapshot"] as const),
  status: literals(["prepared", "worktree_removed", "failed", "completed"] as const),
  expectedHead: GitObjectId,
  replacementRunId: Type.Optional(Identifier),
  preparedAt: Timestamp,
  updatedAt: Timestamp,
  worktreeRemoved: Type.Boolean(),
  branchRemoved: Type.Boolean(),
  diagnostic: Type.Optional(Diagnostic),
  evidenceRefs: referenceList(),
});
export const RunSchema = closed({
  schemaVersion: Version,
  admissionId: Identifier,
  admission: RunAdmission,
  runId: Identifier,
  packetId: Identifier,
  intentDigest: Sha256,
  purposeLabel: Type.String({ minLength: 1, maxLength: LIMITS.labelLength }),
  role: Role,
  state: RunState,
  revision: Revision,
  fencingEpoch: Revision,
  binding: RunBinding,
  resources: Type.Optional(RunResources),
  runtimeRequest: Type.Optional(DispatchRuntimeOverride),
  startup: Type.Optional(RunStartup),
  observation: Type.Optional(RunObservation),
  resourceDisposition: literals(["unallocated", "open", "retained", "closed", "missing"] as const),
  health: RunHealth,
  queue: Type.Optional(QueueMetadata),
  retentionPolicy: literals(["auto_close", "retain"] as const),
  repositoryResource: Type.Optional(RepositoryResource),
  repositoryAllocation: Type.Optional(RepositoryAllocation),
  runtimeCleanup: Type.Optional(RuntimeCleanup),
  integration: Type.Optional(IntegrationIntent),
  repositoryCleanup: Type.Optional(RepositoryCleanupIntent),
  activeBlockerId: Type.Optional(Identifier),
  resultId: Type.Optional(Identifier),
  resultDigest: Type.Optional(Sha256),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const EventSchema = closed({
  schemaVersion: Version,
  eventId: Identifier,
  runId: Identifier,
  sequence: Sequence,
  timestamp: Timestamp,
  actor: literals(["crewlead", "companion", "recovery", "human"] as const),
  type: literals([
    "run_created",
    "state_transition",
    "amendment_appended",
    "blocker_opened",
    "blocker_cleared",
    "result_committed",
    "delivery_changed",
    "cleanup_changed",
    "diagnostic",
  ] as const),
  reason: Summary,
  evidenceRefs: referenceList(),
  expectedPriorState: Type.Optional(RunState),
  resultingState: RunState,
  expectedRevision: Revision,
  resultingRevision: Sequence,
  fencingEpoch: Revision,
});

const DeliveryDestination = closed({
  crewleadSessionId: Identifier,
  herdrWorkspaceId: Identifier,
});
const DeliveryValidation = closed({
  passed: Type.Integer({ minimum: 0, maximum: LIMITS.resultItems }),
  failed: Type.Integer({ minimum: 0, maximum: LIMITS.resultItems }),
  notApplicable: Type.Integer({ minimum: 0, maximum: LIMITS.resultItems }),
});
export const DeliveryEnvelopeSchema = closed({
  schemaVersion: Version,
  deliveryId: Identifier,
  resultId: Identifier,
  resultDigest: Sha256,
  runId: Identifier,
  role: Role,
  purpose: Type.String({ minLength: 1, maxLength: LIMITS.labelLength }),
  destination: DeliveryDestination,
  outcome: literals(["completed", "failed", "cancelled", "abandoned"] as const),
  summary: Summary,
  validation: DeliveryValidation,
  deliverableRefs: referenceList(LIMITS.deliveryBatchResults),
  unresolvedItems: stringList(LIMITS.deliveryBatchResults),
  recommendedNextAction: Type.Optional(Summary),
  omittedDeliverables: Type.Integer({ minimum: 0, maximum: LIMITS.resultItems }),
  omittedUnresolvedItems: Type.Integer({ minimum: 0, maximum: LIMITS.resultItems }),
  createdAt: Timestamp,
});

const ProgressUsage = closed({
  inputTokens: Type.Integer({ minimum: 0, maximum: 10_000_000 }),
  outputTokens: Type.Integer({ minimum: 0, maximum: 10_000_000 }),
});
export const CancellationCheckpointSchema = closed({
  schemaVersion: Version,
  checkpointId: Identifier,
  cancelRequestId: Identifier,
  runId: Identifier,
  expectedRevision: Revision,
  fencingEpoch: Sequence,
  summary: Summary,
  completedWork: stringList(LIMITS.resultItems),
  validation: stringList(LIMITS.resultItems),
  unresolvedEffects: stringList(LIMITS.resultItems),
  retainedArtifacts: referenceList(LIMITS.resultItems),
  timestamp: Timestamp,
});

export const ProgressFrameSchema = closed({
  schemaVersion: Version,
  progressId: Identifier,
  runId: Identifier,
  sequence: Sequence,
  fencingEpoch: Revision,
  kind: literals(["started", "phase", "tool", "blocked", "finalizing", "terminal_observation"] as const),
  phase: Type.Optional(Type.String({ minLength: 1, maxLength: LIMITS.labelLength })),
  tool: Type.Optional(Type.String({ minLength: 1, maxLength: LIMITS.labelLength, pattern: "^[A-Za-z0-9_.:-]+$" })),
  outcome: Type.Optional(literals(["started", "succeeded", "failed", "cancelled"] as const)),
  summary: Type.Optional(Diagnostic),
  usage: Type.Optional(ProgressUsage),
  timestamp: Timestamp,
});

const RuntimeOverride = closed({
  provider: Type.Optional(Type.String({ minLength: 1, maxLength: LIMITS.labelLength, pattern: "^[^\\s\\u0000-\\u001F]+$" })),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: LIMITS.idLength, pattern: "^[^\\s\\u0000-\\u001F]+$" })),
  thinking: Type.Optional(ThinkingLevel),
});
const RoleRuntimes = closed({
  scout: Type.Optional(RuntimeOverride),
  planner: Type.Optional(RuntimeOverride),
  builder: Type.Optional(RuntimeOverride),
});
const AdmissionLimits = closed({
  maxActiveMembers: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.maxActiveMembers })),
  maxOpenMemberResources: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.maxOpenMemberResources })),
  maxQueuedDelegations: Type.Optional(Type.Integer({ minimum: 0, maximum: LIMITS.maxQueuedDelegations })),
});
const RetentionConfiguration = closed({
  policy: Type.Optional(literals(["auto_close", "retain"] as const)),
  inspectionGraceMilliseconds: Type.Optional(
    Type.Integer({
      minimum: LIMITS.inspectionGraceMinimumMilliseconds,
      maximum: LIMITS.inspectionGraceMaximumMilliseconds,
    }),
  ),
});
const ProgressConfiguration = closed({ enabled: Type.Optional(Type.Boolean()) });
export const ConfigurationSchema = closed({
  schemaVersion: ConfigurationVersion,
  limits: Type.Optional(AdmissionLimits),
  retention: Type.Optional(RetentionConfiguration),
  progress: Type.Optional(ProgressConfiguration),
  runtimes: Type.Optional(RoleRuntimes),
});

const CapabilityList = Type.Array(Type.String({ minLength: 1, maxLength: LIMITS.idLength, pattern: "^[A-Za-z0-9_.:-]+$" }), {
  maxItems: 128,
  uniqueItems: true,
});
const ComponentObservation = closed({ version: Type.String({ minLength: 1, maxLength: 32 }), capabilities: CapabilityList });
const HerdrObservation = closed({
  version: Type.String({ minLength: 1, maxLength: 32 }),
  protocol: Type.Integer({ minimum: 1, maximum: 10_000 }),
  apiSchema: Type.Integer({ minimum: 1, maximum: 10_000 }),
  capabilities: CapabilityList,
});
export const CompatibilityObservationSchema = closed({
  schemaVersion: Version,
  platform: Type.Literal("linux"),
  pi: ComponentObservation,
  herdr: HerdrObservation,
  wyrd: ComponentObservation,
  git: ComponentObservation,
});

const ManifestResource = closed({
  id: Identifier,
  packageName: Type.String({ minLength: 1, maxLength: LIMITS.idLength }),
  packageVersion: Type.String({ minLength: 1, maxLength: 32 }),
  resourcePath: RelativePath,
  sha256: Sha256,
  npmIntegrity: Type.Optional(NpmIntegrity),
});
const ManifestRole = closed({
  id: Role,
  profileVersion: Type.Literal(ROLE_PROFILE_VERSION),
  profilePath: RelativePath,
  profileSha256: Sha256,
});
export const RoleManifestSchema = closed({
  schemaVersion: MemberProfileManifestVersion,
  package: closed({ name: Type.Literal("@debonzi/db11-crew"), version: Type.Literal("0.2.0") }),
  resources: Type.Array(ManifestResource, { minItems: 4, maxItems: 4 }),
  roles: Type.Array(ManifestRole, { minItems: 3, maxItems: 3 }),
});

export const CONTRACT_SCHEMAS = Object.freeze({
  taskPacket: TaskPacketSchema,
  companionConfiguration: CompanionConfigurationSchema,
  amendment: AmendmentSchema,
  blocker: BlockerSchema,
  result: ResultSchema,
  cancellationCheckpoint: CancellationCheckpointSchema,
  run: RunSchema,
  event: EventSchema,
  deliveryEnvelope: DeliveryEnvelopeSchema,
  progressFrame: ProgressFrameSchema,
  configuration: ConfigurationSchema,
  compatibilityObservation: CompatibilityObservationSchema,
  roleManifest: RoleManifestSchema,
});

export type ContractKind = keyof typeof CONTRACT_SCHEMAS;
