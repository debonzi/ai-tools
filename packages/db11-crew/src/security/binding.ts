import { isAbsolute, normalize } from "node:path";

import { SCHEMA_VERSION } from "../protocol/limits.ts";
import { canonicalJson } from "./json.ts";
import { stateError } from "./errors.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROLES = new Set(["scout", "planner", "builder"] as const);

export type BuiltInRole = "scout" | "planner" | "builder";

export interface RunCapabilityBinding {
  protocolVersion: typeof SCHEMA_VERSION;
  crewleadSessionId: string;
  herdrWorkspaceId: string;
  canonicalProjectPath: string;
  runId: string;
  memberSessionId: string;
  role: BuiltInRole;
  fencingEpoch: number;
}

export interface LeaseBinding {
  protocolVersion: typeof SCHEMA_VERSION;
  scope: "supervisor" | "companion";
  crewleadSessionId: string;
  herdrWorkspaceId: string;
  canonicalProjectPath: string;
  runId?: string;
  memberSessionId?: string;
  role?: BuiltInRole;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function canonicalAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    isAbsolute(value) &&
    normalize(value) === value &&
    !/[\u0000-\u001F\u007F]/.test(value)
  );
}

export function validateRunBinding(value: RunCapabilityBinding): RunCapabilityBinding {
  if (
    value.protocolVersion !== SCHEMA_VERSION ||
    !identifier(value.crewleadSessionId) ||
    !identifier(value.herdrWorkspaceId) ||
    !canonicalAbsolutePath(value.canonicalProjectPath) ||
    !identifier(value.runId) ||
    !identifier(value.memberSessionId) ||
    !ROLES.has(value.role) ||
    !Number.isSafeInteger(value.fencingEpoch) ||
    value.fencingEpoch < 1 ||
    value.fencingEpoch > 2_147_483_647
  ) {
    throw stateError("invalid_binding");
  }
  return value;
}

export function validateLeaseBinding(value: LeaseBinding): LeaseBinding {
  const baseValid =
    value.protocolVersion === SCHEMA_VERSION &&
    (value.scope === "supervisor" || value.scope === "companion") &&
    identifier(value.crewleadSessionId) &&
    identifier(value.herdrWorkspaceId) &&
    canonicalAbsolutePath(value.canonicalProjectPath);
  const companionValid =
    value.scope !== "companion" ||
    (identifier(value.runId) && identifier(value.memberSessionId) && ROLES.has(value.role!));
  const supervisorNarrow =
    value.scope !== "supervisor" ||
    (value.runId === undefined && value.memberSessionId === undefined && value.role === undefined);
  if (!baseValid || !companionValid || !supervisorNarrow) throw stateError("invalid_binding");
  return value;
}

export function bindingsEqual(left: RunCapabilityBinding, right: RunCapabilityBinding): boolean {
  validateRunBinding(left);
  validateRunBinding(right);
  return canonicalJson(left, 4_096) === canonicalJson(right, 4_096);
}

export function bindingKey(value: RunCapabilityBinding | LeaseBinding): string {
  return canonicalJson(value, 4_096);
}

export function validateIdentifier(value: string): string {
  if (!identifier(value)) throw stateError("invalid_record");
  return value;
}
