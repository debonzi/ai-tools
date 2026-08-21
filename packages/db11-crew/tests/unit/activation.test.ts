import assert from "node:assert/strict";
import test from "node:test";

import {
  CREWLEAD_ACTIVATION_COMMAND,
  CREWLEAD_DESIGNATION_ENTRY_TYPE,
  CREWLEAD_TOOL_NAMES,
  MANAGED_MEMBER_ENVIRONMENT_KEYS,
  classifyCrewleadActivationInput,
  createCrewleadDesignation,
  hasCurrentCrewleadDesignation,
  isCrewleadToolName,
  isManagedMemberSession,
  parseCrewleadDesignation,
  withCrewleadTools,
  withoutCrewleadTools,
} from "../../src/crewlead/activation.ts";

const SESSION_ID = "019c2f66-ec52-7ed1-a780-2c6fe351ba2a";

function marker(data: unknown, customType: string = CREWLEAD_DESIGNATION_ENTRY_TYPE) {
  return { type: "custom", customType, data };
}

test("only exact image-free direct input is classified as activation", () => {
  assert.equal(classifyCrewleadActivationInput({
    text: CREWLEAD_ACTIVATION_COMMAND,
    source: "interactive",
  }), "direct");
  assert.equal(classifyCrewleadActivationInput({
    text: CREWLEAD_ACTIVATION_COMMAND,
    images: [],
    source: "rpc",
  }), "direct");

  for (const text of [
    "db11-crew",
    " /skill:db11-crew",
    "/skill:db11-crew ",
    "/skill:db11-crew now",
    "/skill:DB11-CREW",
    "/skill:db11-crew\n",
  ]) {
    assert.equal(classifyCrewleadActivationInput({ text, source: "interactive" }), "none", text);
  }

  assert.equal(classifyCrewleadActivationInput({
    text: CREWLEAD_ACTIVATION_COMMAND,
    images: [{ type: "image" }],
    source: "interactive",
  }), "none");
  assert.equal(classifyCrewleadActivationInput({
    text: CREWLEAD_ACTIVATION_COMMAND,
    source: "extension",
  }), "extension");
});

test("designation payload creation and parsing enforce the closed version-1 shape", () => {
  const payload = createCrewleadDesignation(SESSION_ID);
  assert.deepEqual(payload, { schemaVersion: 1, crewleadSessionId: SESSION_ID });
  assert.deepEqual(Object.keys(payload), ["schemaVersion", "crewleadSessionId"]);
  assert.equal(Object.isFrozen(payload), true);
  assert.deepEqual(parseCrewleadDesignation(payload), payload);

  for (const malformed of [
    null,
    [],
    {},
    { schemaVersion: 2, crewleadSessionId: SESSION_ID },
    { schemaVersion: 1 },
    { schemaVersion: 1, crewleadSessionId: "" },
    { schemaVersion: 1, crewleadSessionId: "invalid session" },
    { schemaVersion: 1, crewleadSessionId: SESSION_ID, owner: "requester" },
    { schemaVersion: 1, crewleadSessionId: SESSION_ID, path: "/private/session" },
  ]) {
    assert.equal(parseCrewleadDesignation(malformed), undefined);
  }
  assert.throws(() => createCrewleadDesignation(""), /session ID is invalid/u);
});

test("designation restoration scans complete entries but accepts only the current session", () => {
  const copiedMarker = marker(createCrewleadDesignation("different-session"));
  const currentMarker = marker(createCrewleadDesignation(SESSION_ID));

  assert.equal(hasCurrentCrewleadDesignation([copiedMarker], SESSION_ID), false);
  assert.equal(hasCurrentCrewleadDesignation([currentMarker], SESSION_ID), true);
  assert.equal(hasCurrentCrewleadDesignation([
    marker({ schemaVersion: 1, crewleadSessionId: SESSION_ID, extra: true }),
    currentMarker,
  ], SESSION_ID), true);
  assert.equal(hasCurrentCrewleadDesignation([
    { ...currentMarker, type: "custom_message" },
    marker(createCrewleadDesignation(SESSION_ID), "other-extension"),
  ], SESSION_ID), false);
  assert.equal(hasCurrentCrewleadDesignation([currentMarker], "different-session"), false);
  assert.equal(hasCurrentCrewleadDesignation([currentMarker], ""), false);
});

test("every launch-owned managed-member indicator rejects Crewlead ownership", () => {
  assert.equal(isManagedMemberSession({}), false);
  assert.equal(isManagedMemberSession({ DB11_CREW_UNRELATED: "1" }), false);

  for (const key of MANAGED_MEMBER_ENVIRONMENT_KEYS) {
    assert.equal(isManagedMemberSession({ [key]: "" }), true, key);
    assert.equal(isManagedMemberSession({ [key]: "value" }), true, key);
  }
});

test("Crewlead tool helpers preserve unrelated tools and use the complete exact surface", () => {
  assert.deepEqual(CREWLEAD_TOOL_NAMES, [
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
  ]);
  assert.equal(Object.isFrozen(CREWLEAD_TOOL_NAMES), true);
  assert.equal(isCrewleadToolName("db11_crew_dispatch"), true);
  assert.equal(isCrewleadToolName("db11_finalize"), false);

  const active = ["read", "db11_crew_dispatch", "other_extension_tool"];
  assert.deepEqual(withoutCrewleadTools(active), ["read", "other_extension_tool"]);
  const activated = withCrewleadTools(active);
  assert.deepEqual(activated.slice(0, 3), active);
  assert.deepEqual(activated.filter(isCrewleadToolName), CREWLEAD_TOOL_NAMES);
  assert.deepEqual(withCrewleadTools(activated), activated);
  assert.deepEqual(active, ["read", "db11_crew_dispatch", "other_extension_tool"]);
});
