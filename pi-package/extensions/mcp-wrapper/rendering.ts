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

const EXPAND_TOOL_RESULT_KEYBINDING = "app.tools.expand";
const RESULT_LABEL = "Result:";
const MCP_CALL_PREVIEW_LINES = 3;
export const MCP_COLLAPSED_RESULT_PREVIEW_LINES = 5;

class McpCallHeader implements Component {
	constructor(
		private readonly toolName: string,
		private readonly args: unknown,
		private readonly theme: Theme,
		private readonly expanded: boolean,
	) {}

	render(width: number): string[] {
		const rendered = renderLabeledWrappedText({
			label: `${this.toolName}:`,
			text: JSON.stringify(this.args) ?? "undefined",
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

	invalidate(): void {}

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

export function renderMcpToolCall(
	toolName: string,
	args: unknown,
	theme: Theme,
	context?: { readonly expanded?: boolean },
): Component {
	return new McpCallHeader(toolName, args, theme, context?.expanded === true);
}

export function renderMcpToolResult(
	result: AgentToolResult<unknown>,
	options: { readonly expanded?: boolean },
	theme: Theme,
	context: { readonly isError?: boolean },
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

	return new CollapsedMcpResult(text, theme, context.isError === true);
}

class CollapsedMcpResult implements Component {
	constructor(
		private readonly text: string,
		private readonly theme: Theme,
		private readonly isError: boolean,
	) {}

	render(width: number): string[] {
		const rendered = renderLabeledWrappedText({
			label: RESULT_LABEL,
			text: this.text,
			width,
			labelStyle: (value) => this.theme.fg("toolTitle", this.theme.bold(value)),
			textStyle: (value) =>
				this.theme.fg(this.isError ? "error" : "dim", value),
		});
		const preview = rendered.slice(0, MCP_COLLAPSED_RESULT_PREVIEW_LINES);
		const hidden = rendered.length - preview.length;
		if (hidden <= 0) {
			return preview;
		}
		preview.push(this.renderHiddenHint(hidden, rendered.length, width));
		return preview;
	}

	invalidate(): void {}

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

function getResultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}
