import assert from "node:assert/strict";
import test from "node:test";
import {
	diagnosticFromError,
	SchemaValidationError,
	throwIfValidationIssues,
	validationIssue,
} from "./errors.mjs";

test("schema validation primitives retain structured field issues", () => {
	const issue = validationIssue(
		["execution", "claim"],
		"invalid_claim",
		"A completed ticket must not retain a claim.",
	);
	assert.throws(
		() => throwIfValidationIssues([issue], { artifact: "T-0001", path: "tickets/T-0001.md" }),
		(error) => {
			assert.ok(error instanceof SchemaValidationError);
			assert.equal(error.code, "schema_validation_failed");
			assert.deepEqual(error.issues, [issue]);
			assert.deepEqual(diagnosticFromError(error), {
				name: "SchemaValidationError",
				code: "schema_validation_failed",
				message: "Artifact 'T-0001' failed schema validation with 1 issue(s).",
				details: {
					artifact: "T-0001",
					path: "tickets/T-0001.md",
					issues: [issue],
				},
			});
			return true;
		},
	);
});

test("an empty schema issue collection is valid", () => {
	assert.equal(throwIfValidationIssues([]), undefined);
});
