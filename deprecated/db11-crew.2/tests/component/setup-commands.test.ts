import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { AccountConfigurationStore } from "../../src/config/store.ts";
import { installSetupCommands } from "../../src/setup/commands.ts";
import type { HerdrIntegrationPlan, SetupDiagnosticReport } from "../../src/setup/diagnostics.ts";
import { temporaryAccountHome } from "../security/helpers.ts";

interface CapturedCommand {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function plan(home: string): HerdrIntegrationPlan {
  return {
    command: ["herdr", "integration", "install", "pi"],
    targetPath: `${home}/.pi/agent/extensions/herdr-agent-state.ts`,
    effects: [
      `Write the official Herdr Pi integration only at ${home}/.pi/agent/extensions/herdr-agent-state.ts.`,
      "Do not change trust or package filters.",
    ],
  };
}

function report(
  home: string,
  status: "missing" | "current",
  canonicalState: SetupDiagnosticReport["canonicalState"] = "recognized",
): SetupDiagnosticReport {
  return {
    schemaVersion: 1,
    ready: status === "current" && canonicalState !== "blocked",
    checks: [{ id: "test", status: status === "current" ? "ready" : "blocked", message: "bounded result" }],
    canonicalState,
    configuration: {
      status: "default",
      path: `${home}/.config/db11-crew/config.json`,
      configuration: {
        schemaVersion: 2,
        limits: { maxActiveMembers: 4, maxOpenMemberResources: 6, maxQueuedDelegations: 6 },
        retention: { policy: "auto_close", inspectionGraceMilliseconds: 300_000 },
        progress: { enabled: true },
        runtimes: {},
      },
    },
    integration: { status, targetPath: `${home}/.pi/agent/extensions/herdr-agent-state.ts` },
    ...(status === "missing" ? { integrationPlan: plan(home) } : {}),
  };
}

function harness(options: Parameters<typeof installSetupCommands>[1], editorResults: Array<string | undefined> = []) {
  const commands = new Map<string, CapturedCommand>();
  const notifications: Array<{ message: string; level: string }> = [];
  const confirmations: string[] = [];
  const documents: string[] = [];
  let confirmResult = false;
  const pi = {
    registerCommand(name: string, command: CapturedCommand) { commands.set(name, command); },
  } as unknown as ExtensionAPI;
  installSetupCommands(pi, options);
  const context = {
    cwd: "/fixture/project",
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => true,
    scopedModels: [],
    modelRegistry: {
      getAvailable: () => [{ provider: "approved", id: "model-a", reasoning: true }],
    },
    ui: {
      editor: async (_title: string, text: string) => {
        documents.push(text);
        return editorResults.length > 0 ? editorResults.shift() : undefined;
      },
      confirm: async (_title: string, text: string) => {
        confirmations.push(text);
        return confirmResult;
      },
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
  } as unknown as ExtensionCommandContext;
  return {
    commands,
    context,
    notifications,
    confirmations,
    documents,
    setConfirm(value: boolean) { confirmResult = value; },
  };
}

test("doctor renders only sanitized three-state canonical readiness evidence", async (t) => {
  const home = await temporaryAccountHome();
  t.after(home.cleanup);

  const renderedStates = {
    missing_safe: "missing; safe for possible initialization only during a later explicit activation",
    recognized: "recognized current state",
    blocked: "blocked by an unsafe or foreign collision",
  } as const;
  for (const canonicalState of ["missing_safe", "recognized", "blocked"] as const) {
    const value = harness({
      extensionPath: "/package/extension.ts",
      environment: { HOME: home.path },
      diagnose: async () => report(home.path, "current", canonicalState),
    });
    await value.commands.get("db11-crew-doctor")!.handler("", value.context);
    const document = value.documents[0]!;
    assert.ok(document.includes(`Canonical state: ${renderedStates[canonicalState]}`));
    assert.match(document, /point-in-time evidence only/u);
    assert.match(document, /does not authorize activation or establish ownership or future availability/u);
    assert.equal(document.includes(home.path), false);
  }
});

test("setup review is read-only and apply requires a separate explicit confirmation", async (t) => {
  const home = await temporaryAccountHome();
  t.after(home.cleanup);
  let applied = 0;
  let current = false;
  const value = harness({
    extensionPath: "/package/extension.ts",
    environment: { HOME: home.path },
    diagnose: async () => report(home.path, current ? "current" : "missing"),
    applyIntegration: async () => { applied += 1; current = true; },
  });
  const setup = value.commands.get("db11-crew-setup")!;

  await setup.handler("", value.context);
  assert.equal(applied, 0);
  assert.equal(value.confirmations.length, 0);
  assert.equal(value.documents[0]!.includes(home.path), false);
  assert.match(value.documents[0]!, /Canonical state: recognized current state/u);
  assert.match(value.documents[0]!, /separate \/db11-crew-setup apply invocation/u);

  await setup.handler("apply", value.context);
  assert.equal(applied, 0);
  assert.equal(value.confirmations.length, 1);
  assert.equal(value.confirmations[0]!.includes(home.path), false);

  value.setConfirm(true);
  await setup.handler("apply", value.context);
  assert.equal(applied, 1);
  assert.equal(value.notifications.at(-1)?.message.includes("verified"), true);
});

test("settings command rejects and redacts secret-like or unavailable runtime values", async (t) => {
  const home = await temporaryAccountHome();
  t.after(home.cleanup);
  const secret = `sk-${"z".repeat(24)}`;
  const unavailable = JSON.stringify({
    schemaVersion: 2,
    runtimes: { scout: { provider: "unapproved", model: "model-x" } },
  });
  const value = harness({
    extensionPath: "/package/extension.ts",
    environment: { HOME: home.path },
    configurationStore: new AccountConfigurationStore(home.path),
    diagnose: async () => report(home.path, "current"),
  }, [JSON.stringify({ schemaVersion: 2, runtimes: { scout: { model: secret } } }), unavailable]);
  const settings = value.commands.get("db11-crew-settings")!;

  await settings.handler("edit", value.context);
  assert.equal(value.notifications.some((entry) => entry.message.includes(secret)), false);
  assert.equal(value.confirmations.length, 0);

  await settings.handler("edit", value.context);
  assert.equal(value.notifications.at(-1)?.message.includes("provider_unavailable"), true);
  assert.equal(value.confirmations.length, 0);
  assert.equal((await new AccountConfigurationStore(home.path).inspect()).status, "default");
});

test("settings command confirms exact validated account changes and never writes project state", async (t) => {
  const home = await temporaryAccountHome();
  t.after(home.cleanup);
  const edited = JSON.stringify({
    schemaVersion: 2,
    limits: { maxActiveMembers: 2, maxOpenMemberResources: 3, maxQueuedDelegations: 1 },
    retention: { policy: "retain", inspectionGraceMilliseconds: 60_000 },
    progress: { enabled: false },
    runtimes: { scout: { provider: "approved", model: "model-a", thinking: "high" } },
  });
  const store = new AccountConfigurationStore(home.path);
  const value = harness({
    extensionPath: "/package/extension.ts",
    environment: { HOME: home.path },
    configurationStore: store,
    diagnose: async () => report(home.path, "current"),
  }, [edited]);
  value.setConfirm(true);
  await value.commands.get("db11-crew-settings")!.handler("edit", value.context);
  assert.equal(value.confirmations.length, 1);
  assert.match(value.confirmations[0]!, /limits\.maxActiveMembers = 2/u);
  assert.match(value.confirmations[0]!, /no project, trust, package, or secret-store changes/u);
  assert.equal(value.confirmations[0]!.includes(home.path), false);
  const inspection = await store.inspect();
  assert.equal(inspection.status, "valid");
  if (inspection.status === "valid") assert.equal(inspection.configuration.limits.maxActiveMembers, 2);
});
