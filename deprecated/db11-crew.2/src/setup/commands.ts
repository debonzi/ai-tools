import { homedir } from "node:os";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_CONFIGURATION,
  parseConfigurationText,
  validateConfiguredRuntimeChoices,
  type AvailableRuntimeChoice,
  type EffectiveConfiguration,
} from "../config/config.ts";
import { AccountConfigurationStore, serializeConfiguration } from "../config/store.ts";
import { redactDiagnostic } from "../security/redaction.ts";
import {
  applyHerdrPiIntegration,
  diagnoseSetup,
  type HerdrIntegrationPlan,
  type SetupDiagnosticOptions,
  type SetupDiagnosticReport,
} from "./diagnostics.ts";

export interface SetupCommandOptions {
  extensionPath: string;
  environment?: NodeJS.ProcessEnv;
  diagnose?: (ctx: ExtensionCommandContext) => Promise<SetupDiagnosticReport>;
  applyIntegration?: (plan: HerdrIntegrationPlan) => Promise<void>;
  configurationStore?: AccountConfigurationStore;
}

function displayPath(path: string, home: string): string {
  return path.split(home).join("~");
}

function canonicalStateText(state: SetupDiagnosticReport["canonicalState"]): string {
  switch (state) {
    case "missing_safe":
      return "missing; safe for possible initialization only during a later explicit activation";
    case "recognized":
      return "recognized current state";
    case "blocked":
      return "blocked by an unsafe or foreign collision";
  }
}

function reportText(report: SetupDiagnosticReport, home: string): string {
  const lines = [
    `DB11 Crew setup diagnostics: ${report.ready ? "ready" : "not ready"}`,
    "",
    ...report.checks.map((check) => {
      const marker = check.status === "ready" ? "PASS" : check.status === "warning" ? "WARN" : "BLOCK";
      return `[${marker}] ${check.id}: ${check.message}${check.remediation ? `\n  Remediation: ${check.remediation}` : ""}`;
    }),
    "",
    `Canonical state: ${canonicalStateText(report.canonicalState)}`,
    `Configuration: ${report.configuration.status} (${displayPath(report.configuration.path, home)})`,
    `Herdr Pi integration: ${report.integration.status}`,
  ];
  if (report.integrationPlan) {
    lines.push("", "Exact optional setup plan:", `  Command: ${report.integrationPlan.command.join(" ")}`);
    for (const effect of report.integrationPlan.effects) lines.push(`  - ${displayPath(effect, home)}`);
    lines.push("", "No setup action has run. A separate /db11-crew-setup apply invocation and confirmation are required.");
  }
  lines.push(
    "",
    "Canonical-state readiness is point-in-time evidence only. It does not authorize activation or establish ownership or future availability.",
    "These probes are local and read-only. They do not contact a live Herdr socket or any remote service.",
  );
  return lines.join("\n");
}

function safeConfiguration(configuration: EffectiveConfiguration): string {
  return serializeConfiguration(configuration);
}

function runtimeChoices(ctx: ExtensionCommandContext): AvailableRuntimeChoice[] {
  const models = ctx.scopedModels.length > 0
    ? ctx.scopedModels.map((entry) => entry.model)
    : ctx.modelRegistry.getAvailable();
  return models.map((model) => ({ provider: model.provider, model: model.id, reasoning: model.reasoning }));
}

function changedSettings(before: EffectiveConfiguration, after: EffectiveConfiguration): string[] {
  const pointers: Array<[string, unknown, unknown]> = [
    ["limits.maxActiveMembers", before.limits.maxActiveMembers, after.limits.maxActiveMembers],
    ["limits.maxOpenMemberResources", before.limits.maxOpenMemberResources, after.limits.maxOpenMemberResources],
    ["limits.maxQueuedDelegations", before.limits.maxQueuedDelegations, after.limits.maxQueuedDelegations],
    ["retention.policy", before.retention.policy, after.retention.policy],
    ["retention.inspectionGraceMilliseconds", before.retention.inspectionGraceMilliseconds, after.retention.inspectionGraceMilliseconds],
    ["progress.enabled", before.progress.enabled, after.progress.enabled],
    ...(["scout", "planner", "builder"] as const).map((role) => [
      `runtimes.${role}`,
      before.runtimes[role] ?? null,
      after.runtimes[role] ?? null,
    ] as [string, unknown, unknown]),
  ];
  return pointers
    .filter(([, left, right]) => JSON.stringify(left) !== JSON.stringify(right))
    .map(([path, , right]) => `${path} = ${redactDiagnostic(JSON.stringify(right), { maximumLength: 160 })}`);
}

async function showDocument(ctx: ExtensionCommandContext, title: string, text: string): Promise<void> {
  if (!ctx.hasUI) return;
  await ctx.ui.editor(title, text);
}

/** Register human-only setup, diagnostics, and validated account-settings commands. */
export function installSetupCommands(pi: ExtensionAPI, options: SetupCommandOptions): void {
  const environment = options.environment ?? process.env;
  const home = environment.HOME ?? homedir();
  const store = options.configurationStore ?? new AccountConfigurationStore(home);
  const diagnose = options.diagnose ?? ((ctx) => diagnoseSetup({
    extensionPath: options.extensionPath,
    environment,
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
  }));
  const apply = options.applyIntegration ?? ((plan) => applyHerdrPiIntegration(plan, {
    environment,
    cwd: home,
  }));

  pi.registerCommand("db11-crew-doctor", {
    description: "Run local read-only DB11 Crew setup and readiness diagnostics",
    handler: async (_args, ctx) => {
      const report = await diagnose(ctx);
      if (ctx.hasUI) await showDocument(ctx, "DB11 Crew read-only diagnostics", reportText(report, home));
    },
  });

  pi.registerCommand("db11-crew-setup", {
    description: "Review setup or separately confirm the official Herdr Pi integration",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action && action !== "apply") {
        ctx.ui.notify("Use /db11-crew-setup for read-only review or /db11-crew-setup apply after separate authorization.", "error");
        return;
      }
      const report = await diagnose(ctx);
      await showDocument(ctx, "DB11 Crew setup plan", reportText(report, home));
      if (action !== "apply") return;
      if (!ctx.hasUI) return;
      const plan = report.integrationPlan;
      if (!plan) {
        ctx.ui.notify(report.integration.status === "current" ? "The official Herdr Pi integration is already current." : "No safe integration plan is available.", report.integration.status === "current" ? "info" : "error");
        return;
      }
      const exactPlan = [
        `Command: ${plan.command.join(" ")}`,
        ...plan.effects.map((effect) => displayPath(effect, home)),
        "This confirmation authorizes only this official Herdr Pi integration write.",
      ].join("\n");
      const confirmed = await ctx.ui.confirm("Install the official Herdr Pi integration?", exactPlan);
      if (!confirmed) {
        ctx.ui.notify("DB11 Crew setup was cancelled without mutation.", "info");
        return;
      }
      await apply(plan);
      const after = await diagnose(ctx);
      if (after.integration.status !== "current") throw new Error("The official Herdr Pi integration did not verify as current.");
      ctx.ui.notify("The official Herdr Pi integration is installed and verified. Reload or restart Pi.", "info");
    },
  });

  pi.registerCommand("db11-crew-settings", {
    description: "View or edit validated non-secret DB11 Crew account settings",
    handler: async (args, ctx) => {
      const action = args.trim() || "show";
      if (action !== "show" && action !== "edit") {
        ctx.ui.notify("Use /db11-crew-settings show or /db11-crew-settings edit.", "error");
        return;
      }
      const inspection = await store.inspect();
      if (inspection.status === "unsafe") {
        ctx.ui.notify("DB11 Crew refused an unsafe configuration path and made no change.", "error");
        return;
      }
      const baseline = inspection.status === "valid" || inspection.status === "default"
        ? inspection.configuration
        : undefined;
      if (action === "show") {
        if (!baseline) {
          const issues = inspection.status === "invalid" ? inspection.issues.map((issue) => `${issue.path}: ${issue.code}`).join("\n") : "invalid";
          await showDocument(ctx, "Rejected DB11 Crew settings (values hidden)", issues);
          return;
        }
        await showDocument(ctx, `Validated DB11 Crew settings · ${displayPath(inspection.path, home)}`, safeConfiguration(baseline));
        return;
      }
      if (!ctx.hasUI) return;
      const defaults = baseline ?? DEFAULT_CONFIGURATION;
      if (!baseline) ctx.ui.notify("The invalid file's values are hidden. Editing starts from safe defaults and requires confirmation before replacement.", "warning");
      const choices = runtimeChoices(ctx);
      const providers = [...new Set(choices.map((choice) => choice.provider))].sort();
      ctx.ui.notify(`Allowed runtime providers in this Pi session: ${providers.slice(0, 16).join(", ") || "none"}.`, "info");
      const edited = await ctx.ui.editor("Edit validated DB11 Crew settings JSON", safeConfiguration(defaults));
      if (edited === undefined) return;
      const parsed = parseConfigurationText(edited);
      if (!parsed.ok) {
        const safe = parsed.error.issues.map((issue) => `${issue.path}: ${issue.code}`).join(", ");
        ctx.ui.notify(`Settings rejected without displaying values: ${safe}`, "error");
        return;
      }
      const runtimeIssues = validateConfiguredRuntimeChoices(parsed.value, choices);
      if (runtimeIssues.length > 0) {
        ctx.ui.notify(`Runtime choices rejected: ${runtimeIssues.map((issue) => `${issue.path}: ${issue.code}`).join(", ")}`, "error");
        return;
      }
      const changes = changedSettings(defaults, parsed.value);
      if (changes.length === 0 && inspection.status === "valid") {
        ctx.ui.notify("Validated settings are unchanged.", "info");
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Write DB11 Crew account settings?",
        [`Path: ${displayPath(store.path, home)}`, ...(changes.length > 0 ? changes : ["Replace the rejected file with validated defaults."]), "Mode: private account file; no project, trust, package, or secret-store changes."].join("\n"),
      );
      if (!confirmed) return;
      const receipt = await store.writeText(serializeConfiguration(parsed.value));
      ctx.ui.notify(receipt.changed ? "Validated DB11 Crew settings were written. Run /reload or restart Pi." : "Validated settings are unchanged.", "info");
    },
  });
}
