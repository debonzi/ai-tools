import { Buffer } from "node:buffer";
import { MarkdownError } from "./errors.mjs";
import { parseFrontmatter } from "./frontmatter.mjs";

export const DEFAULT_SECTION_MAX_BYTES = 50 * 1024;
export const DEFAULT_SECTION_MAX_LINES = 2_000;

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

function headingFromLine(line) {
	const match = /^ {0,3}(#{1,6})(?:[\t ]+(.*?)[\t ]*|[\t ]*)$/u.exec(line);
	if (!match) return undefined;
	let title = match[2] ?? "";
	title = title.replace(/[\t ]+#+[\t ]*$/u, "").trim();
	return { level: match[1].length, title };
}

function fenceFromLine(line) {
	const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
	if (!match) return undefined;
	const marker = match[1];
	if (marker[0] === "`" && match[2].includes("`")) return undefined;
	return { marker: marker[0], length: marker.length };
}

function closesFence(line, fence) {
	const trimmed = line.replace(/^ {0,3}/u, "");
	let markerCount = 0;
	while (trimmed[markerCount] === fence.marker) markerCount += 1;
	return markerCount >= fence.length && /^[\t ]*$/u.test(trimmed.slice(markerCount));
}

function normalizeHeading(title) {
	return title.trim().replace(/[\t ]+/gu, " ").toLocaleLowerCase("en-US");
}

function lineCount(value) {
	if (value.length === 0) return 0;
	let count = 0;
	for (const character of value) {
		if (character === "\n") count += 1;
	}
	return value.endsWith("\n") ? count : count + 1;
}

function validateBound(name, value) {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new MarkdownError(`${name} must be a positive integer.`);
	}
}

function enforceBounds(value, { maxBytes, maxLines }, heading) {
	validateBound("maxBytes", maxBytes);
	validateBound("maxLines", maxLines);
	const bytes = Buffer.byteLength(value, "utf8");
	const lines = lineCount(value);
	if (bytes > maxBytes || lines > maxLines) {
		throw new MarkdownError(`Section '${heading}' exceeds the configured read bounds.`, {
			details: {
				heading,
				bytes,
				lines,
				max_bytes: maxBytes,
				max_lines: maxLines,
			},
		});
	}
}

function collectHeadings(body, bodyStart, firstBodyLine) {
	const headings = [];
	let cursor = 0;
	let line = firstBodyLine;
	let fence;
	while (cursor < body.length) {
		const record = readLine(body, cursor);
		if (fence) {
			if (closesFence(record.text, fence)) fence = undefined;
		} else {
			const openingFence = fenceFromLine(record.text);
			if (openingFence) {
				fence = openingFence;
			} else {
				const heading = headingFromLine(record.text);
				if (heading) {
					headings.push({
						...heading,
						start: bodyStart + record.start,
						lineEnd: bodyStart + record.end,
						contentStart: bodyStart + record.next,
						lineEnding: record.ending,
						line,
					});
				}
			}
		}
		if (record.next === body.length) break;
		cursor = record.next;
		line += 1;
	}
	return headings;
}

export function indexLevelTwoSections(source, { path, validateStructure = true } = {}) {
	const parsed = parseFrontmatter(source, { path });
	const firstBodyLine = parsed.closingLine + (parsed.closingNewline === "" ? 0 : 1);
	const headings = collectHeadings(parsed.body, parsed.bodyStart, firstBodyLine);
	const structural = headings.filter(({ level }) => level <= 2);

	if (validateStructure) {
		const topLevel = structural.filter(({ level }) => level === 1);
		if (topLevel.length !== 1) {
			throw new MarkdownError("A managed Markdown artifact must contain exactly one level-one heading.", {
				details: { ...(path === undefined ? {} : { path }), found: topLevel.length },
			});
		}
		if (structural[0] !== topLevel[0]) {
			throw new MarkdownError("The level-one heading must appear before managed level-two sections.", {
				details: { ...(path === undefined ? {} : { path }), line: structural[0]?.line },
			});
		}
	}

	const sections = [];
	const byName = new Map();
	for (const heading of structural) {
		if (heading.level !== 2) continue;
		if (heading.title.length === 0) {
			throw new MarkdownError("Managed level-two headings must have a name.", {
				details: { ...(path === undefined ? {} : { path }), line: heading.line },
			});
		}
		const normalized = normalizeHeading(heading.title);
		if (byName.has(normalized)) {
			throw new MarkdownError(`Duplicate managed section '${heading.title}'.`, {
				details: {
					...(path === undefined ? {} : { path }),
					heading: heading.title,
					line: heading.line,
					first_line: byName.get(normalized).line,
				},
			});
		}
		const nextBoundary = structural.find(
			(candidate) => candidate.start > heading.start && candidate.level <= heading.level,
		);
		const section = {
			...heading,
			end: nextBoundary?.start ?? source.length,
		};
		sections.push(section);
		byName.set(normalized, section);
	}

	return sections.map((section) => ({ ...section }));
}

function findSection(source, heading, options) {
	if (typeof heading !== "string" || heading.trim().length === 0) {
		throw new MarkdownError("A section heading must be a non-empty string.");
	}
	const normalized = normalizeHeading(heading);
	const section = indexLevelTwoSections(source, options).find(
		(candidate) => normalizeHeading(candidate.title) === normalized,
	);
	if (!section) {
		throw new MarkdownError(`Managed section '${heading}' was not found.`, {
			details: { ...(options.path === undefined ? {} : { path: options.path }), heading },
		});
	}
	return section;
}

export function listLevelTwoSections(source, options = {}) {
	return indexLevelTwoSections(source, options).map(({ title, line }) => ({ title, line }));
}

export function readLevelTwoSection(
	source,
	heading,
	{
		includeHeading = true,
		maxBytes = DEFAULT_SECTION_MAX_BYTES,
		maxLines = DEFAULT_SECTION_MAX_LINES,
		path,
		validateStructure = true,
	} = {},
) {
	const section = findSection(source, heading, { path, validateStructure });
	const start = includeHeading ? section.start : section.contentStart;
	const value = source.slice(start, section.end);
	enforceBounds(value, { maxBytes, maxLines }, section.title);
	return value;
}

function assertReplacementDoesNotDefineManagedSections(replacement) {
	let cursor = 0;
	let fence;
	while (cursor < replacement.length) {
		const record = readLine(replacement, cursor);
		if (fence) {
			if (closesFence(record.text, fence)) fence = undefined;
		} else {
			const openingFence = fenceFromLine(record.text);
			if (openingFence) fence = openingFence;
			else {
				const heading = headingFromLine(record.text);
				if (heading && heading.level <= 2) {
					throw new MarkdownError(
						"Replacement content must not define level-one or level-two headings.",
						{ details: { heading: heading.title, level: heading.level } },
					);
				}
			}
		}
		if (record.next === replacement.length) break;
		cursor = record.next;
	}
}

export function appendLevelTwoSection(
	source,
	heading,
	content,
	{
		maxBytes = DEFAULT_SECTION_MAX_BYTES,
		maxLines = DEFAULT_SECTION_MAX_LINES,
		path,
		validateStructure = true,
	} = {},
) {
	if (
		typeof heading !== "string" ||
		heading.trim().length === 0 ||
		heading.includes("\0") ||
		/[\r\n]/u.test(heading)
	) {
		throw new MarkdownError("A section heading must be a non-empty single-line string.");
	}
	if (typeof content !== "string" || content.includes("\0")) {
		throw new MarkdownError("Section content must be a string without NUL bytes.");
	}
	const normalizedHeading = heading.trim();
	enforceBounds(content, { maxBytes, maxLines }, normalizedHeading);
	assertReplacementDoesNotDefineManagedSections(content);
	const sections = indexLevelTwoSections(source, { path, validateStructure });
	if (sections.some(({ title }) => normalizeHeading(title) === normalizeHeading(normalizedHeading))) {
		throw new MarkdownError(`Managed section '${normalizedHeading}' already exists.`, {
			details: { ...(path === undefined ? {} : { path }), heading: normalizedHeading },
		});
	}
	const parsed = parseFrontmatter(source, { path });
	const separator = source.endsWith(parsed.newline) ? "" : parsed.newline;
	let addition = `## ${normalizedHeading}${parsed.newline}${parsed.newline}${content}`;
	if (!addition.endsWith(parsed.newline)) addition += parsed.newline;
	const replacement = `${source}${separator}${addition}`;
	indexLevelTwoSections(replacement, { path, validateStructure });
	return replacement;
}

export function replaceLevelTwoSection(
	source,
	heading,
	replacement,
	{
		maxBytes = DEFAULT_SECTION_MAX_BYTES,
		maxLines = DEFAULT_SECTION_MAX_LINES,
		path,
		validateStructure = true,
	} = {},
) {
	if (typeof replacement !== "string") {
		throw new MarkdownError("Section replacement content must be a string.");
	}
	if (replacement.includes("\0")) {
		throw new MarkdownError("Section replacement content must not contain NUL bytes.");
	}
	enforceBounds(replacement, { maxBytes, maxLines }, heading);
	assertReplacementDoesNotDefineManagedSections(replacement);
	const section = findSection(source, heading, { path, validateStructure });

	let content = replacement;
	const hasFollowingSection = section.end < source.length;
	if (content.length > 0 && section.lineEnding === "") {
		const parsed = parseFrontmatter(source, { path });
		content = `${parsed.newline}${content}`;
	}
	if (hasFollowingSection && content.length > 0 && !content.endsWith("\n")) {
		const parsed = parseFrontmatter(source, { path });
		content += parsed.newline;
	}
	return `${source.slice(0, section.contentStart)}${content}${source.slice(section.end)}`;
}
