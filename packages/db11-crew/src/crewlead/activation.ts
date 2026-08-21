import { LIMITS } from "../protocol/limits.ts";

export const CREWLEAD_ACTIVATION_COMMAND = "/skill:db11-crew" as const;
export const CREWLEAD_DESIGNATION_ENTRY_TYPE = "db11-crew-crewlead-designation" as const;

export const CREWLEAD_TOOL_NAMES = Object.freeze([
  "db11_crew_dispatch",
  "db11_crew_list",
  "db11_crew_inspect",
  "db11_crew_amend",
  "db11_crew_respond_blocker",
  "db11_crew_result",
  "db11_crew_cancel",
  "db11_crew_force_cancel",
  "db11_crew_recover",
  "db11_crew_runtime_cleanup",
  "db11_crew_integrate",
  "db11_crew_repository_cleanup",
  "db11_crew_reconcile",
] as const);

export type CrewleadToolName = (typeof CREWLEAD_TOOL_NAMES)[number];

export const MANAGED_MEMBER_ENVIRONMENT_KEYS = Object.freeze([
  "DB11_CREW_MEMBER_BOOTSTRAP",
  "DB11_CREW_ROLE",
  "DB11_CREW_RUN_ID",
  "DB11_CREW_ASSIGNED_ROOT",
  "DB11_CREW_MEMBER_EXTENSION_PATH",
  "DB11_CREW_ROLE_PROFILE_PATH",
] as const);

export interface CrewleadDesignationPayload {
  schemaVersion: 1;
  crewleadSessionId: string;
}

export interface CrewleadActivationInput {
  text: string;
  images?: readonly unknown[];
  source: "interactive" | "rpc" | "extension";
}

export type CrewleadActivationInputClassification = "direct" | "extension" | "none";

interface CustomEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

const CREWLEAD_TOOL_NAME_SET = new Set<string>(CREWLEAD_TOOL_NAMES);
const SESSION_ID_PATTERN = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._:-]{0,${LIMITS.idLength - 1}}$`,
  "u",
);

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/** Build the only accepted closed designation payload. */
export function createCrewleadDesignation(crewleadSessionId: string): Readonly<CrewleadDesignationPayload> {
  if (!validSessionId(crewleadSessionId)) throw new TypeError("The Crewlead session ID is invalid.");
  return Object.freeze({ schemaVersion: 1, crewleadSessionId });
}

/** Parse a designation payload without accepting unknown or inherited data fields. */
export function parseCrewleadDesignation(value: unknown): Readonly<CrewleadDesignationPayload> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(record, "schemaVersion") ||
    !Object.hasOwn(record, "crewleadSessionId") ||
    record.schemaVersion !== 1 ||
    !validSessionId(record.crewleadSessionId)
  ) {
    return undefined;
  }
  return createCrewleadDesignation(record.crewleadSessionId);
}

/** Recognize a valid marker only when it belongs to the exact current session. */
export function hasCurrentCrewleadDesignation(
  entries: readonly unknown[],
  currentSessionId: string,
): boolean {
  if (!validSessionId(currentSessionId)) return false;
  return entries.some((value) => {
    if (value === null || typeof value !== "object") return false;
    const entry = value as CustomEntryLike;
    if (entry.type !== "custom" || entry.customType !== CREWLEAD_DESIGNATION_ENTRY_TYPE) {
      return false;
    }
    return parseCrewleadDesignation(entry.data)?.crewleadSessionId === currentSessionId;
  });
}

/** Distinguish direct activation from an extension-originated copy and unrelated input. */
export function classifyCrewleadActivationInput(
  input: CrewleadActivationInput,
): CrewleadActivationInputClassification {
  if (
    input.text !== CREWLEAD_ACTIVATION_COMMAND ||
    (input.images !== undefined && input.images.length > 0)
  ) {
    return "none";
  }
  return input.source === "extension" ? "extension" : "direct";
}

/** Fail closed when any launch-owned managed-member indicator is present. */
export function isManagedMemberSession(environment: NodeJS.ProcessEnv): boolean {
  return MANAGED_MEMBER_ENVIRONMENT_KEYS.some((key) => typeof environment[key] === "string");
}

export function isCrewleadToolName(name: string): name is CrewleadToolName {
  return CREWLEAD_TOOL_NAME_SET.has(name);
}

/** Return an active-tool set without changing unrelated tool names. */
export function withoutCrewleadTools(activeTools: readonly string[]): string[] {
  return activeTools.filter((name) => !isCrewleadToolName(name));
}

/** Return the union of the active tools and the complete Crewlead tool surface. */
export function withCrewleadTools(activeTools: readonly string[]): string[] {
  return [...new Set([...activeTools, ...CREWLEAD_TOOL_NAMES])];
}
