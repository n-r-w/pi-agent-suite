import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	getKeybindings,
	Markdown,
	Text,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { truncateTextByWidth } from "../../shared/display-width";

const EXPAND_TOOL_RESULT_KEYBINDING = "app.tools.expand";
export const MCP_COLLAPSED_RESULT_PREVIEW_LINES = 5;

class McpCallHeader implements Component {
	constructor(
		private readonly toolName: string,
		private readonly args: unknown,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		const title = `${this.toolName}:`;
		const separator = " ";
		if (visibleWidth(title) >= width) {
			return [
				this.theme.fg(
					"toolTitle",
					this.theme.bold(truncateTextByWidth(title, width, "…")),
				),
			];
		}

		const argsWidth = Math.max(
			0,
			width - visibleWidth(title) - visibleWidth(separator),
		);
		const argsText = truncateTextByWidth(
			JSON.stringify(this.args),
			argsWidth,
			"…",
		);

		return [
			`${this.theme.fg("toolTitle", this.theme.bold(title))}${this.theme.fg("dim", `${separator}${argsText}`)}`,
		];
	}

	invalidate(): void {}
}

export function renderMcpToolCall(
	toolName: string,
	args: unknown,
	theme: Theme,
): Component {
	return new McpCallHeader(toolName, args, theme);
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
		const rendered = new Text(this.text, 0, 0).render(width);
		const preview = rendered
			.slice(0, MCP_COLLAPSED_RESULT_PREVIEW_LINES)
			.map((line) => this.renderPreviewLine(line));
		const hidden = rendered.length - preview.length;
		if (hidden <= 0) {
			return preview;
		}
		preview.push(this.renderHiddenHint(hidden, rendered.length, width));
		return preview;
	}

	invalidate(): void {}

	private renderPreviewLine(line: string): string {
		return this.theme.fg(this.isError ? "error" : "dim", line.trimEnd());
	}

	private renderHiddenHint(
		hidden: number,
		total: number,
		width: number,
	): string {
		const key = getKeybindings()
			.getKeys(EXPAND_TOOL_RESULT_KEYBINDING)
			.join("/");
		const text = `… ${hidden} of ${total} lines hidden (${key} to expand)`;
		return this.theme.fg(
			this.isError ? "error" : "dim",
			truncateTextByWidth(text, width, "…"),
		);
	}
}

function getResultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}
