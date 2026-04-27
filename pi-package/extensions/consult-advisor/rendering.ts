/** Width-aware rendering for the consult_advisor tool. */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getMarkdownTheme, type Theme } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Container,
	getKeybindings,
	Markdown,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import { truncateTextByWidth } from "../../shared/display-width";

const EXPAND_TOOL_RESULT_KEYBINDING = "app.tools.expand";
export const COLLAPSED_ADVICE_PREVIEW_LINES = 5;

/** Renders the compact question preview as one tool-call header row. */
class AdvisorQuestionHeader implements Component {
	public constructor(
		private readonly questionPreview: string,
		private readonly theme: Theme,
	) {}

	/** Returns one width-bounded row because tool-call arguments must not consume collapsed output space. */
	public render(width: number): string[] {
		const title = "consult_advisor:";
		const separator = " ";
		const questionWidth = Math.max(
			0,
			width - visibleWidth(title) - visibleWidth(separator),
		);
		const question = truncateTextByWidth(
			this.questionPreview,
			questionWidth,
			"…",
		);
		return [
			`${this.theme.fg("toolTitle", this.theme.bold(title))}${separator}${this.theme.fg("dim", question)}`,
		];
	}

	/** Keeps the component compatible with the TUI invalidation contract. */
	public invalidate(): void {}
}

/** Renders the visible header for a consult_advisor tool call. */
export function renderConsultAdvisorCall(
	args: { readonly question?: string },
	theme: Theme,
): Component {
	const questionPreview = args.question
		? normalizePreviewText(args.question)
		: "...";
	return new AdvisorQuestionHeader(questionPreview, theme);
}

/** Renders advisor output as compact advice by default and full Markdown when Pi expands tool output. */
export function renderConsultAdvisorResult(
	result: AgentToolResult<unknown>,
	options: { readonly expanded?: boolean },
	theme: Theme,
	context: { readonly isError?: boolean },
): Component {
	const advice = getResultText(result) || "(no advice)";
	const label = context.isError === true ? "Error" : "Advice";
	if (options.expanded !== true) {
		return new CollapsedAdvice(advice, label, theme, context.isError === true);
	}

	const container = new Container();
	container.addChild(
		new Text(
			theme.fg(
				context.isError === true ? "error" : "accent",
				theme.bold(label),
			),
			0,
			0,
		),
	);
	container.addChild(new Markdown(advice, 0, 0, getMarkdownTheme()));
	return container;
}

/** Normalizes multi-line text into one preview line before width clipping. */
function normalizePreviewText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** Formats the currently configured keys for expanding collapsed tool results. */
function formatToolExpandKeybindingText(): string {
	return getKeybindings().getKeys(EXPAND_TOOL_RESULT_KEYBINDING).join("/");
}

/** Renders collapsed advice and the standard expansion hint when content is hidden. */
class CollapsedAdvice implements Component {
	public constructor(
		private readonly advice: string,
		private readonly label: "Advice" | "Error",
		private readonly theme: Theme,
		private readonly isError: boolean,
	) {}

	/** Returns the first Pi-rendered visual lines plus a hidden-line summary when needed. */
	public render(width: number): string[] {
		const wrappedLines = this.renderAdviceVisualLines(width);
		const previewLines = wrappedLines.slice(0, COLLAPSED_ADVICE_PREVIEW_LINES);
		const hiddenLineCount = wrappedLines.length - previewLines.length;
		if (hiddenLineCount <= 0) {
			return previewLines;
		}

		previewLines.push(
			this.renderHiddenLineHint(hiddenLineCount, wrappedLines.length, width),
		);
		return previewLines;
	}

	/** Delegates wrapping and ANSI preservation to Pi Text rendering. */
	private renderAdviceVisualLines(width: number): string[] {
		const labelColor = this.isError ? "error" : "accent";
		const text = `${this.theme.fg(labelColor, `${this.label}:`)} ${this.theme.fg("dim", normalizePreviewText(this.advice))}`;
		return new Text(text, 0, 0).render(width);
	}

	/** Renders the standard collapsed-output summary with the active Pi expansion key. */
	private renderHiddenLineHint(
		hiddenLineCount: number,
		totalLineCount: number,
		width: number,
	): string {
		const hint =
			this.theme.fg(
				"muted",
				`... (${hiddenLineCount} more ${formatLineWord(hiddenLineCount)}, ${totalLineCount} total, `,
			) +
			this.theme.fg("dim", formatToolExpandKeybindingText()) +
			this.theme.fg("muted", " to expand)");
		return truncateToWidth(hint, width, "...");
	}

	/** Keeps the component compatible with the TUI invalidation contract. */
	public invalidate(): void {}
}

/** Selects a readable singular or plural word for hidden-line status. */
function formatLineWord(lineCount: number): string {
	return lineCount === 1 ? "line" : "lines";
}

/** Joins all text parts from a tool result for advisor rendering. */
function getResultText(result: AgentToolResult<unknown>): string | undefined {
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	return text.length > 0 ? text : undefined;
}
