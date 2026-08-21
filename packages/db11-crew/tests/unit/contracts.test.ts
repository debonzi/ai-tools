import assert from "node:assert/strict";
import test from "node:test";

import { BUILT_IN_ROLE_MANIFEST } from "../../src/roles/resolve.ts";
import { CONTRACT_BYTE_LIMITS } from "../../src/protocol/limits.ts";
import { parseContractText, validateContract } from "../../src/protocol/validate.ts";

const now = "2026-08-16T12:00:00Z";
const digest = "a".repeat(64);

const taskPacket = {
  schemaVersion: 1,
  packetId: "packet-1",
  resultContractVersion: 1,
  role: "scout",
  objective: "Inspect the repository and report the relevant evidence.",
  scope: { readPaths: ["."] },
  inputs: [],
  constraints: ["Keep repository content read-only."],
  nonGoals: ["Do not implement changes."],
  deliverables: [{ id: "report", description: "A bounded evidence report.", required: true }],
  validation: [{ id: "sources", description: "Verify cited sources.", required: true }],
  completionCriteria: [{ id: "accounted", description: "Account for the report.", required: true }],
  escalationConditions: ["Report missing required evidence."],
};

const amendment = {
  schemaVersion: 1,
  amendmentId: "amendment-1",
  runId: "run-1",
  sequence: 1,
  expectedRevision: 2,
  author: "crewlead",
  timestamp: now,
  kind: "clarification",
  summary: "Use the package manifest as the primary source.",
  constraints: ["Prefer package-owned evidence."],
};

const blocker = {
  schemaVersion: 1,
  blockerId: "blocker-1",
  blockerRevision: 1,
  runId: "run-1",
  expectedRevision: 2,
  status: "open",
  category: "missing_input",
  summary: "A required input is unavailable.",
  requiredDecision: "Provide the missing input or narrow the task.",
  options: [],
  evidenceRefs: ["evidence:missing-input"],
  decisionOwner: "human",
};

const result = {
  schemaVersion: 1,
  resultContractVersion: 1,
  resultId: "result-1",
  runId: "run-1",
  packetId: "packet-1",
  role: "scout",
  profileVersion: 2,
  outcome: "completed",
  summary: "The requested evidence was inspected.",
  deliverables: [{ id: "report", status: "produced", references: ["evidence:report"] }],
  completionCriteria: [{ id: "accounted", status: "passed", evidenceRefs: ["evidence:report"] }],
  validation: [{ id: "sources", status: "passed", evidenceRefs: ["evidence:report"], summary: "Sources verified." }],
  unresolvedBlockerIds: [],
  unresolvedDecisions: [],
  stateChanges: [],
  durableReferences: ["evidence:report"],
  recommendedNextSteps: [],
  roleDetails: { role: "scout", repositoryManifestDigest: digest, evidenceRefs: ["evidence:report"] },
};

const run = {
  schemaVersion: 1,
  admissionId: "admission-1",
  admission: {
    mode: "start",
    actor: "crewlead",
    evidenceRefs: ["request:authorized"],
  },
  runId: "run-1",
  packetId: "packet-1",
  intentDigest: "b".repeat(64),
  purposeLabel: "inspect-evidence",
  role: "scout",
  state: "working",
  revision: 2,
  fencingEpoch: 1,
  binding: {
    crewleadSessionId: "crewlead-session",
    memberSessionId: "member-session",
    herdrWorkspaceId: "workspace-1",
    canonicalProjectPath: "/work/project",
  },
  resources: { tabId: "tab-1", paneId: "pane-1", agentId: "agent-1" },
  observation: { state: "working", observedAt: now, sourceSequence: 4 },
  resourceDisposition: "open",
  health: {
    status: "healthy",
    reconciliationRequired: false,
    evidenceRefs: ["observation:4"],
    updatedAt: now,
  },
  retentionPolicy: "auto_close",
  createdAt: now,
  updatedAt: now,
};

const event = {
  schemaVersion: 1,
  eventId: "event-1",
  runId: "run-1",
  sequence: 2,
  timestamp: now,
  actor: "companion",
  type: "state_transition",
  reason: "The authenticated member accepted the task packet.",
  evidenceRefs: ["packet:packet-1"],
  expectedPriorState: "starting",
  resultingState: "working",
  expectedRevision: 1,
  resultingRevision: 2,
  fencingEpoch: 1,
};

const deliveryEnvelope = {
  schemaVersion: 1,
  deliveryId: "delivery-1",
  resultId: "result-1",
  resultDigest: digest,
  runId: "run-1",
  role: "scout",
  purpose: "inspect evidence",
  destination: { crewleadSessionId: "crewlead-session", herdrWorkspaceId: "workspace-1" },
  outcome: "completed",
  summary: "The requested evidence was inspected.",
  validation: { passed: 1, failed: 0, notApplicable: 0 },
  deliverableRefs: ["evidence:report"],
  unresolvedItems: [],
  recommendedNextAction: "Review the result.",
  omittedDeliverables: 0,
  omittedUnresolvedItems: 0,
  createdAt: now,
};

const progressFrame = {
  schemaVersion: 1,
  progressId: "progress-1",
  runId: "run-1",
  sequence: 1,
  fencingEpoch: 1,
  kind: "tool",
  tool: "db11_read",
  outcome: "succeeded",
  summary: "Repository evidence inspected.",
  timestamp: now,
};

const companionConfiguration = {
  schemaVersion: 2,
  packageName: "@debonzi/db11-crew",
  packageVersion: "0.2.0",
  memberExtensionPath: "agents/pi/extensions/db11-crew-member/index.ts",
  memberExtensionSha256: digest,
  roleProfileVersion: 2,
  roleProfilePath: "agents/pi/roles/scout.md",
  roleProfileSha256: digest,
  assignedRoot: "/work/snapshot",
  sourceCanonicalProjectPath: "/work/project",
  packet: taskPacket,
  progressEnabled: true,
};

const cancellationCheckpoint = {
  schemaVersion: 1,
  checkpointId: "checkpoint-1",
  cancelRequestId: "cancel-1",
  runId: "run-1",
  expectedRevision: 3,
  fencingEpoch: 1,
  summary: "Cancellation settled with a bounded checkpoint.",
  completedWork: [],
  validation: [],
  unresolvedEffects: ["No further effects were attempted."],
  retainedArtifacts: [],
  timestamp: now,
};

const configuration = {
  schemaVersion: 2,
  limits: { maxActiveMembers: 4, maxOpenMemberResources: 6, maxQueuedDelegations: 6 },
  retention: { policy: "auto_close", inspectionGraceMilliseconds: 300_000 },
  progress: { enabled: true },
};

const compatibilityObservation = {
  schemaVersion: 1,
  platform: "linux",
  pi: { version: "0.84.1", capabilities: [] },
  herdr: { version: "0.7.5", protocol: 17, apiSchema: 1, capabilities: [] },
  wyrd: { version: "0.2.0", capabilities: [] },
  git: { version: "2.43.0", capabilities: [] },
};

const validContracts = {
  taskPacket,
  companionConfiguration,
  amendment,
  blocker,
  result,
  cancellationCheckpoint,
  run,
  event,
  deliveryEnvelope,
  progressFrame,
  configuration,
  compatibilityObservation,
  roleManifest: BUILT_IN_ROLE_MANIFEST,
} as const;

test("changed member surfaces accept v2 while durable and control-plane contracts retain v1", () => {
  for (const [kind, value] of Object.entries(validContracts)) {
    const checked = validateContract(kind as keyof typeof validContracts, value);
    assert.equal(checked.ok, true, kind);
  }
  assert.equal(configuration.schemaVersion, 2);
  assert.equal(companionConfiguration.schemaVersion, 2);
  assert.equal((BUILT_IN_ROLE_MANIFEST as { schemaVersion: number }).schemaVersion, 2);
  for (const value of [taskPacket, amendment, blocker, run, event, deliveryEnvelope, progressFrame, cancellationCheckpoint]) {
    assert.equal(value.schemaVersion, 1);
  }
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.resultContractVersion, 1);
});

test("configuration, companion, and member manifest v1 forms are rejected", () => {
  for (const [kind, value] of [
    ["configuration", configuration],
    ["companionConfiguration", companionConfiguration],
    ["roleManifest", BUILT_IN_ROLE_MANIFEST],
  ] as const) {
    const checked = validateContract(kind, { ...(structuredClone(value) as Record<string, unknown>), schemaVersion: 1 });
    assert.equal(checked.ok, false, kind);
    if (!checked.ok) assert.equal(checked.error.code, "schema_invalid");
  }
});

test("companion v2 rejects obsolete tool inventory and adapter execution metadata", () => {
  for (const field of ["activeTools", "executionGrants"] as const) {
    const checked = validateContract("companionConfiguration", {
      ...companionConfiguration,
      [field]: [],
    });
    assert.equal(checked.ok, false, field);
    if (!checked.ok) assert.equal(checked.error.code, "schema_invalid", field);
  }
});

test("all contracts reject unknown versions and root extension fields", () => {
  for (const [kind, value] of Object.entries(validContracts)) {
    const unknownVersion = {
      ...(structuredClone(value) as Record<string, unknown>),
      schemaVersion: 99,
    };
    const versionResult = validateContract(kind as keyof typeof validContracts, unknownVersion);
    assert.equal(versionResult.ok, false, `${kind}: version`);
    if (!versionResult.ok) assert.equal(versionResult.error.code, "schema_invalid");

    const extended = {
      ...(structuredClone(value) as Record<string, unknown>),
      unexpected: true,
    };
    const extendedResult = validateContract(kind as keyof typeof validContracts, extended);
    assert.equal(extendedResult.ok, false, `${kind}: extension`);
    if (!extendedResult.ok) assert.equal(extendedResult.error.code, "schema_invalid");
  }
});

test("encoded files and frames are byte-bounded before JSON parsing", () => {
  for (const [kind, value] of Object.entries(validContracts)) {
    const parsed = parseContractText(kind as keyof typeof validContracts, JSON.stringify(value));
    assert.equal(parsed.ok, true, kind);

    const maximum = CONTRACT_BYTE_LIMITS[kind as keyof typeof validContracts];
    const oversized = parseContractText(
      kind as keyof typeof validContracts,
      "{" + "x".repeat(maximum + 1),
    );
    assert.equal(oversized.ok, false, kind);
    if (!oversized.ok) assert.equal(oversized.error.code, "oversized", kind);
  }

  const malformed = parseContractText("taskPacket", "{not-json");
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.code, "invalid_json_value");
});

test("all contracts reject oversized in-memory values before schema evaluation", () => {
  for (const [kind, value] of Object.entries(validContracts)) {
    const maximum = CONTRACT_BYTE_LIMITS[kind as keyof typeof validContracts];
    const oversized = {
      ...(structuredClone(value) as Record<string, unknown>),
      padding: "x".repeat(maximum + 1),
    };
    const checked = validateContract(kind as keyof typeof validContracts, oversized);
    assert.equal(checked.ok, false, kind);
    if (!checked.ok) assert.equal(checked.error.code, "oversized", kind);
  }
});

test("run v1 accepts bounded Builder allocation evidence while old records remain readable", () => {
  assert.equal(validateContract("run", run).ok, true, "pre-allocation compatibility");
  const source = {
    canonicalRoot: "/work/project",
    canonicalRootDigest: digest,
    commonGitDirectory: "/work/project/.git",
    commonGitDirectoryDigest: "b".repeat(64),
    commonGitDevice: "1",
    commonGitInode: "2",
  };
  const allocated = {
    ...run,
    role: "builder",
    repositoryAllocation: {
      status: "created",
      runId: run.runId,
      source,
      sourceStatusDigest: "c".repeat(64),
      path: "/work/builder",
      sessionDirectory: "/private/session",
      branch: "db11-crew/run-1",
      branchRef: "refs/heads/db11-crew/run-1",
      baseCommit: "d".repeat(40),
      targetBranch: "main",
      targetRef: "refs/heads/main",
      targetCommit: "d".repeat(40),
      protectedRefDigest: "e".repeat(64),
      automaticIntegrationEligible: true,
      expectedRevision: 1,
      fencingEpoch: 1,
      preparedAt: now,
      updatedAt: now,
    },
    repositoryResource: {
      kind: "builder_worktree",
      runId: run.runId,
      source: { ...source },
      path: "/work/builder",
      branch: "db11-crew/run-1",
      branchRef: "refs/heads/db11-crew/run-1",
      baseCommit: "d".repeat(40),
      targetBranch: "main",
      targetRef: "refs/heads/main",
      targetCommit: "d".repeat(40),
      protectedRefDigest: "e".repeat(64),
      automaticIntegrationEligible: true,
    },
  };
  assert.equal(validateContract("run", allocated).ok, true);
  const invalid = validateContract("run", {
    ...allocated,
    repositoryAllocation: { ...allocated.repositoryAllocation, protectedRefDigest: "missing" },
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "schema_invalid");
});

test("nested contract objects are closed", () => {
  const checked = validateContract("taskPacket", {
    ...taskPacket,
    scope: { ...taskPacket.scope, hiddenAuthority: true },
  });
  assert.equal(checked.ok, false);
  if (!checked.ok) assert.equal(checked.error.code, "schema_invalid");
});

test("task packets reject role-incompatible and contradictory authority", () => {
  const mutableScout = validateContract("taskPacket", {
    ...taskPacket,
    scope: { readPaths: ["."], mutablePaths: ["src"] },
  });
  assert.equal(mutableScout.ok, false);
  if (!mutableScout.ok) assert.equal(mutableScout.error.code, "semantic_invalid");

  const contradictory = validateContract("taskPacket", {
    ...taskPacket,
    nonGoals: [taskPacket.constraints[0]],
  });
  assert.equal(contradictory.ok, false);

  const grant = { id: "git-commit", executable: "git", argumentPrefixes: [["status"], ["add"], ["commit"]] };
  const scoutGrant = validateContract("taskPacket", { ...taskPacket, executionGrants: [grant] });
  assert.equal(scoutGrant.ok, false);
  if (!scoutGrant.ok) assert.equal(scoutGrant.error.code, "semantic_invalid");
  const builderGrant = validateContract("taskPacket", {
    ...taskPacket,
    role: "builder",
    scope: { readPaths: ["."], mutablePaths: ["src"] },
    executionGrants: [grant],
  });
  assert.equal(builderGrant.ok, true);
});

test("role results accept role-specific evidence and reject mismatched details", () => {
  const planner = validateContract("result", {
    ...result,
    role: "planner",
    roleDetails: {
      role: "planner",
      repositoryManifestDigest: digest,
      wyrdRevisions: [{ id: "10.3", beforeRevision: 2, afterRevision: 3 }],
    },
  });
  assert.equal(planner.ok, true);

  const commit = "b".repeat(40);
  const builder = validateContract("result", {
    ...result,
    role: "builder",
    roleDetails: {
      role: "builder",
      repository: { rootDigest: digest, baseCommit: commit, headCommit: commit },
      commits: [],
      changedPaths: [],
      noChange: true,
      worktreeClean: true,
    },
  });
  assert.equal(builder.ok, true);

  const mismatch = validateContract("result", { ...result, role: "builder" });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error.code, "semantic_invalid");
});

test("completed results enforce structural completion gates", () => {
  const checked = validateContract("result", {
    ...result,
    deliverables: [{ id: "report", status: "not_produced", references: [] }],
  });
  assert.equal(checked.ok, false);
  if (!checked.ok) assert.equal(checked.error.code, "semantic_invalid");
});

test("non-JSON values fail closed without invoking accessors", () => {
  let invoked = false;
  const value = {
    schemaVersion: 1,
    get packetId() {
      invoked = true;
      return "packet-1";
    },
  };
  const checked = validateContract("taskPacket", value);
  assert.equal(checked.ok, false);
  assert.equal(invoked, false);
  if (!checked.ok) assert.equal(checked.error.code, "invalid_json_value");
});
