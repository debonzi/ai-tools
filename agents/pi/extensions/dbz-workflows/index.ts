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
import {
	DBZ_CREW_EXECUTOR,
	registerDbzCrewExecutor,
	type DbzCrewRegistrationOptions,
} from "./executors/dbz-crew.ts";
import { currentTicketSessionLocator } from "./sessions.ts";
import {
	registerVerificationTools,
	type VerificationDependencies,
} from "./verification.ts";
import {
	registerIssuesTools,
	type IssuesDependencies,
} from "./issues.ts";

export interface DbzWorkflowsExtensionOptions {
	homeDirectory?: string;
	commandDependencies?: Partial<CommandDependencies>;
	toolDependencies?: Partial<ToolDependencies>;
	fileMutationQueue?: FileMutationQueue;
	crewAdapter?: DbzCrewRegistrationOptions;
	verificationDependencies?: Partial<VerificationDependencies>;
	issuesDependencies?: Partial<IssuesDependencies>;
}

export default function dbzWorkflowsExtension(
	pi: ExtensionAPI,
	options: DbzWorkflowsExtensionOptions = {},
): void {
	pi.on("session_start", (_event, ctx) => {
		if (process.env.DBZ_WORKFLOWS_EXECUTOR === DBZ_CREW_EXECUTOR) {
			const retained = pi.getActiveTools().filter((name) => !name.startsWith("dbz_workflows_"));
			pi.setActiveTools([...new Set(retained)]);
			return;
		}
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
	registerVerificationTools(pi, {
		dependencies: options.verificationDependencies,
		homeDirectory: options.homeDirectory,
		fileMutationQueue: options.fileMutationQueue,
	});
	registerIssuesTools(pi, {
		dependencies: options.issuesDependencies,
		homeDirectory: options.homeDirectory,
		fileMutationQueue: options.fileMutationQueue,
	});
	registerDbzCrewExecutor(pi, {
		...options.crewAdapter,
		homeDirectory: options.crewAdapter?.homeDirectory ?? options.homeDirectory,
		fileMutationQueue: options.crewAdapter?.fileMutationQueue ?? options.fileMutationQueue,
	});
}
