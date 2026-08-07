import assert from "node:assert/strict";
import test from "node:test";
import codexUsageExtension from "./index.ts";

interface RegisteredCommand {
	handler: (args: string, ctx: any) => Promise<void> | void;
}

function registeredCommands(): Map<string, RegisteredCommand> {
	const commands = new Map<string, RegisteredCommand>();
	codexUsageExtension({
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		on() {},
	} as any);
	return commands;
}

test("registers the /usage-codex command", () => {
	const commands = registeredCommands();
	assert.deepEqual([...commands.keys()], ["usage-codex"]);
});

test("uses the command name in argument validation", async () => {
	const command = registeredCommands().get("usage-codex");
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
		{ message: "/usage-codex does not accept arguments.", level: "warning" },
	]);
});
