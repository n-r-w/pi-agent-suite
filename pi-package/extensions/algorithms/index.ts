import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	getTriggerAlgorithm,
	getTriggerAlgorithms,
} from "../../shared/algorithm-registry";
import { isAlgorithmsChildProcess } from "./environment";

/** Registers the manual algorithm-launch CLI flag and slash commands. */
export default function algorithmsExtension(pi: ExtensionAPI): void {
	pi.registerFlag("trigger", {
		description: "Run an algorithm trigger at startup and exit",
		type: "string",
	});
	pi.on("session_start", async (_event, ctx) => {
		if (await handleCliTriggerIfRequested(pi, ctx)) {
			return;
		}
		registerTriggerCommands(pi);
	});
}

/**
 * Checks the --trigger CLI flag and executes the requested algorithm if set.
 * Returns true when the flag was handled (algorithm executed or error reported),
 * signaling the caller to skip normal session initialization.
 */
async function handleCliTriggerIfRequested(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<boolean> {
	if (isAlgorithmsChildProcess()) {
		return false;
	}
	const triggerFlag = pi.getFlag("trigger");
	if (typeof triggerFlag !== "string") {
		return false;
	}
	const algorithm = getTriggerAlgorithm(pi, triggerFlag);
	if (algorithm === undefined) {
		process.stderr.write(`unknown trigger type: ${triggerFlag}\n`);
		process.exitCode = 1;
		ctx.shutdown();
		return true;
	}
	process.stderr.write(`[trigger] running ${triggerFlag}...\n`);
	try {
		const result = await algorithm.run(ctx, undefined);
		if (result.ok) {
			process.stderr.write(`[trigger] ${triggerFlag} completed\n`);
		} else {
			process.stderr.write(`[trigger] ${triggerFlag} failed\n`);
			process.exitCode = 1;
		}
	} catch {
		process.stderr.write(`[trigger] ${triggerFlag} failed\n`);
		process.exitCode = 1;
	}
	ctx.shutdown();
	return true;
}

/** Registers one slash command per registered algorithm for manual TUI launch. */
function registerTriggerCommands(pi: ExtensionAPI): void {
	for (const algorithm of getTriggerAlgorithms(pi)) {
		pi.registerCommand(`trigger:${algorithm.type}`, {
			description: algorithm.description,
			handler: async (_args, ctx) => {
				await algorithm.run(ctx, undefined);
			},
		});
	}
}
