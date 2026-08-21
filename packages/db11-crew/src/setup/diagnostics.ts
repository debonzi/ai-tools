import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";

import { runBoundedCommand, type CommandOptions, type CommandResult } from "../adapters/process.ts";
import { AccountConfigurationStore, type ConfigurationInspection } from "../config/store.ts";
import { COMPATIBILITY_DESCRIPTOR, resolveCompatibility, type CompatibilityReadiness } from "../protocol/compatibility.ts";
import { SCHEMA_VERSION } from "../protocol/limits.ts";
import { redactDiagnostic } from "../security/redaction.ts";
import { SecureStateRoot, type CanonicalStateInspection } from "../state/filesystem.ts";

export type SetupCheckStatus = "ready" | "warning" | "blocked";

export interface SetupCheck {
  id: string;
  status: SetupCheckStatus;
  message: string;
  remediation?: string;
}

export interface HerdrIntegrationObservation {
  status: "current" | "missing" | "outdated" | "unknown";
  targetPath?: string;
  version?: number;
}

export interface HerdrIntegrationPlan {
  command: readonly [string, "integration", "install", "pi"];
  targetPath: string;
  effects: readonly string[];
}

export interface SetupDiagnosticReport {
  schemaVersion: typeof SCHEMA_VERSION;
  ready: boolean;
  checks: readonly SetupCheck[];
  compatibility?: CompatibilityReadiness;
  canonicalState: CanonicalStateInspection;
  configuration: ConfigurationInspection;
  integration: HerdrIntegrationObservation;
  integrationPlan?: HerdrIntegrationPlan;
}

export type SetupCommandRunner = (
  executable: string,
  arguments_: readonly string[],
  options: CommandOptions,
) => Promise<CommandResult>;

export interface SetupDiagnosticOptions {
  extensionPath: string;
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  projectTrusted?: boolean;
  runner?: SetupCommandRunner;
}

function commandEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "PATH", "LANG", "LC_ALL", "PI_CODING_AGENT_DIR"] as const) {
    const value = environment[key];
    if (value && value.length <= 4_096 && !value.includes("\0")) output[key] = value;
  }
  output.PATH ??= "/usr/local/bin:/usr/bin:/bin";
  output.LANG ??= "C.UTF-8";
  output.LC_ALL ??= output.LANG;
  return output;
}

function parseVersion(output: Buffer, pattern: RegExp): string {
  const match = pattern.exec(output.toString("utf8").trim());
  if (!match?.[1]) throw new Error("version_unavailable");
  return match[1];
}

function collectMethodConstants(value: unknown, methods = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectMethodConstants(item, methods);
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.method !== null && typeof record.method === "object") {
      const constant = (record.method as { const?: unknown }).const;
      if (typeof constant === "string") methods.add(constant);
    }
    for (const item of Object.values(record)) collectMethodConstants(item, methods);
  }
  return methods;
}

export function parseHerdrSchema(text: string | Buffer): { protocol: number; schemaVersion: number; methods: Set<string> } {
  let value: unknown;
  try { value = JSON.parse(text.toString()); } catch { throw new Error("schema_invalid"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("schema_invalid");
  const schema = value as Record<string, unknown>;
  if (!Number.isInteger(schema.protocol) || !Number.isInteger(schema.schema_version) || schema.schemas === undefined) {
    throw new Error("schema_invalid");
  }
  return {
    protocol: schema.protocol as number,
    schemaVersion: schema.schema_version as number,
    methods: collectMethodConstants((schema.schemas as Record<string, unknown>).request),
  };
}

export function parseHerdrIntegrationStatus(output: string): HerdrIntegrationObservation {
  const line = output.split(/\r?\n/u).find((candidate) => candidate.startsWith("pi:"));
  if (!line) return { status: "unknown" };
  const missing = /^pi:\s+not installed\s+\(([^\r\n)]+)\)\s*$/u.exec(line);
  if (missing) return { status: "missing", targetPath: missing[1] };
  const current = /^pi:\s+current\s+\(v([0-9]+)\)\s+\((\/[^\r\n)]+)\)\s*$/u.exec(line);
  if (current) {
    const version = Number(current[1]);
    return { status: version < 2 ? "outdated" : "current", targetPath: current[2], version };
  }
  if (!/^pi:\s+installed\b/u.test(line)) return { status: "unknown" };
  const target = /\((\/[^\r\n)]+)\)\s*$/u.exec(line)?.[1];
  const versionText = /\b(?:version\s+|v)([0-9]+)\b/iu.exec(line)?.[1];
  const version = versionText === undefined ? undefined : Number(versionText);
  const outdated = /\boutdated\b/iu.test(line) || (version !== undefined && version < 2);
  return {
    status: outdated ? "outdated" : "current",
    ...(target ? { targetPath: target } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

function planFor(integration: HerdrIntegrationObservation, executable: string): HerdrIntegrationPlan | undefined {
  if (integration.status !== "missing" && integration.status !== "outdated") return undefined;
  if (!integration.targetPath || !isAbsolute(integration.targetPath)) return undefined;
  return Object.freeze({
    command: Object.freeze([executable, "integration", "install", "pi"] as const),
    targetPath: integration.targetPath,
    effects: Object.freeze([
      `Write the official Herdr Pi integration only at ${integration.targetPath}.`,
      "Create its extensions directory only under the resolved existing Pi agent directory when Herdr requires it.",
      "Do not install or update DB11 Crew, alter package filters, change Pi trust, or modify project files.",
    ]),
  });
}

export async function diagnoseSetup(options: SetupDiagnosticOptions): Promise<SetupDiagnosticReport> {
  const environment = options.environment ?? process.env;
  const home = environment.HOME;
  if (!home || !isAbsolute(home)) throw new Error("The account home is unavailable.");
  const runner = options.runner ?? runBoundedCommand;
  const command = environment.HERDR_BIN_PATH && isAbsolute(environment.HERDR_BIN_PATH)
    ? environment.HERDR_BIN_PATH
    : "herdr";
  const cwd = options.cwd ? resolve(options.cwd) : home;
  const commandOptions: CommandOptions = {
    cwd,
    environment: commandEnvironment(environment),
    timeoutMilliseconds: 10_000,
    maximumOutputBytes: 2 * 1_024 * 1_024,
  };
  const [configuration, canonicalState] = await Promise.all([
    new AccountConfigurationStore(home).inspect(),
    SecureStateRoot.inspectAtAccountHome(home),
  ]);
  const checks: SetupCheck[] = [];
  if (process.platform !== "linux") {
    checks.push({ id: "platform", status: "blocked", message: "DB11 Crew 0.2.0 supports local Linux only." });
  } else {
    checks.push({ id: "platform", status: "ready", message: "The local Linux platform is supported." });
  }
  if (canonicalState === "missing_safe") {
    checks.push({
      id: "canonical_state",
      status: "ready",
      message: "Canonical state is absent and safe for possible initialization during a later explicit activation.",
    });
  } else if (canonicalState === "recognized") {
    checks.push({
      id: "canonical_state",
      status: "ready",
      message: "Canonical state is exactly recognized at this point in time.",
    });
  } else {
    checks.push({
      id: "canonical_state",
      status: "blocked",
      message: "Canonical state is blocked by an unsafe or foreign collision.",
      remediation: "Inspect canonical account state manually; DB11 Crew will not repair, replace, migrate, or inspect noncanonical resources.",
    });
  }
  if (configuration.status === "invalid") {
    checks.push({ id: "configuration", status: "blocked", message: "The account configuration is not valid configuration v2; rejected values remain hidden.", remediation: "Review the v2 example, then use /db11-crew-settings edit to manually replace the file with validated non-secret v2 settings. DB11 Crew does not migrate or rewrite it automatically." });
  } else if (configuration.status === "unsafe") {
    checks.push({ id: "configuration", status: "blocked", message: "The account configuration path failed ownership, type, link, or mode checks.", remediation: "Inspect the path manually; DB11 Crew will not repair or replace an unsafe target." });
  } else {
    checks.push({ id: "configuration", status: "ready", message: configuration.status === "default" ? "Validated built-in settings are active; no configuration file exists." : "The account configuration is valid and private." });
  }

  let integration: HerdrIntegrationObservation = { status: "unknown" };
  let compatibility: CompatibilityReadiness | undefined;
  try {
    const extensionPath = await realpath(options.extensionPath);
    const packageRoot = resolve(dirname(extensionPath), "../../../..");
    const packageInfo = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    if (packageInfo.name !== "@debonzi/db11-crew" || packageInfo.version !== "0.2.0") throw new Error("package_identity");
    checks.push({ id: "package", status: "ready", message: "The loaded DB11 Crew package identity is @debonzi/db11-crew 0.2.0." });

    const [herdrVersionResult, schemaResult, integrationResult, gitResult, wyrdResult] = await Promise.all([
      runner(command, ["--version"], commandOptions),
      runner(command, ["api", "schema", "--json"], commandOptions),
      runner(command, ["integration", "status"], commandOptions),
      runner("git", ["--version"], commandOptions),
      runner("wyrd", ["--version"], commandOptions),
    ]);
    const herdrVersion = parseVersion(herdrVersionResult.stdout, /(?:herdr\s+)?([0-9]+\.[0-9]+\.[0-9]+)/u);
    const schema = parseHerdrSchema(schemaResult.stdout);
    integration = parseHerdrIntegrationStatus(integrationResult.stdout.toString("utf8"));
    const requiredHerdrMethods = COMPATIBILITY_DESCRIPTOR.herdr.requiredCapabilities.filter((capability) => schema.methods.has(capability));
    compatibility = resolveCompatibility({
      schemaVersion: SCHEMA_VERSION,
      platform: "linux",
      pi: { version: PI_VERSION, capabilities: [...COMPATIBILITY_DESCRIPTOR.pi.requiredCapabilities] },
      herdr: { version: herdrVersion, protocol: schema.protocol, apiSchema: schema.schemaVersion, capabilities: requiredHerdrMethods },
      git: { version: parseVersion(gitResult.stdout, /git version ([0-9]+\.[0-9]+\.[0-9]+)/u), capabilities: [...COMPATIBILITY_DESCRIPTOR.git.requiredCapabilities] },
      wyrd: { version: parseVersion(wyrdResult.stdout, /(?:wyrd\s+)?([0-9]+\.[0-9]+\.[0-9]+)/u), capabilities: [...COMPATIBILITY_DESCRIPTOR.wyrd.requiredCapabilities] },
    });
    for (const [component, result] of Object.entries(compatibility.components)) {
      checks.push({
        id: `compatibility.${component}`,
        status: result.ready ? "ready" : "blocked",
        message: result.ready ? `${component} satisfies the tested compatibility and capability contract.` : `${component} does not satisfy the tested compatibility and capability contract.`,
        ...(!result.ready ? { remediation: compatibility.diagnostics.find((item) => item.component === component)?.remediation } : {}),
      });
    }
  } catch (error) {
    checks.push({ id: "runtime", status: "blocked", message: "A bounded local runtime or package probe failed.", remediation: `Verify the supported Pi, Herdr, Git, and Wyrd executables, then rerun read-only diagnostics. (${redactDiagnostic(error instanceof Error ? error.message : error, { homeDirectory: home, maximumLength: 160 })})` });
  }

  if (integration.status === "current") {
    checks.push({ id: "herdr.pi_integration", status: "ready", message: "The official Herdr Pi integration is installed and current." });
  } else if (integration.status === "missing" || integration.status === "outdated") {
    checks.push({ id: "herdr.pi_integration", status: "blocked", message: `The official Herdr Pi integration is ${integration.status}.`, remediation: "Review the exact setup plan, then authorize setup separately if desired." });
  } else {
    checks.push({ id: "herdr.pi_integration", status: "blocked", message: "The official Herdr Pi integration status could not be determined safely." });
  }

  if (options.projectTrusted === false) {
    checks.push({ id: "project.trust", status: "warning", message: "The current project is not trusted by Pi; dispatch remains inert.", remediation: "Use Pi's own trust flow. DB11 Crew never changes trust." });
  }
  const integrationPlan = planFor(integration, command);
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    ready: checks.every((check) => check.status !== "blocked"),
    checks: Object.freeze(checks),
    compatibility,
    canonicalState,
    configuration,
    integration,
    integrationPlan,
  });
}

export async function applyHerdrPiIntegration(
  plan: HerdrIntegrationPlan,
  options: Pick<SetupDiagnosticOptions, "environment" | "cwd" | "runner"> = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  const home = environment.HOME;
  if (!home || !isAbsolute(home)) throw new Error("The account home is unavailable.");
  const runner = options.runner ?? runBoundedCommand;
  await runner(plan.command[0], plan.command.slice(1), {
    cwd: options.cwd ? resolve(options.cwd) : home,
    environment: commandEnvironment(environment),
    timeoutMilliseconds: 30_000,
    maximumOutputBytes: 64 * 1_024,
  });
}
