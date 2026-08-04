import {
	readdir,
	unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
	canonicalArtifactFileMode,
	canonicalTimestamp,
	requireArtifactDigest,
	resolveWorkflowArtifactContext,
	withWorkflowArtifactLock,
} from "./artifacts.mjs";
import {
	DecisionError,
	ERROR_CODES,
	RevisionConflictError,
	ValidationError,
} from "./errors.mjs";
import {
	atomicWriteFile,
	readFileWithDigest,
	resolveWithinRoot,
	sha256Hex,
} from "./filesystem.mjs";
import {
	parseFrontmatter,
	patchFrontmatter,
} from "./frontmatter.mjs";
import {
	indexLevelTwoSections,
	listLevelTwoSections,
	replaceLevelTwoSection,
} from "./markdown.mjs";
import {
	DECISION_REQUIRED_SECTIONS,
	validateDecisionMetadata,
} from "./schemas/decision.mjs";
import {
	formatSequentialId,
	parseSequentialId,
	validateDecisionId,
} from "./schemas/identifiers.mjs";
import { validateWorkflowMetadata } from "./schemas/workflow.mjs";
import { createDecisionArtifactSource } from "./templates/decision.mjs";
import { generateImmutableSlug } from "./workflows.mjs";

const DECISION_FILE_PATTERN = /^(D-\d{4,})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/u;

function normalizeTitle(value) {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.includes("\0") ||
		/[\r\n]/u.test(value)
	) {
		throw new ValidationError("Decision title must be a non-empty single-line string without NUL bytes.");
	}
	return value.trim();
}

function decisionFilename(id, slug) {
	validateDecisionId(id);
	return `${id}-${slug}.md`;
}

export function parseDecisionArtifact(
	source,
	{ path, expectedId, expectedSlug, expectedWorkflowId } = {},
) {
	const parsed = parseFrontmatter(source, { path });
	validateDecisionMetadata(parsed.data, { path, expectedId, expectedSlug, expectedWorkflowId });
	const sections = listLevelTwoSections(source, { path });
	const headings = new Set(sections.map(({ title }) => title.toLocaleLowerCase("en-US")));
	for (const required of DECISION_REQUIRED_SECTIONS) {
		if (!headings.has(required.toLocaleLowerCase("en-US"))) {
			throw new DecisionError(`Decision '${parsed.data.id}' is missing required section '${required}'.`, {
				details: { path, decision_id: parsed.data.id, heading: required },
			});
		}
	}
	return { ...parsed, sections };
}

async function listDecisionsInContext(context) {
	let entries;
	try {
		entries = await readdir(context.paths.decisions, { withFileTypes: true });
	} catch (error) {
		throw new DecisionError("Canonical decisions directory cannot be listed safely.", { cause: error });
	}
	const decisions = [];
	const ids = new Set();
	for (const entry of entries) {
		const match = DECISION_FILE_PATTERN.exec(entry.name);
		if (match === null) continue;
		let parsedId;
		try {
			parsedId = parseSequentialId(match[1], { prefix: "D", name: "Decision ID" });
		} catch (error) {
			throw new DecisionError(`Decision filename '${entry.name}' contains a non-canonical ID.`, { cause: error });
		}
		if (entry.isSymbolicLink() || !entry.isFile()) {
			throw new DecisionError("Canonical decision path must be a real regular file.", {
				details: { path: resolve(context.paths.decisions, entry.name) },
			});
		}
		if (ids.has(match[1])) throw new DecisionError(`Decision ID '${match[1]}' appears more than once.`);
		ids.add(match[1]);
		const path = resolveWithinRoot(context.paths.decisions, entry.name);
		const snapshot = await readFileWithDigest(path, { encoding: "utf8" });
		const parsed = parseDecisionArtifact(snapshot.data, {
			path,
			expectedId: match[1],
			expectedSlug: match[2],
			expectedWorkflowId: context.workflow.id,
		});
		decisions.push({
			id: parsed.data.id,
			title: parsed.data.title,
			slug: parsed.data.slug,
			status: parsed.data.status,
			supersedes: parsed.data.supersedes,
			superseded_by: parsed.data.superseded_by,
			updated_at: parsed.data.updated_at,
			path,
			digest: snapshot.digest,
			metadata: parsed.data,
			_number: parsedId.number,
		});
	}
	decisions.sort((left, right) => left._number - right._number);
	return decisions.map(({ _number, ...decision }) => decision);
}

export async function listDecisions(identity, workflowId, { homeDirectory = homedir() } = {}) {
	const context = await resolveWorkflowArtifactContext(identity, workflowId, { homeDirectory });
	return listDecisionsInContext(context);
}

async function inspectDecisionInContext(context, decisionId) {
	validateDecisionId(decisionId);
	const decision = (await listDecisionsInContext(context)).find(({ id }) => id === decisionId);
	if (decision === undefined) {
		throw new DecisionError(`Decision '${decisionId}' was not found in workflow '${context.workflow.id}'.`, {
			code: ERROR_CODES.DECISION_NOT_FOUND,
			details: { decision_id: decisionId, workflow_id: context.workflow.id },
		});
	}
	return decision;
}

export async function inspectDecision(
	identity,
	workflowId,
	decisionId,
	{ homeDirectory = homedir() } = {},
) {
	const context = await resolveWorkflowArtifactContext(identity, workflowId, { homeDirectory });
	return inspectDecisionInContext(context, decisionId);
}

async function removeOwnedDecision(path, digest) {
	try {
		const snapshot = await readFileWithDigest(path);
		if (snapshot.digest !== digest) return false;
		await unlink(path);
		return true;
	} catch {
		return false;
	}
}

async function restoreOwnedReplacement(path, originalSource, replacementDigest, root) {
	try {
		await atomicWriteFile(path, originalSource, { expectedDigest: replacementDigest, root });
		return true;
	} catch {
		return false;
	}
}

function workflowReplacement(context, nextDecisionNumber, timestamp, source) {
	const replacement = patchFrontmatter(
		source,
		[
			{ path: ["next_decision_number"], value: nextDecisionNumber },
			{ path: ["updated_at"], value: timestamp },
		],
		{ path: context.workflow.path },
	);
	const parsed = parseFrontmatter(replacement, { path: context.workflow.path });
	validateWorkflowMetadata(parsed.data, {
		path: context.workflow.path,
		expectedId: context.workflow.id,
		expectedSlug: context.workflow.slug,
		objectFormat: context.identity.objectFormat,
	});
	indexLevelTwoSections(replacement, { path: context.workflow.path });
	return replacement;
}

function decisionMetadata(context, id, title, slug, timestamp, supersedes) {
	return {
		artifact: "decision",
		schema_version: 1,
		id,
		workflow_id: context.workflow.id,
		title,
		slug,
		status: "accepted",
		supersedes,
		superseded_by: null,
		created_at: timestamp,
		updated_at: timestamp,
	};
}

async function allocateDecision(
	identity,
	workflowId,
	input,
	{
		expectedWorkflowDigest,
		expectedDecisionDigest,
		supersedes = null,
		homeDirectory = homedir(),
		clock = () => new Date(),
		lockOptions,
	} = {},
) {
	const workflowDigest = requireArtifactDigest(expectedWorkflowDigest, "expectedWorkflowDigest");
	const predecessorDigest = supersedes === null
		? null
		: requireArtifactDigest(expectedDecisionDigest, "expectedDecisionDigest");
	const title = normalizeTitle(input?.title);
	const timestamp = canonicalTimestamp(clock);
	return withWorkflowArtifactLock(identity, workflowId, async (context) => {
		if (context.workflow.digest !== workflowDigest) {
			throw new RevisionConflictError(`Workflow '${workflowId}' does not match the expected revision.`, {
				details: { expected_digest: workflowDigest, actual_digest: context.workflow.digest },
			});
		}
		if (context.workflow.phase !== "discovery") {
			throw new DecisionError("Decisions may be allocated only while the workflow is in discovery.", {
				details: { workflow_id: workflowId, phase: context.workflow.phase },
			});
		}
		const number = context.workflow.metadata.next_decision_number;
		if (number >= Number.MAX_SAFE_INTEGER) throw new DecisionError("Decision ID counter is exhausted.");
		const id = formatSequentialId("D", number);
		const slug = generateImmutableSlug(title);
		const path = resolveWithinRoot(context.paths.decisions, decisionFilename(id, slug));
		let predecessor = null;
		let predecessorSource = null;
		let predecessorReplacement = null;
		if (supersedes !== null) {
			predecessor = await inspectDecisionInContext(context, supersedes);
			if (predecessor.digest !== predecessorDigest) {
				throw new RevisionConflictError(`Decision '${supersedes}' does not match the expected revision.`, {
					details: { expected_digest: predecessorDigest, actual_digest: predecessor.digest },
				});
			}
			if (predecessor.status !== "accepted" || predecessor.superseded_by !== null) {
				throw new DecisionError(`Decision '${supersedes}' is not an active accepted decision and cannot be superseded.`);
			}
			predecessorSource = (await readFileWithDigest(predecessor.path, { encoding: "utf8" })).data;
			predecessorReplacement = replaceLevelTwoSection(
				predecessorSource,
				"Supersession",
				`\nSuperseded by ${id}.\n`,
				{ path: predecessor.path },
			);
			predecessorReplacement = patchFrontmatter(
				predecessorReplacement,
				[
					{ path: ["status"], value: "superseded" },
					{ path: ["superseded_by"], value: id },
					{ path: ["updated_at"], value: timestamp },
				],
				{ path: predecessor.path },
			);
			parseDecisionArtifact(predecessorReplacement, {
				path: predecessor.path,
				expectedId: predecessor.id,
				expectedSlug: predecessor.slug,
				expectedWorkflowId: workflowId,
			});
		}
		const metadata = decisionMetadata(context, id, title, slug, timestamp, supersedes);
		const source = createDecisionArtifactSource(metadata, {
			context: input.context,
			consideredOptions: input.consideredOptions,
			decision: input.decision,
			rationale: input.rationale,
			consequences: input.consequences,
			supersession: supersedes === null
				? "This decision does not supersede an earlier decision."
				: `Supersedes ${supersedes}.`,
		});
		const workflowSource = (await readFileWithDigest(context.workflow.path, { encoding: "utf8" })).data;
		const nextWorkflowSource = workflowReplacement(context, number + 1, timestamp, workflowSource);
		let createdDigest = null;
		let predecessorReplacementDigest = null;
		let workflowCommitted = false;
		try {
			try {
				const written = await atomicWriteFile(path, source, {
					expectedDigest: null,
					mode: canonicalArtifactFileMode(context.storage),
					root: context.storage.effectivePath,
				});
				createdDigest = written.digest;
			} catch (error) {
				if (error?.details?.committed === true) createdDigest = sha256Hex(source);
				throw error;
			}
			if (predecessor !== null) {
				try {
					const written = await atomicWriteFile(predecessor.path, predecessorReplacement, {
						expectedDigest: predecessor.digest,
						root: context.storage.effectivePath,
					});
					predecessorReplacementDigest = written.digest;
				} catch (error) {
					if (error?.details?.committed === true) {
						predecessorReplacementDigest = sha256Hex(predecessorReplacement);
					}
					throw error;
				}
			}
			try {
				await atomicWriteFile(context.workflow.path, nextWorkflowSource, {
					expectedDigest: context.workflow.digest,
					root: context.storage.effectivePath,
				});
			} catch (error) {
				workflowCommitted = error?.details?.committed === true;
				throw error;
			}
		} catch (error) {
			if (workflowCommitted) {
				throw new DecisionError(
					"Decision allocation committed, but the workflow directory could not be synchronized; inspect the committed artifacts before retrying.",
					{
						details: { committed: true, decision_path: path, workflow_path: context.workflow.path },
						cause: error,
					},
				);
			}
			const predecessorRestored = predecessorReplacementDigest === null
				? true
				: await restoreOwnedReplacement(
					predecessor.path,
					predecessorSource,
					predecessorReplacementDigest,
					context.storage.effectivePath,
				);
			const createdRemoved = createdDigest === null ? true : await removeOwnedDecision(path, createdDigest);
			if (!predecessorRestored || !createdRemoved) {
				throw new DecisionError(
					"Decision allocation failed and its owned intermediate changes could not be fully restored; inspect the reported paths before retrying.",
					{
						details: {
							decision_path: path,
							created_removed: createdRemoved,
							predecessor_path: predecessor?.path,
							predecessor_restored: predecessorRestored,
						},
						cause: error,
					},
				);
			}
			throw error;
		}
		const decisions = await listDecisionsInContext(context);
		return {
			changed: true,
			decision: decisions.find((candidate) => candidate.id === id),
			...(supersedes === null
				? {}
				: { superseded: decisions.find((candidate) => candidate.id === supersedes) }),
			workflow: (await resolveWorkflowArtifactContext(context.identity, workflowId, {
				homeDirectory: context.homeDirectory,
			})).workflow,
		};
	}, { homeDirectory, lockOptions });
}

export async function createDecision(identity, workflowId, input, options = {}) {
	return allocateDecision(identity, workflowId, input, { ...options, supersedes: null });
}

export async function supersedeDecision(
	identity,
	workflowId,
	predecessorId,
	input,
	options = {},
) {
	validateDecisionId(predecessorId);
	return allocateDecision(identity, workflowId, input, { ...options, supersedes: predecessorId });
}
