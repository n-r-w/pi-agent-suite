import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";

/** CommonJS loader used for the stream-json parser package exported as CommonJS. */
const requireStreamJson = createRequire(import.meta.url);
/** Streaming JSON parser factory used only for oversized child RPC JSONL projection. */
const streamJsonParser = requireStreamJson("stream-json/parser.js") as {
	readonly parser: StreamJsonParserFactory;
};
/** Incremental object assembler used for bounded get_entries session entries. */
const streamJsonAssembler = requireStreamJson("stream-json/Assembler.js") as {
	readonly assembler: () => StreamJsonAssembler;
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
/** Visible suffix that discloses text omitted from an oversized projected scalar. */
const CHILD_RPC_PROJECTED_TEXT_ELLIPSIS = "…";
/** Maximum quoted parser cause or stdout fragment retained in malformed-output diagnostics. */
const CHILD_RPC_MALFORMED_DIAGNOSTIC_PART_LIMIT = 1024;
/** Maximum raw line prefix retained while child stdout exceeds the normal line buffer. */
const CHILD_RPC_MALFORMED_RAW_PREFIX_LIMIT = 1024;
/** Separator between retained head and tail diagnostic text. */
const CHILD_RPC_MALFORMED_DIAGNOSTIC_SEPARATOR = "...";
/** Number of retained sides around a truncated diagnostic part. */
const CHILD_RPC_MALFORMED_DIAGNOSTIC_SIDE_COUNT = 2;
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
	stdoutLinePrefix: string;
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

interface StreamJsonAssembler {
	current: unknown;
	keyValue(value: string): void;
	stringValue(value: string): void;
	numberValue(value: string): void;
	nullValue(): void;
	trueValue(): void;
	falseValue(): void;
	startObject(): void;
	endObject(): void;
	startArray(): void;
	endArray(): void;
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
	responseId: string | undefined;
	responseCommand: string | undefined;
	responseSuccess: boolean | undefined;
	responseLeafId: string | null | undefined;
	readonly responseEntries: Record<string, unknown>[];
	entryAssembler: StreamJsonAssembler | undefined;
	responseProjectionInvalid: boolean;
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
		stdoutLinePrefix: "",
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

	/** Appends one decoded line segment to bounded parsing and diagnostic state. */
	private appendStdoutLineSegment(segment: string): string | undefined {
		this.retainStdoutLinePrefix(segment);
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
			const projectionError = writeChildRpcLineProjectionSegment(
				this.state.stdoutProjection,
				nextLine,
			);
			return projectionError === undefined
				? undefined
				: this.malformedOutputError(projectionError);
		}

		this.state.stdoutBuffer = (this.state.stdoutBuffer + segment).slice(
			-CHILD_RPC_STDOUT_LINE_BUFFER_LIMIT,
		);
		if (this.state.stdoutProjection === undefined) {
			return this.malformedOutputError(
				"oversized RPC projection state is unavailable",
			);
		}
		const projectionError = writeChildRpcLineProjectionSegment(
			this.state.stdoutProjection,
			segment,
		);
		return projectionError === undefined
			? undefined
			: this.malformedOutputError(projectionError);
	}

	/** Parses or projects one complete buffered JSONL record. */
	private processStdoutLine(
		onEvent: ChildRpcEventHandler,
	): string | Promise<string | undefined> | undefined {
		const line = this.state.stdoutBuffer.replace(TRAILING_CR, "");
		if (line.trim().length === 0 && !this.state.stdoutBufferTruncated) {
			return undefined;
		}

		if (this.state.stdoutBufferTruncated) {
			const projection = this.state.stdoutProjection;
			const linePrefix = this.state.stdoutLinePrefix.replace(TRAILING_CR, "");
			const lineSuffix = this.state.stdoutBuffer.replace(TRAILING_CR, "");
			return projectOversizedChildRpcLine(projection).then((event) => {
				if (event === undefined) {
					return formatMalformedOutputError({
						cause:
							projection?.error ?? "oversized RPC event could not be projected",
						linePrefix,
						lineSuffix,
						truncated: true,
					});
				}
				onEvent(event);
				return undefined;
			});
		}

		let event: Record<string, unknown>;
		try {
			event = parseJsonLine(line);
		} catch (error) {
			return this.malformedOutputError(readErrorMessage(error));
		}
		onEvent(event);
		return undefined;
	}

	/** Retains the start of one stdout line before suffix-only buffering discards it. */
	private retainStdoutLinePrefix(segment: string): void {
		const remaining =
			CHILD_RPC_MALFORMED_RAW_PREFIX_LIMIT - this.state.stdoutLinePrefix.length;
		if (remaining > 0) {
			this.state.stdoutLinePrefix += segment.slice(0, remaining);
		}
	}

	/** Formats one bounded, escaped parser error with the offending line evidence. */
	private malformedOutputError(cause: string): string {
		return formatMalformedOutputError({
			cause,
			linePrefix: this.state.stdoutLinePrefix.replace(TRAILING_CR, ""),
			lineSuffix: this.state.stdoutBuffer.replace(TRAILING_CR, ""),
			truncated: this.state.stdoutBufferTruncated,
		});
	}

	/** Clears per-line parsing state after one LF delimiter is consumed. */
	private resetStdoutLine(): void {
		this.state.stdoutBuffer = "";
		this.state.stdoutLinePrefix = "";
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
		responseId: undefined,
		responseCommand: undefined,
		responseSuccess: undefined,
		responseLeafId: undefined,
		responseEntries: [],
		entryAssembler: undefined,
		responseProjectionInvalid: false,
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
		return projection.error;
	}
	try {
		projection.stream.write(segment);
	} catch (error) {
		return readErrorMessage(error);
	}
	return projection.error;
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
			recordJsonProjectionNullValue(state);
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
	if (kind === "object" && isGetEntriesEntryPath(path)) {
		if (state.entryAssembler !== undefined) {
			state.responseProjectionInvalid = true;
		} else {
			state.entryAssembler = streamJsonAssembler.assembler();
		}
	}
	if (state.entryAssembler !== undefined) {
		if (kind === "object") {
			state.entryAssembler.startObject();
		} else {
			state.entryAssembler.startArray();
		}
	}
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
		state.responseProjectionInvalid = true;
		return;
	}
	finishJsonProjectionAssemblerContainer(state, kind, container.path);
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

/** Completes one assembled container and commits a finished get_entries entry. */
function finishJsonProjectionAssemblerContainer(
	state: ChildRpcLineProjectionState,
	kind: "object" | "array",
	path: readonly string[],
): void {
	const entryAssembler = state.entryAssembler;
	if (entryAssembler === undefined) {
		return;
	}
	if (kind === "object") {
		entryAssembler.endObject();
	} else {
		entryAssembler.endArray();
	}
	if (!isGetEntriesEntryPath(path)) {
		return;
	}
	if (isRecord(entryAssembler.current)) {
		state.responseEntries.push(entryAssembler.current);
	} else {
		state.responseProjectionInvalid = true;
	}
	state.entryAssembler = undefined;
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
		// Preserve a useful prefix while keeping the projected scalar within its existing bound.
		state.text = `${nextText.slice(
			0,
			limit - CHILD_RPC_PROJECTED_TEXT_ELLIPSIS.length,
		)}${CHILD_RPC_PROJECTED_TEXT_ELLIPSIS}`;
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
	state.entryAssembler?.keyValue(currentString.text);
}

/** Stores a completed scalar value when it is part of the RPC control projection. */
function finishJsonProjectionStringValue(
	state: ChildRpcLineProjectionState,
): void {
	const currentString = state.currentString;
	state.currentString = undefined;
	if (currentString?.kind !== "value") {
		return;
	}
	const projectedValue = currentString.text;
	state.entryAssembler?.stringValue(projectedValue);
	if (currentString.truncated) {
		return;
	}
	recordJsonProjectionStringValue(state, currentString.path, projectedValue);
}

/** Applies one completed bounded string value to projected RPC event metadata. */
function recordJsonProjectionStringValue(
	state: ChildRpcLineProjectionState,
	path: readonly string[],
	value: string,
): void {
	if (recordJsonProjectionEnvelopeString(state, path, value)) {
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

/** Records string fields that route either a normal event or a get_entries response. */
function recordJsonProjectionEnvelopeString(
	state: ChildRpcLineProjectionState,
	path: readonly string[],
	value: string,
): boolean {
	if (isJsonProjectionPath(path, "id")) {
		state.responseId = value;
		return true;
	}
	if (isJsonProjectionPath(path, "type")) {
		state.eventType = value;
		return true;
	}
	if (isJsonProjectionPath(path, "command")) {
		state.responseCommand = value;
		return true;
	}
	if (isJsonProjectionPath(path, "data", "leafId")) {
		state.responseLeafId = value;
		return true;
	}
	return false;
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
	const rawValue = value ?? currentNumber?.text;
	const numberText = String(rawValue);
	state.entryAssembler?.numberValue(numberText);
	if (!isJsonProjectionPath(path, "message", "usage", "cost", "total")) {
		return;
	}
	const numericValue =
		typeof rawValue === "number" ? rawValue : Number(rawValue);
	if (Number.isFinite(numericValue)) {
		state.helperCostTotal = numericValue;
	}
}

/** Applies one completed null value to an assembled response entry or leaf identity. */
function recordJsonProjectionNullValue(
	state: ChildRpcLineProjectionState,
): void {
	const path = consumeJsonProjectionValuePath(state);
	state.entryAssembler?.nullValue();
	if (isJsonProjectionPath(path, "data", "leafId")) {
		state.responseLeafId = null;
	}
}

/** Applies one completed boolean value to the projected RPC event metadata. */
function recordJsonProjectionBooleanValue(
	state: ChildRpcLineProjectionState,
	value: boolean,
): void {
	const path = consumeJsonProjectionValuePath(state);
	if (value) {
		state.entryAssembler?.trueValue();
	} else {
		state.entryAssembler?.falseValue();
	}
	if (isJsonProjectionPath(path, "success")) {
		state.responseSuccess = value;
		return;
	}
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
		case "response":
			return buildProjectedGetEntriesResponse(state);
		default:
			return undefined;
	}
}

/** Builds one bounded get_entries response for management conversation synchronization. */
function buildProjectedGetEntriesResponse(
	state: ChildRpcLineProjectionState,
): Record<string, unknown> | undefined {
	if (
		state.responseProjectionInvalid ||
		state.entryAssembler !== undefined ||
		state.responseId === undefined ||
		state.responseCommand !== "get_entries" ||
		state.responseSuccess !== true ||
		state.responseLeafId === undefined
	) {
		return undefined;
	}
	return {
		id: state.responseId,
		type: "response",
		command: "get_entries",
		success: true,
		data: {
			entries: state.responseEntries,
			leafId: state.responseLeafId,
		},
	};
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

/** Identifies one top-level entry object inside a get_entries response. */
function isGetEntriesEntryPath(path: readonly string[]): boolean {
	return isJsonProjectionPath(path, "data", "entries", "*");
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

/** Parses one RPC JSONL output record and rejects non-object protocol values. */
function parseJsonLine(line: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(line);
	if (!isRecord(parsed)) {
		throw new Error("RPC output must be a JSON object");
	}
	return parsed;
}

/** Formats one bounded malformed-output error without emitting raw control characters. */
function formatMalformedOutputError(options: {
	readonly cause: string;
	readonly linePrefix: string;
	readonly lineSuffix: string;
	readonly truncated: boolean;
}): string {
	const cause = quoteDiagnosticPart(options.cause);
	if (!options.truncated) {
		return `${CHILD_RPC_MALFORMED_OUTPUT_ERROR}; cause: ${cause}; line: ${quoteDiagnosticPart(options.lineSuffix)}`;
	}
	return `${CHILD_RPC_MALFORMED_OUTPUT_ERROR}; cause: ${cause}; line head: ${quoteDiagnosticPart(options.linePrefix)}; line tail: ${quoteDiagnosticPart(options.lineSuffix)}`;
}

/** Quotes and bounds one diagnostic part while retaining evidence from both ends. */
function quoteDiagnosticPart(value: string): string {
	const quoted = JSON.stringify(value);
	if (quoted.length <= CHILD_RPC_MALFORMED_DIAGNOSTIC_PART_LIMIT) {
		return quoted;
	}
	const sideLength = Math.floor(
		(CHILD_RPC_MALFORMED_DIAGNOSTIC_PART_LIMIT -
			CHILD_RPC_MALFORMED_DIAGNOSTIC_SEPARATOR.length) /
			CHILD_RPC_MALFORMED_DIAGNOSTIC_SIDE_COUNT,
	);
	return `${quoted.slice(0, sideLength)}${CHILD_RPC_MALFORMED_DIAGNOSTIC_SEPARATOR}${quoted.slice(-sideLength)}`;
}

/** Reads a stable diagnostic message from an unknown thrown value. */
function readErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
