import { Buffer } from "node:buffer";
import { isAbsolute, normalize } from "node:path";
import { isMap, parseDocument } from "yaml";
import {
	ERROR_CODES,
	LocatorError,
	ValidationError,
} from "./errors.mjs";
import { readFileWithDigest } from "./filesystem.mjs";
import { parseProjectKey } from "./git-identity.mjs";

export const EXTERNAL_LOCATOR_SCHEMA_VERSION = 1;
export const MAX_LOCATOR_BYTES = 50 * 1024;
export const MAX_LOCATOR_LINES = 2_000;
const LOCATOR_FIELDS = Object.freeze([
	"schema_version",
	"project_key",
	"storage_path",
	"updated_at",
]);

function locatorProblem(message, { path, field, details, cause, code } = {}) {
	return new LocatorError(message, {
		...(code === undefined ? {} : { code }),
		details: {
			...(path === undefined ? {} : { path }),
			...(field === undefined ? {} : { field }),
			...details,
		},
		cause,
	});
}

function countLines(value) {
	if (value.length === 0) return 0;
	let lines = 1;
	for (const character of value) {
		if (character === "\n") lines += 1;
	}
	return value.endsWith("\n") ? lines - 1 : lines;
}

function yamlPosition(problem) {
	const position = problem?.linePos?.[0];
	if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.col)) return {};
	return { line: position.line, column: position.col };
}

function parseLocatorJson(source, path) {
	if (typeof source !== "string") {
		throw locatorProblem("External locator content must be a UTF-8 string.", { path });
	}
	if (source.includes("\0")) {
		throw locatorProblem("External locator content must not contain NUL bytes.", { path });
	}
	const bytes = Buffer.byteLength(source, "utf8");
	const lines = countLines(source);
	if (bytes > MAX_LOCATOR_BYTES || lines > MAX_LOCATOR_LINES) {
		throw locatorProblem("External locator content exceeds the supported size limit.", {
			path,
			details: {
				bytes,
				lines,
				max_bytes: MAX_LOCATOR_BYTES,
				max_lines: MAX_LOCATOR_LINES,
			},
		});
	}

	const document = parseDocument(source, {
		customTags: [],
		prettyErrors: true,
		schema: "json",
		strict: true,
		uniqueKeys: true,
	});
	const problem = document.errors[0] ?? document.warnings[0];
	if (problem) {
		const position = yamlPosition(problem);
		throw locatorProblem("External locator is not valid JSON with unique mapping keys.", {
			path,
			details: {
				...position,
				...(typeof problem.code === "string" ? { parser_code: problem.code } : {}),
			},
			cause: problem instanceof Error ? problem : undefined,
		});
	}
	if (!isMap(document.contents)) {
		throw locatorProblem("External locator must contain one top-level JSON object.", { path });
	}

	try {
		return JSON.parse(source);
	} catch (error) {
		throw locatorProblem("External locator is not valid JSON.", {
			path,
			cause: error instanceof Error ? error : undefined,
		});
	}
}

export function isRfc3339UtcTimestamp(value) {
	if (typeof value !== "string") return false;
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u.exec(value);
	if (!match) return false;
	const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText);
	if (year === 0 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
		return false;
	}
	const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
	return day >= 1 && day <= daysInMonth;
}

function assertPlainObject(value, path) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw locatorProblem("External locator must be a JSON object.", { path });
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw locatorProblem("External locator must be a plain object.", { path });
	}
}

export function validateExternalLocator(locator, { path, expectedProjectKey } = {}) {
	assertPlainObject(locator, path);
	const unknownFields = Object.keys(locator).filter((field) => !LOCATOR_FIELDS.includes(field));
	if (unknownFields.length > 0) {
		throw locatorProblem("External locator contains unsupported fields.", {
			path,
			details: { fields: unknownFields.sort() },
		});
	}
	for (const field of LOCATOR_FIELDS) {
		if (!Object.hasOwn(locator, field)) {
			throw locatorProblem(`External locator is missing required field '${field}'.`, { path, field });
		}
	}
	if (locator.schema_version !== EXTERNAL_LOCATOR_SCHEMA_VERSION) {
		throw locatorProblem(
			`External locator schema_version must be ${EXTERNAL_LOCATOR_SCHEMA_VERSION}.`,
			{ path, field: "schema_version" },
		);
	}
	try {
		parseProjectKey(locator.project_key);
	} catch (error) {
		throw locatorProblem("External locator project_key is invalid.", {
			path,
			field: "project_key",
			cause: error instanceof Error ? error : undefined,
		});
	}
	if (expectedProjectKey !== undefined && locator.project_key !== expectedProjectKey) {
		throw locatorProblem("External locator belongs to a different Git lineage.", {
			path,
			field: "project_key",
			details: { expected_project_key: expectedProjectKey, actual_project_key: locator.project_key },
		});
	}
	if (
		typeof locator.storage_path !== "string" ||
		locator.storage_path.length === 0 ||
		locator.storage_path.includes("\0")
	) {
		throw locatorProblem("External locator storage_path must be a non-empty absolute path.", {
			path,
			field: "storage_path",
		});
	}
	if (!isAbsolute(locator.storage_path)) {
		throw locatorProblem("External locator storage_path must be absolute.", {
			path,
			field: "storage_path",
		});
	}
	if (normalize(locator.storage_path) !== locator.storage_path) {
		throw locatorProblem("External locator storage_path must not contain traversal or redundant segments.", {
			path,
			field: "storage_path",
		});
	}
	if (!isRfc3339UtcTimestamp(locator.updated_at)) {
		throw locatorProblem("External locator updated_at must be an RFC 3339 UTC timestamp.", {
			path,
			field: "updated_at",
		});
	}
	return {
		schema_version: locator.schema_version,
		project_key: locator.project_key,
		storage_path: locator.storage_path,
		updated_at: locator.updated_at,
	};
}

export function parseExternalLocator(source, options = {}) {
	return validateExternalLocator(parseLocatorJson(source, options.path), options);
}

export function serializeExternalLocator(locator) {
	const normalized = validateExternalLocator(locator);
	return `${JSON.stringify(normalized, null, 2)}\n`;
}

export async function readExternalLocator(path, { expectedProjectKey } = {}) {
	if (typeof path !== "string" || path.includes("\0") || !isAbsolute(path)) {
		throw new ValidationError("External locator path must be absolute and contain no NUL bytes.");
	}
	let snapshot;
	try {
		snapshot = await readFileWithDigest(path, { encoding: "utf8" });
	} catch (error) {
		if (error?.code === "ENOENT") throw error;
		throw locatorProblem("External locator cannot be read safely.", {
			path,
			code: ERROR_CODES.BROKEN_LOCATOR,
			cause: error instanceof Error ? error : undefined,
		});
	}
	try {
		return {
			path,
			digest: snapshot.digest,
			locator: parseExternalLocator(snapshot.data, { path, expectedProjectKey }),
		};
	} catch (error) {
		if (error instanceof LocatorError && error.code === ERROR_CODES.BROKEN_LOCATOR) throw error;
		throw locatorProblem("External locator is invalid and must be reconfigured explicitly.", {
			path,
			code: ERROR_CODES.BROKEN_LOCATOR,
			details: {
				reason_code: typeof error?.code === "string" ? error.code : "invalid_locator",
				reason: error instanceof Error ? error.message : String(error),
				...(error?.details === undefined ? {} : { reason_details: error.details }),
			},
			cause: error instanceof Error ? error : undefined,
		});
	}
}
