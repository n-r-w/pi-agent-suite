import type { Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getKeybindings,
	Markdown,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	sliceTextByWidth,
	truncateTextByWidth,
} from "../../shared/display-width.ts";
import { renderLabeledWrappedText } from "../../shared/labeled-wrapped-text.ts";
import type {
	AcceptedPresentationEvidence,
	InvocationMetadata,
	SubagentFeedback,
} from "./domain.ts";

const PREVIEW_VISUAL_LINE_LIMIT = 3;
const EXPAND_TOOL_RESULT_KEYBINDING = "app.tools.expand";
const SECOND_MS = 1_000;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 3_600;
const TOKEN_THOUSAND = 1_000;
const CONTEXT_WARNING_RATIO = 0.5;
const CONTEXT_ERROR_RATIO = 0.8;

export interface SemanticHeaderPart {
	readonly value: string | undefined;
	readonly role: "agent" | "metadata" | "primary";
	readonly separator?: " " | " · ";
}

interface ContextHeaderOptions {
	readonly toolName: string;
	readonly parts: readonly SemanticHeaderPart[];
	readonly metadata: InvocationMetadata;
	readonly width: number;
}

interface AppendContextOptions {
	readonly width: number;
	readonly theme: Theme;
	readonly normalColor: "muted" | "toolTitle";
}

interface FormattedTextOptions {
	readonly label: string;
	readonly sectionName: string;
	readonly text: string;
	readonly width: number;
	readonly theme: Theme;
	readonly expanded: boolean;
}

export interface BoundedTextOptions {
	readonly label: string;
	readonly text: string;
	readonly width: number;
	readonly theme: Theme;
	readonly expanded: boolean;
	readonly color: "muted" | "error";
}

/** Defers width-sensitive semantic layout until Pi supplies the shell child width. */
export class SemanticComponent implements Component {
	public constructor(
		private readonly renderLines: (width: number) => readonly string[],
	) {}

	/** Renders immutable semantic rows within the current public Pi width. */
	public render(width: number): string[] {
		return [...this.renderLines(Math.max(0, Math.floor(width)))];
	}

	/** Keeps the immutable component compatible with Pi's invalidation contract. */
	public invalidate(): void {}
}

/** Renders output as formatted Markdown and errors as plain wrapped text. */
export function renderFeedbackBody(
	feedback: SubagentFeedback,
	width: number,
	theme: Theme,
	expanded: boolean,
): readonly string[] {
	return feedback.status === "success"
		? renderFormattedText({
				label: "Output:",
				sectionName: "Output",
				text: feedback.output,
				width,
				theme,
				expanded,
			})
		: renderBoundedText({
				label: "Error:",
				text: feedback.error,
				width,
				theme,
				expanded,
				color: "error",
			});
}

/** Renders a compact prompt preview or the complete expanded prompt section. */
export function renderPrompt(
	prompt: string,
	width: number,
	theme: Theme,
	expanded: boolean,
): readonly string[] {
	return renderFormattedText({
		label: "Prompt:",
		sectionName: "Prompt",
		text: prompt,
		width,
		theme,
		expanded,
	});
}

/** Selects bounded plain preview text or a complete Markdown section. */
function renderFormattedText(options: FormattedTextOptions): readonly string[] {
	if (!options.expanded) {
		return renderBoundedText({
			label: options.label,
			text: options.text,
			width: options.width,
			theme: options.theme,
			expanded: false,
			color: "muted",
		});
	}
	return [
		options.theme.fg("muted", `--- ${options.sectionName} ---`),
		...new Markdown(options.text, 0, 0, getMarkdownTheme()).render(
			options.width,
		),
	];
}

/** Renders Name as one clipped row or complete wrapped rows. */
export function renderName(
	name: string,
	width: number,
	theme: Theme,
	expanded: boolean,
): readonly string[] {
	const normalized = normalizePreview(name);
	if (expanded) {
		return renderLabeledWrappedText({
			label: "Name:",
			text: normalized,
			width,
			labelStyle: (value) => theme.fg("toolTitle", theme.bold(value)),
			textStyle: (value) => theme.fg("muted", value),
		});
	}
	const label = "Name:";
	const available = Math.max(0, width - label.length - 1);
	const value = truncateTextByWidth(normalized, available, "…");
	return [
		`${theme.fg("toolTitle", theme.bold(label))}${value.length === 0 ? "" : theme.fg("muted", ` ${value}`)}`,
	];
}

/** Renders normalized text within the V1 visual-line budget and standard hint. */
export function renderBoundedText(
	options: BoundedTextOptions,
): readonly string[] {
	const normalized = normalizePreview(options.text);
	const lines = renderLabeledWrappedText({
		label: options.label,
		text: normalized,
		width: options.width,
		labelStyle: (value) =>
			options.theme.fg("toolTitle", options.theme.bold(value)),
		textStyle: (value) => options.theme.fg(options.color, value),
	});
	if (options.expanded) {
		return lines;
	}
	if (lines.length <= PREVIEW_VISUAL_LINE_LIMIT) {
		return lines;
	}
	const hiddenLineCount = lines.length - PREVIEW_VISUAL_LINE_LIMIT;
	return [
		...lines.slice(0, PREVIEW_VISUAL_LINE_LIMIT),
		renderExpandHint(
			hiddenLineCount,
			lines.length,
			options.width,
			options.theme,
		),
	];
}

/** Renders a complete structured error without exposing its code. */
export function renderError(
	text: string,
	expanded: boolean,
	theme: Theme,
): Component {
	return new SemanticComponent((width) =>
		renderBoundedText({
			label: "Error:",
			text,
			width,
			theme,
			expanded,
			color: "error",
		}),
	);
}

/** Renders the configured standard hidden-line hint within one shell row. */
function renderExpandHint(
	hiddenLineCount: number,
	totalLineCount: number,
	width: number,
	theme: Theme,
): string {
	const key = getKeybindings().getKeys(EXPAND_TOOL_RESULT_KEYBINDING).join("/");
	const lineWord = hiddenLineCount === 1 ? "line" : "lines";
	const hint = `... (${hiddenLineCount} more ${lineWord}, ${totalLineCount} total, ${key} to expand)`;
	return theme.fg("muted", truncateTextByWidth(hint, width, "…"));
}

/** Renders one metadata row for wait feedback. */
export function renderMetadata(
	presentation: SubagentFeedback["presentation"],
	width: number,
	theme: Theme,
): string {
	const metadata = presentation.invocationMetadata;
	const prefix = renderSemanticSequence(
		[
			{ value: presentation.agentId, role: "agent" },
			{ value: formatMetadataRuntime(metadata), role: "metadata" },
		],
		width,
		theme,
		"",
	);
	return appendContext(prefix, metadata, {
		width,
		theme,
		normalColor: "muted",
	});
}

/** Formats model and thinking when each accepted value is available. */
export function formatRuntime(
	evidence: AcceptedPresentationEvidence,
): string | undefined {
	if (evidence.modelId === undefined) {
		return undefined;
	}
	return evidence.thinking === undefined
		? evidence.modelId
		: `${evidence.modelId}/${evidence.thinking}`;
}

/** Renders a direct-feedback header without nesting context colors. */
export function renderContextHeader(
	options: ContextHeaderOptions,
	theme: Theme,
): string {
	const prefix = renderHeader(
		options.toolName,
		options.parts,
		options.width,
		theme,
	);
	return appendContext(prefix, options.metadata, {
		width: options.width,
		theme,
		normalColor: "muted",
	});
}

/** Formats finalized model and thinking from terminal metadata. */
export function formatMetadataRuntime(
	metadata: InvocationMetadata,
): string | undefined {
	if (metadata.modelId === undefined) {
		return undefined;
	}
	return metadata.thinking === undefined
		? metadata.modelId
		: `${metadata.modelId}/${metadata.thinking}`;
}

/** Colors projection savings and current usage with the shared V1 thresholds. */
export function renderContext(
	metadata: Pick<
		InvocationMetadata,
		"contextTokens" | "contextWindow" | "projectionSavedTokens"
	>,
	theme: Theme,
	options: {
		readonly normalColor?: "muted" | "toolTitle";
		readonly maxWidth?: number;
	} = {},
): string | undefined {
	if (
		metadata.contextTokens === undefined ||
		metadata.contextWindow === undefined
	) {
		return undefined;
	}
	const usage = `${formatTokenCount(metadata.contextTokens)}/${formatTokenCount(metadata.contextWindow)}`;
	const ratio =
		metadata.contextWindow <= 0
			? 0
			: metadata.contextTokens / metadata.contextWindow;
	let usageColor: "error" | "warning" | typeof options.normalColor =
		options.normalColor;
	if (ratio >= CONTEXT_ERROR_RATIO) {
		usageColor = "error";
	} else if (ratio >= CONTEXT_WARNING_RATIO) {
		usageColor = "warning";
	}
	const maxWidth = Math.max(0, options.maxWidth ?? Number.POSITIVE_INFINITY);
	if (metadata.projectionSavedTokens === undefined) {
		const clippedUsage = sliceTextByWidth(usage, maxWidth);
		return usageColor === undefined
			? clippedUsage
			: theme.fg(usageColor, clippedUsage);
	}
	const saved = sliceTextByWidth(
		`~${formatTokenCount(metadata.projectionSavedTokens)}/`,
		maxWidth,
	);
	const clippedUsage = sliceTextByWidth(
		usage,
		Math.max(0, maxWidth - visibleWidth(saved)),
	);
	const styledUsage =
		usageColor === undefined
			? clippedUsage
			: theme.fg(usageColor, clippedUsage);
	return `${theme.fg("warning", saved)}${styledUsage}`;
}

/** Formats one token count as the rounded V1 compact k-unit. */
function formatTokenCount(tokens: number): string {
	if (tokens < TOKEN_THOUSAND) {
		return String(tokens);
	}
	const thousands = tokens / TOKEN_THOUSAND;
	return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`;
}

/** Formats elapsed time as seconds, minute-seconds, or hour-minutes. */
export function formatDuration(milliseconds: number): string {
	const totalSeconds = Math.floor(Math.max(0, milliseconds) / SECOND_MS);
	if (totalSeconds >= HOUR_SECONDS) {
		const hours = Math.floor(totalSeconds / HOUR_SECONDS);
		const minutes = Math.floor((totalSeconds % HOUR_SECONDS) / MINUTE_SECONDS);
		return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
	}
	if (totalSeconds >= MINUTE_SECONDS) {
		const minutes = Math.floor(totalSeconds / MINUTE_SECONDS);
		const seconds = totalSeconds % MINUTE_SECONDS;
		return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
	}
	return `${totalSeconds}s`;
}

/** Joins tool identity with its first argument by space and later metadata by separators. */
export function joinToolParts(
	toolName: string,
	parts: readonly (string | undefined)[],
): string {
	const present = parts.filter((part): part is string => part !== undefined);
	const [first, ...rest] = present;
	return first === undefined
		? toolName
		: `${toolName} ${first}${rest.map((part) => ` · ${part}`).join("")}`;
}

/** Joins present semantic metadata parts with the approved separator. */
export function joinParts(parts: readonly (string | undefined)[]): string {
	return parts.filter((part): part is string => part !== undefined).join(" · ");
}

/** Formats ordered session IDs without spaces after commas. */
export function formatIds(ids: readonly number[]): string | undefined {
	return ids.length === 0 ? undefined : `#${ids.join(",")}`;
}

/** Renders one tool header from role-colored, width-bounded fields. */
export function renderHeader(
	toolName: string,
	parts: readonly SemanticHeaderPart[],
	width: number,
	theme: Theme,
): string {
	const clippedTool = sliceTextByWidth(toolName, width);
	const styledTool = theme.fg("toolTitle", theme.bold(clippedTool));
	const remaining = Math.max(0, width - visibleWidth(clippedTool));
	return `${styledTool}${renderSemanticSequence(parts, remaining, theme, " ")}`;
}

/** Appends threshold-colored context after an already styled semantic prefix. */
function appendContext(
	prefix: string,
	metadata: InvocationMetadata,
	options: AppendContextOptions,
): string {
	const remaining = Math.max(0, options.width - visibleWidth(prefix));
	const hasContext =
		metadata.contextTokens !== undefined &&
		metadata.contextWindow !== undefined;
	if (!hasContext || remaining === 0) {
		return prefix;
	}
	const separator = sliceTextByWidth(" · ", remaining);
	const context = renderContext(metadata, options.theme, {
		normalColor: options.normalColor,
		maxWidth: Math.max(0, remaining - visibleWidth(separator)),
	});
	return `${prefix}${options.theme.fg("muted", separator)}${context ?? ""}`;
}

/** Renders semantic fields and muted separators without slicing styled text. */
function renderSemanticSequence(
	parts: readonly SemanticHeaderPart[],
	width: number,
	theme: Theme,
	firstSeparator: string,
): string {
	let remaining = Math.max(0, width);
	let rendered = "";
	let presentIndex = 0;
	for (const part of parts) {
		if (part.value === undefined || remaining === 0) {
			continue;
		}
		const separator =
			part.separator ?? (presentIndex === 0 ? firstSeparator : " · ");
		const clippedSeparator = sliceTextByWidth(separator, remaining);
		if (clippedSeparator.length > 0) {
			rendered += theme.fg("muted", clippedSeparator);
		}
		remaining -= visibleWidth(clippedSeparator);
		const clippedValue = sliceTextByWidth(part.value, remaining);
		rendered += renderSemanticValue(clippedValue, part.role, theme);
		remaining -= visibleWidth(clippedValue);
		presentIndex += 1;
	}
	return rendered;
}

/** Applies the approved foreground for one semantic field. */
function renderSemanticValue(
	value: string,
	role: SemanticHeaderPart["role"],
	theme: Theme,
): string {
	if (role === "agent") {
		return theme.fg("accent", value);
	}
	if (role === "metadata") {
		return theme.fg("muted", value);
	}
	return value;
}

/** Normalizes collapsed arbitrary text with the historical V1 whitespace rule. */
function normalizePreview(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}
