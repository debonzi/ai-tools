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
