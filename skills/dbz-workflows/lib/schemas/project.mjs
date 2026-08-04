import {
	throwIfValidationIssues,
	validationIssue,
} from "../errors.mjs";
import {
	deriveProjectKey,
	parseProjectKey,
	validateObjectId,
} from "../git-identity.mjs";
import { isRfc3339UtcTimestamp } from "../locators.mjs";

export const PROJECT_SCHEMA_VERSION = 1;

export function projectManifestIssues(metadata, { expectedIdentity } = {}) {
	const issues = [];
	const add = (path, code, message, details) => {
		issues.push(validationIssue(path, code, message, details));
	};
	if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
		add([], "invalid_metadata", "Root manifest metadata must be a mapping.");
		return issues;
	}
	if (metadata.artifact !== "project") {
		add(["artifact"], "invalid_artifact", "Root manifest artifact must be 'project'.");
	}
	if (metadata.schema_version !== PROJECT_SCHEMA_VERSION) {
		add(
			["schema_version"],
			"unsupported_schema_version",
			`Root manifest schema_version must be ${PROJECT_SCHEMA_VERSION}.`,
		);
	}

	let keyIdentity;
	try {
		keyIdentity = parseProjectKey(metadata.project_key);
	} catch {
		add(
			["project_key"],
			"invalid_project_key",
			"Root manifest project_key must contain a full supported root commit object ID.",
		);
	}
	if (typeof metadata.project_name !== "string" || metadata.project_name.trim().length === 0) {
		add(["project_name"], "invalid_project_name", "Root manifest project_name must be a non-empty string.");
	}
	if (metadata.object_format !== "sha1" && metadata.object_format !== "sha256") {
		add(
			["object_format"],
			"invalid_object_format",
			"Root manifest object_format must be 'sha1' or 'sha256'.",
		);
	}
	try {
		validateObjectId(metadata.object_format, metadata.root_commit, { name: "Root manifest root_commit" });
	} catch {
		add(
			["root_commit"],
			"invalid_root_commit",
			"Root manifest root_commit must be a full object ID for object_format.",
		);
	}
	if (
		keyIdentity &&
		(metadata.object_format !== keyIdentity.objectFormat || metadata.root_commit !== keyIdentity.rootCommit)
	) {
		add(
			["project_key"],
			"inconsistent_project_identity",
			"Root manifest project_key, object_format, and root_commit must describe the same Git lineage.",
		);
	}
	if (!Number.isSafeInteger(metadata.next_workflow_number) || metadata.next_workflow_number < 1) {
		add(
			["next_workflow_number"],
			"invalid_counter",
			"Root manifest next_workflow_number must be a positive safe integer.",
		);
	}
	for (const field of ["created_at", "updated_at"]) {
		if (!isRfc3339UtcTimestamp(metadata[field])) {
			add([field], "invalid_timestamp", `Root manifest ${field} must be an RFC 3339 UTC timestamp.`);
		}
	}
	if (expectedIdentity !== undefined) {
		let expectedKey;
		try {
			expectedKey = deriveProjectKey(expectedIdentity.objectFormat, expectedIdentity.rootCommit);
		} catch {
			expectedKey = expectedIdentity.projectKey;
		}
		if (metadata.project_key !== expectedKey || metadata.project_key !== expectedIdentity.projectKey) {
			add(
				["project_key"],
				"foreign_project_lineage",
				"Root manifest belongs to a different Git lineage.",
				{
					expected_project_key: expectedIdentity.projectKey,
					actual_project_key: metadata.project_key,
				},
			);
		}
		if (metadata.object_format !== expectedIdentity.objectFormat) {
			add(
				["object_format"],
				"foreign_object_format",
				"Root manifest object_format does not match the current project.",
			);
		}
		if (metadata.root_commit !== expectedIdentity.rootCommit) {
			add(
				["root_commit"],
				"foreign_root_commit",
				"Root manifest root_commit does not match the current project.",
			);
		}
	}
	return issues;
}

export function validateProjectMetadata(metadata, options = {}) {
	throwIfValidationIssues(projectManifestIssues(metadata, options), {
		artifact: "dbz-workflows.md",
		path: options.path,
	});
	return metadata;
}
