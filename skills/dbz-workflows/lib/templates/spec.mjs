import { ValidationError } from "../errors.mjs";
import { serializeFrontmatter } from "../frontmatter.mjs";
import { indexLevelTwoSections } from "../markdown.mjs";
import { validateSpecMetadata } from "../schemas/spec.mjs";

function assertText(value, name, { multiline = false } = {}) {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.includes("\0") ||
		(!multiline && /[\r\n]/u.test(value))
	) {
		throw new ValidationError(
			`${name} must be a non-empty ${multiline ? "text" : "single-line string"} without NUL bytes.`,
		);
	}
	return value.trim();
}

function quotedMarkdown(value) {
	return value.replace(/\r\n?/gu, "\n").split("\n").map((line) => `> ${line}`).join("\n");
}

export function createInitialSpecArtifactSource({ workflowId, title, initialIdea, timestamp }) {
	assertText(workflowId, "workflowId");
	const normalizedTitle = assertText(title, "title");
	const normalizedIdea = assertText(initialIdea, "initialIdea", { multiline: true });
	assertText(timestamp, "timestamp");
	const metadata = {
		artifact: "spec",
		schema_version: 1,
		workflow_id: workflowId,
		status: "draft",
		based_on: null,
		current_baseline: null,
		open_blockers: [],
		last_synthesis_ticket: null,
		updated_at: timestamp,
	};
	validateSpecMetadata(metadata, { expectedWorkflowId: workflowId });
	const body = [
		`# Specification: ${normalizedTitle}`,
		"",
		"## Initial Idea",
		"",
		quotedMarkdown(normalizedIdea),
		"",
	].join("\n");
	const source = serializeFrontmatter(metadata, body);
	indexLevelTwoSections(source);
	return source;
}
