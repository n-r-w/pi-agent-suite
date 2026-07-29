import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getKeybindings,
	Markdown,
	Text,
} from "@earendil-works/pi-tui";
import { truncateTextByWidth } from "../display-width.ts";
import { normalizeCollapsedToolText } from "../terminal-display-text.ts";

const EXPAND_TOOL_RESULT_KEYBINDING = "app.tools.expand";

/** Configures the behavior difference between package and unknown-tool results. */
interface BoundedToolResultOptions {
	readonly text: string;
	readonly theme: Theme;
	readonly isError: boolean;
	readonly expanded: boolean;
	readonly collapsedLineLimit: number;
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

	/** Normalizes serialized arguments before applying the call row limit. */
	public render(width: number): string[] {
		const json = normalizeCollapsedToolText(
			JSON.stringify(this.args) ?? "undefined",
		);
		const prefix =
			this.label === undefined
				? ""
				: `${this.theme.fg("toolTitle", this.theme.bold(`${this.label}:`))} `;
		return new Text(`${prefix}${this.theme.fg("dim", json)}`, 0, 0)
			.render(width)
			.slice(0, this.lineLimit);
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
			visualLines.length <= this.options.collapsedLineLimit
		) {
			return visualLines.slice(0, this.options.collapsedLineLimit);
		}
		const contentLineLimit = this.options.collapsedLineLimit - 1;
		return [
			...visualLines.slice(0, contentLineLimit),
			this.renderHiddenLineHint(visualLines.length - contentLineLimit, width),
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

	private renderHiddenLineHint(hiddenLineCount: number, width: number): string {
		const key = getKeybindings()
			.getKeys(EXPAND_TOOL_RESULT_KEYBINDING)
			.join("/");
		const hint = `${hiddenLineCount} hidden · ${key}`;
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
