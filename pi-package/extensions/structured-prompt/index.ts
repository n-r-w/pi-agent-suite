import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { readPromptConfig } from "./config.ts";
import {
	StructuredPromptForm,
	type StructuredPromptFormResult,
} from "./form.ts";
import { formatStructuredPrompt, PROMPT_SECTIONS } from "./formatter.ts";

const PROMPT_COMMAND = "prompt";
const PROMPT_SHORTCUT = Key.ctrlAlt("p");
const PROMPT_OVERLAY_OPTIONS = {
	overlay: true,
	overlayOptions: { anchor: "center" as const },
};

/** Registers the structured prompt form command and shortcut when the extension is enabled. */
export default function prompt(pi: ExtensionAPI): void {
	const configResult = readPromptConfig();
	if (configResult.kind === "invalid" || !configResult.config.enabled) {
		return;
	}

	pi.registerCommand(PROMPT_COMMAND, {
		description: "Open a structured prompt form",
		handler: async (_args, ctx) => {
			await openPromptForm(pi, ctx);
		},
	});

	pi.registerShortcut(PROMPT_SHORTCUT, {
		description: "Open a structured prompt form",
		handler: async (ctx) => {
			await openPromptForm(pi, ctx);
		},
	});
}

async function openPromptForm(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext | ExtensionContext,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Prompt form requires interactive mode.", "warning");
		return;
	}

	const result = await ctx.ui.custom<StructuredPromptFormResult>(
		(tui, theme, _keybindings, done) =>
			new StructuredPromptForm({
				tui,
				theme,
				sections: PROMPT_SECTIONS,
				onDone: done,
			}),
		PROMPT_OVERLAY_OPTIONS,
	);
	if (result.kind === "cancelled") {
		return;
	}

	const promptText = formatStructuredPrompt(PROMPT_SECTIONS, result.values);
	if (promptText.length === 0) {
		ctx.ui.notify("Prompt form is empty.", "warning");
		return;
	}

	if (ctx.isIdle()) {
		pi.sendUserMessage(promptText);
		return;
	}

	const queueFollowUp = await ctx.ui.confirm(
		"Queue prompt as follow-up?",
		"The agent is busy. Queue this prompt to run after the current response finishes?",
	);
	if (!queueFollowUp) {
		return;
	}

	pi.sendUserMessage(promptText, { deliverAs: "followUp" });
}
