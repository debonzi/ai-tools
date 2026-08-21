import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type SchemaModule from "typebox/schema";

import { CONTRACT_SCHEMAS, type ContractKind } from "./contracts.ts";
import { CONTRACT_BYTE_LIMITS, LIMITS } from "./limits.ts";

export interface ValidationIssue {
  path: string;
  code: string;
}

export interface ValidationFailure {
  code: "invalid_json_value" | "oversized" | "schema_invalid" | "semantic_invalid";
  contract: ContractKind;
  message: string;
  issues: ValidationIssue[];
}

export type ValidationResult<Value = unknown> =
  | { ok: true; value: Value; bytes: number }
  | { ok: false; error: ValidationFailure };

// Pi's extension loader resolves the documented `typebox` peer but some Jiti
// paths append subpaths to the package's ESM entry instead of honoring exports.
// Resolve the peer's main entry first, then synchronously load its adjacent
// schema module through Node's ESM-capable require bridge.
const require = createRequire(import.meta.url);
const typeboxBuild = dirname(require.resolve("typebox"));
const Schema = require(join(typeboxBuild, "schema", "index.mjs")).default as typeof SchemaModule;

const validators = Object.fromEntries(
  Object.entries(CONTRACT_SCHEMAS).map(([kind, schema]) => [kind, Schema.Compile(schema)]),
) as Record<ContractKind, ReturnType<typeof Schema.Compile>>;

type JsonInspection = { ok: true; bytes: number } | { ok: false; code: string };

function inspectJson(value: unknown, byteLimit: number): JsonInspection {
  const seen = new Set<object>();
  let nodes = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > LIMITS.jsonNodes) return { ok: false, code: "node_limit" };
    if (current.depth > LIMITS.jsonDepth) return { ok: false, code: "depth_limit" };

    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean"
    ) {
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return { ok: false, code: "non_finite_number" };
      continue;
    }
    if (typeof current.value !== "object") return { ok: false, code: "non_json_type" };
    if (seen.has(current.value)) return { ok: false, code: "cycle" };
    seen.add(current.value);

    if (Array.isArray(current.value)) {
      if (current.value.length > LIMITS.jsonNodes - nodes - stack.length) {
        return { ok: false, code: "node_limit" };
      }
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }

    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { ok: false, code: "non_plain_object" };
    }
    const ownKeys = Reflect.ownKeys(current.value);
    const remainingNodes = LIMITS.jsonNodes - nodes - stack.length;
    if (ownKeys.length > remainingNodes || ownKeys.some((key) => typeof key !== "string")) {
      return {
        ok: false,
        code: ownKeys.length > remainingNodes ? "node_limit" : "symbol_key",
      };
    }
    const descriptors = Object.getOwnPropertyDescriptors(current.value);
    for (const descriptor of Object.values(descriptors)) {
      if (!("value" in descriptor) || descriptor.enumerable !== true) {
        return { ok: false, code: "non_data_property" };
      }
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }

  const serialized = JSON.stringify(value);
  if (serialized === undefined) return { ok: false, code: "not_serializable" };
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > byteLimit) return { ok: false, code: "byte_limit" };
  return { ok: true, bytes };
}

function schemaIssues(kind: ContractKind, value: unknown): ValidationIssue[] {
  const [, errors] = validators[kind].Errors(value);
  return errors.slice(0, LIMITS.validationIssues).map((error) => ({
    path: typeof error.instancePath === "string" && error.instancePath ? error.instancePath : "/",
    code: typeof error.keyword === "string" ? error.keyword : "invalid",
  }));
}

function failure(
  contract: ContractKind,
  code: ValidationFailure["code"],
  issues: ValidationIssue[],
): ValidationResult<never> {
  return {
    ok: false,
    error: {
      code,
      contract,
      message: `The ${contract} contract was rejected.`,
      issues: issues.slice(0, LIMITS.validationIssues),
    },
  };
}

function duplicateIssue(values: string[], path: string): ValidationIssue[] {
  return new Set(values).size === values.length ? [] : [{ path, code: "duplicate" }];
}

function validateTaskPacketSemantics(value: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const role = value.role as string;
  const scope = value.scope as {
    mutablePaths?: string[];
    wyrd?: unknown;
  };
  if (role !== "builder" && scope.mutablePaths !== undefined) {
    issues.push({ path: "/scope/mutablePaths", code: "role_incompatible" });
  }
  if (role !== "planner" && scope.wyrd !== undefined) {
    issues.push({ path: "/scope/wyrd", code: "role_incompatible" });
  }
  const inputs = value.inputs as Array<{ kind: string; value: string }>;
  if (role !== "planner" && inputs.some((input) => input.kind === "wyrd")) {
    issues.push({ path: "/inputs", code: "role_incompatible" });
  }
  const executionGrants = value.executionGrants as Array<{ id: string }> | undefined;
  if (role !== "builder" && executionGrants !== undefined) {
    issues.push({ path: "/executionGrants", code: "role_incompatible" });
  }
  if (executionGrants) {
    issues.push(...duplicateIssue(executionGrants.map((grant) => grant.id), "/executionGrants"));
  }

  const deliverables = value.deliverables as Array<{ id: string }>;
  const validation = value.validation as Array<{ id: string }>;
  const criteria = value.completionCriteria as Array<{ id: string }>;
  issues.push(...duplicateIssue(deliverables.map((item) => item.id), "/deliverables"));
  issues.push(...duplicateIssue(validation.map((item) => item.id), "/validation"));
  issues.push(...duplicateIssue(criteria.map((item) => item.id), "/completionCriteria"));
  issues.push(
    ...duplicateIssue(inputs.map((input) => `${input.kind}\u0000${input.value}`), "/inputs"),
  );

  const constraints = new Set((value.constraints as string[]).map((item) => item.trim().toLowerCase()));
  if ((value.nonGoals as string[]).some((item) => constraints.has(item.trim().toLowerCase()))) {
    issues.push({ path: "/nonGoals", code: "contradictory" });
  }
  return issues;
}

function validateAmendmentSemantics(value: Record<string, unknown>): ValidationIssue[] {
  if (Array.isArray(value.completionCriteria)) {
    return duplicateIssue(
      (value.completionCriteria as Array<{ id: string }>).map((item) => item.id),
      "/completionCriteria",
    );
  }
  return [];
}

function validateResultSemantics(value: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const roleDetails = value.roleDetails as { role: string; noChange?: boolean; commits?: unknown[]; changedPaths?: unknown[] };
  if (roleDetails.role !== value.role) {
    issues.push({ path: "/roleDetails/role", code: "role_mismatch" });
  }
  issues.push(
    ...duplicateIssue(
      (value.deliverables as Array<{ id: string }>).map((item) => item.id),
      "/deliverables",
    ),
    ...duplicateIssue(
      (value.completionCriteria as Array<{ id: string }>).map((item) => item.id),
      "/completionCriteria",
    ),
    ...duplicateIssue(
      (value.validation as Array<{ id: string }>).map((item) => item.id),
      "/validation",
    ),
  );

  if ((value.outcome === "failed") !== (value.failure !== undefined)) {
    issues.push({ path: "/failure", code: "outcome_mismatch" });
  }

  if (value.outcome === "completed") {
    const incompleteDeliverable = (value.deliverables as Array<{ status: string }>).some(
      (item) => item.status === "not_produced",
    );
    const unmetCriterion = (value.completionCriteria as Array<{ status: string }>).some(
      (item) => item.status === "not_met",
    );
    const failedValidation = (value.validation as Array<{ status: string }>).some(
      (item) => item.status === "failed",
    );
    if (incompleteDeliverable) issues.push({ path: "/deliverables", code: "completion_gate" });
    if (unmetCriterion) issues.push({ path: "/completionCriteria", code: "completion_gate" });
    if (failedValidation) issues.push({ path: "/validation", code: "completion_gate" });
    if ((value.unresolvedBlockerIds as unknown[]).length > 0) {
      issues.push({ path: "/unresolvedBlockerIds", code: "completion_gate" });
    }
    if ((value.unresolvedDecisions as unknown[]).length > 0) {
      issues.push({ path: "/unresolvedDecisions", code: "completion_gate" });
    }
  }

  if (
    roleDetails.role === "builder" &&
    roleDetails.noChange === true &&
    ((roleDetails.commits?.length ?? 0) > 0 || (roleDetails.changedPaths?.length ?? 0) > 0)
  ) {
    issues.push({ path: "/roleDetails/noChange", code: "contradictory" });
  }
  return issues;
}

function validateRunSemantics(value: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const state = value.state as string;
  const terminal = ["completed", "failed", "cancelled", "abandoned"].includes(state);
  const admission = value.admission as { mode: string };
  if ((admission.mode === "queue") !== (value.queue !== undefined)) {
    issues.push({ path: "/queue", code: "admission_mode_mismatch" });
  }
  if (state === "queued") {
    if (admission.mode !== "queue") issues.push({ path: "/admission/mode", code: "queue_required" });
    if (value.resources !== undefined || value.resourceDisposition !== "unallocated") {
      issues.push({ path: "/resources", code: "queued_side_effect" });
    }
    if (value.queue === undefined) issues.push({ path: "/queue", code: "missing_queue_metadata" });
  }
  if (["starting", "working", "blocked"].includes(state) && value.resourceDisposition === "unallocated") {
    issues.push({ path: "/resourceDisposition", code: "missing_reservation" });
  }
  if (value.resourceDisposition === "unallocated" && value.resources !== undefined) {
    issues.push({ path: "/resources", code: "unallocated_with_resources" });
  }
  const runtimeRequest = value.runtimeRequest as Record<string, unknown> | undefined;
  if (runtimeRequest && Object.keys(runtimeRequest).length === 0) {
    issues.push({ path: "/runtimeRequest", code: "empty_override" });
  }
  const health = value.health as { status: string; reconciliationRequired: boolean };
  if (health.status === "healthy" && health.reconciliationRequired) {
    issues.push({ path: "/health/reconciliationRequired", code: "contradictory" });
  }
  if (state === "blocked" && value.activeBlockerId === undefined) {
    issues.push({ path: "/activeBlockerId", code: "missing_blocker" });
  }
  if (["completed", "failed"].includes(state) && (value.resultId === undefined || value.resultDigest === undefined)) {
    issues.push({ path: "/resultId", code: "missing_result" });
  }
  if (!terminal && (value.resultId !== undefined || value.resultDigest !== undefined)) {
    issues.push({ path: "/resultId", code: "premature_result" });
  }
  const allocation = value.repositoryAllocation as Record<string, unknown> | undefined;
  if (allocation) {
    const resource = value.repositoryResource as Record<string, unknown> | undefined;
    const source = allocation.source as Record<string, unknown>;
    const resourceSource = resource?.source as Record<string, unknown> | undefined;
    if (
      value.role !== "builder" ||
      allocation.runId !== value.runId ||
      allocation.fencingEpoch !== value.fencingEpoch ||
      (allocation.expectedRevision as number) >= (value.revision as number)
    ) {
      issues.push({ path: "/repositoryAllocation", code: "allocation_binding_mismatch" });
    }
    if (allocation.status === "created") {
      if (
        resource?.kind !== "builder_worktree" ||
        resource.runId !== allocation.runId ||
        resource.path !== allocation.path ||
        resource.branch !== allocation.branch ||
        resource.branchRef !== allocation.branchRef ||
        resource.baseCommit !== allocation.baseCommit ||
        resource.targetBranch !== allocation.targetBranch ||
        resource.targetRef !== allocation.targetRef ||
        resource.targetCommit !== allocation.targetCommit ||
        resource.protectedRefDigest !== allocation.protectedRefDigest ||
        resourceSource?.canonicalRootDigest !== source.canonicalRootDigest ||
        resourceSource?.commonGitDirectoryDigest !== source.commonGitDirectoryDigest
      ) {
        issues.push({ path: "/repositoryResource", code: "allocation_resource_mismatch" });
      }
    } else if (resource !== undefined) {
      issues.push({ path: "/repositoryResource", code: "allocation_not_created" });
    }
  }
  return issues;
}

function validateEventSemantics(value: Record<string, unknown>): ValidationIssue[] {
  return value.resultingRevision === (value.expectedRevision as number) + 1
    ? []
    : [{ path: "/resultingRevision", code: "revision_sequence" }];
}

function validateProgressSemantics(value: Record<string, unknown>): ValidationIssue[] {
  if (value.kind === "tool" && value.tool === undefined) {
    return [{ path: "/tool", code: "required_for_kind" }];
  }
  if (value.kind === "phase" && value.phase === undefined) {
    return [{ path: "/phase", code: "required_for_kind" }];
  }
  return [];
}

function validateConfigurationSemantics(value: Record<string, unknown>): ValidationIssue[] {
  const runtimes = value.runtimes as Record<string, Record<string, unknown>> | undefined;
  if (!runtimes) return [];
  const emptyRole = Object.entries(runtimes).find(([, runtime]) => Object.keys(runtime).length === 0);
  return emptyRole ? [{ path: `/runtimes/${emptyRole[0]}`, code: "empty_override" }] : [];
}

function validateManifestSemantics(value: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const resources = value.resources as Array<{ id: string }>;
  const roles = value.roles as Array<{ id: string; profilePath: string }>;
  const expectedRoles = ["scout", "planner", "builder"];
  const expectedResources = [
    "member_companion",
    "member_companion_runtime",
    "member_companion_protocol",
    "member_progress_transport",
  ];
  if (roles.map((role) => role.id).sort().join(",") !== [...expectedRoles].sort().join(",")) {
    issues.push({ path: "/roles", code: "builtin_roles_only" });
  }
  if (resources.map((resource) => resource.id).sort().join(",") !== [...expectedResources].sort().join(",")) {
    issues.push({ path: "/resources", code: "companion_resources_only" });
  }
  issues.push(...duplicateIssue(resources.map((resource) => resource.id), "/resources"));
  for (const [index, role] of roles.entries()) {
    if (role.profilePath !== `agents/pi/roles/${role.id}.md`) {
      issues.push({ path: `/roles/${index}/profilePath`, code: "profile_path_mismatch" });
    }
  }
  return issues;
}

const semanticValidators: Partial<
  Record<ContractKind, (value: Record<string, unknown>) => ValidationIssue[]>
> = {
  taskPacket: validateTaskPacketSemantics,
  amendment: validateAmendmentSemantics,
  result: validateResultSemantics,
  run: validateRunSemantics,
  event: validateEventSemantics,
  progressFrame: validateProgressSemantics,
  configuration: validateConfigurationSemantics,
  roleManifest: validateManifestSemantics,
};

export function parseContractText<Kind extends ContractKind>(
  kind: Kind,
  text: string | Buffer,
): ValidationResult {
  const bytes = typeof text === "string" ? Buffer.byteLength(text, "utf8") : text.byteLength;
  if (bytes > CONTRACT_BYTE_LIMITS[kind]) {
    return failure(kind, "oversized", [{ path: "/", code: "byte_limit" }]);
  }
  let value: unknown;
  try {
    value = JSON.parse(text.toString());
  } catch {
    return failure(kind, "invalid_json_value", [{ path: "/", code: "parse" }]);
  }
  return validateContract(kind, value);
}

export function validateContract<Kind extends ContractKind>(
  kind: Kind,
  value: unknown,
): ValidationResult {
  const inspection = inspectJson(value, CONTRACT_BYTE_LIMITS[kind]);
  if (!inspection.ok) {
    const code = inspection.code === "byte_limit" ? "oversized" : "invalid_json_value";
    return failure(kind, code, [{ path: "/", code: inspection.code }]);
  }
  if (!validators[kind].Check(value)) {
    return failure(kind, "schema_invalid", schemaIssues(kind, value));
  }
  const semanticIssues = semanticValidators[kind]?.(value as Record<string, unknown>) ?? [];
  if (semanticIssues.length > 0) return failure(kind, "semantic_invalid", semanticIssues);
  return { ok: true, value, bytes: inspection.bytes };
}
