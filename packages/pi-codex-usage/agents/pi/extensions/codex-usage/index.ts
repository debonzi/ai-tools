import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	DEFAULT_CONFIG,
	formatUsageReport,
	formatUsageStatusline,
	normalizeCodexUsage,
	parseConfig,
	type CodexUsageConfig,
	type CodexUsageReport,
	type UsageModel,
} from "./core.ts";

const PROVIDER_ID = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OFFICIAL_ORIGIN = "https://chatgpt.com";
const COMMAND_NAME = "usage-codex";
const COMMAND_INVOCATION = `/${COMMAND_NAME}`;
const WIDGET_KEY = "codex-usage";
const WIDGET_LABEL = "codex usage";
const QUERY_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

type CacheEntry = {
	fingerprint: string;
	createdAt: number;
	report: CodexUsageReport;
};

type RefreshResult =
	| { status: "ready"; report: CodexUsageReport }
	| { status: "auth-error" | "query-error" | "cancelled" };

type RuntimeAuth = {
	authorization: string;
	fingerprint: string;
};

type PiModel = NonNullable<ExtensionContext["model"]>;

class UsageAuthError extends Error {}
class UsageQueryError extends Error {}

export default function codexUsageExtension(pi: ExtensionAPI) {
	let config: CodexUsageConfig = { ...DEFAULT_CONFIG };
	const fingerprintSalt = randomBytes(32);
	let cache: CacheEntry | undefined;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	let activeController: AbortController | undefined;
	let generation = 0;
	let sessionActive = false;
	let successfulModelIdentity: string | undefined;

	const clearTimer = () => {
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = undefined;
	};

	const safeSetDisplay = (ctx: ExtensionContext, value: string | undefined): boolean => {
		try {
			if (value === undefined) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
			} else {
				ctx.ui.setWidget(
					WIDGET_KEY,
					(_tui, theme) => ({
						render(width: number): string[] {
							const text = theme.fg("dim", value);
							const padding = " ".repeat(Math.max(0, width - visibleWidth(text)));
							return [truncateToWidth(`${padding}${text}`, width, "")];
						},
						invalidate() {},
					}),
					{ placement: "belowEditor" },
				);
			}
			return true;
		} catch (error) {
			if (isStaleContextError(error)) return false;
			throw error;
		}
	};

	const stopRefresh = (ctx: ExtensionContext, clearStatus: boolean) => {
		generation += 1;
		activeController?.abort();
		activeController = undefined;
		clearTimer();
		successfulModelIdentity = undefined;
		if (clearStatus) safeSetDisplay(ctx, undefined);
	};

	const scheduleRefresh = (ctx: ExtensionContext) => {
		clearTimer();
		if (!sessionActive || ctx.mode !== "tui" || ctx.model?.provider !== PROVIDER_ID) return;
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			void refresh(ctx, true).catch(() => {
				if (sessionActive) safeSetDisplay(ctx, `${WIDGET_LABEL} error`);
			});
		}, config.refreshIntervalMinutes * 60_000);
		refreshTimer.unref?.();
	};

	const refresh = async (ctx: ExtensionContext, force: boolean): Promise<RefreshResult> => {
		clearTimer();
		const model = activeCodexModel(ctx);
		if (!model || ctx.mode !== "tui") {
			stopRefresh(ctx, true);
			return { status: "cancelled" };
		}

		generation += 1;
		const currentGeneration = generation;
		const identity = modelIdentity(model);
		activeController?.abort();
		const controller = new AbortController();
		activeController = controller;
		const isCurrent = () =>
			!controller.signal.aborted &&
			generation === currentGeneration &&
			ctx.model?.provider === PROVIDER_ID &&
			modelIdentity(ctx.model) === identity;
		if (successfulModelIdentity !== identity) {
			safeSetDisplay(ctx, `${WIDGET_LABEL} checking`);
		}

		try {
			const auth = await resolveRuntimeAuth(ctx, model, fingerprintSalt);
			if (!isCurrent()) return { status: "cancelled" };

			const maxAgeMs = config.refreshIntervalMinutes * 60_000;
			let report =
				!force &&
				cache?.fingerprint === auth.fingerprint &&
				Date.now() - cache.createdAt < maxAgeMs
					? cache.report
					: undefined;

			if (!report) {
				const payload = await fetchUsage(auth.authorization, controller.signal);
				report = normalizeCodexUsage(payload);
				if (!isCurrent()) return { status: "cancelled" };
				cache = {
					fingerprint: auth.fingerprint,
					createdAt: Date.now(),
					report,
				};
			}

			const status = formatUsageStatusline(report, model, config.showOtherModels);
			if (!safeSetDisplay(ctx, status)) return { status: "cancelled" };
			successfulModelIdentity = identity;
			return { status: "ready", report };
		} catch (error) {
			if (isAbortError(error) || isStaleContextError(error)) return { status: "cancelled" };
			if (error instanceof UsageAuthError) {
				safeSetDisplay(ctx, `${WIDGET_LABEL} auth error`);
				return { status: "auth-error" };
			}
			safeSetDisplay(ctx, `${WIDGET_LABEL} error`);
			return { status: "query-error" };
		} finally {
			if (activeController === controller) activeController = undefined;
			if (isCurrent()) scheduleRefresh(ctx);
		}
	};

	pi.registerCommand(COMMAND_NAME, {
		description: "Show OpenAI Codex usage for the active Pi account",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify(`${COMMAND_INVOCATION} does not accept arguments.`, "warning");
				return;
			}
			if (ctx.mode !== "tui") return;
			const model = activeCodexModel(ctx);
			if (!model) {
				ctx.ui.notify(
					`${COMMAND_INVOCATION} requires an active OpenAI Codex model.`,
					"warning",
				);
				return;
			}

			const result = await refresh(ctx, true);
			if (result.status === "ready") {
				ctx.ui.notify(formatUsageReport(result.report, model), "info");
			} else if (result.status === "auth-error") {
				ctx.ui.notify("Codex usage authentication failed.", "error");
			} else if (result.status === "query-error") {
				ctx.ui.notify("Codex usage query failed.", "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const loadedConfig = await loadConfig(ctx);
		config = loadedConfig.config;
		sessionActive = ctx.mode === "tui";
		if (!sessionActive) return;
		for (const warning of loadedConfig.warnings) ctx.ui.notify(warning, "warning");
		void refresh(ctx, false);
	});

	pi.on("model_select", (_event, ctx) => {
		if (!sessionActive || ctx.mode !== "tui") return;
		if (ctx.model?.provider !== PROVIDER_ID) {
			stopRefresh(ctx, true);
			return;
		}
		void refresh(ctx, false);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionActive = false;
		stopRefresh(ctx, true);
		cache = undefined;
	});
}

async function loadConfig(
	ctx: ExtensionContext,
): Promise<{ config: CodexUsageConfig; warnings: string[] }> {
	const warnings: string[] = [];
	const merged: Record<string, unknown> = {};
	let agentDirectory: string;
	try {
		agentDirectory = resolveAgentDirectory();
	} catch (error) {
		return {
			config: { ...DEFAULT_CONFIG },
			warnings: [`Could not resolve the global codex-usage config path: ${errorMessage(error)}`],
		};
	}

	const layers: Array<{ label: string; path: string }> = [
		{ label: "global", path: resolve(agentDirectory, "codex-usage.json") },
	];
	if (ctx.isProjectTrusted()) {
		layers.push({
			label: "project",
			path: resolve(ctx.cwd, CONFIG_DIR_NAME, "codex-usage.json"),
		});
	}

	for (const layer of layers) {
		const value = await readConfigLayer(layer.path, layer.label, warnings);
		if (value === undefined) continue;
		if (!isConfigObject(value)) {
			warnings.push(`${layer.label} codex-usage config must be a JSON object; ignoring it.`);
			continue;
		}
		Object.assign(merged, value);
	}

	const parsed = parseConfig(merged);
	return { config: parsed.config, warnings: [...warnings, ...parsed.warnings] };
}

function resolveAgentDirectory(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (!configured) return resolve(userInfo().homedir, ".pi", "agent");
	if (!isAbsolute(configured)) throw new Error("PI_CODING_AGENT_DIR must be absolute");
	return resolve(configured);
}

async function readConfigLayer(
	path: string,
	label: string,
	warnings: string[],
): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		warnings.push(`Could not read ${label} codex-usage config at ${path}; ignoring it.`);
		return undefined;
	}
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function resolveRuntimeAuth(
	ctx: ExtensionContext,
	model: PiModel,
	salt: Uint8Array,
): Promise<RuntimeAuth> {
	if (!hasOfficialOrigin(model.baseUrl)) {
		throw new UsageAuthError("The active Codex model uses a non-official base URL.");
	}

	let providerAuth: Awaited<ReturnType<typeof ctx.modelRegistry.getProviderAuth>>;
	try {
		providerAuth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
	} catch {
		throw new UsageAuthError("Pi could not resolve OpenAI Codex authentication.");
	}
	if (!providerAuth) throw new UsageAuthError("OpenAI Codex authentication is unavailable.");
	if (providerAuth.auth.baseUrl && !hasOfficialOrigin(providerAuth.auth.baseUrl)) {
		throw new UsageAuthError("Resolved Codex authentication uses a non-official base URL.");
	}

	let requestAuth: Awaited<ReturnType<typeof ctx.modelRegistry.getApiKeyAndHeaders>>;
	try {
		requestAuth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	} catch {
		throw new UsageAuthError("Pi could not resolve active model authentication.");
	}
	if (!requestAuth.ok) throw new UsageAuthError("Pi could not resolve active model authentication.");
	const authorization =
		headerValue(requestAuth.headers, "Authorization") ??
		(requestAuth.apiKey ? `Bearer ${requestAuth.apiKey}` : undefined) ??
		headerValue(providerAuth.auth.headers, "Authorization") ??
		(providerAuth.auth.apiKey ? `Bearer ${providerAuth.auth.apiKey}` : undefined);
	if (!authorization) throw new UsageAuthError("OpenAI Codex bearer authentication is unavailable.");

	return {
		authorization,
		fingerprint: createHmac("sha256", salt).update(authorization).digest("hex"),
	};
}

async function fetchUsage(authorization: string, callerSignal: AbortSignal): Promise<unknown> {
	const controller = new AbortController();
	let timedOut = false;
	const abortFromCaller = () => controller.abort();
	if (callerSignal.aborted) controller.abort();
	else callerSignal.addEventListener("abort", abortFromCaller, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, QUERY_TIMEOUT_MS);

	try {
		const response = await fetch(USAGE_URL, {
			headers: {
				Authorization: authorization,
				"User-Agent": "db11-codex-usage",
			},
			signal: controller.signal,
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new UsageQueryError(`Codex usage endpoint returned HTTP ${response.status}.`);
		}
		const text = await readBoundedBody(response, MAX_RESPONSE_BYTES);
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new UsageQueryError("Codex usage endpoint returned invalid JSON.");
		}
	} catch (error) {
		if (timedOut) throw new UsageQueryError("Codex usage query timed out.");
		if (callerSignal.aborted) throw abortError();
		if (error instanceof UsageQueryError) throw error;
		throw new UsageQueryError("Codex usage request failed.");
	} finally {
		clearTimeout(timeout);
		callerSignal.removeEventListener("abort", abortFromCaller);
	}
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (total + value.byteLength > maxBytes) {
				await reader.cancel();
				throw new UsageQueryError(`Codex usage response exceeded ${maxBytes} bytes.`);
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

function activeCodexModel(ctx: ExtensionContext): PiModel | undefined {
	const model = ctx.model;
	return model?.provider === PROVIDER_ID ? model : undefined;
}

function modelIdentity(model: Pick<UsageModel, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function hasOfficialOrigin(value: string): boolean {
	try {
		return new URL(value).origin === OFFICIAL_ORIGIN;
	} catch {
		return false;
	}
}

function headerValue(
	headers: Record<string, string> | undefined,
	name: string,
): string | undefined {
	const entry = Object.entries(headers ?? {}).find(
		([candidate]) => candidate.toLowerCase() === name.toLowerCase(),
	);
	return entry?.[1];
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
	return Object.assign(new Error("Codex usage query aborted."), { name: "AbortError" });
}

function isStaleContextError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes("This extension ctx is stale after session replacement or reload")
	);
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
