import { serializeFrontmatter } from "../frontmatter.mjs";
import { indexLevelTwoSections } from "../markdown.mjs";
import { validateWorkflowMetadata } from "../schemas/workflow.mjs";

export { createInitialSpecArtifactSource } from "./spec.mjs";

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
