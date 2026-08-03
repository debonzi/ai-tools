import { ValidationError } from "../errors.mjs";

const SUPPORTED_PREFIXES = Object.freeze(["B", "D", "T", "WF"]);

function assertPrefix(prefix) {
	if (!SUPPORTED_PREFIXES.includes(prefix)) {
		throw new ValidationError(`Artifact ID prefix must be one of: ${SUPPORTED_PREFIXES.join(", ")}.`);
	}
	return prefix;
}

export function formatSequentialId(prefix, number) {
	assertPrefix(prefix);
	if (!Number.isSafeInteger(number) || number < 1) {
		throw new ValidationError("Artifact ID number must be a positive safe integer.");
	}
	return `${prefix}-${String(number).padStart(4, "0")}`;
}

export function parseSequentialId(value, { prefix, name = "Artifact ID" } = {}) {
	if (typeof value !== "string") {
		throw new ValidationError(`${name} must be a string.`);
	}
	const match = /^([A-Z]+)-(\d{4,})$/u.exec(value);
	if (match === null) {
		throw new ValidationError(`${name} must use an uppercase prefix and a positive zero-padded number.`);
	}
	const actualPrefix = match[1];
	assertPrefix(actualPrefix);
	if (prefix !== undefined && actualPrefix !== assertPrefix(prefix)) {
		throw new ValidationError(`${name} must use the '${prefix}-' prefix.`);
	}
	if (match[2].length > 4 && match[2].startsWith("0")) {
		throw new ValidationError(`${name} must not contain redundant leading zeroes.`);
	}
	const number = Number(match[2]);
	if (!Number.isSafeInteger(number) || number < 1 || formatSequentialId(actualPrefix, number) !== value) {
		throw new ValidationError(`${name} must contain a positive safe integer in canonical form.`);
	}
	return { prefix: actualPrefix, number };
}

export function isSequentialId(value, prefix) {
	try {
		parseSequentialId(value, { prefix });
		return true;
	} catch {
		return false;
	}
}

export function validateBaselineId(value) {
	parseSequentialId(value, { prefix: "B", name: "Baseline ID" });
	return value;
}

export function validateDecisionId(value) {
	parseSequentialId(value, { prefix: "D", name: "Decision ID" });
	return value;
}

export function validateTicketId(value) {
	parseSequentialId(value, { prefix: "T", name: "Ticket ID" });
	return value;
}
