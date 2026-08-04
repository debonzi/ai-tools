import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	relative,
	resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseFrontmatter } from "./frontmatter.mjs";

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_PATH = resolve(SKILL_ROOT, "SKILL.md");
const EXPECTED_REFERENCES = [
	"references/continuation.md",
	"references/decomposition.md",
	"references/design.md",
	"references/discovery.md",
	"references/question-session.md",
	"references/research.md",
	"references/synthesis.md",
];

async function skillSource() {
	return readFile(SKILL_PATH, "utf8");
}

async function referenceSources() {
	return Promise.all(EXPECTED_REFERENCES.map(async (relativePath) => ({
		relativePath,
		source: await readFile(resolve(SKILL_ROOT, relativePath), "utf8"),
	})));
}

function markdownLinks(source) {
	return [...source.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)].map((match) => match[1]);
}

test("DBZ Workflows is a valid progressively disclosed Agent Skill", async () => {
	const source = await skillSource();
	const parsed = parseFrontmatter(source, { path: SKILL_PATH });
	assert.equal(parsed.data.name, "dbz-workflows");
	assert.match(parsed.data.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
	assert.ok(parsed.data.name.length <= 64);
	assert.equal(parsed.data.name, basename(SKILL_ROOT));
	assert.equal(typeof parsed.data.description, "string");
	assert.ok(parsed.data.description.length >= 1 && parsed.data.description.length <= 1_024);
	assert.match(parsed.data.description, /when|Use when/iu);
	assert.match(parsed.data.description, /Do not trigger/u);
	assert.equal(typeof parsed.data.compatibility, "string");
	assert.ok(parsed.data.compatibility.length >= 1 && parsed.data.compatibility.length <= 500);
	assert.ok(source.split("\n").length < 500, "SKILL.md should remain below the Agent Skills 500-line recommendation");

	const links = markdownLinks(source).filter((link) => link.startsWith("references/"));
	assert.deepEqual([...new Set(links)].sort(), EXPECTED_REFERENCES);
	assert.match(source, /Load only the reference needed/u);
	for (const link of links) {
		const withinReferences = relative(
			resolve(SKILL_ROOT, "references"),
			resolve(SKILL_ROOT, link),
		);
		assert.equal(isAbsolute(withinReferences) || withinReferences.startsWith(".."), false);
	}
});

test("discovery and planning instructions encode every S11 gate", async () => {
	const source = await skillSource();
	const references = await referenceSources();
	const byPath = new Map(references.map(({ relativePath, source: value }) => [relativePath, value]));
	const discovery = byPath.get("references/discovery.md");
	const research = byPath.get("references/research.md");
	const questions = byPath.get("references/question-session.md");
	const synthesis = byPath.get("references/synthesis.md");
	const decomposition = byPath.get("references/decomposition.md");
	const continuation = byPath.get("references/continuation.md");

	assert.match(source, /Do \*\*not\*\* activate.*ordinary coding or review/su);
	assert.match(source, /one-off specification/u);
	assert.match(source, /exactly one discovery question per turn/u);
	assert.match(discovery, /\(003\/~018\)/u);
	assert.match(discovery, /offer a concrete proposal/u);
	assert.match(discovery, /incremental persistence/iu);
	assert.match(discovery, /dbz_workflows_update_spec_sections/u);

	for (const requirement of ["evidence", "source", "conclusion", "confidence", "impact"]) {
		assert.match(research, new RegExp(requirement, "iu"));
	}
	assert.match(questions, /manual, interactive, non-delegatable/u);
	assert.match(questions, /Ask exactly one concise question per turn/u);
	assert.match(questions, /human approval/u);
	assert.match(synthesis, /exclusive discovery writer/u);
	assert.match(synthesis, /separate, explicit user action/u);
	assert.match(synthesis, /Do not infer approval/u);
	assert.match(decomposition, /active, explicitly approved baseline/u);
	assert.match(decomposition, /one independently verifiable outcome/u);
	assert.match(decomposition, /context.*narrowly/iu);
	assert.match(continuation, /never depends on a previous Pi transcript/u);
	assert.match(continuation, /never expires automatically/u);

	const allInstructions = [source, ...references.map(({ source: value }) => value)].join("\n");
	assert.match(allInstructions, /implementation tickets must not be created.*baseline-blocking research/su);
	assert.match(allInstructions, /Never directly modify managed frontmatter/u);
	assert.match(allInstructions, /never creates a baseline/u);
});

test("references use core-owned templates without copying machine schemas", async () => {
	const references = await referenceSources();
	for (const { relativePath, source } of references) {
		assert.doesNotMatch(source, /^---$/mu, `${relativePath} must not add artifact-style frontmatter`);
		assert.doesNotMatch(source, /^\s*(?:artifact|schema_version|next_ticket_number|body_sha256):/mu);
	}
	const aggregate = references.map(({ source }) => source).join("\n");
	assert.match(aggregate, /not a (?:replacement|machine) schema/iu);
	assert.match(aggregate, /core.*template/iu);
});

test("every structured tool named by the skill exists in the extension", async () => {
	const documentation = [await skillSource(), ...(await referenceSources()).map(({ source }) => source)].join("\n");
	const namedTools = [...new Set(documentation.match(/\bdbz_workflows_[a-z_]+\b/gu) ?? [])].sort();
	const extensionSource = await readFile(
		resolve(SKILL_ROOT, "../../agents/pi/extensions/dbz-workflows/tools.ts"),
		"utf8",
	);
	assert.ok(namedTools.length > 0);
	for (const name of namedTools) {
		assert.match(extensionSource, new RegExp(`name: ["']${name}["']`, "u"), `${name} must be registered`);
	}
});
