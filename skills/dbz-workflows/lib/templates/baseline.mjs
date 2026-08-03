import { ValidationError } from "../errors.mjs";
import {
	markdownBodySha256,
	normalizeMarkdownBody,
} from "../filesystem.mjs";
import { serializeFrontmatter } from "../frontmatter.mjs";
import { indexLevelTwoSections } from "../markdown.mjs";
import { validateBaselineMetadata } from "../schemas/baseline.mjs";

export function createBaselineArtifactSource(metadata, body) {
	if (typeof body !== "string" || body.includes("\0")) {
		throw new ValidationError("Baseline body must be Markdown without NUL bytes.");
	}
	validateBaselineMetadata(metadata, {
		expectedId: metadata.id,
		expectedWorkflowId: metadata.workflow_id,
	});
	const normalizedBody = normalizeMarkdownBody(body);
	const actualDigest = markdownBodySha256(normalizedBody);
	if (metadata.body_sha256 !== actualDigest) {
		throw new ValidationError("Baseline metadata body_sha256 does not match the normalized Markdown body.", {
			details: { expected_digest: metadata.body_sha256, actual_digest: actualDigest },
		});
	}
	const source = serializeFrontmatter(metadata, normalizedBody);
	indexLevelTwoSections(source);
	return source;
}
