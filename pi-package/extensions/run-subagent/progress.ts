/**
 * Subagent progress helpers.
 *
 * The child `pi --mode json` stream is noisy. This module keeps only logical
 * progress events so the parent TUI shows stable rows instead of raw token
 * deltas.
 */

/** Keeps recent child-run events while bounding session history growth. */
export const MAX_SUBAGENT_PROGRESS_EVENTS = 40;

/** Keeps each stored event preview bounded before terminal-width rendering. */
const MAX_SUBAGENT_PROGRESS_TEXT_LENGTH = 240;

/** Full percentage value used for context-window usage calculations. */
const FULL_PERCENT = 100;

/** Token count where compact formatting switches from raw units to thousands. */
const TOKEN_THOUSAND = 1000;

/** Fraction digits used for non-integer compact token counts. */
const TOKEN_FRACTION_DIGITS = 1;

/** Defines the lifecycle states shown for one child agent process. */
export type SubagentRunStatus = "running" | "succeeded" | "failed" | "aborted";

/** Identifies event kinds shown in the compact and expanded tool views. */
export type SubagentProgressEventKind =
	| "assistant"
	| "tool_call"
	| "tool_result"
	| "error";

/** Describes the runtime selected for one child process. */
export interface SubagentRuntimeDetails {
	readonly modelId: string;
	readonly thinking: string;
	readonly contextWindow: number;
}

/** Stores the latest known context usage for one child process. */
export interface SubagentContextUsage {
	readonly tokens: number | null;
	readonly contextWindow: number;
	readonly percent: number | null;
}

/** Stores one visible child-run event extracted from JSON-mode output. */
export interface SubagentProgressEvent {
	readonly kind: SubagentProgressEventKind;
	readonly title: string;
	readonly text: string | undefined;
	readonly timestampMs: number;
}

/** Stores mutable progress while a child process is still producing events. */
export interface SubagentProgressState {
	readonly runId: string;
	readonly agentId: string;
	readonly depth: number;
	readonly runtime: SubagentRuntimeDetails | undefined;
	contextUsage: SubagentContextUsage | undefined;
	readonly startedAtMs: number;
	finalOutput: string;
	stderr: string;
	stopReason: string | undefined;
	errorMessage: string | undefined;
	readonly events: SubagentProgressEvent[];
	omittedEventCount: number;
	readonly children: SubagentRunDetails[];
}

/** Stores serializable progress details used by partial and final tool rendering. */
export interface SubagentRunDetails {
	readonly runId: string;
	readonly agentId: string;
	readonly depth: number;
	readonly runtime: SubagentRuntimeDetails | undefined;
	readonly contextUsage: SubagentContextUsage | undefined;
	readonly status: SubagentRunStatus;
	readonly elapsedMs: number;
	readonly exitCode: number | undefined;
	readonly finalOutput: string;
	readonly stderr: string;
	readonly stopReason: string | undefined;
	readonly errorMessage: string | undefined;
	readonly events: readonly SubagentProgressEvent[];
	readonly omittedEventCount: number;
	readonly children: readonly SubagentRunDetails[];
}

interface CreateSubagentProgressStateOptions {
	readonly agentId: string;
	readonly depth: number;
	readonly startedAtMs: number;
	readonly runtime?: SubagentRuntimeDetails;
	readonly runId?: string;
}

/** Creates mutable progress state for one child run. */
export function createSubagentProgressState(
	options: CreateSubagentProgressStateOptions,
): SubagentProgressState {
	const runId =
		options.runId ??
		`${options.agentId}:${options.depth}:${options.startedAtMs}`;
	return {
		runId,
		agentId: options.agentId,
		depth: options.depth,
		runtime: options.runtime,
		contextUsage: options.runtime
			? {
					tokens: null,
					contextWindow: options.runtime.contextWindow,
					percent: null,
				}
			: undefined,
		startedAtMs: options.startedAtMs,
		finalOutput: "",
		stderr: "",
		stopReason: undefined,
		errorMessage: undefined,
		events: [],
		omittedEventCount: 0,
		children: [],
	};
}

/** Converts mutable progress into the stable details shape used by TUI rendering. */
export function toSubagentRunDetails(
	state: SubagentProgressState,
	status: SubagentRunStatus,
	nowMs: number,
	exitCode?: number,
): SubagentRunDetails {
	return {
		runId: state.runId,
		agentId: state.agentId,
		depth: state.depth,
		runtime: state.runtime,
		contextUsage: state.contextUsage ? { ...state.contextUsage } : undefined,
		status,
		elapsedMs: Math.max(0, nowMs - state.startedAtMs),
		exitCode,
		finalOutput: state.finalOutput,
		stderr: state.stderr,
		stopReason: state.stopReason,
		errorMessage: state.errorMessage,
		events: state.events.map((event) => ({ ...event })),
		omittedEventCount: state.omittedEventCount,
		children: state.children.map(cloneSubagentRunDetails),
	};
}

/** Converts final child process state into details with an exit code. */
export function finalizeSubagentProgressState(
	state: SubagentProgressState,
	status: SubagentRunStatus,
	nowMs: number,
	exitCode: number,
): SubagentRunDetails {
	return toSubagentRunDetails(state, status, nowMs, exitCode);
}

/** Formats context usage as compact filled-window text. */
export function formatSubagentContextUsage(
	contextUsage: SubagentContextUsage | undefined,
): string | undefined {
	if (contextUsage === undefined) {
		return undefined;
	}

	const tokensText =
		contextUsage.tokens === null ? "?" : formatTokenCount(contextUsage.tokens);
	return `${tokensText}/${formatTokenCount(contextUsage.contextWindow)}`;
}

/** Records one parsed JSON-mode event when it carries logical child progress. */
export function recordSubagentJsonEvent(
	state: SubagentProgressState,
	event: unknown,
	timestampMs: number,
): boolean {
	if (!isPlainRecord(event)) {
		return false;
	}

	const eventType = getStringField(event, "type");
	if (eventType === "tool_execution_start") {
		recordToolExecutionStart(state, event, timestampMs);
		return true;
	}
	if (eventType === "tool_execution_end") {
		recordNestedSubagentEnd(state, event, timestampMs);
		recordToolExecutionEnd(state, event, timestampMs);
		return true;
	}
	if (eventType === "tool_execution_update") {
		return recordNestedSubagentUpdate(state, event);
	}
	if (eventType !== "message_end") {
		return false;
	}

	const message = getRecordField(event, "message");
	if (
		message === undefined ||
		getStringField(message, "role") !== "assistant"
	) {
		return false;
	}

	let changed = false;
	const assistantText = getFullMessageText(message);
	if (assistantText !== undefined) {
		state.finalOutput = assistantText;
		appendProgressEvent(state, {
			kind: "assistant",
			title: "assistant",
			text: assistantText,
			timestampMs,
		});
		changed = true;
	}

	const stopReason = getStringField(message, "stopReason");
	if (stopReason !== undefined) {
		state.stopReason = stopReason;
		changed = true;
	}

	const errorMessage = getStringField(message, "errorMessage");
	if (errorMessage !== undefined) {
		state.errorMessage = errorMessage;
		appendProgressEvent(state, {
			kind: "error",
			title: "assistant",
			text: errorMessage,
			timestampMs,
		});
		changed = true;
	}

	const contextUsage = getMessageContextUsage(
		message,
		state.runtime?.contextWindow,
	);
	if (contextUsage !== undefined) {
		state.contextUsage = contextUsage;
		changed = true;
	}

	return changed;
}

/** Appends stderr so failed child runs can show the failure reason. */
export function appendSubagentStderr(
	state: SubagentProgressState,
	data: string,
): void {
	state.stderr += data;
}

/** Records one child tool start as a stable progress event. */
function recordToolExecutionStart(
	state: SubagentProgressState,
	event: Record<string, unknown>,
	timestampMs: number,
): void {
	const payload = event as {
		readonly args?: unknown;
		readonly input?: unknown;
	};
	appendProgressEvent(state, {
		kind: "tool_call",
		title: getStringField(event, "toolName") ?? "tool",
		text: formatEventPayload(payload.args ?? payload.input),
		timestampMs,
	});
}

/** Records one child tool completion as a stable progress event. */
function recordToolExecutionEnd(
	state: SubagentProgressState,
	event: Record<string, unknown>,
	timestampMs: number,
): void {
	const { isError } = event as { readonly isError?: unknown };
	appendProgressEvent(state, {
		kind: isError === true ? "error" : "tool_result",
		title: getStringField(event, "toolName") ?? "tool",
		text: getToolExecutionResultText(event),
		timestampMs,
	});
}

/** Records nested run progress when a child itself calls run_subagent. */
function recordNestedSubagentUpdate(
	state: SubagentProgressState,
	event: Record<string, unknown>,
): boolean {
	if (getStringField(event, "toolName") !== "run_subagent") {
		return false;
	}

	const details = getNestedSubagentDetails(
		getRecordField(event, "partialResult"),
	);
	if (details === undefined) {
		return false;
	}

	upsertChildRunDetails(state, details);
	return true;
}

/** Records nested run completion from final child tool details. */
function recordNestedSubagentEnd(
	state: SubagentProgressState,
	event: Record<string, unknown>,
	timestampMs: number,
): boolean {
	if (getStringField(event, "toolName") !== "run_subagent") {
		return false;
	}

	const details = getNestedSubagentDetails(getRecordField(event, "result"));
	if (details !== undefined) {
		upsertChildRunDetails(state, details);
		return true;
	}

	const resultText = getToolExecutionResultText(event);
	if (resultText === undefined) {
		return false;
	}

	appendProgressEvent(state, {
		kind:
			(event as { readonly isError?: unknown }).isError === true
				? "error"
				: "tool_result",
		title: "run_subagent",
		text: resultText,
		timestampMs,
	});
	return true;
}

/** Replaces one nested run while keeping sibling ordering stable. */
function upsertChildRunDetails(
	state: SubagentProgressState,
	details: SubagentRunDetails,
): void {
	const existingIndex = state.children.findIndex(
		(child) => child.runId === details.runId,
	);
	const clonedDetails = cloneSubagentRunDetails(details);
	if (existingIndex >= 0) {
		state.children[existingIndex] = clonedDetails;
		return;
	}

	state.children.push(clonedDetails);
}

/** Extracts nested run details from the child tool result shape. */
function getNestedSubagentDetails(
	result: Record<string, unknown> | undefined,
): SubagentRunDetails | undefined {
	const details = (result as { readonly details?: unknown } | undefined)
		?.details;
	return isSubagentRunDetails(details)
		? cloneSubagentRunDetails(details)
		: undefined;
}

/** Keeps progress memory bounded while preserving recent child events. */
function appendProgressEvent(
	state: SubagentProgressState,
	event: SubagentProgressEvent,
): void {
	if (state.events.length >= MAX_SUBAGENT_PROGRESS_EVENTS) {
		state.events.shift();
		state.omittedEventCount += 1;
	}

	state.events.push({ ...event, text: normalizeEventText(event.text) });
}

/** Copies run details so widget state cannot mutate stored tool details. */
function cloneSubagentRunDetails(
	details: SubagentRunDetails,
): SubagentRunDetails {
	return {
		...details,
		contextUsage: details.contextUsage
			? { ...details.contextUsage }
			: undefined,
		events: details.events.map((event) => ({ ...event })),
		children: details.children.map(cloneSubagentRunDetails),
	};
}

/** Validates nested run details before using child process JSON events. */
function isSubagentRunDetails(value: unknown): value is SubagentRunDetails {
	if (!isPlainRecord(value)) {
		return false;
	}

	const details = value as {
		readonly runId?: unknown;
		readonly agentId?: unknown;
		readonly depth?: unknown;
		readonly status?: unknown;
		readonly elapsedMs?: unknown;
		readonly events?: unknown;
		readonly children?: unknown;
	};
	return (
		typeof details.runId === "string" &&
		typeof details.agentId === "string" &&
		typeof details.depth === "number" &&
		isSubagentRunStatus(details.status) &&
		typeof details.elapsedMs === "number" &&
		Array.isArray(details.events) &&
		Array.isArray(details.children)
	);
}

/** Validates known lifecycle values for nested subagent details. */
function isSubagentRunStatus(value: unknown): value is SubagentRunStatus {
	return (
		value === "running" ||
		value === "succeeded" ||
		value === "failed" ||
		value === "aborted"
	);
}

/** Extracts visible text from a completed child tool execution event. */
function getToolExecutionResultText(
	event: Record<string, unknown>,
): string | undefined {
	const result = getRecordField(event, "result");
	return (
		getMessageText(result) ??
		getStringField(event, "error") ??
		getStringField(event, "errorMessage")
	);
}

/** Extracts message text used for bounded progress display. */
function getMessageText(message: unknown): string | undefined {
	return normalizeEventText(getFullMessageText(message));
}

/** Extracts text content without truncating the final child answer. */
function getFullMessageText(message: unknown): string | undefined {
	if (!isPlainRecord(message)) {
		return undefined;
	}

	const { content } = message;
	if (typeof content === "string") {
		return normalizeNonEmptyText(content);
	}
	if (!Array.isArray(content)) {
		return undefined;
	}

	const textParts = content.flatMap(extractContentPartText);
	return textParts.length > 0 ? textParts.join("\n") : undefined;
}

/** Extracts non-empty text from one message content part. */
function extractContentPartText(part: unknown): readonly string[] {
	if (typeof part === "string") {
		const text = normalizeNonEmptyText(part);
		return text === undefined ? [] : [text];
	}
	if (!isPlainRecord(part)) {
		return [];
	}

	const textPart = part as {
		readonly type?: unknown;
		readonly text?: unknown;
	};
	if (textPart.type !== "text" || typeof textPart.text !== "string") {
		return [];
	}

	const text = normalizeNonEmptyText(textPart.text);
	return text === undefined ? [] : [text];
}

/** Trims text and converts empty strings into absent values. */
function normalizeNonEmptyText(text: string): string | undefined {
	const normalizedText = text.trim();
	return normalizedText.length > 0 ? normalizedText : undefined;
}

/** Extracts context usage from assistant usage metadata emitted by child JSON mode. */
function getMessageContextUsage(
	message: Record<string, unknown>,
	contextWindow: number | undefined,
): SubagentContextUsage | undefined {
	if (contextWindow === undefined) {
		return undefined;
	}

	const usage = getRecordField(message, "usage");
	const totalTokens = (usage as { readonly totalTokens?: unknown } | undefined)
		?.totalTokens;
	if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens)) {
		return undefined;
	}

	return {
		tokens: Math.max(0, totalTokens),
		contextWindow,
		percent:
			contextWindow > 0
				? (Math.max(0, totalTokens) / contextWindow) * FULL_PERCENT
				: null,
	};
}

/** Converts structured tool arguments into compact text for display. */
function formatEventPayload(payload: unknown): string | undefined {
	if (payload === undefined) {
		return undefined;
	}
	if (typeof payload === "string") {
		return normalizeEventText(payload);
	}

	try {
		return normalizeEventText(JSON.stringify(payload));
	} catch {
		return normalizeEventText(String(payload));
	}
}

/** Normalizes whitespace and limits event text stored in session details. */
function normalizeEventText(text: string | undefined): string | undefined {
	const normalizedText = text?.replace(/\s+/g, " ").trim();
	if (!normalizedText) {
		return undefined;
	}
	if (normalizedText.length <= MAX_SUBAGENT_PROGRESS_TEXT_LENGTH) {
		return normalizedText;
	}

	return `${normalizedText.slice(0, MAX_SUBAGENT_PROGRESS_TEXT_LENGTH)}…`;
}

/** Formats token counts for compact terminal rows. */
function formatTokenCount(tokens: number): string {
	if (tokens < TOKEN_THOUSAND) {
		return String(Math.round(tokens));
	}

	const thousands = tokens / TOKEN_THOUSAND;
	return Number.isInteger(thousands)
		? `${thousands}k`
		: `${thousands.toFixed(TOKEN_FRACTION_DIGITS)}k`;
}

/** Reads one object field when the source is a plain record. */
function getRecordField(
	value: unknown,
	key: string,
): Record<string, unknown> | undefined {
	if (!isPlainRecord(value)) {
		return undefined;
	}

	const field = value[key];
	return isPlainRecord(field) ? field : undefined;
}

/** Reads one string field when the source is a plain record. */
function getStringField(value: unknown, key: string): string | undefined {
	if (!isPlainRecord(value)) {
		return undefined;
	}

	const field = value[key];
	return typeof field === "string" ? field : undefined;
}

/** Checks that a value can be safely accessed as an object record. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
