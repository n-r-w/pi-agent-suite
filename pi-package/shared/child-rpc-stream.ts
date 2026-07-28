import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";

/** CommonJS loader used for the stream-json parser package exported as CommonJS. */
const requireStreamJson = createRequire(import.meta.url);
/** Streaming JSON parser factory used only for oversized child RPC JSONL projection. */
const streamJsonParser = requireStreamJson("stream-json/parser.js") as {
	readonly parser: StreamJsonParserFactory;
};

/** Bytes in one kibibyte for child stream limits. */
const BYTES_PER_KIB = 1024;
/** Kibibytes in one mebibyte for child stream limits. */
const KIB_PER_MIB = 1024;
/** Bytes in one mebibyte for child stream limits. */
const BYTES_PER_MIB = BYTES_PER_KIB * KIB_PER_MIB;
/** Bounded JSONL suffix size kept for normal child stdout event parsing. */
const CHILD_RPC_STDOUT_LINE_BUFFER_KIB = 256;
/** Maximum JSON object key text collected while projecting oversized RPC events. */
const CHILD_RPC_PROJECTED_KEY_TEXT_LIMIT = 128;
/** Maximum scalar control-field text collected while projecting oversized RPC events. */
const CHILD_RPC_PROJECTED_SCALAR_TEXT_LIMIT = 4096;
/** Trailing carriage return accepted before one JSONL newline delimiter. */
const TRAILING_CR = /\r$/;

/** Bounded JSONL suffix size in bytes kept for normal child stdout event parsing. */
export const CHILD_RPC_STDOUT_LINE_BUFFER_LIMIT =
	CHILD_RPC_STDOUT_LINE_BUFFER_KIB * BYTES_PER_KIB;
/** Maximum stored child stderr diagnostics. */
export const CHILD_RPC_STDERR_TEXT_LIMIT = 64_000;
/** Maximum streamed assistant text delta stored inside one projected event. */
export const CHILD_RPC_STREAMED_TEXT_MIB_LIMIT = 100;
/** Maximum streamed assistant text delta bytes stored inside one projected event. */
export const CHILD_RPC_STREAMED_TEXT_BYTES_LIMIT =
	CHILD_RPC_STREAMED_TEXT_MIB_LIMIT * BYTES_PER_MIB;
/** Error returned when a large child RPC event cannot be projected safely. */
export const CHILD_RPC_OVERSIZED_JSON_EVENT_ERROR =
	"child pi output exceeded supported JSON event size before final response could be parsed";
/** Error returned for invalid child RPC JSONL records. */
export const CHILD_RPC_MALFORMED_OUTPUT_ERROR =
	"child pi emitted malformed RPC output";
/** Synthetic content part marking text skipped from an oversized assistant message. */
export const CHILD_RPC_SKIPPED_TEXT_PART_TYPE = "child_rpc_text_skipped";

/** Diagnostics retained from child RPC streams. */
export interface ChildRpcStreamDiagnostics {
	stdoutSuffix: string;
	stderr: string;
	stderrTruncated: boolean;
	stdoutLineExceededLimit: boolean;
}

/** Receives one parsed child RPC event. */
export type ChildRpcEventHandler = (event: unknown) => void;

interface ChildRpcStreamState {
	stdoutBuffer: string;
	stdoutProjection: ChildRpcLineProjection | undefined;
	stdoutBufferTruncated: boolean;
}

interface StreamJsonToken {
	readonly name: string;
	readonly value?: unknown;
}

interface StreamJsonParserStream {
	write(chunk: string): boolean;
	end(): void;
	on(event: "data", handler: (token: StreamJsonToken) => void): this;
	on(event: "error", handler: (error: Error) => void): this;
	on(event: "end", handler: () => void): this;
}

interface StreamJsonParserFactory {
	asStream(options: {
		readonly packKeys: boolean;
		readonly streamKeys: boolean;
		readonly packStrings: boolean;
		readonly streamStrings: boolean;
		readonly packNumbers: boolean;
		readonly streamNumbers: boolean;
	}): StreamJsonParserStream;
}

interface ChildRpcLineProjection {
	readonly stream: StreamJsonParserStream;
	readonly state: ChildRpcLineProjectionState;
	readonly done: Promise<void>;
	error: string | undefined;
}

interface ChildRpcLineProjectionState {
	readonly stack: JsonProjectionContainer[];
	currentString: JsonProjectionString | undefined;
	currentNumber: JsonProjectionNumber | undefined;
	eventType: string | undefined;
	role: string | undefined;
	stopReason: string | undefined;
	helperCostTotal: number | undefined;
	assistantMessageEventType: string | undefined;
	assistantMessageEventDelta: string | undefined;
	assistantMessageEventDeltaBytes: number;
	assistantMessageEventDeltaExceededLimit: boolean;
	hasSkippedText: boolean;
	hasToolCall: boolean;
	toolCallId: string | undefined;
	toolName: string | undefined;
	toolIsError: boolean | undefined;
	toolResultText: string | undefined;
}

interface JsonProjectionContainer {
	readonly kind: "object" | "array";
	readonly path: readonly string[];
	pendingKey: string | undefined;
	readonly contentPart: JsonProjectionContentPart | undefined;
}

interface JsonProjectionContentPart {
	readonly owner: "message" | "toolResult";
	type: string | undefined;
	hasText: boolean;
	text: string | undefined;
}

interface JsonProjectionString {
	readonly kind: "key" | "value";
	readonly path: readonly string[];
	text: string;
	truncated: boolean;
}

interface JsonProjectionNumber {
	readonly path: readonly string[];
	text: string;
}

/** Parses child RPC stdout and stderr streams. */
export class ChildRpcStreamParser {
	readonly diagnostics: ChildRpcStreamDiagnostics = {
		stdoutSuffix: "",
		stderr: "",
		stderrTruncated: false,
		stdoutLineExceededLimit: false,
	};

	private readonly stdoutDecoder = new StringDecoder("utf8");
	private readonly stderrDecoder = new StringDecoder("utf8");
	private readonly state: ChildRpcStreamState = {
		stdoutBuffer: "",
		stdoutProjection: undefined,
		stdoutBufferTruncated: false,
	};

	/** Processes one stdout chunk and returns a promise only while finalizing oversized JSON projection. */
	processStdoutChunk(
		chunk: unknown,
		onEvent: ChildRpcEventHandler,
	): string | Promise<string | undefined> | undefined {
		const decoded = this.stdoutDecoder.write(toBuffer(chunk));
		this.diagnostics.stdoutSuffix = retainUtf8Suffix(
			this.diagnostics.stdoutSuffix + decoded,
			CHILD_RPC_STDOUT_LINE_BUFFER_LIMIT,
		);
		return this.processStdoutSegments(decoded.split("\n"), 0, onEvent);
	}

	/** Processes one stderr chunk from a child RPC process. */
	processStderrChunk(chunk: unknown): void {
		this.appendStderr(this.stderrDecoder.write(toBuffer(chunk)));
	}

	/** Processes the final stderr decoder text after child process exit. */
	flushStderr(): void {
		this.appendStderr(this.stderrDecoder.end());
	}

	/** Processes a final unterminated stdout line after child process exit. */
	async flushStdout(
		onEvent: ChildRpcEventHandler,
	): Promise<string | undefined> {
		const remainingText = this.stdoutDecoder.end();
		if (remainingText.length > 0) {
			const appendError = this.appendStdoutLineSegment(remainingText);
			if (appendError !== undefined) {
				return appendError;
			}
		}
		return await this.processStdoutLine(onEvent);
	}

	private processStdoutSegments(
		segments: readonly string[],
		startIndex: number,
		onEvent: ChildRpcEventHandler,
	): string | Promise<string | undefined> | undefined {
		for (let index = startIndex; index < segments.length; index += 1) {
			const appendError = this.appendStdoutLineSegment(segments[index] ?? "");
			if (appendError !== undefined) {
				return appendError;
			}
			if (index === segments.length - 1) {
				break;
			}
			const lineError = this.processStdoutLine(onEvent);
			this.resetStdoutLine();
			if (isPromiseLike(lineError)) {
				return lineError.then(
					(error) =>
						error ?? this.processStdoutSegments(segments, index + 1, onEvent),
				);
			}
			if (lineError !== undefined) {
				return lineError;
			}
		}
		return undefined;
	}

	private appendStdoutLineSegment(segment: string): string | undefined {
		if (!this.state.stdoutBufferTruncated) {
			const nextLine = this.state.stdoutBuffer + segment;
			if (nextLine.length <= CHILD_RPC_STDOUT_LINE_BUFFER_LIMIT) {
				this.state.stdoutBuffer = nextLine;
				return undefined;
			}

			this.state.stdoutBufferTruncated = true;
			this.diagnostics.stdoutLineExceededLimit = true;
			this.state.stdoutProjection = createChildRpcLineProjection();
			this.state.stdoutBuffer = nextLine.slice(
				-CHILD_RPC_STDOUT_LINE_BUFFER_LIMIT,
			);
			return writeChildRpcLineProjectionSegment(
				this.state.stdoutProjection,
				nextLine,
			);
		}

		this.state.stdoutBuffer = (this.state.stdoutBuffer + segment).slice(
			-CHILD_RPC_STDOUT_LINE_BUFFER_LIMIT,
		);
		if (this.state.stdoutProjection === undefined) {
			return CHILD_RPC_MALFORMED_OUTPUT_ERROR;
		}
		return writeChildRpcLineProjectionSegment(
			this.state.stdoutProjection,
			segment,
		);
	}

	private processStdoutLine(
		onEvent: ChildRpcEventHandler,
	): string | Promise<string | undefined> | undefined {
		const line = this.state.stdoutBuffer.replace(TRAILING_CR, "");
		if (line.trim().length === 0 && !this.state.stdoutBufferTruncated) {
			return undefined;
		}

		if (this.state.stdoutBufferTruncated) {
			return projectOversizedChildRpcLine(this.state.stdoutProjection).then(
				(event) => {
					if (event === undefined) {
						return CHILD_RPC_MALFORMED_OUTPUT_ERROR;
					}
					onEvent(event);
					return undefined;
				},
			);
		}

		const event = parseJsonLine(line);
		if (event === undefined) {
			return CHILD_RPC_MALFORMED_OUTPUT_ERROR;
		}
		onEvent(event);
		return undefined;
	}

	private resetStdoutLine(): void {
		this.state.stdoutBuffer = "";
		this.state.stdoutProjection = undefined;
		this.state.stdoutBufferTruncated = false;
	}

	private appendStderr(text: string): void {
		const boundedStderr = appendBoundedText(
			this.diagnostics.stderr,
			text,
			CHILD_RPC_STDERR_TEXT_LIMIT,
		);
		this.diagnostics.stderr = boundedStderr.text;
		this.diagnostics.stderrTruncated =
			this.diagnostics.stderrTruncated || boundedStderr.truncated;
	}
}

/** Finalizes an oversized RPC JSONL projection without materializing unneeded payloads. */
async function projectOversizedChildRpcLine(
	projection: ChildRpcLineProjection | undefined,
): Promise<unknown | undefined> {
	if (projection === undefined) {
		return undefined;
	}
	projection.stream.end();
	await projection.done;
	if (projection.error !== undefined) {
		return undefined;
	}
	return buildProjectedChildRpcEvent(projection.state);
}

/** Creates projection state for one oversized child RPC JSONL line. */
function createChildRpcLineProjection(): ChildRpcLineProjection {
	let resolveDone: () => void = () => undefined;
	const done = new Promise<void>((resolve) => {
		resolveDone = resolve;
	});
	const state: ChildRpcLineProjectionState = {
		stack: [],
		currentString: undefined,
		currentNumber: undefined,
		eventType: undefined,
		role: undefined,
		stopReason: undefined,
		helperCostTotal: undefined,
		assistantMessageEventType: undefined,
		assistantMessageEventDelta: undefined,
		assistantMessageEventDeltaBytes: 0,
		assistantMessageEventDeltaExceededLimit: false,
		hasSkippedText: false,
		hasToolCall: false,
		toolCallId: undefined,
		toolName: undefined,
		toolIsError: undefined,
		toolResultText: undefined,
	};
	const stream = streamJsonParser.parser.asStream({
		packKeys: false,
		streamKeys: true,
		packStrings: false,
		streamStrings: true,
		packNumbers: false,
		streamNumbers: false,
	});
	const projection: ChildRpcLineProjection = {
		stream,
		state,
		done,
		error: undefined,
	};
	stream.on("data", (token) => recordChildRpcProjectionToken(state, token));
	stream.on("error", (error) => {
		projection.error = error.message;
		resolveDone();
	});
	stream.on("end", resolveDone);
	return projection;
}

/** Writes one segment to the oversized JSON projection parser. */
function writeChildRpcLineProjectionSegment(
	projection: ChildRpcLineProjection,
	segment: string,
): string | undefined {
	if (projection.error !== undefined) {
		return CHILD_RPC_MALFORMED_OUTPUT_ERROR;
	}
	try {
		projection.stream.write(segment);
	} catch {
		return CHILD_RPC_MALFORMED_OUTPUT_ERROR;
	}
	return projection.error === undefined
		? undefined
		: CHILD_RPC_MALFORMED_OUTPUT_ERROR;
}

/** Records one streaming JSON token into the bounded RPC event projection. */
function recordChildRpcProjectionToken(
	state: ChildRpcLineProjectionState,
	token: StreamJsonToken,
): void {
	switch (token.name) {
		case "startObject":
			pushJsonProjectionContainer(state, "object");
			return;
		case "endObject":
			popJsonProjectionContainer(state, "object");
			return;
		case "startArray":
			pushJsonProjectionContainer(state, "array");
			return;
		case "endArray":
			popJsonProjectionContainer(state, "array");
			return;
		case "startKey":
			state.currentString = createJsonProjectionString("key", []);
			return;
		case "endKey":
			finishJsonProjectionKey(state);
			return;
		case "startString":
			startJsonProjectionStringValue(state);
			return;
		case "endString":
			finishJsonProjectionStringValue(state);
			return;
		case "stringChunk":
			recordJsonProjectionStringChunk(state, token.value);
			return;
		case "startNumber":
			startJsonProjectionNumberValue(state);
			return;
		case "numberChunk":
			recordJsonProjectionNumberChunk(state, token.value);
			return;
		case "endNumber":
		case "numberValue":
			finishJsonProjectionNumberValue(state, token.value);
			return;
		case "nullValue":
			consumeJsonProjectionValuePath(state);
			return;
		case "trueValue":
			recordJsonProjectionBooleanValue(state, true);
			return;
		case "falseValue":
			recordJsonProjectionBooleanValue(state, false);
			return;
		default:
			return;
	}
}

/** Pushes a JSON container and marks payload areas that need bounded metadata. */
function pushJsonProjectionContainer(
	state: ChildRpcLineProjectionState,
	kind: "object" | "array",
): void {
	const path = consumeJsonProjectionValuePath(state);
	state.stack.push({
		kind,
		path,
		pendingKey: undefined,
		contentPart: createJsonProjectionContentPart(kind, path),
	});
}

/** Creates content-part metadata for payloads that affect parent progress. */
function createJsonProjectionContentPart(
	kind: "object" | "array",
	path: readonly string[],
): JsonProjectionContentPart | undefined {
	if (kind !== "object") {
		return undefined;
	}
	if (isJsonProjectionPath(path, "message", "content", "*")) {
		return {
			owner: "message",
			type: undefined,
			hasText: false,
			text: undefined,
		};
	}
	if (isJsonProjectionPath(path, "result", "content", "*")) {
		return {
			owner: "toolResult",
			type: undefined,
			hasText: false,
			text: undefined,
		};
	}
	return undefined;
}

/** Pops a JSON container and commits bounded content metadata. */
function popJsonProjectionContainer(
	state: ChildRpcLineProjectionState,
	kind: "object" | "array",
): void {
	const container = state.stack.pop();
	if (container?.kind !== kind) {
		return;
	}
	const { contentPart } = container;
	if (contentPart === undefined) {
		return;
	}
	if (contentPart.owner === "message") {
		if (contentPart.type === "text" && contentPart.hasText) {
			state.hasSkippedText = true;
		}
		if (contentPart.type === "toolCall") {
			state.hasToolCall = true;
		}
		return;
	}
	if (contentPart.type === "text" && contentPart.text !== undefined) {
		state.toolResultText = appendProjectedToolResultText(
			state.toolResultText,
			contentPart.text,
		);
	}
}

/** Appends one text tool-result part while preserving the projection memory bound. */
function appendProjectedToolResultText(
	currentText: string | undefined,
	partText: string,
): string | undefined {
	const nextText =
		currentText === undefined ? partText : `${currentText}\n${partText}`;
	return nextText.length > CHILD_RPC_PROJECTED_SCALAR_TEXT_LIMIT
		? undefined
		: nextText;
}

/** Starts collecting a string value only when its path can affect control flow or safe progress text. */
function startJsonProjectionStringValue(
	state: ChildRpcLineProjectionState,
): void {
	const path = consumeJsonProjectionValuePath(state);
	const contentPart = getCurrentJsonProjectionContentPart(state);
	if (contentPart !== undefined) {
		if (isJsonProjectionPath(path, "message", "content", "*", "text")) {
			contentPart.hasText = true;
		}
		if (isJsonProjectionPath(path, "result", "content", "*", "text")) {
			contentPart.hasText = true;
		}
	}
	state.currentString = createJsonProjectionString("value", path);
}

/** Creates bounded string collection state for a key or scalar value. */
function createJsonProjectionString(
	kind: "key" | "value",
	path: readonly string[],
): JsonProjectionString {
	return { kind, path, text: "", truncated: false };
}

/** Records one string chunk without collecting large payloads. */
function recordJsonProjectionStringChunk(
	state: ChildRpcLineProjectionState,
	value: unknown,
): void {
	if (typeof value !== "string" || state.currentString === undefined) {
		return;
	}
	if (state.currentString.kind === "value") {
		if (
			isJsonProjectionPath(
				state.currentString.path,
				"message",
				"content",
				"*",
				"text",
			)
		) {
			return;
		}
		if (
			isJsonProjectionPath(
				state.currentString.path,
				"assistantMessageEvent",
				"delta",
			)
		) {
			appendProjectedAssistantDelta(state, value);
			return;
		}
	}
	appendJsonProjectionStringChunk(state.currentString, value);
}

/** Appends projected text_delta chunks with the same memory limit as normal streamed text. */
function appendProjectedAssistantDelta(
	state: ChildRpcLineProjectionState,
	chunk: string,
): void {
	if (state.assistantMessageEventDeltaExceededLimit) {
		return;
	}
	const nextBytes =
		state.assistantMessageEventDeltaBytes + Buffer.byteLength(chunk, "utf8");
	if (nextBytes > CHILD_RPC_STREAMED_TEXT_BYTES_LIMIT) {
		state.assistantMessageEventDelta = undefined;
		state.assistantMessageEventDeltaBytes = 0;
		state.assistantMessageEventDeltaExceededLimit = true;
		return;
	}
	state.assistantMessageEventDelta =
		(state.assistantMessageEventDelta ?? "") + chunk;
	state.assistantMessageEventDeltaBytes = nextBytes;
}

/** Appends bounded key or scalar text and marks overlarge values as unusable. */
function appendJsonProjectionStringChunk(
	state: JsonProjectionString,
	chunk: string,
): void {
	if (state.truncated) {
		return;
	}
	const limit =
		state.kind === "key"
			? CHILD_RPC_PROJECTED_KEY_TEXT_LIMIT
			: CHILD_RPC_PROJECTED_SCALAR_TEXT_LIMIT;
	const nextText = state.text + chunk;
	if (nextText.length > limit) {
		state.text = "";
		state.truncated = true;
		return;
	}
	state.text = nextText;
}

/** Stores a completed object key on the current object container. */
function finishJsonProjectionKey(state: ChildRpcLineProjectionState): void {
	const currentString = state.currentString;
	state.currentString = undefined;
	const container = state.stack.at(-1);
	if (
		currentString?.kind !== "key" ||
		currentString.truncated ||
		container?.kind !== "object"
	) {
		return;
	}
	container.pendingKey = currentString.text;
}

/** Stores a completed scalar value when it is part of the RPC control projection. */
function finishJsonProjectionStringValue(
	state: ChildRpcLineProjectionState,
): void {
	const currentString = state.currentString;
	state.currentString = undefined;
	if (currentString?.kind !== "value" || currentString.truncated) {
		return;
	}
	recordJsonProjectionStringValue(
		state,
		currentString.path,
		currentString.text,
	);
}

/** Applies one completed bounded string value to projected RPC event metadata. */
function recordJsonProjectionStringValue(
	state: ChildRpcLineProjectionState,
	path: readonly string[],
	value: string,
): void {
	if (isJsonProjectionPath(path, "type")) {
		state.eventType = value;
		return;
	}
	if (isJsonProjectionPath(path, "message", "role")) {
		state.role = value;
		return;
	}
	if (isJsonProjectionPath(path, "message", "stopReason")) {
		state.stopReason = value;
		return;
	}
	if (isJsonProjectionPath(path, "assistantMessageEvent", "type")) {
		state.assistantMessageEventType = value;
		return;
	}
	if (isJsonProjectionPath(path, "toolCallId")) {
		state.toolCallId = value;
		return;
	}
	if (isJsonProjectionPath(path, "toolName")) {
		state.toolName = value;
		return;
	}
	if (isJsonProjectionPath(path, "message", "content", "*", "type")) {
		const contentPart = getCurrentJsonProjectionContentPart(state);
		if (contentPart !== undefined) {
			contentPart.type = value;
		}
		return;
	}
	if (isJsonProjectionPath(path, "result", "content", "*", "type")) {
		const contentPart = getCurrentJsonProjectionContentPart(state);
		if (contentPart !== undefined) {
			contentPart.type = value;
		}
		return;
	}
	if (isJsonProjectionPath(path, "result", "content", "*", "text")) {
		const contentPart = getCurrentJsonProjectionContentPart(state);
		if (contentPart !== undefined) {
			contentPart.text = value;
		}
	}
}

/** Starts collecting a number value only when its path can affect helper-cost accounting. */
function startJsonProjectionNumberValue(
	state: ChildRpcLineProjectionState,
): void {
	state.currentNumber = {
		path: consumeJsonProjectionValuePath(state),
		text: "",
	};
}

/** Records one numeric chunk for projected helper-cost accounting. */
function recordJsonProjectionNumberChunk(
	state: ChildRpcLineProjectionState,
	value: unknown,
): void {
	if (state.currentNumber === undefined) {
		return;
	}
	state.currentNumber.text += String(value);
}

/** Applies one completed number value to projected RPC event metadata. */
function finishJsonProjectionNumberValue(
	state: ChildRpcLineProjectionState,
	value: unknown,
): void {
	const currentNumber = state.currentNumber;
	state.currentNumber = undefined;
	const path = currentNumber?.path ?? consumeJsonProjectionValuePath(state);
	if (!isJsonProjectionPath(path, "message", "usage", "cost", "total")) {
		return;
	}

	const rawValue = value ?? currentNumber?.text;
	const numericValue =
		typeof rawValue === "number" ? rawValue : Number(rawValue);
	if (Number.isFinite(numericValue)) {
		state.helperCostTotal = numericValue;
	}
}

/** Applies one completed boolean value to the projected RPC event metadata. */
function recordJsonProjectionBooleanValue(
	state: ChildRpcLineProjectionState,
	value: boolean,
): void {
	const path = consumeJsonProjectionValuePath(state);
	if (isJsonProjectionPath(path, "isError")) {
		state.toolIsError = value;
	}
}

/** Resolves the current value path and clears consumed object keys. */
function consumeJsonProjectionValuePath(
	state: ChildRpcLineProjectionState,
): readonly string[] {
	const parent = state.stack.at(-1);
	if (parent === undefined) {
		return [];
	}
	if (parent.kind === "array") {
		return [...parent.path, "*"];
	}
	const key = parent.pendingKey;
	parent.pendingKey = undefined;
	return key === undefined ? parent.path : [...parent.path, key];
}

/** Returns metadata for the innermost message content part currently being parsed. */
function getCurrentJsonProjectionContentPart(
	state: ChildRpcLineProjectionState,
): JsonProjectionContentPart | undefined {
	for (let index = state.stack.length - 1; index >= 0; index -= 1) {
		const contentPart = state.stack[index]?.contentPart;
		if (contentPart !== undefined) {
			return contentPart;
		}
	}
	return undefined;
}

/** Builds the projected RPC event shape consumed by child RPC callers. */
function buildProjectedChildRpcEvent(
	state: ChildRpcLineProjectionState,
): unknown | undefined {
	switch (state.eventType) {
		case "agent_end":
			return { type: "agent_end", messages: [] };
		case "message_start":
			return buildProjectedMessageStartEvent(state);
		case "message_update":
			return buildProjectedMessageUpdateEvent(state);
		case "message_end":
			return buildProjectedMessageEndEvent(state);
		case "tool_execution_end":
			return buildProjectedToolExecutionEndEvent(state);
		case "turn_end":
			return buildProjectedTurnEndEvent();
		default:
			return undefined;
	}
}

/** Builds a minimal message_start event that preserves assistant-turn reset behavior. */
function buildProjectedMessageStartEvent(
	state: ChildRpcLineProjectionState,
): Record<string, unknown> {
	return {
		type: "message_start",
		...(state.role === undefined ? {} : { message: { role: state.role } }),
	};
}

/** Builds a minimal message_update event that preserves usable streamed text deltas. */
function buildProjectedMessageUpdateEvent(
	state: ChildRpcLineProjectionState,
): Record<string, unknown> {
	if (state.assistantMessageEventType !== "text_delta") {
		return { type: "message_update" };
	}
	return {
		type: "message_update",
		assistantMessageEvent: {
			type: "text_delta",
			delta: state.assistantMessageEventDelta ?? "",
			...(state.assistantMessageEventDeltaExceededLimit
				? { deltaExceededLimit: true }
				: {}),
		},
	};
}

/** Builds a minimal message_end event that preserves final-answer validation metadata. */
function buildProjectedMessageEndEvent(
	state: ChildRpcLineProjectionState,
): Record<string, unknown> {
	const content = [
		...(state.role === "assistant" && state.hasSkippedText
			? [{ type: CHILD_RPC_SKIPPED_TEXT_PART_TYPE }]
			: []),
		...(state.hasToolCall ? [{ type: "toolCall" }] : []),
	];
	return {
		type: "message_end",
		message: {
			...(state.role === undefined ? {} : { role: state.role }),
			content,
			...(state.stopReason === undefined
				? {}
				: { stopReason: state.stopReason }),
			...(state.helperCostTotal === undefined
				? {}
				: { usage: { cost: { total: state.helperCostTotal } } }),
		},
	};
}

/** Builds a minimal tool_execution_end event without large result payloads. */
function buildProjectedToolExecutionEndEvent(
	state: ChildRpcLineProjectionState,
): Record<string, unknown> {
	return {
		type: "tool_execution_end",
		...(state.toolCallId === undefined ? {} : { toolCallId: state.toolCallId }),
		...(state.toolName === undefined ? {} : { toolName: state.toolName }),
		...(state.toolIsError === undefined ? {} : { isError: state.toolIsError }),
		...(state.toolResultText === undefined
			? {}
			: {
					result: { content: [{ type: "text", text: state.toolResultText }] },
				}),
	};
}

/** Builds a minimal turn_end event without replaying repeated tool results. */
function buildProjectedTurnEndEvent(): Record<string, unknown> {
	return { type: "turn_end" };
}

/** Compares a JSON projection path with a finite path pattern. */
function isJsonProjectionPath(
	path: readonly string[],
	...expectedPath: readonly string[]
): boolean {
	return (
		path.length === expectedPath.length &&
		path.every((part, index) => part === expectedPath[index])
	);
}

/** Parses one RPC JSONL output record. */
function parseJsonLine(line: string): unknown | undefined {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

/** Appends bounded text while preserving the newest diagnostic suffix. */
function appendBoundedText(
	currentText: string,
	chunk: string,
	limit: number,
): { readonly text: string; readonly truncated: boolean } {
	const combinedText = currentText + chunk;
	if (combinedText.length <= limit) {
		return { text: combinedText, truncated: false };
	}
	return { text: combinedText.slice(-limit), truncated: true };
}

/** Keeps a suffix whose UTF-8 byte length does not exceed the requested limit. */
function retainUtf8Suffix(value: string, maxBytes: number): string {
	let result = value;
	while (Buffer.byteLength(result, "utf8") > maxBytes) {
		result = result.slice(Math.max(1, Math.floor(result.length / 10)));
	}
	return result;
}

/** Returns true when a runtime value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns true when a value follows the Promise contract enough to await it safely. */
function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
	return isRecord(value) && typeof value["then"] === "function";
}

/** Converts process stream chunks to Buffer values before UTF-8 decoding. */
function toBuffer(data: unknown): Buffer {
	if (Buffer.isBuffer(data)) {
		return data;
	}
	if (typeof data === "string") {
		return Buffer.from(data, "utf8");
	}
	return Buffer.from(String(data), "utf8");
}
