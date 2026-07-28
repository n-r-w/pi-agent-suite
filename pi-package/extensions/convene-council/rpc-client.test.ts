import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ChildRpcRuntimeFacts } from "../../shared/child-rpc-completion";
import {
	COUNCIL_RPC_STDERR_MAX_CHARS,
	COUNCIL_RPC_STDOUT_SUFFIX_MAX_BYTES,
	CouncilRpcClient,
	CouncilRpcCommandError,
} from "./rpc-client";

/** Creates a fake RPC transport for client protocol tests. */
function createTransport() {
	const writes: string[] = [];
	let onStdout: ((chunk: unknown) => void) | undefined;
	let onStderr: ((chunk: unknown) => void) | undefined;
	return {
		transport: {
			write(line: string): void {
				writes.push(line);
			},
			onStdout(handler: (chunk: unknown) => void): void {
				onStdout = handler;
			},
			onStderr(handler: (chunk: unknown) => void): void {
				onStderr = handler;
			},
			onError(): void {},
		},
		writes,
		stdout(chunk: unknown): void {
			onStdout?.(chunk);
		},
		stderr(chunk: unknown): void {
			onStderr?.(chunk);
		},
	};
}

/** Parses one command line written by the client. */
function writtenCommand(line: string): Record<string, unknown> {
	return JSON.parse(line) as Record<string, unknown>;
}

/** Extracts text from one assistant message in tests. */
function assistantText(message: AssistantMessage): string {
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("");
}

const BASE_FACTS: ChildRpcRuntimeFacts = {
	modelProvider: "openai",
	modelId: "model-a",
	contextWindow: 1_000,
};

/** Creates one complete assistant message for child RPC protocol tests. */
function assistantMessage(
	text: string,
	overrides: Record<string, unknown> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "openai",
		model: "model-a",
		usage: {
			input: 10,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 11,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	} as AssistantMessage;
}

/** Emits one JSONL RPC stdout message through the fake transport. */
function emitRpc(
	fake: ReturnType<typeof createTransport>,
	message: Record<string, unknown>,
): void {
	fake.stdout(`${JSON.stringify(message)}\n`);
}

/** Emits the session-level boundary for one fully settled participant prompt. */
function emitAgentSettled(fake: ReturnType<typeof createTransport>): void {
	emitRpc(fake, { type: "agent_settled" });
}

describe("CouncilRpcClient", () => {
	test("starts participant prompts without a startup RPC command", async () => {
		// Purpose: constructing the client must not write child settings through RPC.
		// Input and expected output: the first write is the real participant prompt.
		// Edge case: prompt execution must work without a setup command.
		// Dependencies: fake JSONL transport.
		const fake = createTransport();
		const client = new CouncilRpcClient(fake.transport, BASE_FACTS);

		expect(fake.writes).toHaveLength(0);
		const result = client.prompt("first task");
		expect(writtenCommand(fake.writes[0] ?? "{}")).toMatchObject({
			type: "prompt",
			message: "first task",
		});
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "1", command: "prompt", success: true })}\n`,
		);
		fake.stdout(
			`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "answer", api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 } })}\n`,
		);
		fake.stdout(`${JSON.stringify({ type: "agent_end" })}\n`);
		emitAgentSettled(fake);

		expect(assistantText(await result)).toBe("answer");
	});

	test("writes newline-delimited JSONL commands", async () => {
		// Purpose: child Pi reads stdin as JSONL and needs LF command delimiters.
		// Input and expected output: prompt command is valid JSON followed by LF.
		// Edge case: tests parse the trimmed command separately from framing.
		// Dependencies: fake JSONL transport.
		const fake = createTransport();
		const client = new CouncilRpcClient(fake.transport, BASE_FACTS);

		const result = client.prompt("framed task");

		expect(fake.writes[0]?.endsWith("\n")).toBe(true);
		expect(writtenCommand(fake.writes[0]?.trimEnd() ?? "{}")).toMatchObject({
			type: "prompt",
			message: "framed task",
		});
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "1", command: "prompt", success: false, error: "busy" })}\n`,
		);
		await expect(result).rejects.toThrow("busy");
	});

	test("does not complete a prompt before agent_settled", async () => {
		// Purpose: prompt response success and agent_end do not exhaust Pi's automatic continuations.
		// Input and expected output: message_end text remains pending through agent_end and resolves on agent_settled.
		// Edge case: stdout chunks can split valid LF-delimited JSON.
		// Dependencies: fake JSONL transport.
		const fake = createTransport();
		const client = new CouncilRpcClient(fake.transport, BASE_FACTS);

		const result = client.prompt("review task");
		const handledResult = result.catch(() => undefined);
		expect(writtenCommand(fake.writes[0] ?? "{}")).toMatchObject({
			type: "prompt",
			message: "review task",
		});
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "1", command: "prompt", success: true })}\n`,
		);
		let completed = false;
		const completionProbe = result.then(() => {
			completed = true;
		});
		await Promise.resolve();
		expect(completed).toBe(false);
		fake.stdout(
			`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "answer", api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 } })}\n`,
		);
		fake.stdout(`${JSON.stringify({ type: "agent_end" })}\n`);
		await Promise.resolve();
		expect(completed).toBe(false);
		emitAgentSettled(fake);

		expect(assistantText(await result)).toBe("answer");
		await handledResult;
		await completionProbe;
	});

	test("waits for agent_settled during successful child retry", async () => {
		// Purpose: participant prompt ownership must survive every low-level agent_end in one retried run.
		// Input and expected output: retry events and both agent_end events remain pending; agent_settled resolves the retried output.
		// Edge case: auto_retry_end(success=true) is not the prompt boundary.
		// Dependencies: fake JSONL transport and shared runtime facts.
		const fake = createTransport();
		const client = new CouncilRpcClient(fake.transport, BASE_FACTS);

		const result = client.prompt("review task");
		emitRpc(fake, {
			type: "response",
			id: "1",
			command: "prompt",
			success: true,
		});
		emitRpc(fake, {
			type: "message_end",
			message: assistantMessage("temporary failure", {
				stopReason: "error",
				errorMessage: "server error 500",
			}),
		});
		emitRpc(fake, { type: "agent_end" });
		let completed = false;
		const completionProbe = result.then(() => {
			completed = true;
		});
		await Promise.resolve();
		expect(completed).toBe(false);

		emitRpc(fake, { type: "auto_retry_start", attempt: 1 });
		emitRpc(fake, {
			type: "message_end",
			message: assistantMessage("retry answer"),
		});
		emitRpc(fake, { type: "auto_retry_end", success: true });
		await Promise.resolve();
		expect(completed).toBe(false);
		emitRpc(fake, { type: "agent_end" });
		await Promise.resolve();
		expect(completed).toBe(false);
		emitAgentSettled(fake);

		expect(assistantText(await result)).toBe("retry answer");
		await completionProbe;
	});

	test("rejects participant prompt after failed retry settles", async () => {
		// Purpose: exhausted child auto-retry preserves its error until Pi reports the session-level boundary.
		// Input and expected output: auto_retry_end remains pending; agent_settled rejects and clears the active prompt.
		// Edge case: a later prompt can be started after the failed prompt is cleared.
		// Dependencies: fake JSONL transport and shared runtime facts.
		const fake = createTransport();
		const client = new CouncilRpcClient(fake.transport, BASE_FACTS);

		const result = client.prompt("review task");
		emitRpc(fake, {
			type: "response",
			id: "1",
			command: "prompt",
			success: true,
		});
		emitRpc(fake, {
			type: "message_end",
			message: assistantMessage("temporary failure", {
				stopReason: "error",
				errorMessage: "server error 500",
			}),
		});
		emitRpc(fake, { type: "agent_end" });
		emitRpc(fake, {
			type: "auto_retry_end",
			success: false,
			finalError: "retry exhausted",
		});
		emitAgentSettled(fake);

		await expect(result).rejects.toThrow("retry exhausted");
		const next = client.prompt("next task");
		emitRpc(fake, {
			type: "response",
			id: "2",
			command: "prompt",
			success: false,
			error: "next rejected",
		});
		await expect(next).rejects.toThrow("next rejected");
	});

	test("keeps participant prompt active during overflow compaction", async () => {
		// Purpose: overflow compaction has a non-final agent_end before continuation.
		// Input and expected output: overflow agent_end does not resolve; final post-compaction output resolves.
		// Edge case: silent stop overflow is classified through usage and contextWindow.
		// Dependencies: fake JSONL transport and shared runtime facts.
		const fake = createTransport();
		const client = new CouncilRpcClient(fake.transport, BASE_FACTS);

		const result = client.prompt("review task");
		emitRpc(fake, {
			type: "response",
			id: "1",
			command: "prompt",
			success: true,
		});
		emitRpc(fake, {
			type: "message_end",
			message: assistantMessage("overflow", {
				usage: {
					input: 1_001,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_002,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
		});
		emitRpc(fake, { type: "agent_end" });
		let completed = false;
		const completionProbe = result.then(() => {
			completed = true;
		});
		await Promise.resolve();
		expect(completed).toBe(false);
		const overlapping = client.prompt("overlapping task");
		let overlappingRejected = false;
		overlapping.catch(() => {
			overlappingRejected = true;
		});
		await Promise.resolve();
		expect(overlappingRejected).toBe(true);

		emitRpc(fake, {
			type: "compaction_end",
			reason: "overflow",
			willRetry: true,
			aborted: false,
		});
		emitRpc(fake, {
			type: "message_end",
			message: assistantMessage("after compaction"),
		});
		emitRpc(fake, { type: "agent_end" });
		emitAgentSettled(fake);

		expect(assistantText(await result)).toBe("after compaction");
		await completionProbe;
	});

	test("emits child session events without exposing command responses", async () => {
		// Purpose: live council progress needs child session events while command responses remain protocol-only.
		// Input and expected output: tool and agent events reach the callback, response records do not.
		// Edge case: prompt completion still waits for agent_settled after event emission.
		// Dependencies: fake JSONL transport and callback capture.
		const fake = createTransport();
		const events: unknown[] = [];
		const client = new CouncilRpcClient(fake.transport, BASE_FACTS, (event) => {
			events.push(event);
		});

		const result = client.prompt("review task");
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "1", command: "prompt", success: true })}\n`,
		);
		fake.stdout(
			`${JSON.stringify({ type: "agent_start" })}\n${JSON.stringify({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "README.md" } })}\n`,
		);
		fake.stdout(
			`${JSON.stringify({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: { content: [{ type: "text", text: "README content" }] }, isError: false })}\n`,
		);
		fake.stdout(
			`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "answer", api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 } })}\n`,
		);
		fake.stdout(`${JSON.stringify({ type: "agent_end" })}\n`);
		emitAgentSettled(fake);

		expect(assistantText(await result)).toBe("answer");
		expect(events).toEqual([
			{ type: "agent_start" },
			{
				type: "tool_execution_start",
				toolCallId: "read-1",
				toolName: "read",
				args: { path: "README.md" },
			},
			{
				type: "tool_execution_end",
				toolCallId: "read-1",
				toolName: "read",
				result: { content: [{ type: "text", text: "README content" }] },
				isError: false,
			},
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: "answer",
					api: "test",
					provider: "test",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason: "stop",
					timestamp: 1,
				},
			},
			{ type: "agent_end" },
			{ type: "agent_settled" },
		]);
	});

	test("projects oversized child session events before later prompt completion events", async () => {
		// Purpose: oversized valid child RPC events must not reject the participant prompt as malformed stdout.
		// Input and expected output: a large tool_execution_end image result is projected, then the prompt resolves from later message_end and agent_settled.
		// Edge case: the oversized JSONL line is split across chunks before the final LF delimiter.
		// Dependencies: fake JSONL transport and callback capture.
		const fake = createTransport();
		const events: unknown[] = [];
		const client = new CouncilRpcClient(fake.transport, BASE_FACTS, (event) => {
			events.push(event);
		});

		const result = client.prompt("review task");
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "1", command: "prompt", success: true })}\n`,
		);
		const oversizedToolEvent = JSON.stringify({
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
		const firstSplitIndex = Math.floor(oversizedToolEvent.length / 2);
		const secondSplitIndex = oversizedToolEvent.length - 1;
		fake.stdout(oversizedToolEvent.slice(0, firstSplitIndex));
		fake.stdout(oversizedToolEvent.slice(firstSplitIndex, secondSplitIndex));
		fake.stdout(`${oversizedToolEvent.slice(secondSplitIndex)}\n`);
		fake.stdout(
			`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "answer", api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 } })}\n`,
		);
		fake.stdout(`${JSON.stringify({ type: "agent_end" })}\n`);
		emitAgentSettled(fake);

		expect(assistantText(await result)).toBe("answer");
		expect(events).toEqual([
			{
				type: "tool_execution_end",
				toolCallId: "read-1",
				toolName: "read",
				isError: false,
				result: { content: [{ type: "text", text: "image inspected" }] },
			},
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: "answer",
					api: "test",
					provider: "test",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason: "stop",
					timestamp: 1,
				},
			},
			{ type: "agent_end" },
			{ type: "agent_settled" },
		]);
	});

	test("uses get_last_assistant_text when agent_settled has no assistant message_end", async () => {
		// Purpose: participant output extraction must recover final text after agent_settled.
		// Input and expected output: the settled client requests get_last_assistant_text fallback and returns that text.
		// Edge case: fallback command response is correlated by id.
		// Dependencies: fake JSONL transport.
		const fake = createTransport();
		const client = new CouncilRpcClient(fake.transport, BASE_FACTS);

		const result = client.prompt("final task");
		const handledResult = result.catch(() => undefined);
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "1", command: "prompt", success: true })}\n`,
		);
		fake.stdout(`${JSON.stringify({ type: "agent_end" })}\n`);
		emitAgentSettled(fake);
		expect(writtenCommand(fake.writes[1] ?? "{}")).toMatchObject({
			type: "get_last_assistant_text",
		});
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "2", command: "get_last_assistant_text", success: true, data: { text: "fallback answer" } })}\n`,
		);

		expect(assistantText(await result)).toBe("fallback answer");
		await handledResult;
	});

	test("uses fallback text after malformed assistant message_end", async () => {
		// Purpose: malformed assistant payloads must not become trusted participant output.
		// Input and expected output: role-only message_end is ignored and fallback text is returned.
		// Edge case: malformed payload arrives before agent_settled.
		// Dependencies: fake JSONL transport.
		const fake = createTransport();
		const client = new CouncilRpcClient(fake.transport, BASE_FACTS);

		const result = client.prompt("final task");
		const handledResult = result.catch(() => undefined);
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "1", command: "prompt", success: true })}\n`,
		);
		emitRpc(fake, { type: "message_end", message: { role: "assistant" } });
		emitRpc(fake, { type: "agent_end" });
		emitAgentSettled(fake);
		expect(writtenCommand(fake.writes[1] ?? "{}")).toMatchObject({
			type: "get_last_assistant_text",
		});
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "2", command: "get_last_assistant_text", success: true, data: { text: "fallback after malformed" } })}\n`,
		);

		expect(assistantText(await result)).toBe("fallback after malformed");
		await handledResult;
	});

	test("uses fallback text after assistant message_end without api", async () => {
		// Purpose: assistant payloads must include api before becoming trusted participant output.
		// Input and expected output: message without api is ignored and fallback text is returned.
		// Edge case: all other assistant fields are present.
		// Dependencies: fake JSONL transport.
		const fake = createTransport();
		const client = new CouncilRpcClient(fake.transport, BASE_FACTS);
		const { api: _api, ...messageWithoutApi } = assistantMessage("missing api");

		const result = client.prompt("final task");
		const handledResult = result.catch(() => undefined);
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "1", command: "prompt", success: true })}\n`,
		);
		emitRpc(fake, { type: "message_end", message: messageWithoutApi });
		emitRpc(fake, { type: "agent_end" });
		emitAgentSettled(fake);
		expect(writtenCommand(fake.writes[1] ?? "{}")).toMatchObject({
			type: "get_last_assistant_text",
		});
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "2", command: "get_last_assistant_text", success: true, data: { text: "fallback without api" } })}\n`,
		);

		expect(assistantText(await result)).toBe("fallback without api");
		await handledResult;
	});

	test("clears the active prompt when prompt acceptance fails", async () => {
		// Purpose: one failed prompt command must not permanently block later prompts.
		// Input and expected output: first prompt rejects; second prompt writes a new prompt command.
		// Edge case: active prompt is cleared from the prompt response failure path.
		// Dependencies: fake JSONL transport.
		const fake = createTransport();
		const client = new CouncilRpcClient(fake.transport, BASE_FACTS);

		const first = client.prompt("first");
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "1", command: "prompt", success: false, error: "busy" })}\n`,
		);
		const firstFailure = await first.catch((error: unknown) => error);
		expect(firstFailure).toBeInstanceOf(CouncilRpcCommandError);
		expect(firstFailure).toMatchObject({ command: "prompt", message: "busy" });
		const second = client.prompt("second");

		expect(writtenCommand(fake.writes[1]?.trimEnd() ?? "{}")).toMatchObject({
			type: "prompt",
			message: "second",
		});
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "2", command: "prompt", success: false, error: "still busy" })}\n`,
		);
		await expect(second).rejects.toThrow("still busy");
	});

	test("writes direct Pi RPC abort commands", () => {
		// Purpose: abort must use Pi's direct RPC command shape, not a wrapped compatibility envelope.
		// Input and expected output: abort writes one LF-delimited direct abort command.
		// Edge case: abort is fire-and-forget and has no pending response.
		// Dependencies: fake JSONL transport.
		const fake = createTransport();
		const client = new CouncilRpcClient(fake.transport, BASE_FACTS);

		client.abort();

		expect(writtenCommand(fake.writes[0] ?? "{}")).toMatchObject({
			type: "abort",
		});
	});

	test("fails closed for extension UI requests", async () => {
		// Purpose: child UI prompts must not block council runs or grant implicit approval.
		// Input and expected output: confirm returns false; input/select/editor are cancelled.
		// Edge case: each request id receives a matching response.
		// Dependencies: fake JSONL transport.
		const fake = createTransport();
		new CouncilRpcClient(fake.transport, BASE_FACTS);

		fake.stdout(
			`${JSON.stringify({ type: "extension_ui_request", id: "confirm-id", method: "confirm" })}\n`,
		);
		fake.stdout(
			`${JSON.stringify({ type: "extension_ui_request", id: "input-id", method: "input" })}\n`,
		);

		expect(writtenCommand(fake.writes[0] ?? "{}")).toEqual({
			type: "extension_ui_response",
			id: "confirm-id",
			confirmed: false,
		});
		expect(writtenCommand(fake.writes[1] ?? "{}")).toEqual({
			type: "extension_ui_response",
			id: "input-id",
			cancelled: true,
		});
	});

	test("uses LF-only JSONL framing and keeps bounded diagnostic buffers", () => {
		// Purpose: JSON strings may contain Unicode separators and stderr/stdout diagnostics must stay bounded.
		// Input and expected output: U+2028 stays inside JSON text; buffers are capped by exported constants.
		// Edge case: records can arrive split across chunks.
		// Dependencies: fake JSONL transport.
		const fake = createTransport();
		const client = new CouncilRpcClient(fake.transport, BASE_FACTS);
		const result = client.prompt("diagnostic task");
		const record = JSON.stringify({
			type: "response",
			id: "1",
			command: "prompt",
			success: false,
			error: "line separator   inside JSON",
		});

		fake.stdout(`${record.slice(0, 20)}`);
		fake.stdout(`${record.slice(20)}\n`);
		fake.stderr("x".repeat(COUNCIL_RPC_STDERR_MAX_CHARS + 10));
		fake.stdout("🔥".repeat(COUNCIL_RPC_STDOUT_SUFFIX_MAX_BYTES));

		expect(client.diagnostics.stderr.length).toBe(COUNCIL_RPC_STDERR_MAX_CHARS);
		expect(client.diagnostics.stdoutSuffix.length).toBeLessThanOrEqual(
			COUNCIL_RPC_STDOUT_SUFFIX_MAX_BYTES,
		);
		return expect(result).rejects.toThrow("line separator   inside JSON");
	});
});
