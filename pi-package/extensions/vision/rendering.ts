import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, Text } from "@earendil-works/pi-tui";
import { truncateTextByWidth } from "../../shared/display-width";
import { renderLabeledWrappedText } from "../../shared/labeled-wrapped-text";
import { normalizeCollapsedToolText } from "../../shared/terminal-display-text";
import { getToolResultText } from "../../shared/tool-presentation/bounded";

const COLLAPSED_LINE_LIMIT = 2;
const EXPAND_KEYBINDING = "app.tools.expand";

export function renderVisionCall(
	args: unknown,
	theme: Theme,
	context: { readonly expanded?: boolean },
): Component {
	const parameters = args as {
		readonly image_path?: string;
		readonly prompt?: string;
	};
	return new VisionCall(
		parameters.image_path ?? "...",
		parameters.prompt ?? "...",
		theme,
		context.expanded === true,
	);
}

export function renderVisionResult(
	result: AgentToolResult<unknown>,
	options: { readonly expanded?: boolean },
	theme: Theme,
	context: { readonly isError?: boolean },
): Component {
	return new VisionResult(
		getToolResultText(result),
		context.isError === true ? "Error" : "Description",
		theme,
		options.expanded === true,
	);
}

class VisionCall implements Component {
	public constructor(
		private readonly imagePath: string,
		private readonly prompt: string,
		private readonly theme: Theme,
		private readonly expanded: boolean,
	) {}

	public render(width: number): string[] {
		const path = renderLabeledWrappedText({
			label: "describe_image:",
			text: this.imagePath,
			width,
			labelStyle: (value) => this.theme.fg("toolTitle", this.theme.bold(value)),
			textStyle: (value) => this.theme.fg("toolOutput", value),
		});
		if (this.expanded) {
			return [
				...path,
				"--- Prompt ---",
				...new Text(this.prompt, 0, 0).render(width),
			];
		}
		return [
			...path,
			...renderCollapsedText(this.prompt, "Prompt", this.theme, width),
		];
	}

	public invalidate(): void {}
}

class VisionResult implements Component {
	public constructor(
		private readonly text: string,
		private readonly label: "Description" | "Error",
		private readonly theme: Theme,
		private readonly expanded: boolean,
	) {}

	public render(width: number): string[] {
		if (this.expanded) {
			return [
				`--- ${this.label} ---`,
				...new Text(this.text, 0, 0).render(width),
			];
		}
		return renderCollapsedText(this.text, this.label, this.theme, width);
	}

	public invalidate(): void {}
}

function renderCollapsedText(
	text: string,
	label: string,
	theme: Theme,
	width: number,
): string[] {
	// Keep preview lines plain until truncation so ANSI styles do not affect display-width clipping.
	const lines = renderLabeledWrappedText({
		label: `${label}:`,
		text: normalizeCollapsedToolText(text),
		width,
		labelStyle: (value) => value,
		textStyle: (value) => value,
	});
	if (lines.length <= COLLAPSED_LINE_LIMIT) {
		return lines.map((line) => theme.fg("toolOutput", line));
	}
	const preview = lines.slice(0, COLLAPSED_LINE_LIMIT);
	const lastPreviewLine = preview.at(-1) ?? "";
	preview[COLLAPSED_LINE_LIMIT - 1] = truncateTextByWidth(
		`${lastPreviewLine}...`,
		width,
		"...",
	);
	return [
		...preview.map((line) => theme.fg("toolOutput", line)),
		renderExpandHint(
			lines.length - COLLAPSED_LINE_LIMIT,
			lines.length,
			width,
			theme,
		),
	];
}

function renderExpandHint(
	hiddenLineCount: number,
	totalLineCount: number,
	width: number,
	theme: Theme,
): string {
	const keys = getKeybindings().getKeys(EXPAND_KEYBINDING).join("/");
	const hint = `... (${hiddenLineCount} more lines, ${totalLineCount} total, ${keys} to expand)`;
	return theme.fg("muted", truncateTextByWidth(hint, width, "..."));
}
