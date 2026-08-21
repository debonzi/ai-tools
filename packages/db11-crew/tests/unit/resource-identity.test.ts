import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNT_CONFIGURATION_VERSION,
  builderBranchForRun,
  builderRefForRun,
  CANONICAL_RESOURCE_IDENTITY,
  COMPANION_CONFIGURATION_VERSION,
  isCanonicalBuilderBranch,
  isCanonicalBuilderRef,
  MEMBER_PROFILE_MANIFEST_VERSION,
  RESULT_CONTRACT_VERSION,
  ROLE_PROFILE_VERSION,
  SCHEMA_VERSION,
} from "../../src/protocol/limits.ts";

test("exports the exact immutable canonical resource identities", () => {
  assert.deepEqual(CANONICAL_RESOURCE_IDENTITY, {
    stateDirectory: "db11-crew",
    stateMarkerStore: "db11-crew",
    builderBranchPrefix: "db11-crew/",
    builderRefPrefix: "refs/heads/db11-crew/",
    herdrMetadataSource: "db11-crew",
  });
  assert.equal(Object.isFrozen(CANONICAL_RESOURCE_IDENTITY), true);
});

test("derives and recognizes only safe canonical Builder branches and refs", () => {
  assert.equal(builderBranchForRun("run-1.alpha_beta"), "db11-crew/run-1.alpha_beta");
  assert.equal(builderRefForRun("run-1.alpha_beta"), "refs/heads/db11-crew/run-1.alpha_beta");

  assert.equal(isCanonicalBuilderBranch("db11-crew/run-1.alpha_beta"), true);
  assert.equal(isCanonicalBuilderRef("refs/heads/db11-crew/run-1.alpha_beta"), true);

  for (const branch of [
    "db11-crew/",
    "db11-crew-v2/run-1",
    "db11-crew/run/child",
    "db11-crew/run..child",
    "db11-crew/run.",
    "db11-crew/run.lock",
  ]) {
    assert.equal(isCanonicalBuilderBranch(branch), false, branch);
  }

  for (const ref of [
    "refs/heads/db11-crew/",
    "refs/heads/db11-crew-v2/run-1",
    "refs/heads/db11-crew/run/child",
    "refs/heads/db11-crew/run..child",
    "refs/tags/db11-crew/run-1",
  ]) {
    assert.equal(isCanonicalBuilderRef(ref), false, ref);
  }

  for (const runId of ["", "-run", ".run", "run/child", "run..child", "run.", "run.lock", "a".repeat(129)]) {
    assert.throws(() => builderBranchForRun(runId), /Builder run ID is invalid/u, runId);
    assert.throws(() => builderRefForRun(runId), /Builder run ID is invalid/u, runId);
  }
});

test("keeps independent version axes unchanged", () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(RESULT_CONTRACT_VERSION, 1);
  assert.equal(ACCOUNT_CONFIGURATION_VERSION, 2);
  assert.equal(MEMBER_PROFILE_MANIFEST_VERSION, 2);
  assert.equal(COMPANION_CONFIGURATION_VERSION, 2);
  assert.equal(ROLE_PROFILE_VERSION, 2);
});
