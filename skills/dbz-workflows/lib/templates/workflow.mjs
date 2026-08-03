import { ValidationError } from "../errors.mjs";
import { serializeFrontmatter } from "../frontmatter.mjs";
import { indexLevelTwoSections } from "../markdown.mjs";
import { validateWorkflowMetadata } from "../schemas/workflow.mjs";

function assertText(value, name, { multiline = false } = {}) {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.includes("\0") ||
		(!multiline && /[\r\n]/u.test(value))
	) {
		throw new ValidationError(
			`${name} must be a non-empty ${multiline ? "UTF-8" : "single-line"} string without NUL bytes.`,
		);
	}
	return value.trim();
}

function quotedMarkdown(value) {
	return value.replace(/\r\n?/gu, "\n").split("\n").map((line) => `> ${line}`).join("\n");
}

export function createWorkflowArtifactSource(metadata, { objectFormat } = {}) {
	validateWorkflowMetadata(metadata, { objectFormat });
	const body = [
		`# ${metadata.title}`,
		"",
		"## Summary",
		"",
		"This workflow is managed by DBZ Workflows. Use deterministic workflow operations for lifecycle metadata.",
		"",
	].join("\n");
	const source = serializeFrontmatter(metadata, body);
	indexLevelTwoSections(source);
	return source;
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
		updated_at: timestamp,
	};
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
