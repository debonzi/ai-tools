import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FrontmatterError } from "./errors.mjs";
import {
	parseFrontmatter,
	patchFrontmatter,
	readFrontmatter,
	serializeFrontmatter,
	splitFrontmatter,
} from "./frontmatter.mjs";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "test-fixtures");

async function fixture(kind, name) {
	return readFile(resolve(fixtureRoot, kind, name), "utf8");
}

test("parses a valid mapping and retains its exact body", async () => {
	const source = await fixture("valid", "artifact.md");
	const parsed = parseFrontmatter(source, { path: "artifact.md" });
	assert.equal(parsed.data.artifact, "ticket");
	assert.deepEqual(parsed.data.unknown_extension, { enabled: true });
	assert.equal(parsed.body, source.slice(parsed.bodyStart));
	assert.match(parsed.body, /^# Evaluate compatibility\n/u);
	assert.deepEqual(readFrontmatter(source), parsed.data);
	assert.equal(Object.hasOwn(readFrontmatter(source), "body"), false);
});

test("reports duplicate YAML keys with artifact line and column diagnostics", async () => {
	const source = await fixture("malformed", "duplicate-key.md");
	assert.throws(
		() => parseFrontmatter(source, { path: "duplicate-key.md" }),
		(error) => {
			assert.ok(error instanceof FrontmatterError);
			assert.equal(error.code, "invalid_frontmatter");
			assert.equal(error.details.path, "duplicate-key.md");
			assert.equal(error.details.line, 4);
			assert.equal(error.details.column, 1);
			assert.match(error.message, /Map keys must be unique/u);
			return true;
		},
	);
});

test("rejects unsupported YAML tags, cyclic aliases, and excessive aliases", async () => {
	for (const name of ["custom-tag.md", "excessive-aliases.md"]) {
		const source = await fixture("malformed", name);
		assert.throws(() => parseFrontmatter(source), FrontmatterError, name);
	}
	assert.throws(
		() => parseFrontmatter("---\nvalue: &value [*value]\n---\n# Cyclic alias\n"),
		/circular reference/u,
	);
});

test("rejects missing, indented, and non-first-line delimiters", async () => {
	const missingDelimiter = await fixture("malformed", "missing-delimiter.md");
	assert.throws(() => splitFrontmatter(missingDelimiter), FrontmatterError);
	for (const source of ["\n---\na: 1\n---\n# Body\n", " ---\na: 1\n---\n# Body\n", "---\na: 1\n ...\n"]) {
		assert.throws(() => splitFrontmatter(source), FrontmatterError);
	}
});

test("serializes only conservative YAML values and round-trips them", () => {
	const source = serializeFrontmatter(
		{
			artifact: "spec",
			schema_version: 1,
			active: true,
			values: [null, "2026-08-03T15:30:00Z"],
		},
		"# Specification\n",
	);
	const parsed = parseFrontmatter(source);
	assert.deepEqual(parsed.data, {
		artifact: "spec",
		schema_version: 1,
		active: true,
		values: [null, "2026-08-03T15:30:00Z"],
	});
	assert.equal(parsed.body, "# Specification\n");
	assert.throws(() => serializeFrontmatter({ created_at: new Date() }), FrontmatterError);
	assert.throws(() => serializeFrontmatter({ invalid: Number.POSITIVE_INFINITY }), FrontmatterError);
});

test("metadata patches preserve comments, ordering, unknown fields, and the body", async () => {
	const source = await fixture("valid", "artifact.md");
	const original = parseFrontmatter(source);
	const patched = patchFrontmatter(source, [
		{ path: ["status"], value: "in-progress" },
		{ path: ["unknown_extension", "enabled"], value: false },
		{ path: ["updated_at"], value: "2026-08-03T15:30:00Z" },
	]);
	const result = parseFrontmatter(patched);

	assert.equal(result.body, original.body);
	assert.match(patched, /# Preserve this comment during metadata patches\./u);
	assert.ok(patched.indexOf("artifact:") < patched.indexOf("unknown_extension:"));
	assert.ok(patched.indexOf("unknown_extension:") < patched.indexOf("updated_at:"));
	assert.equal(result.data.status, "in-progress");
	assert.deepEqual(result.data.unknown_extension, { enabled: false });
});

test("metadata patches support explicit deletion without dropping unrelated data", () => {
	const source = "---\r\na: 1\r\n# keep\r\nb: 2\r\n---\r\n# Body\r\nExact body.\r\n";
	const patched = patchFrontmatter(source, [{ operation: "delete", path: ["a"] }]);
	const parsed = parseFrontmatter(patched);
	assert.deepEqual(parsed.data, { b: 2 });
	assert.match(patched, /# keep\r\n/u);
	assert.equal(parsed.body, "# Body\r\nExact body.\r\n");
	assert.ok(patched.startsWith("---\r\n"));
});
