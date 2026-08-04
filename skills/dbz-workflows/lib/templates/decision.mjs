import { ValidationError } from "../errors.mjs";
import { serializeFrontmatter } from "../frontmatter.mjs";
import { listLevelTwoSections } from "../markdown.mjs";
import {
	DECISION_REQUIRED_SECTIONS,
	validateDecisionMetadata,
} from "../schemas/decision.mjs";

function normalizeContent(value, name) {
	if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
		throw new ValidationError(`${name} must be non-empty Markdown without NUL bytes.`);
	}
	return value.replace(/\r\n?/gu, "\n").trim();
}

export function createDecisionArtifactSource(
	metadata,
	{
		context,
		consideredOptions,
		decision,
		rationale,
		consequences,
		supersession,
	},
) {
	validateDecisionMetadata(metadata, {
		expectedId: metadata.id,
		expectedSlug: metadata.slug,
		expectedWorkflowId: metadata.workflow_id,
	});
	const sectionContent = [
		["Context", normalizeContent(context, "context")],
		["Considered Options", normalizeContent(consideredOptions, "consideredOptions")],
		["Decision", normalizeContent(decision, "decision")],
		["Rationale", normalizeContent(rationale, "rationale")],
		["Consequences", normalizeContent(consequences, "consequences")],
		["Supersession", normalizeContent(supersession, "supersession")],
	];
	const body = [
		`# ${metadata.title}`,
		"",
		...sectionContent.flatMap(([heading, content]) => [`## ${heading}`, "", content, ""]),
	].join("\n");
	const source = serializeFrontmatter(metadata, body);
	const headings = listLevelTwoSections(source).map(({ title }) => title);
	if (JSON.stringify(headings) !== JSON.stringify(DECISION_REQUIRED_SECTIONS)) {
		throw new ValidationError("Decision section content must not define additional managed headings.");
	}
	return source;
}
