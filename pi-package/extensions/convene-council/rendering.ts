/** Width-aware rendering for the convene_council tool. */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
	getMarkdownTheme,
	type Theme,
	type ThemeColor,
} from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Container,
	getKeybindings,
	Markdown,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import {
	sliceTextByWidth,
	truncateTextByWidth,
} from "../../shared/display-width";
import {
	type CouncilProgressEvent,
	type CouncilRunDetails,
	formatCouncilElapsedMs,
	isCouncilRunDetails,
} from "./progress";

const EXPAND_TOOL_RESULT_KEYBINDING = "app.tools.expand";
const PARTICIPANT_TITLE_PATTERN = /^(A|B)(?:\s+(.*))?$/;
const COLLAPSED_COUNCIL_PREVIEW_LINES = 5;
const COLLAPSED_COUNCIL_PROGRESS_LINES = 5;
const EXPANDED_EVENT_PREVIEW_WIDTH = 240;

/** Stores progress metadata that belongs in the tool-call header. */
interface CouncilRenderState {
	headerDetails?: CouncilRunDetails;
	headerFingerprint?: string;
}

/** Describes the subset of Pi renderer context used by council rendering. */
interface CouncilRenderContext {
	readonly args?: { readonly question?: string };
	readonly state?: CouncilRenderState;
	readonly invalidate?: () => void;
	readonly isError?: boolean;
}

/** One renderable piece of a fixed-width line before color is applied. */
interface FixedLinePart {
	readonly text: string;
	readonly color?: ThemeColor;
	readonly bold?: boolean;
	readonly truncate?: boolean;
}

/** Renders the compact question preview as one tool-call header row. */
class CouncilQuestionHeader implements Component {
	public constructor(
		private readonly questionPreview: string,
		private readonly theme: Theme,
	) {}

	/** Returns one width-bounded row because tool-call arguments must not consume collapsed output space. */
	public render(width: number): string[] {
		const title = "convene_council:";
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

/** Renders the visible header for a convene_council tool call. */
export function renderConveneCouncilCall(
	args: { readonly question?: string },
	theme: Theme,
	context: CouncilRenderContext = {},
): Component {
	const questionPreview = args.question
		? normalizePreviewText(args.question)
		: "...";
	const details = context.state?.headerDetails;
	if (details === undefined) {
		return new CouncilQuestionHeader(questionPreview, theme);
	}

	return new FixedLines(
		[
			formatCouncilHeaderLine(details),
			[
				{ text: "  Question: ", color: "muted" },
				{ text: questionPreview, color: "dim", truncate: true },
			],
			formatParticipantRuntimeLine(details),
		],
		theme,
	);
}

/** Renders council output as live progress when details are partial and final answer otherwise. */
export function renderConveneCouncilResult(
	result: AgentToolResult<unknown>,
	options: { readonly expanded?: boolean },
	theme: Theme,
	context: CouncilRenderContext,
): Component {
	const details = isCouncilRunDetails(result.details)
		? result.details
		: undefined;
	if (details !== undefined) {
		updateCouncilHeaderDetails(details, context);
		return options.expanded === true
			? renderExpandedCouncilProgress(details, theme)
			: renderCollapsedCouncilProgress(details, theme);
	}

	const answer = getResultText(result) || "(no answer)";
	const label = context.isError === true ? "Error" : "Council";
	if (options.expanded !== true) {
		return new CollapsedCouncilAnswer(
			answer,
			label,
			theme,
			context.isError === true,
		);
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
	container.addChild(new Markdown(answer, 0, 0, getMarkdownTheme()));
	return container;
}

/** Stores the latest progress details for the next call-header render. */
function updateCouncilHeaderDetails(
	details: CouncilRunDetails,
	context: CouncilRenderContext,
): void {
	if (context.state === undefined) {
		return;
	}

	const headerFingerprint = formatCouncilHeaderFingerprint(details);
	if (context.state.headerFingerprint === headerFingerprint) {
		return;
	}

	context.state.headerDetails = details;
	context.state.headerFingerprint = headerFingerprint;
	if (context.invalidate !== undefined) {
		queueMicrotask(context.invalidate);
	}
}

/** Formats a stable value used to avoid redundant renderer invalidations. */
function formatCouncilHeaderFingerprint(details: CouncilRunDetails): string {
	return [
		details.status,
		details.phase,
		String(details.iteration),
		String(details.iterationLimit),
		String(details.elapsedMs),
		...details.participants.map((participant) => participant.display),
	].join("\u001F");
}

/** Formats the first tool-call row around the current council phase. */
function formatCouncilHeaderLine(details: CouncilRunDetails): FixedLinePart[] {
	return [
		{ text: "convene_council", color: "toolTitle", bold: true },
		{ text: " · " },
		{ text: details.phase, color: formatCouncilStatusColor(details.status) },
		{ text: " · " },
		{
			text: `iter ${details.iteration}/${details.iterationLimit}`,
			color: "muted",
		},
		{ text: " · " },
		{ text: formatCouncilElapsedMs(details.elapsedMs), color: "dim" },
	];
}

/** Selects a header phase color from the current council status. */
function formatCouncilStatusColor(
	status: CouncilRunDetails["status"],
): ThemeColor {
	if (status === "succeeded") {
		return "success";
	}
	if (status === "failed" || status === "aborted") {
		return "error";
	}
	return "accent";
}

/** Formats the participant runtime mapping as one compact header row. */
function formatParticipantRuntimeLine(
	details: CouncilRunDetails,
): FixedLinePart[] {
	const [first, second] = details.participants;
	if (
		first !== undefined &&
		second !== undefined &&
		first.display === second.display
	) {
		return [
			{ text: "  " },
			{ text: "A", color: formatParticipantLabelColor("A") },
			{ text: "/" },
			{ text: "B", color: formatParticipantLabelColor("B") },
			{ text: " " },
			{ text: first.display, color: "dim", truncate: true },
		];
	}

	const parts: FixedLinePart[] = [];
	for (const [index, participant] of details.participants.entries()) {
		if (index > 0) {
			parts.push({ text: " · ", color: "muted" });
		}
		parts.push(
			{ text: "  " },
			{
				text: participant.label,
				color: formatParticipantLabelColor(participant.label),
			},
			{ text: " " },
			{ text: participant.display, color: "dim", truncate: true },
		);
	}
	return parts;
}

/** Renders the default compact view for live council progress. */
function renderCollapsedCouncilProgress(
	details: CouncilRunDetails,
	theme: Theme,
): Component {
	const rows = details.events.map((event) =>
		formatCouncilEventLineParts(event),
	);
	const displayedRows = rows.slice(-COLLAPSED_COUNCIL_PROGRESS_LINES);
	const hiddenLineCount =
		details.omittedEventCount + Math.max(0, rows.length - displayedRows.length);
	const totalLineCount = hiddenLineCount + displayedRows.length;
	const lines = [...displayedRows];

	if (lines.length === 0) {
		lines.push([
			{
				text:
					details.status === "running"
						? "(starting...)"
						: "(no progress events)",
				color: "muted",
			},
		]);
	}
	if (hiddenLineCount > 0) {
		lines.push(formatCouncilExpandHintLine(hiddenLineCount, totalLineCount));
	}
	return new FixedLines(lines, theme);
}

/** Renders the expanded live progress view with question, participants, and all visible events. */
function renderExpandedCouncilProgress(
	details: CouncilRunDetails,
	theme: Theme,
): Component {
	const container = new Container();
	container.addChild(new Text(theme.fg("muted", "─── Question ───"), 0, 0));
	container.addChild(new Text(theme.fg("dim", details.question), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Participants ───"), 0, 0));
	for (const participant of details.participants) {
		container.addChild(
			new Text(
				`${theme.fg("accent", `${participant.label}:`)} ${theme.fg("dim", participant.display)}`,
				0,
				0,
			),
		);
	}
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Progress ───"), 0, 0));
	if (details.omittedEventCount > 0) {
		container.addChild(
			new Text(
				theme.fg(
					"muted",
					`... ${details.omittedEventCount} earlier events omitted`,
				),
				0,
				0,
			),
		);
	}
	if (details.events.length === 0) {
		container.addChild(new Text(theme.fg("muted", "(starting...)"), 0, 0));
	} else {
		for (const event of details.events) {
			container.addChild(
				new Text(
					renderFixedLine(
						formatCouncilEventLineParts(event, EXPANDED_EVENT_PREVIEW_WIDTH),
						Number.MAX_SAFE_INTEGER,
						theme,
					),
					0,
					0,
				),
			);
		}
	}
	return container;
}

/** Selects the neutral identity color for a participant label. */
function formatParticipantLabelColor(label: "A" | "B"): ThemeColor {
	return label === "A" ? "accent" : "toolOutput";
}

/** Formats one council progress event as plain parts for fixed-width rendering. */
function formatCouncilEventLineParts(
	event: CouncilProgressEvent,
	textLimit?: number,
): FixedLinePart[] {
	const parts: FixedLinePart[] = [
		{
			text: formatCouncilEventIconText(event.kind),
			color: formatCouncilEventIconColor(event.kind),
		},
		{ text: " " },
		...formatCouncilEventTitleParts(event),
	];
	if (event.text === undefined) {
		return parts;
	}
	parts.push(
		{ text: " " },
		{
			text: normalizePreviewText(event.text, textLimit),
			color: "dim",
			truncate: true,
		},
	);
	return parts;
}

/** Formats event title parts while keeping participant identity separate from status semantics. */
function formatCouncilEventTitleParts(
	event: CouncilProgressEvent,
): FixedLinePart[] {
	const match = PARTICIPANT_TITLE_PATTERN.exec(event.title);
	if (match === null) {
		return [{ text: event.title, color: formatCouncilEventTitleColor(event) }];
	}

	const label = match[1] as "A" | "B";
	const rest = match[2];
	const parts: FixedLinePart[] = [
		{ text: label, color: formatParticipantLabelColor(label) },
	];
	if (rest !== undefined && rest.length > 0) {
		parts.push({ text: " " }, ...formatCouncilEventRestParts(rest, event));
	}
	return parts;
}

/** Formats the non-label part of one participant event title. */
function formatCouncilEventRestParts(
	rest: string,
	event: CouncilProgressEvent,
): FixedLinePart[] {
	const [firstWord, ...remainingWords] = rest.split(" ");
	if (isParticipantStatusWord(firstWord)) {
		return [
			{ text: firstWord, color: formatParticipantStatusColor(firstWord) },
			...(remainingWords.length > 0
				? ([
						{ text: " " },
						{
							text: remainingWords.join(" "),
							color: formatCouncilEventTitleColor(event),
						},
					] satisfies FixedLinePart[])
				: []),
		];
	}
	return [{ text: rest, color: formatCouncilEventTitleColor(event) }];
}

/** Returns true for participant status tokens that deserve semantic coloring. */
function isParticipantStatusWord(
	value: string | undefined,
): value is "AGREE" | "DIFF" | "NEED_INFO" {
	return value === "AGREE" || value === "DIFF" || value === "NEED_INFO";
}

/** Selects the color for a participant status token. */
function formatParticipantStatusColor(
	status: "AGREE" | "DIFF" | "NEED_INFO",
): ThemeColor {
	return status === "AGREE" ? "success" : "warning";
}

/** Selects a title color that does not override participant identity. */
function formatCouncilEventTitleColor(event: CouncilProgressEvent): ThemeColor {
	if (event.kind === "retry") {
		return "warning";
	}
	if (event.kind === "error") {
		return "error";
	}
	if (event.kind === "success") {
		return "success";
	}
	return "accent";
}

/** Selects the uncolored icon text for a council event kind. */
function formatCouncilEventIconText(
	kind: CouncilProgressEvent["kind"],
): string {
	if (kind === "request") {
		return "→";
	}
	if (kind === "response") {
		return "←";
	}
	if (kind === "retry" || kind === "error") {
		return "!";
	}
	if (kind === "success") {
		return "✓";
	}
	return "•";
}

/** Selects the theme color for a council event icon. */
function formatCouncilEventIconColor(
	kind: CouncilProgressEvent["kind"],
): ThemeColor {
	if (kind === "request") {
		return "muted";
	}
	if (kind === "response" || kind === "success") {
		return "success";
	}
	if (kind === "retry") {
		return "warning";
	}
	if (kind === "error") {
		return "error";
	}
	return "toolOutput";
}

/** Formats the collapsed expansion hint with Pi's current keybinding. */
function formatCouncilExpandHintLine(
	hiddenLineCount: number,
	totalLineCount: number,
): FixedLinePart[] {
	return [
		{
			text: `... (${hiddenLineCount} more ${formatLineWord(hiddenLineCount)}, ${totalLineCount} total, `,
			color: "muted",
		},
		{ text: formatToolExpandKeybindingText(), color: "dim" },
		{ text: " to expand)", color: "muted" },
	];
}

/** Normalizes multi-line text into one preview line before width clipping. */
function normalizePreviewText(value: string, maxWidth?: number): string {
	const normalizedValue = value.replace(/\s+/g, " ").trim();
	return maxWidth === undefined
		? normalizedValue
		: truncateTextByWidth(normalizedValue, maxWidth, "…");
}

/** Formats the currently configured keys for expanding collapsed tool results. */
function formatToolExpandKeybindingText(): string {
	return getKeybindings().getKeys(EXPAND_TOOL_RESULT_KEYBINDING).join("/");
}

/** Renders collapsed council output and the standard expansion hint when content is hidden. */
class CollapsedCouncilAnswer implements Component {
	public constructor(
		private readonly answer: string,
		private readonly label: "Council" | "Error",
		private readonly theme: Theme,
		private readonly isError: boolean,
	) {}

	/** Returns the first Pi-rendered visual lines plus a hidden-line summary when needed. */
	public render(width: number): string[] {
		const wrappedLines = this.renderAnswerVisualLines(width);
		const previewLines = wrappedLines.slice(0, COLLAPSED_COUNCIL_PREVIEW_LINES);
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
	private renderAnswerVisualLines(width: number): string[] {
		const labelColor = this.isError ? "error" : "accent";
		const text = `${this.theme.fg(labelColor, `${this.label}:`)} ${this.theme.fg("dim", normalizePreviewText(this.answer))}`;
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

/** Renders fixed lines without wrapping into extra terminal rows. */
class FixedLines implements Component {
	public constructor(
		private readonly lines: readonly (readonly FixedLinePart[])[],
		private readonly theme: Theme,
	) {}

	/** Returns lines clipped by visible terminal columns before color is applied. */
	public render(width: number): string[] {
		return this.lines.map((line) => renderFixedLine(line, width, this.theme));
	}

	/** Keeps the component compatible with the TUI invalidation contract. */
	public invalidate(): void {}
}

/** Renders one line by clipping raw text first, then applying theme colors. */
function renderFixedLine(
	parts: readonly FixedLinePart[],
	width: number,
	theme: Theme,
): string {
	let remainingWidth = width;
	let renderedLine = "";
	for (const part of parts) {
		if (remainingWidth <= 0) {
			break;
		}

		const partText =
			part.truncate === true
				? truncateTextByWidth(part.text, remainingWidth, "…")
				: sliceTextByWidth(part.text, remainingWidth);
		if (partText.length === 0) {
			continue;
		}

		const styledText =
			part.color !== undefined
				? theme.fg(
						part.color,
						part.bold === true ? theme.bold(partText) : partText,
					)
				: partText;
		renderedLine += styledText;
		remainingWidth -= visibleWidth(partText);
	}
	return renderedLine;
}

/** Joins all text parts from a tool result for council rendering. */
function getResultText(result: AgentToolResult<unknown>): string | undefined {
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	return text.length > 0 ? text : undefined;
}
