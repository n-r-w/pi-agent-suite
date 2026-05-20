import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import {
	copyToClipboard as defaultCopyToClipboard,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	Key,
} from "@earendil-works/pi-tui";
import { readPromptConfig } from "./config.ts";
import { readPathEnvironment } from "./environment.ts";
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

type CreateAutocompleteProvider = (
	cwd: string,
	fdPath: string | null,
) => AutocompleteProvider | undefined;

interface PromptFormRuntime {
	readonly copyToClipboard: (text: string) => Promise<void>;
	readonly resolveFdPath: () => string | null;
	readonly createAutocompleteProvider: CreateAutocompleteProvider;
}

interface StructuredPromptDependencies {
	readonly copyToClipboard?: (text: string) => Promise<void>;
	readonly resolveFdPath?: () => string | null;
	readonly createAutocompleteProvider?: CreateAutocompleteProvider;
}

/** Registers the structured prompt form command and shortcut when the extension is enabled. */
export default function prompt(
	pi: ExtensionAPI,
	dependencies: StructuredPromptDependencies = {},
): void {
	const configResult = readPromptConfig();
	if (configResult.kind === "invalid" || !configResult.config.enabled) {
		return;
	}

	const copyToClipboard =
		dependencies.copyToClipboard ?? defaultCopyToClipboard;
	const resolveFdPath = dependencies.resolveFdPath ?? resolveFdPathFromPath;
	const createProvider =
		dependencies.createAutocompleteProvider ?? createAutocompleteProvider;

	const runtime = {
		copyToClipboard,
		resolveFdPath,
		createAutocompleteProvider: createProvider,
	};

	pi.registerCommand(PROMPT_COMMAND, {
		description: "Open a structured prompt form",
		handler: async (_args, ctx) => {
			await openPromptForm(pi, ctx, runtime);
		},
	});

	pi.registerShortcut(PROMPT_SHORTCUT, {
		description: "Open a structured prompt form",
		handler: async (ctx) => {
			await openPromptForm(pi, ctx, runtime);
		},
	});
}

async function openPromptForm(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext | ExtensionContext,
	runtime: PromptFormRuntime,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Prompt form requires interactive mode.", "warning");
		return;
	}

	const autocompleteProvider = runtime.createAutocompleteProvider(
		ctx.cwd,
		runtime.resolveFdPath(),
	);
	const result = await ctx.ui.custom<StructuredPromptFormResult>(
		(tui, theme, _keybindings, done) =>
			new StructuredPromptForm({
				tui,
				theme,
				sections: PROMPT_SECTIONS,
				...(autocompleteProvider === undefined ? {} : { autocompleteProvider }),
				onCopyPrompt: (promptText) =>
					copyPromptToClipboard(ctx, runtime.copyToClipboard, promptText),
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

	if (result.kind === "inserted") {
		ctx.ui.setEditorText(promptText);
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

/** Creates a Pi TUI CombinedAutocompleteProvider for form file references when fd is available. */
function createAutocompleteProvider(
	cwd: string,
	fdPath: string | null,
): AutocompleteProvider | undefined {
	if (fdPath === null) {
		return undefined;
	}
	return new CombinedAutocompleteProvider([], cwd, fdPath);
}

/** Finds an executable fd on PATH for Pi TUI file autocomplete. */
function resolveFdPathFromPath(): string | null {
	const pathValue = readPathEnvironment();
	if (pathValue === undefined || pathValue.length === 0) {
		return null;
	}

	for (const directory of pathValue.split(delimiter)) {
		if (directory.length === 0) {
			continue;
		}
		const candidate = join(directory, "fd");
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Keep scanning PATH entries until an executable fd is found.
		}
	}
	return null;
}

async function copyPromptToClipboard(
	ctx: ExtensionCommandContext | ExtensionContext,
	copyToClipboard: (text: string) => Promise<void>,
	promptText: string,
): Promise<void> {
	try {
		await copyToClipboard(promptText);
		ctx.ui.notify("Prompt copied to clipboard.", "info");
	} catch (error) {
		ctx.ui.notify(
			`Failed to copy prompt to clipboard: ${formatError(error)}`,
			"warning",
		);
	}
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
