import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type RunCapabilityBinding } from "../../src/security/binding.ts";

export async function temporaryAccountHome(): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const path = await mkdtemp(join(tmpdir(), "db11-crew-home-"));
  await chmod(path, 0o700);
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

export const timestamp = "2026-08-16T12:00:00Z";

export function runValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    admissionId: "admission-1",
    admission: {
      mode: "start",
      actor: "crewlead",
      evidenceRefs: ["admission:admission-1"],
    },
    runId: "run-1",
    packetId: "packet-1",
    intentDigest: "b".repeat(64),
    purposeLabel: "inspect-state",
    role: "scout",
    state: "starting",
    revision: 1,
    fencingEpoch: 1,
    binding: {
      crewleadSessionId: "crewlead-session",
      memberSessionId: "member-session",
      herdrWorkspaceId: "workspace-1",
      canonicalProjectPath: "/work/project",
    },
    resourceDisposition: "open",
    health: {
      status: "healthy",
      reconciliationRequired: false,
      evidenceRefs: ["admission:admission-1"],
      updatedAt: timestamp,
    },
    retentionPolicy: "auto_close",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

export function eventValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    eventId: "event-create",
    runId: "run-1",
    sequence: 1,
    timestamp,
    actor: "crewlead",
    type: "run_created",
    reason: "The durable run was created before dispatch side effects.",
    evidenceRefs: ["packet:packet-1"],
    resultingState: "starting",
    expectedRevision: 0,
    resultingRevision: 1,
    fencingEpoch: 1,
    ...overrides,
  };
}

export function capabilityBinding(overrides: Partial<RunCapabilityBinding> = {}): RunCapabilityBinding {
  return {
    protocolVersion: 1,
    crewleadSessionId: "crewlead-session",
    herdrWorkspaceId: "workspace-1",
    canonicalProjectPath: "/work/project",
    runId: "run-1",
    memberSessionId: "member-session",
    role: "scout",
    fencingEpoch: 1,
    ...overrides,
  };
}

export function deliveryEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    deliveryId: "delivery-1",
    resultId: "result-1",
    resultDigest: "a".repeat(64),
    runId: "run-1",
    role: "scout",
    purpose: "inspect evidence",
    destination: {
      crewleadSessionId: "crewlead-session",
      herdrWorkspaceId: "workspace-1",
    },
    outcome: "completed",
    summary: "The delegated work completed.",
    validation: { passed: 1, failed: 0, notApplicable: 0 },
    deliverableRefs: ["evidence:result"],
    unresolvedItems: [],
    omittedDeliverables: 0,
    omittedUnresolvedItems: 0,
    createdAt: timestamp,
    ...overrides,
  };
}
