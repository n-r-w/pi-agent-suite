import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getKeybindings,
	Markdown,
	Text,
} from "@earendil-works/pi-tui";
import { truncateTextByWidth } from "../display-width.ts";
import { renderLabeledWrappedText } from "../labeled-wrapped-text.ts";
import { normalizeCollapsedToolText } from "../terminal-display-text.ts";

const EXPAND_TOOL_RESULT_KEYBINDING = "app.tools.expand";

/** Configures the behavior difference between package and unknown-tool results. */
interface BoundedToolResultOptions {
	readonly text: string;
	readonly theme: Theme;
	readonly isError: boolean;
	readonly expanded: boolean;
	readonly collapsedContentLineLimit: number;
	readonly showHiddenLineHint: boolean;
	readonly showExpandedErrorLabel: boolean;
}

/** Renders one JSON call preview within a visual-line budget. */
export class BoundedToolCall implements Component {
	public constructor(
		private readonly label: string | undefined,
		private readonly args: unknown,
		private readonly theme: Theme,
		private readonly lineLimit: number,
	) {}

	/** Starts labeled arguments on the label row before applying the call row limit. */
	public render(width: number): string[] {
		const json = normalizeCollapsedToolText(
			JSON.stringify(this.args) ?? "undefined",
		);
		if (this.label === undefined) {
			return new Text(this.theme.fg("dim", json), 0, 0)
				.render(width)
				.slice(0, this.lineLimit);
		}
		return renderLabeledWrappedText({
			label: `${this.label}:`,
			text: json,
			width,
			labelStyle: (value) => this.theme.fg("toolTitle", this.theme.bold(value)),
			textStyle: (value) => this.theme.fg("dim", value),
		}).slice(0, this.lineLimit);
	}

	public invalidate(): void {}
}

/** Renders complete Markdown or one bounded text result preview. */
export class BoundedToolResult implements Component {
	public constructor(private readonly options: BoundedToolResultOptions) {}

	/** Selects original expanded Markdown or normalized collapsed text. */
	public render(width: number): string[] {
		if (this.options.expanded) {
			return this.renderExpanded(width);
		}
		const color = this.options.isError ? "error" : "toolOutput";
		const visualLines = new Text(
			this.options.theme.fg(
				color,
				normalizeCollapsedToolText(this.options.text),
			),
			0,
			0,
		).render(width);
		if (
			!this.options.showHiddenLineHint ||
			visualLines.length <= this.options.collapsedContentLineLimit
		) {
			return visualLines.slice(0, this.options.collapsedContentLineLimit);
		}
		return [
			...visualLines.slice(0, this.options.collapsedContentLineLimit),
			this.renderHiddenLineHint(
				visualLines.length - this.options.collapsedContentLineLimit,
				visualLines.length,
				width,
			),
		];
	}

	public invalidate(): void {}

	private renderExpanded(width: number): string[] {
		const markdown = new Markdown(this.options.text, 0, 0, getMarkdownTheme());
		if (!this.options.isError || !this.options.showExpandedErrorLabel) {
			return markdown.render(width);
		}
		return [
			...new Text(
				this.options.theme.fg("error", this.options.theme.bold("Error")),
				0,
				0,
			).render(width),
			...markdown.render(width),
		];
	}

	/** Renders Pi's standard collapsed-content summary within one visual line. */
	private renderHiddenLineHint(
		hiddenLineCount: number,
		totalLineCount: number,
		width: number,
	): string {
		const key = getKeybindings()
			.getKeys(EXPAND_TOOL_RESULT_KEYBINDING)
			.join("/");
		// Match Pi's singular and plural wording for the hidden visual-line count.
		const lineWord = hiddenLineCount === 1 ? "line" : "lines";
		const hint = `... (${hiddenLineCount} more ${lineWord}, ${totalLineCount} total, ${key} to expand)`;
		return this.options.theme.fg(
			"muted",
			truncateTextByWidth(hint, width, "..."),
		);
	}
}

/** Joins public text result parts without inspecting tool-private details. */
export function getToolResultText(result: AgentToolResult<unknown>): string {
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return text.length === 0 ? "(no output)" : text;
}

/** Prevents display-only definitions from becoming executable tools. */
export async function rejectPresentationExecution(): Promise<never> {
	throw new Error("presentation-only tool definitions cannot execute");
}
