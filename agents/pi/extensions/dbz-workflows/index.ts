import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createCommandCache,
	registerDbzWorkflowCommands,
	type CommandDependencies,
} from "./commands.ts";
import {
	registerDbzWorkflowTools,
	type FileMutationQueue,
	type ToolDependencies,
} from "./tools.ts";
import { currentTicketSessionLocator } from "./sessions.ts";

export interface DbzWorkflowsExtensionOptions {
	homeDirectory?: string;
	commandDependencies?: Partial<CommandDependencies>;
	toolDependencies?: Partial<ToolDependencies>;
	fileMutationQueue?: FileMutationQueue;
}

export default function dbzWorkflowsExtension(
	pi: ExtensionAPI,
	options: DbzWorkflowsExtensionOptions = {},
): void {
	pi.on("session_start", (_event, ctx) => {
		const locator = currentTicketSessionLocator(ctx.sessionManager);
		if (locator === null || locator.mutates_project) return;
		const retained = pi.getActiveTools().filter((name) => !["bash", "edit", "write"].includes(name));
		pi.setActiveTools([...new Set(retained)]);
	});
	const cache = createCommandCache();
	registerDbzWorkflowCommands(pi, {
		cache,
		dependencies: options.commandDependencies,
		homeDirectory: options.homeDirectory,
	});
	registerDbzWorkflowTools(pi, {
		dependencies: options.toolDependencies,
		homeDirectory: options.homeDirectory,
		fileMutationQueue: options.fileMutationQueue,
	});
}
