import { SCHEMA_VERSION } from "./limits.ts";
import { validateContract } from "./validate.ts";

export type CompatibilityComponent = "pi" | "herdr" | "wyrd" | "git";
export type BuiltInRole = "scout" | "planner" | "builder";

interface VersionObservation {
  version: string;
  capabilities: string[];
}

interface CompatibilityObservation {
  schemaVersion: typeof SCHEMA_VERSION;
  platform: "linux";
  pi: VersionObservation;
  herdr: VersionObservation & { protocol: number; apiSchema: number };
  wyrd: VersionObservation;
  git: VersionObservation;
}

export interface ComponentReadiness {
  ready: boolean;
  code: "ready" | "unsupported_version" | "unsupported_protocol" | "missing_capability" | "observation_invalid";
  missingCapabilities: number;
}

export interface CompatibilityReadiness {
  schemaVersion: typeof SCHEMA_VERSION;
  ready: boolean;
  components: Record<CompatibilityComponent, ComponentReadiness>;
  roles: Record<BuiltInRole, boolean>;
  diagnostics: Array<{
    component: CompatibilityComponent;
    code: ComponentReadiness["code"];
    message: string;
    remediation: string;
  }>;
}

const PI_CAPABILITIES = [
  "cli.no_builtin_tools",
  "extension.active_tools",
  "extension.async_factory",
  "extension.custom_bash_no_session_env",
  "extension.custom_entries",
  "extension.input",
  "extension.project_trust",
  "extension.session_id",
  "extension.session_shutdown",
  "extension.session_start",
  "extension.session_tree",
  "extension.tool_source_info",
  "package.explicit_extension",
] as const;

const HERDR_CAPABILITIES = [
  "agent.get",
  "agent.prompt",
  "agent.send_keys",
  "agent.start",
  "agent.wait",
  "events.subscribe",
  "events.wait",
  "notification.show",
  "pane.close",
  "pane.get",
  "pane.report_agent_session",
  "pane.report_metadata",
  "session.snapshot",
  "tab.close",
  "tab.create",
  "tab.get",
  "tab.list",
  "workspace.get",
  "workspace.list",
] as const;

const WYRD_CAPABILITIES = [
  "json",
  "lifecycle",
  "optimistic_revision",
  "project.status",
  "summary",
  "task.edit",
  "task.list",
  "task.view",
  "ticket.edit",
  "ticket.view",
] as const;

const GIT_CAPABILITIES = [
  "apply.binary",
  "branch.safe_delete",
  "diff.binary",
  "diff.name_only",
  "for_each_ref",
  "ls_files",
  "merge.ff_only",
  "merge_base.is_ancestor",
  "rev_list",
  "rev_parse",
  "show.subject",
  "show_ref.verify",
  "status.porcelain_v2",
  "symbolic_ref",
  "worktree.add",
  "worktree.remove",
] as const;

export const COMPATIBILITY_DESCRIPTOR = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  platform: "linux" as const,
  pi: Object.freeze({
    referenceVersion: "0.84.1",
    supportedMinorLines: Object.freeze([
      Object.freeze({ major: 0, minor: 84, minimumPatch: 1 }),
    ]),
    requiredCapabilities: Object.freeze([...PI_CAPABILITIES]),
  }),
  herdr: Object.freeze({
    referenceVersion: "0.7.5",
    adapters: Object.freeze([Object.freeze({ protocol: 17, apiSchema: 1 })]),
    requiredCapabilities: Object.freeze([...HERDR_CAPABILITIES]),
  }),
  wyrd: Object.freeze({
    range: ">=0.1.0 <1.0.0",
    requiredCapabilities: Object.freeze([...WYRD_CAPABILITIES]),
  }),
  git: Object.freeze({
    range: ">=2.39.0 <3.0.0",
    requiredCapabilities: Object.freeze([...GIT_CAPABILITIES]),
  }),
});

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseStableVersion(value: string): ParsedVersion | undefined {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function missingCapabilities(required: readonly string[], observed: readonly string[]): number {
  const available = new Set(observed);
  return required.reduce((count, capability) => count + (available.has(capability) ? 0 : 1), 0);
}

function component(
  versionReady: boolean,
  required: readonly string[],
  observation: VersionObservation,
  protocolReady = true,
): ComponentReadiness {
  if (!versionReady) return { ready: false, code: "unsupported_version", missingCapabilities: 0 };
  if (!protocolReady) return { ready: false, code: "unsupported_protocol", missingCapabilities: 0 };
  const missing = missingCapabilities(required, observation.capabilities);
  if (missing > 0) return { ready: false, code: "missing_capability", missingCapabilities: missing };
  return { ready: true, code: "ready", missingCapabilities: 0 };
}

function invalidReadiness(): CompatibilityReadiness {
  const invalid: ComponentReadiness = {
    ready: false,
    code: "observation_invalid",
    missingCapabilities: 0,
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    ready: false,
    components: { pi: { ...invalid }, herdr: { ...invalid }, wyrd: { ...invalid }, git: { ...invalid } },
    roles: { scout: false, planner: false, builder: false },
    diagnostics: [
      {
        component: "pi",
        code: "observation_invalid",
        message: "Runtime compatibility observations were rejected.",
        remediation: "Run the read-only DB11 Crew setup diagnostics again.",
      },
    ],
  };
}

function diagnostic(componentName: CompatibilityComponent, readiness: ComponentReadiness) {
  const descriptions: Record<ComponentReadiness["code"], [string, string]> = {
    ready: ["Runtime component is ready.", "No action is required."],
    unsupported_version: [
      "Runtime version is outside the tested compatibility contract.",
      "Install a package-tested stable version or update DB11 Crew after compatibility testing.",
    ],
    unsupported_protocol: [
      "Runtime protocol does not match a package-owned adapter.",
      "Install a Herdr release with a supported protocol and API schema.",
    ],
    missing_capability: [
      "Runtime capability probes did not satisfy the required contract.",
      "Inspect the setup report and restore the missing supported capability.",
    ],
    observation_invalid: [
      "Runtime compatibility observations were rejected.",
      "Run the read-only DB11 Crew setup diagnostics again.",
    ],
  };
  const [message, remediation] = descriptions[readiness.code];
  return { component: componentName, code: readiness.code, message, remediation };
}

export function resolveCompatibility(value: unknown): CompatibilityReadiness {
  const validation = validateContract("compatibilityObservation", value);
  if (!validation.ok) return invalidReadiness();
  const observation = validation.value as CompatibilityObservation;

  const piVersion = parseStableVersion(observation.pi.version);
  const piVersionReady =
    piVersion !== undefined &&
    COMPATIBILITY_DESCRIPTOR.pi.supportedMinorLines.some(
      (line) =>
        piVersion.major === line.major &&
        piVersion.minor === line.minor &&
        piVersion.patch >= line.minimumPatch,
    );

  const herdrVersion = parseStableVersion(observation.herdr.version);
  const herdrProtocolReady = COMPATIBILITY_DESCRIPTOR.herdr.adapters.some(
    (adapter) =>
      adapter.protocol === observation.herdr.protocol &&
      adapter.apiSchema === observation.herdr.apiSchema,
  );

  const wyrdVersion = parseStableVersion(observation.wyrd.version);
  const wyrdVersionReady =
    wyrdVersion !== undefined && wyrdVersion.major === 0 && wyrdVersion.minor >= 1;

  const gitVersion = parseStableVersion(observation.git.version);
  const gitVersionReady =
    gitVersion !== undefined &&
    (gitVersion.major > 2 ||
      (gitVersion.major === 2 && (gitVersion.minor > 39 || gitVersion.minor === 39))) &&
    gitVersion.major < 3;

  const components: Record<CompatibilityComponent, ComponentReadiness> = {
    pi: component(piVersionReady, PI_CAPABILITIES, observation.pi),
    herdr: component(
      herdrVersion !== undefined,
      HERDR_CAPABILITIES,
      observation.herdr,
      herdrProtocolReady,
    ),
    wyrd: component(wyrdVersionReady, WYRD_CAPABILITIES, observation.wyrd),
    git: component(gitVersionReady, GIT_CAPABILITIES, observation.git),
  };
  const packageReady = components.pi.ready && components.herdr.ready;
  const roles = {
    scout: packageReady && components.git.ready,
    planner: packageReady && components.git.ready && components.wyrd.ready,
    builder: packageReady && components.git.ready,
  };
  const diagnostics = (Object.entries(components) as Array<[CompatibilityComponent, ComponentReadiness]>)
    .filter(([, readiness]) => !readiness.ready)
    .map(([componentName, readiness]) => diagnostic(componentName, readiness));

  return {
    schemaVersion: SCHEMA_VERSION,
    ready: packageReady,
    components,
    roles,
    diagnostics,
  };
}
