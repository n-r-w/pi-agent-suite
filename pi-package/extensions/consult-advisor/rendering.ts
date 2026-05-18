/** Width-aware rendering for the consult_advisor tool. */

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
const CALL_QUESTION_PREVIEW_LINES = 3;
export const COLLAPSED_ADVICE_PREVIEW_LINES = 5;

/** Renders the question preview as wrapped rows in the tool-call header. */
class AdvisorQuestionHeader implements Component {
	public constructor(
		private readonly questionPreview: string,
		private readonly theme: Theme,
		private readonly expanded: boolean,
	) {}

	/** Returns width-bounded rows and counts wrapped rows against the call preview budget. */
	public render(width: number): string[] {
		const wrappedLines = renderLabeledWrappedText({
			label: "consult_advisor:",
			text: this.questionPreview,
			width,
			labelStyle: (value) => this.theme.fg("toolTitle", this.theme.bold(value)),
			textStyle: (value) => this.theme.fg("dim", value),
		});
		if (this.expanded) {
			return wrappedLines;
		}

		const previewLines = wrappedLines.slice(0, CALL_QUESTION_PREVIEW_LINES);
		const hiddenLineCount = wrappedLines.length - previewLines.length;
		if (hiddenLineCount <= 0) {
			return previewLines;
		}

		previewLines.push(
			this.renderHiddenLineHint(hiddenLineCount, wrappedLines.length, width),
		);
		return previewLines;
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

/** Renders the visible header for a consult_advisor tool call. */
export function renderConsultAdvisorCall(
	args: { readonly question?: string },
	theme: Theme,
	context?: { readonly expanded?: boolean },
): Component {
	const questionPreview = args.question
		? normalizePreviewText(args.question)
		: "...";
	return new AdvisorQuestionHeader(
		questionPreview,
		theme,
		context?.expanded === true,
	);
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
