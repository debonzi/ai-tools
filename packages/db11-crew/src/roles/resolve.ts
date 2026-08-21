import manifestValue from "../../agents/pi/roles/manifest.json" with { type: "json" };

import type {
  EffectiveConfiguration,
  RoleId,
  RuntimeOverride,
  ThinkingLevel,
} from "../config/config.ts";
import type { CompatibilityReadiness } from "../protocol/compatibility.ts";
import {
  LIMITS,
  MEMBER_PROFILE_MANIFEST_VERSION,
  ROLE_PROFILE_VERSION,
  SCHEMA_VERSION,
} from "../protocol/limits.ts";
import { validateContract } from "../protocol/validate.ts";

export interface ManifestResource {
  id: string;
  packageName: string;
  packageVersion: string;
  resourcePath: string;
  sha256: string;
  npmIntegrity?: string;
}

export interface ManifestRole {
  id: RoleId;
  profileVersion: typeof ROLE_PROFILE_VERSION;
  profilePath: string;
  profileSha256: string;
}

interface RoleManifest {
  schemaVersion: typeof MEMBER_PROFILE_MANIFEST_VERSION;
  package: { name: "@debonzi/db11-crew"; version: "0.2.0" };
  resources: ManifestResource[];
  roles: ManifestRole[];
}

export interface ObservedProfile {
  profileVersion: typeof ROLE_PROFILE_VERSION;
  profilePath: string;
  profileSha256: string;
}

export interface ObservedResource extends ManifestResource {}

export interface AvailableRuntime {
  provider: string;
  model: string;
  thinkingLevels: ThinkingLevel[];
}

export interface RoleReadinessInput {
  role: RoleId;
  configuration: EffectiveConfiguration;
  compatibility: CompatibilityReadiness;
  profile: ObservedProfile;
  resources: ObservedResource[];
  availableRuntimes: AvailableRuntime[];
  explicitRuntime?: RuntimeOverride;
  crewleadRuntime?: RuntimeOverride;
}

export interface ResolvedRuntime {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  sources: {
    provider: "dispatch" | "configuration" | "crewlead";
    model: "dispatch" | "configuration" | "crewlead";
    thinking: "dispatch" | "configuration" | "crewlead";
  };
}

export interface RoleReadinessReceipt {
  schemaVersion: typeof SCHEMA_VERSION;
  role: RoleId;
  profileVersion: typeof ROLE_PROFILE_VERSION;
  ready: boolean;
  runtime?: ResolvedRuntime;
  profile?: ObservedProfile;
  resources: ObservedResource[];
  checks: Array<{
    id: "compatibility" | "provenance" | "runtime" | "manifest";
    ready: boolean;
    code: string;
    message: string;
  }>;
}

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const BUILT_IN_ROLE_MANIFEST: unknown = deepFreeze(structuredClone(manifestValue));

export function validateBuiltInRoleManifest() {
  return validateContract("roleManifest", BUILT_IN_ROLE_MANIFEST);
}

function boundedToken(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    !/[\s\u0000-\u001f\u007f]/u.test(value)
  );
}

function boundedRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= LIMITS.pathLength &&
    !value.startsWith("/") &&
    !/(?:^|\/)\.\.(?:\/|$)/u.test(value) &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function runtimeOverrideIsBounded(value: RuntimeOverride | undefined): boolean {
  if (value === undefined) return true;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !["provider", "model", "thinking"].includes(key))) {
    return false;
  }
  if (value.provider !== undefined && !boundedToken(value.provider, LIMITS.labelLength)) return false;
  if (value.model !== undefined && !boundedToken(value.model, LIMITS.idLength)) return false;
  if (
    value.thinking !== undefined &&
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.thinking)
  ) {
    return false;
  }
  return true;
}

function resourceIsBounded(resource: ObservedResource): boolean {
  return (
    boundedToken(resource.id, LIMITS.idLength) &&
    boundedToken(resource.packageName, LIMITS.idLength) &&
    boundedToken(resource.packageVersion, 32) &&
    boundedRelativePath(resource.resourcePath) &&
    /^[a-f0-9]{64}$/u.test(resource.sha256) &&
    (resource.npmIntegrity === undefined || resource.npmIntegrity.length <= 256)
  );
}

function observationsAreBounded(input: RoleReadinessInput): boolean {
  if (input.resources.length > LIMITS.listItems || input.availableRuntimes.length > 128) return false;
  if (
    input.profile.profileVersion !== ROLE_PROFILE_VERSION ||
    !boundedRelativePath(input.profile.profilePath) ||
    !/^[a-f0-9]{64}$/u.test(input.profile.profileSha256) ||
    !input.resources.every(resourceIsBounded)
  ) {
    return false;
  }
  return input.availableRuntimes.every(
    (runtime) =>
      boundedToken(runtime.provider, LIMITS.labelLength) &&
      boundedToken(runtime.model, LIMITS.idLength) &&
      runtime.thinkingLevels.length >= 1 &&
      runtime.thinkingLevels.length <= 7 &&
      new Set(runtime.thinkingLevels).size === runtime.thinkingLevels.length &&
      runtime.thinkingLevels.every((level) =>
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level),
      ),
  );
}

function selectField<Key extends keyof RuntimeOverride>(
  key: Key,
  explicit: RuntimeOverride | undefined,
  configured: RuntimeOverride | undefined,
  crewlead: RuntimeOverride | undefined,
): { value: RuntimeOverride[Key]; source?: "dispatch" | "configuration" | "crewlead" } {
  if (explicit?.[key] !== undefined) return { value: explicit[key], source: "dispatch" };
  if (configured?.[key] !== undefined) return { value: configured[key], source: "configuration" };
  if (crewlead?.[key] !== undefined) return { value: crewlead[key], source: "crewlead" };
  return { value: undefined };
}

function resolveRuntime(input: RoleReadinessInput): { ready: boolean; runtime?: ResolvedRuntime } {
  if (
    !runtimeOverrideIsBounded(input.explicitRuntime) ||
    !runtimeOverrideIsBounded(input.configuration.runtimes[input.role]) ||
    !runtimeOverrideIsBounded(input.crewleadRuntime)
  ) {
    return { ready: false };
  }
  const provider = selectField("provider", input.explicitRuntime, input.configuration.runtimes[input.role], input.crewleadRuntime);
  const model = selectField("model", input.explicitRuntime, input.configuration.runtimes[input.role], input.crewleadRuntime);
  const thinking = selectField("thinking", input.explicitRuntime, input.configuration.runtimes[input.role], input.crewleadRuntime);
  if (
    typeof provider.value !== "string" ||
    typeof model.value !== "string" ||
    thinking.value === undefined ||
    provider.source === undefined ||
    model.source === undefined ||
    thinking.source === undefined
  ) {
    return { ready: false };
  }
  const available = input.availableRuntimes.find(
    (runtime) => runtime.provider === provider.value && runtime.model === model.value,
  );
  const runtime: ResolvedRuntime = {
    provider: provider.value,
    model: model.value,
    thinking: thinking.value,
    sources: {
      provider: provider.source,
      model: model.source,
      thinking: thinking.source,
    },
  };
  return { ready: available?.thinkingLevels.includes(thinking.value) === true, runtime };
}

function resourceMatches(expected: ManifestResource, observed: ObservedResource): boolean {
  return (
    expected.id === observed.id &&
    expected.packageName === observed.packageName &&
    expected.packageVersion === observed.packageVersion &&
    expected.resourcePath === observed.resourcePath &&
    expected.sha256 === observed.sha256 &&
    expected.npmIntegrity === observed.npmIntegrity
  );
}

function profileMatches(expected: ManifestRole, observed: ObservedProfile): boolean {
  return (
    expected.profileVersion === observed.profileVersion &&
    expected.profilePath === observed.profilePath &&
    expected.profileSha256 === observed.profileSha256
  );
}

function check(
  id: RoleReadinessReceipt["checks"][number]["id"],
  ready: boolean,
  code: string,
  message: string,
): RoleReadinessReceipt["checks"][number] {
  return { id, ready, code: ready ? "ready" : code, message };
}

function unavailableReceipt(role: RoleId, code: string): RoleReadinessReceipt {
  return {
    schemaVersion: SCHEMA_VERSION,
    role,
    profileVersion: ROLE_PROFILE_VERSION,
    ready: false,
    resources: [],
    checks: [check("manifest", false, code, "The package-owned member profile manifest was rejected.")],
  };
}

export function resolveRoleReadiness(input: RoleReadinessInput): RoleReadinessReceipt {
  const manifestValidation = validateBuiltInRoleManifest();
  if (!manifestValidation.ok) return unavailableReceipt(input.role, "manifest_invalid");
  const manifest = manifestValidation.value as RoleManifest;
  const profile = manifest.roles.find((candidate) => candidate.id === input.role);
  if (!profile) return unavailableReceipt(input.role, "role_unavailable");
  if (!observationsAreBounded(input)) return unavailableReceipt(input.role, "observation_invalid");

  const resourcesReady = manifest.resources.every((resource) => {
    const candidates = input.resources.filter((observed) => observed.id === resource.id);
    return candidates.length === 1 && resourceMatches(resource, candidates[0]!);
  }) && input.resources.length === manifest.resources.length;
  const provenanceReady = profileMatches(profile, input.profile) && resourcesReady;
  const runtime = resolveRuntime(input);
  const compatibilityReady = input.compatibility.roles[input.role] === true;
  const checks = [
    check("compatibility", compatibilityReady, "compatibility_unready", "Required package runtime compatibility checks did not pass."),
    check("provenance", provenanceReady, "provenance_mismatch", "The role profile or a common companion resource failed exact package provenance checks."),
    check("runtime", runtime.ready, "runtime_unavailable", "The resolved provider, model, or thinking level is unavailable."),
  ];
  const ready = checks.every((entry) => entry.ready);
  return {
    schemaVersion: SCHEMA_VERSION,
    role: input.role,
    profileVersion: profile.profileVersion,
    ready,
    ...(runtime.runtime ? { runtime: runtime.runtime } : {}),
    ...(ready ? { profile: structuredClone(input.profile), resources: structuredClone(input.resources) } : { resources: [] }),
    checks,
  };
}
