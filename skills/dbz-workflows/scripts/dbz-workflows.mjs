#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, parseDocument } from "yaml";
import { diagnosticFromError, ValidationError } from "../lib/errors.mjs";
import { readFileWithDigest } from "../lib/filesystem.mjs";
import { inspectGitProject } from "../lib/git-identity.mjs";
import {
	applyMigrationPlan,
	createMigrationPlan,
} from "../lib/migration.mjs";
import {
	applySetupPlan,
	createSetupPlan,
} from "../lib/setup.mjs";

const MAX_PLAN_BYTES = 50 * 1024;
const MAX_PLAN_LINES = 2_000;

const USAGE = `DBZ Workflows deterministic setup and migration CLI

Usage:
  dbz-workflows.mjs setup plan --mode <project|managed|external> [--external-path PATH] [--project-name NAME] [--project PATH]
  dbz-workflows.mjs setup apply --plan-file PATH --plan-digest SHA256 --authorize [--project PATH]
  dbz-workflows.mjs migration plan --mode <project|managed|external> [--external-path PATH] [--project PATH]
  dbz-workflows.mjs migration apply --plan-file PATH --plan-digest SHA256 --authorize [--project PATH]

Planning never mutates workflow storage. Apply is non-interactive and requires an exact reviewed plan digest plus --authorize.
`;

function parseOptions(argumentsList) {
	const options = {};
	for (let index = 0; index < argumentsList.length; index += 1) {
		const argument = argumentsList[index];
		if (!argument.startsWith("--")) {
			throw new ValidationError(`Unexpected positional argument '${argument}'.`);
		}
		const key = argument.slice(2);
		if (Object.hasOwn(options, key)) {
			throw new ValidationError(`Option '--${key}' may be provided only once.`);
		}
		if (key === "authorize" || key === "help") {
			options[key] = true;
			continue;
		}
		const value = argumentsList[index + 1];
		if (value === undefined || value.startsWith("--")) {
			throw new ValidationError(`Option '--${key}' requires a value.`);
		}
		options[key] = value;
		index += 1;
	}
	return options;
}

function rejectUnknownOptions(options, allowed) {
	const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) {
		throw new ValidationError(`Unsupported option(s): ${unknown.map((key) => `--${key}`).join(", ")}.`);
	}
}

function requireOption(options, key) {
	if (typeof options[key] !== "string" || options[key].length === 0) {
		throw new ValidationError(`Option '--${key}' is required.`);
	}
	return options[key];
}

function countLines(value) {
	if (value.length === 0) return 0;
	return value.endsWith("\n") ? value.split("\n").length - 1 : value.split("\n").length;
}

async function readPlan(path) {
	const absolutePath = resolve(path);
	const snapshot = await readFileWithDigest(absolutePath, { encoding: "utf8" });
	const bytes = Buffer.byteLength(snapshot.data, "utf8");
	const lines = countLines(snapshot.data);
	if (bytes > MAX_PLAN_BYTES || lines > MAX_PLAN_LINES) {
		throw new ValidationError("Plan file exceeds the supported 50 KB or 2,000-line limit.", {
			details: { path: absolutePath, bytes, lines },
		});
	}
	const document = parseDocument(snapshot.data, {
		customTags: [],
		prettyErrors: true,
		schema: "json",
		strict: true,
		uniqueKeys: true,
	});
	const problem = document.errors[0] ?? document.warnings[0];
	if (problem || !isMap(document.contents)) {
		throw new ValidationError("Plan file must contain one valid JSON object with unique keys.", {
			details: { path: absolutePath },
			...(problem instanceof Error ? { cause: problem } : {}),
		});
	}
	try {
		return JSON.parse(snapshot.data);
	} catch (error) {
		throw new ValidationError("Plan file is not valid JSON.", {
			details: { path: absolutePath },
			cause: error,
		});
	}
}

function printJson(value, stream = process.stdout) {
	stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function planOperation(kind, options) {
	const allowed = kind === "setup"
		? ["mode", "external-path", "project-name", "project"]
		: ["mode", "external-path", "project"];
	rejectUnknownOptions(options, allowed);
	const identity = await inspectGitProject(options.project ?? process.cwd());
	const common = {
		mode: requireOption(options, "mode"),
		...(options["external-path"] === undefined ? {} : { externalPath: options["external-path"] }),
		homeDirectory: homedir(),
	};
	return kind === "setup"
		? createSetupPlan(identity, {
			...common,
			...(options["project-name"] === undefined ? {} : { projectName: options["project-name"] }),
		})
		: createMigrationPlan(identity, common);
}

async function applyOperation(kind, options) {
	rejectUnknownOptions(options, ["plan-file", "plan-digest", "authorize", "project"]);
	if (options.authorize !== true) {
		throw new ValidationError("Apply requires the explicit '--authorize' flag.");
	}
	const plan = await readPlan(requireOption(options, "plan-file"));
	const planDigest = requireOption(options, "plan-digest");
	const identity = await inspectGitProject(options.project ?? process.cwd());
	const apply = kind === "setup" ? applySetupPlan : applyMigrationPlan;
	return apply(plan, {
		identity,
		homeDirectory: homedir(),
		authorization: { confirmed: true, planDigest },
	});
}

export async function main(argumentsList = process.argv.slice(2)) {
	if (argumentsList.length === 0 || argumentsList[0] === "--help" || argumentsList[0] === "-h") {
		process.stdout.write(USAGE);
		return 0;
	}
	const [kind, action, ...optionArguments] = argumentsList;
	if ((kind !== "setup" && kind !== "migration") || (action !== "plan" && action !== "apply")) {
		throw new ValidationError("Expected 'setup plan', 'setup apply', 'migration plan', or 'migration apply'.");
	}
	const options = parseOptions(optionArguments);
	if (options.help) {
		process.stdout.write(USAGE);
		return 0;
	}
	const result = action === "plan"
		? await planOperation(kind, options)
		: await applyOperation(kind, options);
	printJson(result);
	return 0;
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && fileURLToPath(import.meta.url) === invokedPath) {
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			printJson(diagnosticFromError(error), process.stderr);
			process.exitCode = error instanceof ValidationError ? 2 : 1;
		},
	);
}
