import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	getKeybindings,
	Markdown,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	sliceTextByWidth,
	truncateTextByWidth,
} from "../../shared/display-width";

const EXPAND_TOOL_RESULT_KEYBINDING = "app.tools.expand";
const RESULT_LABEL = "Result:";
const SEPARATOR = " ";
export const MCP_COLLAPSED_RESULT_PREVIEW_LINES = 5;

class McpCallHeader implements Component {
	constructor(
		private readonly toolName: string,
		private readonly args: unknown,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		return renderLabeledWrappedText({
			label: `${this.toolName}:`,
			text: JSON.stringify(this.args) ?? "undefined",
			width,
			labelStyle: (value) => this.theme.fg("toolTitle", this.theme.bold(value)),
			textStyle: (value) => this.theme.fg("dim", value),
		});
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
		container.addChild(
			new Text(theme.fg("toolTitle", theme.bold(RESULT_LABEL)), 0, 0),
		);
		container.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
		return container;
	}

	return new CollapsedMcpResult(text, theme, context.isError === true);
}

interface LabeledWrappedTextOptions {
	readonly label: string;
	readonly text: string;
	readonly width: number;
	readonly labelStyle: (value: string) => string;
	readonly textStyle: (value: string) => string;
}

function renderLabeledWrappedText(
	options: LabeledWrappedTextOptions,
): string[] {
	const safeWidth = Math.max(0, Math.floor(options.width));
	if (safeWidth === 0) {
		return [];
	}

	const labelWidth = visibleWidth(options.label);
	if (labelWidth >= safeWidth) {
		return [
			options.labelStyle(truncateTextByWidth(options.label, safeWidth, "…")),
			...wrapTextByWidth(options.text, safeWidth).map(options.textStyle),
		];
	}

	const firstTextWidth = safeWidth - labelWidth - visibleWidth(SEPARATOR);
	const wrappedText = wrapTextWithFirstLineWidth(
		options.text,
		firstTextWidth,
		safeWidth,
	);
	if (wrappedText.length === 0) {
		return [options.labelStyle(options.label)];
	}

	const [firstLine = "", ...restLines] = wrappedText;
	return [
		`${options.labelStyle(options.label)}${options.textStyle(`${SEPARATOR}${firstLine}`)}`,
		...restLines.map(options.textStyle),
	];
}

function wrapTextWithFirstLineWidth(
	text: string,
	firstLineWidth: number,
	otherLineWidth: number,
): string[] {
	if (text.length === 0) {
		return [];
	}
	if (firstLineWidth <= 0) {
		return wrapTextByWidth(text, otherLineWidth);
	}

	const [firstParagraph = "", ...remainingParagraphs] = text.split("\n");
	const firstChunk = sliceTextByWidth(firstParagraph, firstLineWidth);
	if (firstChunk.length === 0 && firstParagraph.length > 0) {
		return wrapTextByWidth(text, otherLineWidth);
	}

	const remainder = [
		firstParagraph.slice(firstChunk.length),
		...remainingParagraphs,
	].join("\n");
	return [
		firstChunk,
		...wrapTextByWidth(remainder, otherLineWidth).filter(
			(line, index) => index > 0 || line.length > 0,
		),
	];
}

function wrapTextByWidth(text: string, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (paragraph.length === 0) {
			lines.push("");
			continue;
		}

		let remaining = paragraph;
		while (remaining.length > 0) {
			const line = sliceTextByWidth(remaining, safeWidth);
			if (line.length === 0) {
				break;
			}
			lines.push(line);
			remaining = remaining.slice(line.length);
		}
	}
	return lines;
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
		const key = getKeybindings()
			.getKeys(EXPAND_TOOL_RESULT_KEYBINDING)
			.join("/");
		const lineWord = hidden === 1 ? "line" : "lines";
		const hint =
			this.theme.fg(
				"muted",
				`... (${hidden} more ${lineWord}, ${total} total, `,
			) +
			this.theme.fg("dim", key) +
			this.theme.fg("muted", " to expand)");
		return truncateToWidth(hint, width, "...");
	}
}

function getResultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}
