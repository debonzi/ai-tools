import { Document, isMap, parseDocument, visit } from "yaml";
import { FrontmatterError } from "./errors.mjs";

export const MAX_YAML_ALIASES = 50;

function assertSource(source) {
	if (typeof source !== "string") {
		throw new FrontmatterError("Markdown source must be a string.", {
			details: { received_type: typeof source },
		});
	}
	if (source.includes("\0")) {
		throw new FrontmatterError("Markdown source must not contain NUL bytes.");
	}
}

function readLine(source, start) {
	const newlineIndex = source.indexOf("\n", start);
	if (newlineIndex === -1) {
		const end = source.endsWith("\r") ? source.length - 1 : source.length;
		return {
			text: source.slice(start, end),
			start,
			end,
			next: source.length,
			ending: source.endsWith("\r") ? "\r" : "",
		};
	}
	const hasCarriageReturn = newlineIndex > start && source[newlineIndex - 1] === "\r";
	const end = hasCarriageReturn ? newlineIndex - 1 : newlineIndex;
	return {
		text: source.slice(start, end),
		start,
		end,
		next: newlineIndex + 1,
		ending: hasCarriageReturn ? "\r\n" : "\n",
	};
}

export function splitFrontmatter(source, { path } = {}) {
	assertSource(source);
	const first = readLine(source, 0);
	if (first.text !== "---" || first.ending === "") {
		throw new FrontmatterError("Frontmatter must start on the first line with a standalone '---'.", {
			details: { ...(path === undefined ? {} : { path }), line: 1, column: 1 },
		});
	}

	let cursor = first.next;
	let lineNumber = 2;
	while (cursor <= source.length) {
		const line = readLine(source, cursor);
		if (line.text === "---") {
			return {
				frontmatter: source.slice(first.next, line.start),
				body: source.slice(line.next),
				bodyStart: line.next,
				newline: first.ending,
				closingNewline: line.ending,
				closingLine: lineNumber,
			};
		}
		if (line.next === source.length) break;
		cursor = line.next;
		lineNumber += 1;
	}

	throw new FrontmatterError("Frontmatter is missing a standalone closing '---' delimiter.", {
		details: { ...(path === undefined ? {} : { path }), line: 1, column: 1 },
	});
}

function firstLinePosition(problem) {
	const position = problem?.linePos?.[0];
	if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.col)) return {};
	return { line: position.line + 1, column: position.col };
}

function problemSummary(problem) {
	const message = typeof problem?.message === "string" ? problem.message : "Invalid YAML.";
	return message.split("\n", 1)[0].replace(/\s+at line \d+, column \d+:?$/u, "");
}

function throwYamlProblem(problem, path) {
	const position = firstLinePosition(problem);
	const location = position.line === undefined ? "" : ` at line ${position.line}, column ${position.column}`;
	throw new FrontmatterError(`Invalid YAML frontmatter${location}: ${problemSummary(problem)}`, {
		details: {
			...(path === undefined ? {} : { path }),
			...position,
			...(typeof problem?.code === "string" ? { yaml_code: problem.code } : {}),
		},
		cause: problem instanceof Error ? problem : undefined,
	});
}

function countAliases(document, path) {
	let aliases = 0;
	visit(document, {
		Alias() {
			aliases += 1;
			if (aliases > MAX_YAML_ALIASES) {
				throw new FrontmatterError(
					`YAML frontmatter exceeds the alias limit of ${MAX_YAML_ALIASES}.`,
					{
						details: {
							...(path === undefined ? {} : { path }),
							max_aliases: MAX_YAML_ALIASES,
						},
					},
				);
			}
		},
	});
}

function documentToData(document, path) {
	try {
		return document.toJS({ maxAliasCount: MAX_YAML_ALIASES, mapAsMap: false });
	} catch (error) {
		throw new FrontmatterError("YAML frontmatter contains unsafe or excessive alias expansion.", {
			details: { ...(path === undefined ? {} : { path }), max_aliases: MAX_YAML_ALIASES },
			cause: error,
		});
	}
}

export function parseFrontmatter(source, { path } = {}) {
	const split = splitFrontmatter(source, { path });
	const document = parseDocument(split.frontmatter, {
		customTags: [],
		prettyErrors: true,
		schema: "core",
		strict: true,
		uniqueKeys: true,
	});

	const problem = document.errors[0] ?? document.warnings[0];
	if (problem) throwYamlProblem(problem, path);
	if (!isMap(document.contents)) {
		throw new FrontmatterError("YAML frontmatter must contain one top-level mapping.", {
			details: { ...(path === undefined ? {} : { path }), line: 2, column: 1 },
		});
	}

	countAliases(document, path);
	const data = documentToData(document, path);
	validateMetadata(data);
	return { ...split, data, document };
}

export function readFrontmatter(source, options = {}) {
	return parseFrontmatter(source, options).data;
}

function assertSerializableValue(value, seen, location = "frontmatter") {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return;
	}
	if (typeof value === "number") {
		if (Number.isFinite(value)) return;
		throw new FrontmatterError(`${location} contains a non-finite number.`);
	}
	if (typeof value !== "object") {
		throw new FrontmatterError(`${location} contains an unsupported ${typeof value} value.`);
	}
	if (seen.has(value)) {
		throw new FrontmatterError(`${location} contains a circular reference.`);
	}
	seen.add(value);
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			assertSerializableValue(value[index], seen, `${location}[${index}]`);
		}
	} else {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new FrontmatterError(`${location} contains an unsupported object value.`);
		}
		for (const [key, child] of Object.entries(value)) {
			assertSerializableValue(child, seen, `${location}.${key}`);
		}
	}
	seen.delete(value);
}

function validateMetadata(metadata) {
	if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
		throw new FrontmatterError("Frontmatter metadata must be a mapping.");
	}
	assertSerializableValue(metadata, new WeakSet());
}

function stringifyDocument(document, newline) {
	let yaml = document.toString({ lineWidth: 0 });
	if (!yaml.endsWith("\n")) yaml += "\n";
	if (newline !== "\n") yaml = yaml.replaceAll("\n", newline);
	return yaml;
}

export function serializeFrontmatter(metadata, body = "", { newline = "\n" } = {}) {
	validateMetadata(metadata);
	if (typeof body !== "string") throw new FrontmatterError("Markdown body must be a string.");
	if (newline !== "\n" && newline !== "\r\n") {
		throw new FrontmatterError("Frontmatter newline must be either LF or CRLF.");
	}
	const document = new Document(metadata, { schema: "core" });
	return `---${newline}${stringifyDocument(document, newline)}---${newline}${body}`;
}

function normalizePatchPath(path) {
	if (!Array.isArray(path) || path.length === 0) {
		throw new FrontmatterError("A metadata patch path must be a non-empty array.");
	}
	return path.map((part) => {
		if (typeof part === "string" && part.length > 0 && !part.includes("\0")) return part;
		if (Number.isSafeInteger(part) && part >= 0) return part;
		throw new FrontmatterError("Metadata patch path entries must be non-empty strings or indexes.");
	});
}

function applyPatch(document, patch) {
	if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
		throw new FrontmatterError("Each metadata patch must be an object.");
	}
	const path = normalizePatchPath(patch.path);
	const operation = patch.operation ?? "set";
	if (operation === "set") {
		if (!Object.hasOwn(patch, "value")) {
			throw new FrontmatterError("A set metadata patch must provide a value.");
		}
		assertSerializableValue(patch.value, new WeakSet(), `frontmatter.${path.join(".")}`);
		document.setIn(path, patch.value);
		return;
	}
	if (operation === "delete") {
		document.deleteIn(path);
		return;
	}
	throw new FrontmatterError("Metadata patch operation must be 'set' or 'delete'.");
}

export function patchFrontmatter(source, patches, { path } = {}) {
	if (!Array.isArray(patches) || patches.length === 0) {
		throw new FrontmatterError("Metadata patches must be a non-empty array.");
	}
	const parsed = parseFrontmatter(source, { path });
	for (const patch of patches) applyPatch(parsed.document, patch);

	const problem = parsed.document.errors[0] ?? parsed.document.warnings[0];
	if (problem) throwYamlProblem(problem, path);
	const data = documentToData(parsed.document, path);
	validateMetadata(data);

	const yaml = stringifyDocument(parsed.document, parsed.newline);
	return `---${parsed.newline}${yaml}---${parsed.closingNewline}${parsed.body}`;
}
