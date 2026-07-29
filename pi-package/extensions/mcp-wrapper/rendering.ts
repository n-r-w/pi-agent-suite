import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	getKeybindings,
	Markdown,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { renderLabeledWrappedText } from "../../shared/labeled-wrapped-text.ts";
import { normalizeCollapsedToolText } from "../../shared/terminal-display-text.ts";

const EXPAND_TOOL_RESULT_KEYBINDING = "app.tools.expand";
const RESULT_LABEL = "Result:";
const MCP_CALL_PREVIEW_LINES = 3;

/** Renders one MCP call header with separate collapsed and expanded text. */
class McpCallHeader implements Component {
	constructor(
		private readonly toolName: string,
		private readonly text: string,
		private readonly theme: Theme,
		private readonly expanded: boolean,
	) {}

	/** Wraps arguments and applies the collapsed visual-line budget. */
	render(width: number): string[] {
		const rendered = renderLabeledWrappedText({
			label: `${this.toolName}:`,
			text: this.text,
			width,
			labelStyle: (value) => this.theme.fg("toolTitle", this.theme.bold(value)),
			textStyle: (value) => this.theme.fg("dim", value),
		});
		if (this.expanded) {
			return rendered;
		}

		const preview = rendered.slice(0, MCP_CALL_PREVIEW_LINES);
		const hidden = rendered.length - preview.length;
		if (hidden <= 0) {
			return preview;
		}
		preview.push(this.renderHiddenHint(hidden, rendered.length, width));
		return preview;
	}

	/** Keeps the immutable component compatible with Pi invalidation. */
	invalidate(): void {}

	/** Renders the configured expansion hint for hidden argument rows. */
	private renderHiddenHint(
		hidden: number,
		total: number,
		width: number,
	): string {
		return renderHiddenHint({
			hidden,
			total,
			width,
			theme: this.theme,
		});
	}
}

/** Renders MCP arguments as normalized preview text or complete expanded JSON. */
export function renderMcpToolCall(
	toolName: string,
	args: unknown,
	theme: Theme,
	context?: { readonly expanded?: boolean },
): Component {
	const expanded = context?.expanded === true;
	const serializedArgs = JSON.stringify(args) ?? "undefined";
	const text = expanded
		? serializedArgs
		: normalizeCollapsedToolText(serializedArgs);
	return new McpCallHeader(toolName, text, theme, expanded);
}

/** Renders normalized collapsed MCP text or the original expanded Markdown. */
export function renderMcpToolResult(
	result: AgentToolResult<unknown>,
	options: { readonly expanded?: boolean },
	theme: Theme,
	context: { readonly isError?: boolean; readonly widgetLineBudget: number },
): Component {
	const text = getResultText(result) || "(no MCP output)";
	if (options.expanded === true) {
		const container = new Container();
		container.addChild(
			new Text(theme.fg("toolTitle", theme.bold(RESULT_LABEL)), 0, 0),
		);
		container.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
		return container;
	}

	return new CollapsedMcpResult(
		normalizeCollapsedToolText(text),
		theme,
		context.isError === true,
		context.widgetLineBudget,
	);
}

/** Renders one normalized MCP result within the configured preview budget. */
class CollapsedMcpResult implements Component {
	constructor(
		private readonly text: string,
		private readonly theme: Theme,
		private readonly isError: boolean,
		private readonly widgetLineBudget: number,
	) {}

	/** Wraps normalized result text and appends an expansion hint when needed. */
	render(width: number): string[] {
		const rendered = renderLabeledWrappedText({
			label: RESULT_LABEL,
			text: this.text,
			width,
			labelStyle: (value) => this.theme.fg("toolTitle", this.theme.bold(value)),
			textStyle: (value) =>
				this.theme.fg(this.isError ? "error" : "dim", value),
		});
		const preview = rendered.slice(0, this.widgetLineBudget);
		const hidden = rendered.length - preview.length;
		if (hidden <= 0) {
			return preview;
		}
		preview.push(this.renderHiddenHint(hidden, rendered.length, width));
		return preview;
	}

	/** Keeps the immutable component compatible with Pi invalidation. */
	invalidate(): void {}

	/** Renders the configured expansion hint for hidden result rows. */
	private renderHiddenHint(
		hidden: number,
		total: number,
		width: number,
	): string {
		return renderHiddenHint({
			hidden,
			total,
			width,
			theme: this.theme,
		});
	}
}

/** Formats one width-bounded hint with the active Pi expansion key. */
function renderHiddenHint(options: {
	readonly hidden: number;
	readonly total: number;
	readonly width: number;
	readonly theme: Theme;
}): string {
	const key = getKeybindings().getKeys(EXPAND_TOOL_RESULT_KEYBINDING).join("/");
	const lineWord = options.hidden === 1 ? "line" : "lines";
	const hint =
		options.theme.fg(
			"muted",
			`... (${options.hidden} more ${lineWord}, ${options.total} total, `,
		) +
		options.theme.fg("dim", key) +
		options.theme.fg("muted", " to expand)");
	return truncateToWidth(hint, options.width, "...");
}

/** Joins public text result parts without inspecting MCP-private details. */
function getResultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}
