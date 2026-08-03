import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MarkdownError } from "./errors.mjs";
import {
	indexLevelTwoSections,
	listLevelTwoSections,
	readLevelTwoSection,
	replaceLevelTwoSection,
} from "./markdown.mjs";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "test-fixtures");

async function fixture(kind, name) {
	return readFile(resolve(fixtureRoot, kind, name), "utf8");
}

test("lists section metadata without returning section bodies", async () => {
	const source = await fixture("valid", "artifact.md");
	assert.deepEqual(listLevelTwoSections(source), [
		{ title: "Objective", line: 13 },
		{ title: "Context", line: 16 },
		{ title: "Result", line: 19 },
	]);
});

test("reads only the requested bounded level-two section", async () => {
	const source = await fixture("valid", "artifact.md");
	const objective = readLevelTwoSection(source, "objective");
	assert.equal(objective, "## Objective\nEstablish compatibility requirements.\n\n");
	assert.doesNotMatch(objective, /Existing project conventions/u);
	assert.equal(
		readLevelTwoSection(source, "Objective", { includeHeading: false }),
		"Establish compatibility requirements.\n\n",
	);
});

test("ignores apparent headings inside fenced code blocks", () => {
	const source = [
		"---",
		"artifact: ticket",
		"---",
		"# Ticket",
		"",
		"## Context",
		"~~~markdown",
		"## Not a section",
		"~~~",
		"",
		"```",
		"## Also not a section",
		"```",
		"",
		"## Result",
		"Done.",
		"",
	].join("\n");
	assert.deepEqual(
		listLevelTwoSections(source).map(({ title }) => title),
		["Context", "Result"],
	);
	assert.match(readLevelTwoSection(source, "Context"), /## Not a section/u);
});

test("rejects duplicate managed sections case-insensitively", async () => {
	const source = await fixture("malformed", "duplicate-section.md");
	assert.throws(
		() => indexLevelTwoSections(source),
		(error) => {
			assert.ok(error instanceof MarkdownError);
			assert.match(error.message, /Duplicate managed section 'result'/u);
			assert.equal(error.details.first_line, 7);
			assert.equal(error.details.line, 10);
			return true;
		},
	);
});

test("rejects malformed managed heading structure", () => {
	for (const body of [
		"## Result\nDone.\n",
		"# First\n# Second\n## Result\nDone.\n",
		"# Ticket\n##\nDone.\n",
	]) {
		const source = `---\nartifact: ticket\n---\n${body}`;
		assert.throws(() => indexLevelTwoSections(source), MarkdownError);
	}
});

test("replaces one section while preserving frontmatter and unrelated sections exactly", async () => {
	const source = await fixture("valid", "artifact.md");
	const beforeContext = readLevelTwoSection(source, "Context");
	const frontmatterAndTitle = source.slice(0, source.indexOf("## Objective"));
	const replaced = replaceLevelTwoSection(source, "Objective", "Updated objective.\n\n");

	assert.equal(replaced.slice(0, replaced.indexOf("## Objective")), frontmatterAndTitle);
	assert.equal(readLevelTwoSection(replaced, "Objective"), "## Objective\nUpdated objective.\n\n");
	assert.equal(readLevelTwoSection(replaced, "Context"), beforeContext);
	assert.match(readLevelTwoSection(replaced, "Result"), /Pending\./u);
});

test("rejects replacements that escape the selected section", async () => {
	const source = await fixture("valid", "artifact.md");
	assert.throws(
		() => replaceLevelTwoSection(source, "Objective", "Changed.\n\n## Injected\nUnsafe.\n"),
		MarkdownError,
	);
	assert.throws(
		() => replaceLevelTwoSection(source, "Objective", "# Replacement document\n"),
		MarkdownError,
	);
});

test("enforces byte and line bounds without returning partial content", async () => {
	const source = await fixture("valid", "artifact.md");
	assert.throws(
		() => readLevelTwoSection(source, "Objective", { maxBytes: 10 }),
		/ exceeds the configured read bounds/u,
	);
	assert.throws(
		() => readLevelTwoSection(source, "Objective", { maxLines: 1 }),
		/ exceeds the configured read bounds/u,
	);
	assert.throws(
		() => replaceLevelTwoSection(source, "Objective", "one\ntwo\n", { maxLines: 1 }),
		/ exceeds the configured read bounds/u,
	);
});

test("preserves CRLF delimiters during section replacement", () => {
	const source = "---\r\nartifact: ticket\r\n---\r\n# Ticket\r\n\r\n## Result\r\nOld.\r\n";
	const replaced = replaceLevelTwoSection(source, "Result", "New.\r\n");
	assert.equal(replaced, "---\r\nartifact: ticket\r\n---\r\n# Ticket\r\n\r\n## Result\r\nNew.\r\n");
});
