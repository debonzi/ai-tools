import { homedir } from "node:os";
import { join } from "node:path";

import { ACCOUNT_CONFIGURATION_VERSION, LIMITS } from "../protocol/limits.ts";
import { validateContract, type ValidationFailure } from "../protocol/validate.ts";

export type RoleId = "scout" | "planner" | "builder";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RuntimeOverride {
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
}

export interface EffectiveConfiguration {
  schemaVersion: typeof ACCOUNT_CONFIGURATION_VERSION;
  limits: {
    maxActiveMembers: number;
    maxOpenMemberResources: number;
    maxQueuedDelegations: number;
  };
  retention: {
    policy: "auto_close" | "retain";
    inspectionGraceMilliseconds: number;
  };
  progress: { enabled: boolean };
  runtimes: Partial<Record<RoleId, RuntimeOverride>>;
}

interface ConfigurationInput {
  schemaVersion: typeof ACCOUNT_CONFIGURATION_VERSION;
  limits?: Partial<EffectiveConfiguration["limits"]>;
  retention?: Partial<EffectiveConfiguration["retention"]>;
  progress?: Partial<EffectiveConfiguration["progress"]>;
  runtimes?: Partial<Record<RoleId, RuntimeOverride>>;
}

export type ConfigurationFailure =
  | ValidationFailure
  | {
      code: "configuration_too_large" | "configuration_json_invalid" | "configuration_secret_like";
      contract: "configuration";
      message: string;
      issues: Array<{ path: string; code: string }>;
    };

export type ConfigurationResult =
  | { ok: true; value: EffectiveConfiguration }
  | { ok: false; error: ConfigurationFailure };

export const CONFIGURATION_RELATIVE_PATH = ".config/db11-crew/config.json" as const;

export const DEFAULT_CONFIGURATION: EffectiveConfiguration = Object.freeze({
  schemaVersion: ACCOUNT_CONFIGURATION_VERSION,
  limits: Object.freeze({
    maxActiveMembers: 4,
    maxOpenMemberResources: 6,
    maxQueuedDelegations: 6,
  }),
  retention: Object.freeze({
    policy: "auto_close" as const,
    inspectionGraceMilliseconds: LIMITS.inspectionGraceDefaultMilliseconds,
  }),
  progress: Object.freeze({ enabled: true }),
  runtimes: Object.freeze({}),
});

export function configurationPath(accountHome = homedir()): string {
  return join(accountHome, CONFIGURATION_RELATIVE_PATH);
}

function freezeRuntime(runtime: RuntimeOverride): RuntimeOverride {
  return Object.freeze({ ...runtime });
}

function secretLike(value: string): boolean {
  return /(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|Bearer\s+\S+)/iu.test(value) ||
    /\b(?:api[_-]?key|authorization|credential|password|secret|session[_-]?token|token)\b\s*[:=]/iu.test(value) ||
    /^https?:\/\/[^/@:\s]+(?::[^/@\s]*)?@/iu.test(value);
}

export function resolveConfiguration(value: unknown): ConfigurationResult {
  const validation = validateContract("configuration", value);
  if (!validation.ok) return { ok: false, error: validation.error };
  const input = validation.value as ConfigurationInput;
  for (const [role, runtime] of Object.entries(input.runtimes ?? {})) {
    for (const field of ["provider", "model"] as const) {
      const candidate = runtime?.[field];
      if (candidate && secretLike(candidate)) {
        return {
          ok: false,
          error: {
            code: "configuration_secret_like",
            contract: "configuration",
            message: "The DB11 Crew configuration contains a secret-like runtime value.",
            issues: [{ path: `/runtimes/${role}/${field}`, code: "secret_like_value" }],
          },
        };
      }
    }
  }
  const runtimes: Partial<Record<RoleId, RuntimeOverride>> = {};
  for (const role of ["scout", "planner", "builder"] as const) {
    const override = input.runtimes?.[role];
    if (override) runtimes[role] = freezeRuntime(override);
  }
  const effective: EffectiveConfiguration = {
    schemaVersion: ACCOUNT_CONFIGURATION_VERSION,
    limits: Object.freeze({
      ...DEFAULT_CONFIGURATION.limits,
      ...input.limits,
    }),
    retention: Object.freeze({
      ...DEFAULT_CONFIGURATION.retention,
      ...input.retention,
    }),
    progress: Object.freeze({
      ...DEFAULT_CONFIGURATION.progress,
      ...input.progress,
    }),
    runtimes: Object.freeze(runtimes),
  };
  return { ok: true, value: Object.freeze(effective) };
}

export interface AvailableRuntimeChoice {
  provider: string;
  model: string;
  reasoning: boolean;
}

export function validateConfiguredRuntimeChoices(
  configuration: EffectiveConfiguration,
  available: readonly AvailableRuntimeChoice[],
): Array<{ path: string; code: "provider_unavailable" | "model_unavailable" | "thinking_unavailable" }> {
  const issues: Array<{ path: string; code: "provider_unavailable" | "model_unavailable" | "thinking_unavailable" }> = [];
  for (const role of ["scout", "planner", "builder"] as const) {
    const runtime = configuration.runtimes[role];
    if (!runtime) continue;
    const providerModels = runtime.provider
      ? available.filter((choice) => choice.provider === runtime.provider)
      : available;
    if (runtime.provider && providerModels.length === 0) {
      issues.push({ path: `/runtimes/${role}/provider`, code: "provider_unavailable" });
      continue;
    }
    const matchingModels = runtime.model
      ? providerModels.filter((choice) => choice.model === runtime.model)
      : providerModels;
    if (runtime.model && matchingModels.length === 0) {
      issues.push({ path: `/runtimes/${role}/model`, code: "model_unavailable" });
      continue;
    }
    if (runtime.thinking && runtime.thinking !== "off" && runtime.model && !matchingModels.some((choice) => choice.reasoning)) {
      issues.push({ path: `/runtimes/${role}/thinking`, code: "thinking_unavailable" });
    }
  }
  return issues;
}

export function parseConfigurationText(text: string | Buffer): ConfigurationResult {
  const bytes = typeof text === "string" ? Buffer.byteLength(text, "utf8") : text.byteLength;
  if (bytes > LIMITS.configurationBytes) {
    return {
      ok: false,
      error: {
        code: "configuration_too_large",
        contract: "configuration",
        message: "The DB11 Crew configuration exceeds its size limit.",
        issues: [{ path: "/", code: "byte_limit" }],
      },
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text.toString());
  } catch {
    return {
      ok: false,
      error: {
        code: "configuration_json_invalid",
        contract: "configuration",
        message: "The DB11 Crew configuration is not valid JSON.",
        issues: [{ path: "/", code: "parse" }],
      },
    };
  }
  return resolveConfiguration(value);
}
