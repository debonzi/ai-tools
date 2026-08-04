import { ValidationError } from "../errors.mjs";
import { serializeFrontmatter } from "../frontmatter.mjs";
import { indexLevelTwoSections } from "../markdown.mjs";
import { validateVerificationMetadata } from "../schemas/verification.mjs";

export const VERIFICATION_REQUIRED_SECTIONS = Object.freeze([
	"Acceptance Criteria",
	"Mandatory Tickets",
	"Deviations",
	"Post-Integration Validation",
]);

function normalizeText(value, name, { singleLine = false } = {}) {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.includes("\0") ||
		(singleLine && /[\r\n]/u.test(value))
	) {
		throw new ValidationError(`${name} must be non-empty ${singleLine ? "single-line " : ""}text without NUL bytes.`);
	}
	return value.trim();
}

function criterionBlock(criterion, evidence) {
	const result = evidence ?? { outcome: "pending", evidence: "Pending verification." };
	return [
		`### ${criterion.id}`,
		"",
		`**Criterion:** ${criterion.text}`,
		"",
		`**Outcome:** ${result.outcome}`,
		"",
		`**Evidence:** ${normalizeText(result.evidence, `${criterion.id} evidence`)}`,
	].join("\n");
}

function ticketBlock(entry) {
	return [
		`### ${entry.ticket_id}`,
		"",
		`**Status:** ${entry.status}`,
		"",
		`**Evidence:** ${normalizeText(entry.evidence, `${entry.ticket_id} evidence`)}`,
	].join("\n");
}

function deviationsBlock(deviations) {
	if (deviations.length === 0) return "None.";
	return deviations.map((deviation, index) => [
		`### Deviation ${index + 1}`,
		"",
		`**Blocking:** ${deviation.blocking ? "yes" : "no"}`,
		"",
		normalizeText(deviation.description, `Deviation ${index + 1} description`),
	].join("\n")).join("\n\n");
}

function postIntegrationBlock(metadata) {
	const integration = metadata.integration;
	if (!integration.required) return "Not required because the verified workflow contains no project changes.";
	if (integration.status === "completed") {
		return [
			`Target branch: ${integration.target_branch}`,
			`Target commit: ${integration.target_commit}`,
			`Validated at: ${integration.validated_at}`,
			"",
			"Commands:",
			...integration.validation.commands.map((command) => `- \`${command}\``),
			"",
			`Evidence: ${integration.validation.evidence}`,
		].join("\n");
	}
	if (integration.status === "integrated") {
		return [
			`Target branch: ${integration.target_branch}`,
			`Target commit: ${integration.target_commit}`,
			"",
			"Final integration is contained, but required post-integration validation has not yet been accepted.",
		].join("\n");
	}
	return "Pending confirmed final integration and post-integration validation.";
}

export function createVerificationArtifactSource(
	metadata,
	{
		criteria,
		criterionEvidence = [],
		mandatoryTicketEvidence = [],
		deviations = [],
	} = {},
) {
	validateVerificationMetadata(metadata, { expectedWorkflowId: metadata.workflow_id });
	if (!Array.isArray(criteria) || criteria.length === 0) throw new ValidationError("Verification requires at least one baseline acceptance criterion.");
	const evidenceById = new Map(criterionEvidence.map((entry) => [entry.id, entry]));
	const body = [
		`# Verification: ${metadata.workflow_id}`,
		"",
		"## Acceptance Criteria",
		"",
		criteria.map((criterion) => criterionBlock(criterion, evidenceById.get(criterion.id))).join("\n\n"),
		"",
		"## Mandatory Tickets",
		"",
		mandatoryTicketEvidence.length === 0
			? "Pending verification of mandatory delivery tickets."
			: mandatoryTicketEvidence.map(ticketBlock).join("\n\n"),
		"",
		"## Deviations",
		"",
		deviationsBlock(deviations),
		"",
		"## Post-Integration Validation",
		"",
		postIntegrationBlock(metadata),
		"",
	].join("\n");
	const source = serializeFrontmatter(metadata, body);
	const sections = indexLevelTwoSections(source);
	const actual = sections.map(({ title }) => title);
	if (JSON.stringify(actual) !== JSON.stringify(VERIFICATION_REQUIRED_SECTIONS)) {
		throw new ValidationError("Verification template did not produce the required canonical section order.");
	}
	return source;
}
