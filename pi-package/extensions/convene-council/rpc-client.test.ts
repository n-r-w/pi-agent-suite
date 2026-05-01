import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
	COUNCIL_RPC_STDERR_MAX_CHARS,
	COUNCIL_RPC_STDOUT_SUFFIX_MAX_BYTES,
	CouncilRpcClient,
} from "./rpc-client";

/** Creates a fake RPC transport for client protocol tests. */
function createTransport() {
	const writes: string[] = [];
	let onStdout: ((chunk: string) => void) | undefined;
	let onStderr: ((chunk: string) => void) | undefined;
	return {
		transport: {
			write(line: string): void {
				writes.push(line);
			},
			onStdout(handler: (chunk: string) => void): void {
				onStdout = handler;
			},
			onStderr(handler: (chunk: string) => void): void {
				onStderr = handler;
			},
		},
		writes,
		stdout(chunk: string): void {
			onStdout?.(chunk);
		},
		stderr(chunk: string): void {
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

describe("CouncilRpcClient", () => {
	test("disables child auto-retry before accepting participant prompts", async () => {
		// Purpose: child retry semantics must be deterministic before the first participant prompt.
		// Input and expected output: initialize writes set_auto_retry(false) and waits for success.
		// Edge case: a prompt before successful initialization is rejected.
		// Dependencies: fake JSONL transport.
		const fake = createTransport();
		const client = new CouncilRpcClient(fake.transport);

		await expect(client.prompt("too early")).rejects.toThrow(
			"child auto-retry is not disabled",
		);
		const initialized = client.initialize();
		expect(writtenCommand(fake.writes[0] ?? "{}")).toMatchObject({
			type: "set_auto_retry",
			enabled: false,
		});
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "1", command: "set_auto_retry", success: true })}\n`,
		);

		await initialized;
	});

	test("writes newline-delimited JSONL commands", async () => {
		// Purpose: child Pi reads stdin as JSONL and needs LF command delimiters.
		// Input and expected output: initialize command is valid JSON followed by LF.
		// Edge case: tests parse the trimmed command separately from framing.
		// Dependencies: fake JSONL transport.
		const fake = createTransport();
		const client = new CouncilRpcClient(fake.transport);

		const initialized = client.initialize();

		expect(fake.writes[0]?.endsWith("\n")).toBe(true);
		expect(writtenCommand(fake.writes[0]?.trimEnd() ?? "{}")).toMatchObject({
			type: "set_auto_retry",
		});
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "1", command: "set_auto_retry", success: true })}\n`,
		);
		await initialized;
	});

	test("does not complete a prompt on prompt response success before agent_end", async () => {
		// Purpose: prompt response success only means the child accepted the prompt.
		// Input and expected output: message_end text resolves only after agent_end.
		// Edge case: stdout chunks can split valid LF-delimited JSON.
		// Dependencies: fake JSONL transport.
		const fake = createTransport();
		const client = new CouncilRpcClient(fake.transport);
		const initialized = client.initialize();
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "1", command: "set_auto_retry", success: true })}\n`,
		);
		await initialized;

		const result = client.prompt("review task");
		const handledResult = result.catch(() => undefined);
		expect(writtenCommand(fake.writes[1] ?? "{}")).toMatchObject({
			type: "prompt",
			message: "review task",
		});
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "2", command: "prompt", success: true })}\n`,
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

		expect(assistantText(await result)).toBe("answer");
		await handledResult;
		await completionProbe;
	});

	test("uses get_last_assistant_text when agent_end has no assistant message_end", async () => {
		// Purpose: participant output extraction must recover final text after agent_end.
		// Input and expected output: client requests get_last_assistant_text fallback and returns that text.
		// Edge case: fallback command response is correlated by id.
		// Dependencies: fake JSONL transport.
		const fake = createTransport();
		const client = new CouncilRpcClient(fake.transport);
		const initialized = client.initialize();
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "1", command: "set_auto_retry", success: true })}\n`,
		);
		await initialized;

		const result = client.prompt("final task");
		const handledResult = result.catch(() => undefined);
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "2", command: "prompt", success: true })}\n`,
		);
		fake.stdout(`${JSON.stringify({ type: "agent_end" })}\n`);
		expect(writtenCommand(fake.writes[2] ?? "{}")).toMatchObject({
			type: "get_last_assistant_text",
		});
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "3", command: "get_last_assistant_text", success: true, data: { text: "fallback answer" } })}\n`,
		);

		expect(assistantText(await result)).toBe("fallback answer");
		await handledResult;
	});

	test("keeps prompts disabled when auto-retry disabling fails", async () => {
		// Purpose: failed child setup must not allow participant prompts with ambiguous retry semantics.
		// Input and expected output: failed set_auto_retry rejects initialization and later prompt stays blocked.
		// Edge case: failure response is correlated by request id.
		// Dependencies: fake JSONL transport.
		const fake = createTransport();
		const client = new CouncilRpcClient(fake.transport);
		const initialized = client.initialize();
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "1", command: "set_auto_retry", success: false, error: "denied" })}\n`,
		);

		await expect(initialized).rejects.toThrow("denied");
		await expect(client.prompt("after failed init")).rejects.toThrow(
			"child auto-retry is not disabled",
		);
	});

	test("clears the active prompt when prompt acceptance fails", async () => {
		// Purpose: one failed prompt command must not permanently block later prompts.
		// Input and expected output: first prompt rejects; second prompt writes a new prompt command.
		// Edge case: active prompt is cleared from the prompt response failure path.
		// Dependencies: fake JSONL transport.
		const fake = createTransport();
		const client = new CouncilRpcClient(fake.transport);
		const initialized = client.initialize();
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "1", command: "set_auto_retry", success: true })}\n`,
		);
		await initialized;

		const first = client.prompt("first");
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "2", command: "prompt", success: false, error: "busy" })}\n`,
		);
		await expect(first).rejects.toThrow("busy");
		const second = client.prompt("second");

		expect(writtenCommand(fake.writes[2]?.trimEnd() ?? "{}")).toMatchObject({
			type: "prompt",
			message: "second",
		});
		fake.stdout(
			`${JSON.stringify({ type: "response", id: "3", command: "prompt", success: false, error: "still busy" })}\n`,
		);
		await expect(second).rejects.toThrow("still busy");
	});

	test("writes direct Pi RPC abort commands", () => {
		// Purpose: abort must use Pi's direct RPC command shape, not a wrapped compatibility envelope.
		// Input and expected output: abort writes one LF-delimited direct abort command.
		// Edge case: abort is fire-and-forget and has no pending response.
		// Dependencies: fake JSONL transport.
		const fake = createTransport();
		const client = new CouncilRpcClient(fake.transport);

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
		new CouncilRpcClient(fake.transport);

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
		const client = new CouncilRpcClient(fake.transport);
		const record = JSON.stringify({
			type: "response",
			id: "1",
			command: "set_auto_retry",
			success: false,
			error: "line separator   inside JSON",
		});

		const initialized = client.initialize();
		fake.stdout(`${record.slice(0, 20)}`);
		fake.stdout(`${record.slice(20)}\n`);
		fake.stderr("x".repeat(COUNCIL_RPC_STDERR_MAX_CHARS + 10));
		fake.stdout("🔥".repeat(COUNCIL_RPC_STDOUT_SUFFIX_MAX_BYTES));

		expect(client.diagnostics.stderr.length).toBe(COUNCIL_RPC_STDERR_MAX_CHARS);
		expect(client.diagnostics.stdoutSuffix.length).toBeLessThanOrEqual(
			COUNCIL_RPC_STDOUT_SUFFIX_MAX_BYTES,
		);
		return expect(initialized).rejects.toThrow("line separator   inside JSON");
	});
});
