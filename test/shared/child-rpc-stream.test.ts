import { describe, expect, test } from "bun:test";
import {
	CHILD_RPC_MALFORMED_OUTPUT_ERROR,
	CHILD_RPC_SKIPPED_TEXT_PART_TYPE,
	CHILD_RPC_STDOUT_LINE_BUFFER_LIMIT,
	ChildRpcStreamParser,
} from "../../pi-package/shared/child-rpc-stream";

/** Processes a stdout chunk and returns the parser error, if any. */
async function processStdout(
	parser: ChildRpcStreamParser,
	chunk: unknown,
	events: unknown[],
): Promise<string | undefined> {
	return await parser.processStdoutChunk(chunk, (event) => {
		events.push(event);
	});
}

describe("child RPC stream parser", () => {
	test("projects oversized valid JSONL events split across chunks", async () => {
		// Purpose: valid oversized child RPC events must not become malformed when the raw JSONL line exceeds the bounded buffer.
		// Input and expected output: a large tool_execution_end image result is projected to safe progress metadata.
		// Edge case: the line is split before the final LF delimiter, so suffix-only buffering would parse a truncated line.
		// Dependencies: stream-json is used by the production parser for oversized event projection.
		const parser = new ChildRpcStreamParser();
		const events: unknown[] = [];
		const line = JSON.stringify({
			type: "tool_execution_end",
			toolCallId: "read-1",
			toolName: "read",
			result: {
				content: [
					{ type: "text", text: "image inspected" },
					{
						type: "image",
						data: "a".repeat(300_000),
						mimeType: "image/png",
					},
				],
			},
			isError: false,
		});
		const splitIndex = Math.floor(line.length / 2);

		expect(await processStdout(parser, line.slice(0, splitIndex), events)).toBe(
			undefined,
		);
		expect(
			await processStdout(parser, `${line.slice(splitIndex)}\n`, events),
		).toBe(undefined);

		expect(events).toEqual([
			{
				type: "tool_execution_end",
				toolCallId: "read-1",
				toolName: "read",
				isError: false,
				result: { content: [{ type: "text", text: "image inspected" }] },
			},
		]);
	});

	test("preserves helper cost from oversized message_end projection", async () => {
		// Purpose: helper cost accounting must still see child usage when large child messages are projected.
		// Input and expected output: an oversized assistant message_end keeps only role, content markers, stop reason, and usage.cost.total.
		// Edge case: large text content is replaced by a skipped-text marker while minimal cost metadata remains available.
		// Dependencies: stream-json is used by the production parser for oversized event projection.
		const parser = new ChildRpcStreamParser();
		const events: unknown[] = [];
		const line = `${JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "x".repeat(300_000) }],
				usage: { cost: { total: 0.9 } },
				stopReason: "stop",
			},
		})}\n`;

		expect(await processStdout(parser, line, events)).toBe(undefined);

		expect(events).toEqual([
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: CHILD_RPC_SKIPPED_TEXT_PART_TYPE }],
					stopReason: "stop",
					usage: { cost: { total: 0.9 } },
				},
			},
		]);
	});

	test("projects oversized get_entries responses without retaining large message text", async () => {
		// Purpose: a valid management response must remain usable when one session entry exceeds the raw JSONL limit.
		// Input and expected output: get_entries keeps response identity, branch metadata, and a bounded message entry.
		// Edge case: one text part alone exceeds the limit, so incremental requests cannot prevent oversized output.
		// Dependencies: stream-json is used by the production parser for oversized response projection.
		// ARRANGE: build one valid response whose assistant text exceeds the raw line buffer.
		const parser = new ChildRpcStreamParser();
		const events: unknown[] = [];
		const line = `${JSON.stringify({
			id: "entries-1",
			type: "response",
			command: "get_entries",
			success: true,
			data: {
				entries: [
					{
						type: "message",
						id: "assistant-1",
						parentId: null,
						timestamp: "2026-07-29T00:00:00.000Z",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "x".repeat(300_000) }],
							stopReason: "stop",
							timestamp: 1,
						},
					},
				],
				leafId: "assistant-1",
			},
		})}\n`;

		// ACT: parse the complete oversized response.
		const error = await processStdout(parser, line, events);

		// ASSERT: response routing metadata and a bounded entry survive without a protocol error.
		expect(error).toBeUndefined();
		expect(events).toHaveLength(1);
		const response = events[0] as {
			readonly id?: string;
			readonly command?: string;
			readonly data?: {
				readonly entries?: ReadonlyArray<{
					readonly parentId?: string | null;
					readonly message?: { readonly timestamp?: number };
				}>;
				readonly leafId?: string;
			};
		};
		expect({
			id: response.id,
			command: response.command,
			leafId: response.data?.leafId,
			entryCount: response.data?.entries?.length,
			parentId: response.data?.entries?.[0]?.parentId,
			messageTimestamp: response.data?.entries?.[0]?.message?.timestamp,
			projectedSize: JSON.stringify(response).length,
		}).toEqual({
			id: "entries-1",
			command: "get_entries",
			leafId: "assistant-1",
			entryCount: 1,
			parentId: null,
			messageTimestamp: 1,
			projectedSize: expect.any(Number),
		});
		expect(JSON.stringify(response).length).toBeLessThan(
			CHILD_RPC_STDOUT_LINE_BUFFER_LIMIT,
		);
	});

	test("preserves malformed child RPC stdout diagnostics", async () => {
		// Purpose: a reported protocol failure must retain enough source evidence for later diagnosis.
		// Input and expected output: invalid JSONL returns the parser cause and an escaped copy of the offending line.
		// Edge case: the malformed line is LF-delimited and therefore complete.
		// Dependencies: no child process is required; the parser receives controlled stdout chunks.
		// Arrange
		const parser = new ChildRpcStreamParser();
		const events: unknown[] = [];

		// Act
		const error = await processStdout(parser, "{not-json}\n", events);

		// Assert
		expect(error?.startsWith(CHILD_RPC_MALFORMED_OUTPUT_ERROR)).toBe(true);
		expect(error).toContain("cause:");
		expect(error).toContain('line: "{not-json}"');
		expect(events).toEqual([]);
	});

	test("escapes control characters in malformed stdout diagnostics", async () => {
		// Purpose: source evidence must remain one safe diagnostic line instead of injecting raw terminal controls.
		// Input and expected output: tab and carriage-return characters are represented by escaped text.
		// Edge case: the carriage return occurs inside the malformed line rather than as the accepted JSONL suffix.
		// Dependencies: controlled parser input only.
		// Arrange
		const parser = new ChildRpcStreamParser();
		const events: unknown[] = [];

		// Act
		const error = await processStdout(parser, "noise\twith\rcontrol\n", events);

		// Assert
		expect(error).toContain("\\t");
		expect(error).toContain("\\r");
		expect(error).not.toContain("\t");
		expect(error).not.toContain("\r");
		expect(events).toEqual([]);
	});

	test("bounds diagnostics for an oversized malformed stdout line", async () => {
		// Purpose: preserving source evidence must not copy an unbounded child payload into the parent error.
		// Input and expected output: a line beyond the raw buffer limit keeps escaped head and tail markers in a bounded error.
		// Edge case: streaming projection fails before any later valid RPC event can replace the malformed line.
		// Dependencies: production oversized-line projection and controlled parser input.
		// Arrange
		const parser = new ChildRpcStreamParser();
		const events: unknown[] = [];
		const line = `diagnostic-head-${"x".repeat(CHILD_RPC_STDOUT_LINE_BUFFER_LIMIT + 1)}-diagnostic-tail\n`;

		// Act
		const error = await processStdout(parser, line, events);

		// Assert
		expect(error?.startsWith(CHILD_RPC_MALFORMED_OUTPUT_ERROR)).toBe(true);
		expect(error).toContain("diagnostic-head");
		expect(error).toContain("diagnostic-tail");
		expect(error?.length).toBeLessThanOrEqual(4_096);
		expect(events).toEqual([]);
	});

	test("decodes split UTF-8 stdout chunks before JSON parsing", async () => {
		// Purpose: child RPC stdout decoding must preserve multibyte UTF-8 characters split across process chunks.
		// Input and expected output: a message_end line containing an emoji parses with the original text.
		// Edge case: the split happens inside the emoji byte sequence.
		// Dependencies: Buffer chunks model process stdout behavior.
		const parser = new ChildRpcStreamParser();
		const events: unknown[] = [];
		const line = `${JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done 🙂" }],
			},
		})}\n`;
		const bytes = Buffer.from(line, "utf8");
		const splitIndex = bytes.indexOf(Buffer.from("🙂", "utf8")) + 2;

		expect(
			await processStdout(parser, bytes.subarray(0, splitIndex), events),
		).toBe(undefined);
		expect(
			await processStdout(parser, bytes.subarray(splitIndex), events),
		).toBe(undefined);

		expect(events).toEqual([
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done 🙂" }],
				},
			},
		]);
	});
});
