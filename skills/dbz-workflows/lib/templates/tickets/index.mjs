import { ValidationError } from "../../errors.mjs";
import { serializeFrontmatter } from "../../frontmatter.mjs";
import { listLevelTwoSections } from "../../markdown.mjs";
import {
	requiredTicketSections,
	validateTicketMetadata,
} from "../../schemas/ticket.mjs";

function normalizeSections(value, headings) {
	if (value === undefined) value = {};
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ValidationError("Ticket template sections must be a mapping keyed by section heading.");
	}
	const allowed = new Set(headings);
	for (const [heading, content] of Object.entries(value)) {
		if (!allowed.has(heading)) {
			throw new ValidationError(`Ticket template section '${heading}' is not part of the selected V1 ticket contract.`);
		}
		if (typeof content !== "string" || content.includes("\0")) {
			throw new ValidationError(`Ticket template section '${heading}' must be Markdown without NUL bytes.`);
		}
	}
	return headings.map((heading) => [heading, (value[heading] ?? "").replace(/\r\n?/gu, "\n").trim()]);
}

export function createTicketArtifactSource(metadata, { sections } = {}) {
	const normalized = validateTicketMetadata(metadata, {
		expectedId: metadata?.id,
		expectedSlug: metadata?.slug,
		expectedWorkflowId: metadata?.workflow_id,
	});
	const headings = requiredTicketSections(normalized.type);
	const content = normalizeSections(sections, headings);
	const body = [
		`# ${normalized.title}`,
		"",
		...content.flatMap(([heading, section]) => [
			`## ${heading}`,
			"",
			...(section.length === 0 ? [] : [section]),
			"",
		]),
	].join("\n");
	const source = serializeFrontmatter(normalized, body);
	const actualHeadings = listLevelTwoSections(source).map(({ title }) => title);
	if (JSON.stringify(actualHeadings) !== JSON.stringify(headings)) {
		throw new ValidationError("Ticket section content must not define additional managed headings.");
	}
	return source;
}
