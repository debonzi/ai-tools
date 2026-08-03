import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import {
	LocatorError,
	SchemaValidationError,
	StorageResolutionError,
} from "./errors.mjs";
import { serializeFrontmatter } from "./frontmatter.mjs";
import {
	parseExternalLocator,
	serializeExternalLocator,
} from "./locators.mjs";
import {
	externalLocatorPath,
	lineageNoticeForStorageMode,
	managedStoragePath,
	parseRootManifest,
	projectStoragePath,
	resolveActiveStorage,
	SHARED_LINEAGE_NOTICE,
	storageCandidatePaths,
} from "./storage.mjs";

const ROOT_COMMIT = "1".repeat(40);
const PROJECT_KEY = `git-sha1-${ROOT_COMMIT}`;
const FOREIGN_ROOT_COMMIT = "2".repeat(40);
const FOREIGN_PROJECT_KEY = `git-sha1-${FOREIGN_ROOT_COMMIT}`;
const TIMESTAMP = "2026-08-03T15:30:00Z";

async function withTemporaryDirectory(run) {
	const directory = await mkdtemp(resolve(tmpdir(), "dbz-workflows-storage-test-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function identity(projectRoot) {
	return {
		projectRoot,
		objectFormat: "sha1",
		rootCommit: ROOT_COMMIT,
		projectKey: PROJECT_KEY,
	};
}

function rootManifest(overrides = {}) {
	return serializeFrontmatter(
		{
			artifact: "project",
			schema_version: 1,
			project_key: PROJECT_KEY,
			project_name: "storage-test-project",
			object_format: "sha1",
			root_commit: ROOT_COMMIT,
			next_workflow_number: 1,
			created_at: TIMESTAMP,
			updated_at: TIMESTAMP,
			unknown_extension: { retained: true },
			...overrides,
		},
		"# DBZ Workflows\n\nThis directory is managed by DBZ Workflows.\n",
	);
}

async function createStorageRoot(path, overrides = {}) {
	await mkdir(path, { recursive: true });
	await writeFile(resolve(path, "dbz-workflows.md"), rootManifest(overrides));
}

async function writeLocator(path, locator) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, serializeExternalLocator(locator));
}

function locator(storagePath, overrides = {}) {
	return {
		schema_version: 1,
		project_key: PROJECT_KEY,
		storage_path: storagePath,
		updated_at: TIMESTAMP,
		...overrides,
	};
}

test("derives all fixed candidate and locator paths from an injected home directory", async () => {
	await withTemporaryDirectory(async (directory) => {
		const projectRoot = resolve(directory, "project");
		const homeDirectory = resolve(directory, "isolated-home");
		await mkdir(projectRoot);
		const paths = storageCandidatePaths(identity(projectRoot), { homeDirectory });
		assert.deepEqual(paths, {
			project: resolve(projectRoot, "dbz-workflows"),
			managed: resolve(homeDirectory, ".local", "share", "dbz-workflows", "projects", PROJECT_KEY),
			externalLocator: resolve(
				homeDirectory,
				".config",
				"dbz-workflows",
				"projects",
				`${PROJECT_KEY}.json`,
			),
		});
		assert.equal(projectStoragePath(projectRoot), paths.project);
		assert.equal(managedStoragePath(PROJECT_KEY, { homeDirectory }), paths.managed);
		assert.equal(externalLocatorPath(PROJECT_KEY, { homeDirectory }), paths.externalLocator);
	});
});

test("validates root manifests against the complete project lineage while preserving unknown fields", () => {
	const source = rootManifest();
	const parsed = parseRootManifest(source, {
		path: "/isolated/dbz-workflows.md",
		expectedIdentity: identity("/isolated/project"),
	});
	assert.equal(parsed.metadata.project_key, PROJECT_KEY);
	assert.deepEqual(parsed.metadata.unknown_extension, { retained: true });
	assert.match(parsed.body, /^# DBZ Workflows/u);

	assert.throws(
		() => parseRootManifest(rootManifest({ next_workflow_number: 0 })),
		SchemaValidationError,
	);
	assert.throws(
		() =>
			parseRootManifest(
				rootManifest({
					project_key: FOREIGN_PROJECT_KEY,
					root_commit: FOREIGN_ROOT_COMMIT,
				}),
				{ expectedIdentity: identity("/isolated/project") },
			),
		(error) =>
			error instanceof SchemaValidationError &&
			error.issues.some(({ code }) => code === "foreign_project_lineage"),
	);
});

test("resolves exactly one project-local storage root", async () => {
	await withTemporaryDirectory(async (directory) => {
		const projectRoot = resolve(directory, "project");
		const homeDirectory = resolve(directory, "home");
		await mkdir(projectRoot);
		const storagePath = projectStoragePath(projectRoot);
		await createStorageRoot(storagePath);

		const result = await resolveActiveStorage(identity(projectRoot), { homeDirectory });
		assert.equal(result.mode, "project");
		assert.equal(result.path, storagePath);
		assert.equal(result.effectivePath, storagePath);
		assert.equal(result.projectKey, PROJECT_KEY);
		assert.equal(result.lineageNotice, null);
		assert.equal(result.manifest.unknown_extension.retained, true);
	});
});

test("resolves managed storage and exposes the required clone/fork lineage notice", async () => {
	await withTemporaryDirectory(async (directory) => {
		const projectRoot = resolve(directory, "project");
		const homeDirectory = resolve(directory, "home");
		await mkdir(projectRoot);
		const storagePath = managedStoragePath(PROJECT_KEY, { homeDirectory });
		await createStorageRoot(storagePath);

		const result = await resolveActiveStorage(identity(projectRoot), { homeDirectory });
		assert.equal(result.mode, "managed");
		assert.deepEqual(result.lineageNotice, {
			id: "shared_git_lineage",
			message: SHARED_LINEAGE_NOTICE,
			required: true,
		});
		assert.equal(lineageNoticeForStorageMode("external").message, SHARED_LINEAGE_NOTICE);
		assert.equal(lineageNoticeForStorageMode("project"), null);
	});
});

test("uses the exact external path and permits an explicitly selected symlink traversal", async () => {
	await withTemporaryDirectory(async (directory) => {
		const projectRoot = resolve(directory, "project");
		const homeDirectory = resolve(directory, "home");
		const effectiveStorage = resolve(directory, "selected-storage-target");
		const selectedStorage = resolve(directory, "selected-storage-link");
		await mkdir(projectRoot);
		await createStorageRoot(effectiveStorage);
		await symlink(effectiveStorage, selectedStorage);
		const locatorPath = externalLocatorPath(PROJECT_KEY, { homeDirectory });
		await writeLocator(locatorPath, locator(selectedStorage));

		const result = await resolveActiveStorage(identity(projectRoot), { homeDirectory });
		assert.equal(result.mode, "external");
		assert.equal(result.path, selectedStorage);
		assert.equal(result.effectivePath, effectiveStorage);
		assert.equal(result.locator.path, locatorPath);
		assert.equal(result.lineageNotice.message, SHARED_LINEAGE_NOTICE);
	});
});

test("requires setup when no candidate contains a valid root manifest", async () => {
	await withTemporaryDirectory(async (directory) => {
		const projectRoot = resolve(directory, "project");
		const homeDirectory = resolve(directory, "home-that-is-never-the-real-home");
		await mkdir(resolve(projectRoot, "dbz-workflows"), { recursive: true });

		await assert.rejects(resolveActiveStorage(identity(projectRoot), { homeDirectory }), (error) => {
			assert.ok(error instanceof StorageResolutionError);
			assert.equal(error.code, "storage_setup_required");
			assert.equal(error.details.external_locator_path.startsWith(homeDirectory), true);
			return true;
		});
	});
});

test("fails explicitly when project and managed storage are both valid", async () => {
	await withTemporaryDirectory(async (directory) => {
		const projectRoot = resolve(directory, "project");
		const homeDirectory = resolve(directory, "home");
		await mkdir(projectRoot);
		await createStorageRoot(projectStoragePath(projectRoot));
		await createStorageRoot(managedStoragePath(PROJECT_KEY, { homeDirectory }));

		await assert.rejects(resolveActiveStorage(identity(projectRoot), { homeDirectory }), (error) => {
			assert.ok(error instanceof StorageResolutionError);
			assert.equal(error.code, "storage_ambiguous");
			assert.deepEqual(error.details.candidates.map(({ mode }) => mode), ["project", "managed"]);
			assert.match(error.message, /no mode has precedence/u);
			return true;
		});
	});
});

test("a broken external locator prevents fallback to another valid mode", async () => {
	await withTemporaryDirectory(async (directory) => {
		const projectRoot = resolve(directory, "project");
		const homeDirectory = resolve(directory, "home");
		await mkdir(projectRoot);
		await createStorageRoot(projectStoragePath(projectRoot));
		const locatorPath = externalLocatorPath(PROJECT_KEY, { homeDirectory });
		await mkdir(dirname(locatorPath), { recursive: true });
		await writeFile(locatorPath, "{not valid JSON}\n");

		await assert.rejects(resolveActiveStorage(identity(projectRoot), { homeDirectory }), (error) => {
			assert.ok(error instanceof LocatorError);
			assert.equal(error.code, "broken_locator");
			assert.match(error.message, /reconfiguration/u);
			return true;
		});
	});
});

test("a locator pointing to a missing root is broken rather than absent", async () => {
	await withTemporaryDirectory(async (directory) => {
		const projectRoot = resolve(directory, "project");
		const homeDirectory = resolve(directory, "home");
		await mkdir(projectRoot);
		const missingStorage = resolve(directory, "missing-selected-storage");
		await writeLocator(
			externalLocatorPath(PROJECT_KEY, { homeDirectory }),
			locator(missingStorage),
		);

		await assert.rejects(resolveActiveStorage(identity(projectRoot), { homeDirectory }), (error) => {
			assert.ok(error instanceof LocatorError);
			assert.equal(error.code, "broken_locator");
			assert.equal(error.details.storage_path, missingStorage);
			return true;
		});
	});
});

test("invalid fixed manifests and fixed-root symlinks fail instead of falling back", async () => {
	await withTemporaryDirectory(async (directory) => {
		const projectRoot = resolve(directory, "project");
		const homeDirectory = resolve(directory, "home");
		await mkdir(projectRoot);
		await createStorageRoot(projectStoragePath(projectRoot), { project_key: "invalid" });
		await createStorageRoot(managedStoragePath(PROJECT_KEY, { homeDirectory }));
		await assert.rejects(
			resolveActiveStorage(identity(projectRoot), { homeDirectory }),
			(error) => error instanceof StorageResolutionError && error.code === "invalid_storage_root",
		);

		await rm(projectStoragePath(projectRoot), { recursive: true });
		const symlinkTarget = resolve(directory, "unexpected-target");
		await createStorageRoot(symlinkTarget);
		await symlink(symlinkTarget, projectStoragePath(projectRoot));
		await assert.rejects(
			resolveActiveStorage(identity(projectRoot), { homeDirectory }),
			(error) => error instanceof StorageResolutionError && error.code === "invalid_storage_root",
		);
	});
});

test("external locator schema rejects duplicates, foreign keys, unsafe paths, and invalid timestamps", () => {
	const valid = serializeExternalLocator(locator("/isolated/external"));
	assert.deepEqual(parseExternalLocator(valid), locator("/isolated/external"));
	assert.throws(
		() => parseExternalLocator(`{"schema_version":1,"schema_version":1,"project_key":"${PROJECT_KEY}","storage_path":"/tmp/root","updated_at":"${TIMESTAMP}"}`),
		LocatorError,
	);
	assert.throws(
		() => parseExternalLocator(serializeExternalLocator({ ...locator("/tmp/root"), extra: true })),
		LocatorError,
	);
	for (const storagePath of ["relative/path", "/tmp/../root"]) {
		assert.throws(
			() => parseExternalLocator(JSON.stringify(locator(storagePath))),
			LocatorError,
		);
	}
	assert.throws(
		() => parseExternalLocator(JSON.stringify(locator("/tmp/root", { updated_at: "2026-02-30T00:00:00Z" }))),
		LocatorError,
	);
	assert.throws(
		() => parseExternalLocator(valid, { expectedProjectKey: FOREIGN_PROJECT_KEY }),
		LocatorError,
	);
});
