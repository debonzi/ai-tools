import assert from "node:assert/strict";
import test from "node:test";
import copilotUsageExtension, {
	fetchUsage,
	hasOfficialOrigin,
	resolveRuntimeAuth,
} from "./index.ts";

interface RegisteredCommand {
	handler: (args: string, ctx: any) => Promise<void> | void;
}

function registerExtension(dependencies: Record<string, unknown> = {}) {
	const commands = new Map<string, RegisteredCommand>();
	const events = new Map<string, (...args: any[]) => unknown>();
	copilotUsageExtension(
		{
			registerCommand(name: string, command: RegisteredCommand) {
				commands.set(name, command);
			},
			on(name: string, handler: (...args: any[]) => unknown) {
				events.set(name, handler);
			},
		} as any,
		dependencies,
	);
	return { commands, events };
}

const model = {
	provider: "github-copilot",
	id: "gpt-5.4",
	name: "GPT-5.4",
	baseUrl: "https://api.individual.githubcopilot.com",
};

function oauthCredential(overrides: Record<string, unknown> = {}) {
	return {
		type: "oauth",
		access: "copilot-session-token",
		refresh: "github-oauth-token",
		expires: Date.now() + 60_000,
		...overrides,
	};
}

function authContext(overrides: Record<string, unknown> = {}) {
	return {
		model,
		modelRegistry: {
			getProviderAuth: async () => ({
				auth: { apiKey: "copilot-session-token", baseUrl: model.baseUrl },
			}),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "copilot-session-token" }),
		},
		...overrides,
	} as any;
}

test("registers the /usage-copilot command", () => {
	const { commands } = registerExtension();
	assert.deepEqual([...commands.keys()], ["usage-copilot"]);
});

test("uses the command name in argument validation", async () => {
	const command = registerExtension().commands.get("usage-copilot");
	assert.ok(command);
	const notifications: Array<{ message: string; level: string }> = [];

	await command.handler("unexpected", {
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
	});

	assert.deepEqual(notifications, [
		{ message: "/usage-copilot does not accept arguments.", level: "warning" },
	]);
});

test("requires an active GitHub Copilot model", async () => {
	const command = registerExtension().commands.get("usage-copilot");
	assert.ok(command);
	const notifications: Array<{ message: string; level: string }> = [];
	await command.handler("", {
		mode: "tui",
		model: { provider: "openai-codex", id: "gpt-5.4" },
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
	});
	assert.deepEqual(notifications, [
		{
			message: "/usage-copilot requires an active GitHub Copilot model.",
			level: "warning",
		},
	]);
});

test("resolves only the matching Pi OAuth account", async () => {
	const auth = await resolveRuntimeAuth(
		authContext(),
		model as any,
		new Uint8Array(32),
		() => oauthCredential(),
	);
	assert.equal(auth.authorization, "Bearer github-oauth-token");
	assert.doesNotMatch(auth.fingerprint, /github-oauth-token|copilot-session-token/u);

	await assert.rejects(
		() =>
			resolveRuntimeAuth(authContext(), model as any, new Uint8Array(32), () =>
				oauthCredential({ access: "another-session-token" }),
			),
		/does not match/iu,
	);
	await assert.rejects(
		() =>
			resolveRuntimeAuth(authContext(), model as any, new Uint8Array(32), () => ({
				type: "api_key",
				key: "github-oauth-token",
			})),
		/OAuth account.*Pi \/login/iu,
	);
	await assert.rejects(
		() =>
			resolveRuntimeAuth(authContext(), model as any, new Uint8Array(32), () =>
				oauthCredential({ enterpriseUrl: "company.ghe.com" }),
			),
		/Enterprise Server/iu,
	);
});

test("uses an active Authorization header before a provider default", async () => {
	const ctx = authContext({
		modelRegistry: {
			getProviderAuth: async () => ({
				auth: { apiKey: "copilot-session-token", baseUrl: model.baseUrl },
			}),
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "copilot-session-token",
				headers: { Authorization: "Bearer another-session-token" },
			}),
		},
	});
	await assert.rejects(
		() => resolveRuntimeAuth(ctx, model as any, new Uint8Array(32), () => oauthCredential()),
		/does not match/iu,
	);
});

test("rejects custom and malformed Copilot origins", async () => {
	assert.equal(hasOfficialOrigin("https://api.individual.githubcopilot.com"), true);
	assert.equal(hasOfficialOrigin("https://api.business.githubcopilot.com/v1"), true);
	assert.equal(hasOfficialOrigin("https://proxy.example.test"), false);
	assert.equal(hasOfficialOrigin("http://api.individual.githubcopilot.com"), false);
	assert.equal(hasOfficialOrigin("https://api.individual.githubcopilot.com:8443"), false);

	await assert.rejects(
		() =>
			resolveRuntimeAuth(
				authContext(),
				{ ...model, baseUrl: "https://proxy.example.test" } as any,
				new Uint8Array(32),
				() => oauthCredential(),
			),
		/non-official base URL/iu,
	);
});

test("queries only the fixed GitHub endpoint with the original OAuth token", async () => {
	let requestUrl: string | URL | Request | undefined;
	let requestInit: RequestInit | undefined;
	const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
		requestUrl = input;
		requestInit = init;
		return new Response('{"quota_snapshots":{"premium_interactions":{"unlimited":true}}}');
	};
	const result = await fetchUsage(
		"Bearer github-oauth-token",
		new AbortController().signal,
		fetcher as typeof fetch,
	);
	assert.ok(result);
	assert.equal(requestUrl, "https://api.github.com/copilot_internal/user");
	assert.deepEqual(requestInit?.headers, {
		Accept: "application/json",
		Authorization: "Bearer github-oauth-token",
		"User-Agent": "db11-copilot-usage",
		"X-GitHub-Api-Version": "2025-05-01",
	});
	assert.doesNotMatch(JSON.stringify(requestInit), /copilot-session-token/u);
});

test("bounds provider responses and suppresses response bodies from errors", async () => {
	await assert.rejects(
		() =>
			fetchUsage(
				"Bearer secret",
				new AbortController().signal,
				(async () => new Response("x".repeat(70_000))) as typeof fetch,
			),
		/exceeded 65536 bytes/iu,
	);
	await assert.rejects(
		() =>
			fetchUsage(
				"Bearer secret",
				new AbortController().signal,
				(async () => new Response("provider-secret-body", { status: 500 })) as typeof fetch,
			),
		(error: unknown) =>
			error instanceof Error &&
			/HTTP 500/u.test(error.message) &&
			!error.message.includes("provider-secret-body") &&
			!error.message.includes("secret"),
	);
});

test("command produces a detailed report without persisting credentials", async () => {
	const notifications: Array<{ message: string; level: string }> = [];
	const widgets: Array<{ key: string; value: unknown }> = [];
	const { commands } = registerExtension({
		credentialReader: () => oauthCredential(),
		fetcher: async () =>
			new Response(
				JSON.stringify({
					login: "octocat",
					copilot_plan: "individual",
					quota_snapshots: {
						premium_interactions: { entitlement: 300, remaining: 245 },
					},
				}),
			),
	});
	const command = commands.get("usage-copilot");
	assert.ok(command);
	await command.handler("", {
		...authContext(),
		mode: "tui",
		ui: {
			setWidget(key: string, value: unknown) {
				widgets.push({ key, value });
			},
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
	});

	assert.equal(widgets.at(-1)?.key, "copilot-usage");
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]?.level, "info");
	assert.match(notifications[0]?.message ?? "", /GitHub Copilot Usage/u);
	assert.match(notifications[0]?.message ?? "", /Account: octocat/u);
	assert.doesNotMatch(notifications[0]?.message ?? "", /github-oauth-token|session-token/u);
});
