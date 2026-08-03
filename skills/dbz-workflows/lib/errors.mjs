export const ERROR_CODES = Object.freeze({
	INVALID_ARGUMENT: "invalid_argument",
	INVALID_FRONTMATTER: "invalid_frontmatter",
	INVALID_MARKDOWN: "invalid_markdown",
	SCHEMA_VALIDATION_FAILED: "schema_validation_failed",
	INVALID_PATH: "invalid_path",
	PATH_OUTSIDE_ROOT: "path_outside_root",
	UNSAFE_FILESYSTEM_ENTRY: "unsafe_filesystem_entry",
	REVISION_CONFLICT: "revision_conflict",
	LOCK_TIMEOUT: "lock_timeout",
	LOCK_UNAVAILABLE: "lock_unavailable",
	ATOMIC_WRITE_FAILED: "atomic_write_failed",
});

function normalizeDetails(details) {
	if (details === undefined) return undefined;
	if (details === null || typeof details !== "object" || Array.isArray(details)) {
		return { value: details };
	}
	return { ...details };
}

export class DbzWorkflowsError extends Error {
	constructor(message, { code = ERROR_CODES.INVALID_ARGUMENT, details, cause } = {}) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = new.target.name;
		this.code = code;
		this.details = normalizeDetails(details);
	}
}

export class ValidationError extends DbzWorkflowsError {
	constructor(message, { code = ERROR_CODES.INVALID_ARGUMENT, details, cause } = {}) {
		super(message, { code, details, cause });
	}
}

export class SchemaValidationError extends ValidationError {
	constructor(message, { issues = [], details, cause } = {}) {
		super(message, {
			code: ERROR_CODES.SCHEMA_VALIDATION_FAILED,
			details: { ...details, issues: issues.map((issue) => ({ ...issue })) },
			cause,
		});
		this.issues = this.details.issues;
	}
}

export class FrontmatterError extends ValidationError {
	constructor(message, options = {}) {
		super(message, { ...options, code: options.code ?? ERROR_CODES.INVALID_FRONTMATTER });
	}
}

export class MarkdownError extends ValidationError {
	constructor(message, options = {}) {
		super(message, { ...options, code: options.code ?? ERROR_CODES.INVALID_MARKDOWN });
	}
}

export class PathBoundaryError extends ValidationError {
	constructor(message, options = {}) {
		super(message, { ...options, code: options.code ?? ERROR_CODES.PATH_OUTSIDE_ROOT });
	}
}

export class RevisionConflictError extends DbzWorkflowsError {
	constructor(message, options = {}) {
		super(message, { ...options, code: ERROR_CODES.REVISION_CONFLICT });
	}
}

export class LockError extends DbzWorkflowsError {
	constructor(message, options = {}) {
		super(message, { ...options, code: options.code ?? ERROR_CODES.LOCK_UNAVAILABLE });
	}
}

export class AtomicWriteError extends DbzWorkflowsError {
	constructor(message, options = {}) {
		super(message, { ...options, code: ERROR_CODES.ATOMIC_WRITE_FAILED });
	}
}

export function assertValid(condition, message, options = {}) {
	if (!condition) throw new ValidationError(message, options);
}

export function validationIssue(path, code, message, details) {
	if (
		!Array.isArray(path) ||
		path.some(
			(part) =>
				(typeof part === "string" && part.length === 0) ||
				(typeof part !== "string" && (!Number.isSafeInteger(part) || part < 0)),
		)
	) {
		throw new ValidationError("A schema issue path must be an array of string keys or integer indexes.");
	}
	if (typeof code !== "string" || !/^[a-z][a-z0-9_]*$/u.test(code)) {
		throw new ValidationError("A schema issue code must be a non-empty snake_case identifier.");
	}
	if (typeof message !== "string" || message.length === 0) {
		throw new ValidationError("A schema issue message must be a non-empty string.");
	}
	return {
		path: [...path],
		code,
		message,
		...(details === undefined ? {} : { details: normalizeDetails(details) }),
	};
}

export function throwIfValidationIssues(issues, { artifact, path } = {}) {
	if (!Array.isArray(issues)) throw new ValidationError("Schema issues must be an array.");
	if (issues.length === 0) return;
	const subject = artifact === undefined ? "Artifact" : `Artifact '${artifact}'`;
	throw new SchemaValidationError(`${subject} failed schema validation with ${issues.length} issue(s).`, {
		issues,
		details: {
			...(artifact === undefined ? {} : { artifact }),
			...(path === undefined ? {} : { path }),
		},
	});
}

export function diagnosticFromError(error) {
	if (error instanceof DbzWorkflowsError) {
		return {
			name: error.name,
			code: error.code,
			message: error.message,
			...(error.details === undefined ? {} : { details: error.details }),
		};
	}
	return {
		name: error instanceof Error ? error.name : "Error",
		code: "unexpected_error",
		message: error instanceof Error ? error.message : String(error),
	};
}
