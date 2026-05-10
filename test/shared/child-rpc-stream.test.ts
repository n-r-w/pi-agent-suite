import { describe, expect, test } from "bun:test";
import {
	CHILD_RPC_MALFORMED_OUTPUT_ERROR,
	CHILD_RPC_SKIPPED_TEXT_PART_TYPE,
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

	test("fails closed on malformed child RPC stdout", async () => {
		// Purpose: malformed child RPC stdout must be reported as a transport failure instead of being ignored.
		// Input and expected output: invalid JSONL returns the standard malformed-output error.
		// Edge case: the malformed line is LF-delimited and therefore complete.
		// Dependencies: no child process is required; the parser receives controlled stdout chunks.
		const parser = new ChildRpcStreamParser();
		const events: unknown[] = [];

		expect(await processStdout(parser, "{not-json}\n", events)).toBe(
			CHILD_RPC_MALFORMED_OUTPUT_ERROR,
		);
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
