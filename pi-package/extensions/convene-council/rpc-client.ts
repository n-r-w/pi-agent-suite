import type { AssistantMessage } from "@mariozechner/pi-ai";

const BYTES_PER_KIB = 1024;
const STDOUT_SUFFIX_MAX_KIB = 256;
const TRAILING_CR = /\r$/;

export const COUNCIL_RPC_STDOUT_SUFFIX_MAX_BYTES =
	STDOUT_SUFFIX_MAX_KIB * BYTES_PER_KIB;
export const COUNCIL_RPC_STDERR_MAX_CHARS = 64_000;

const TEXT_ENCODER = new TextEncoder();

export interface CouncilRpcTransport {
	write(line: string): void;
	onStdout(handler: (chunk: string) => void): void;
	onStderr(handler: (chunk: string) => void): void;
}

interface PendingCommand {
	readonly command: string;
	resolve(value: unknown): void;
	reject(error: Error): void;
}

interface ActivePrompt {
	readonly resolve: (message: AssistantMessage) => void;
	readonly reject: (error: Error) => void;
	lastAssistantMessage: AssistantMessage | undefined;
}

/** Handles the JSONL RPC protocol for one persistent council participant. */
export class CouncilRpcClient {
	readonly diagnostics = { stdoutSuffix: "", stderr: "" };

	private initialized = false;
	private nextId = 1;
	private stdoutBuffer = "";
	private readonly pendingCommands = new Map<string, PendingCommand>();
	private activePrompt: ActivePrompt | undefined;

	constructor(
		private readonly transport: CouncilRpcTransport,
		private readonly onSessionEvent?: (event: unknown) => void,
	) {
		this.transport.onStdout((chunk) => this.processStdout(chunk));
		this.transport.onStderr((chunk) => this.processStderr(chunk));
	}

	/** Disables child auto-retry before any participant prompt can run. */
	async initialize(): Promise<void> {
		await this.request("set_auto_retry", { enabled: false });
		this.initialized = true;
	}

	/** Sends an RPC abort command without closing the persistent child session. */
	abort(): void {
		const id = String(this.nextId);
		this.nextId += 1;
		this.writeCommand({ id, type: "abort" });
	}

	/** Sends one participant prompt and resolves only after the child turn ends. */
	async prompt(task: string): Promise<AssistantMessage> {
		if (!this.initialized) {
			throw new Error("child auto-retry is not disabled");
		}
		if (this.activePrompt !== undefined) {
			throw new Error("participant prompt is already running");
		}

		return new Promise<AssistantMessage>((resolve, reject) => {
			this.activePrompt = {
				resolve,
				reject,
				lastAssistantMessage: undefined,
			};
			this.request("prompt", { message: task }).catch((error) => {
				if (this.activePrompt !== undefined) {
					this.activePrompt = undefined;
					reject(error instanceof Error ? error : new Error("prompt failed"));
				}
			});
		});
	}

	private request(
		command: string,
		data: Record<string, unknown>,
	): Promise<unknown> {
		const id = String(this.nextId);
		this.nextId += 1;
		this.writeCommand({ id, type: command, ...data });
		return new Promise((resolve, reject) => {
			this.pendingCommands.set(id, { command, resolve, reject });
		});
	}

	private writeCommand(command: Record<string, unknown>): void {
		this.transport.write(`${JSON.stringify(command)}\n`);
	}

	private processStdout(chunk: string): void {
		this.diagnostics.stdoutSuffix = retainUtf8Suffix(
			this.diagnostics.stdoutSuffix + chunk,
			COUNCIL_RPC_STDOUT_SUFFIX_MAX_BYTES,
		);
		this.stdoutBuffer += chunk;
		let newlineIndex = this.stdoutBuffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const rawLine = this.stdoutBuffer
				.slice(0, newlineIndex)
				.replace(TRAILING_CR, "");
			this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
			if (rawLine.length > 0) {
				this.processLine(rawLine);
			}
			newlineIndex = this.stdoutBuffer.indexOf("\n");
		}
		this.stdoutBuffer = retainUtf8Suffix(
			this.stdoutBuffer,
			COUNCIL_RPC_STDOUT_SUFFIX_MAX_BYTES,
		);
	}

	private processStderr(chunk: string): void {
		this.diagnostics.stderr = (this.diagnostics.stderr + chunk).slice(
			-COUNCIL_RPC_STDERR_MAX_CHARS,
		);
	}

	private processLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch (error) {
			this.rejectActivePrompt(
				error instanceof Error ? error : new Error("failed to parse child RPC"),
			);
			return;
		}

		if (!isRecord(message)) {
			return;
		}
		if (message["type"] === "response") {
			this.processResponse(message);
			return;
		}

		this.onSessionEvent?.(message);
		if (message["type"] === "message_end" || message["type"] === "agent_end") {
			this.processEvent(message);
			return;
		}
		if (message["type"] === "extension_ui_request") {
			this.processUiRequest(message);
		}
	}

	private processResponse(message: Record<string, unknown>): void {
		const id = typeof message["id"] === "string" ? message["id"] : undefined;
		if (id === undefined) {
			return;
		}
		const pending = this.pendingCommands.get(id);
		if (pending === undefined) {
			return;
		}
		this.pendingCommands.delete(id);
		if (message["success"] === false) {
			pending.reject(new Error(readRpcError(message)));
			return;
		}
		pending.resolve(message["data"]);
	}

	private processEvent(message: Record<string, unknown>): void {
		if (message["type"] === "message_end") {
			const rpcMessage = message["message"];
			if (isAssistantMessage(rpcMessage)) {
				const prompt = this.activePrompt;
				if (prompt !== undefined) {
					prompt.lastAssistantMessage = rpcMessage;
				}
			}
			return;
		}
		if (message["type"] === "agent_end") {
			this.finishActivePrompt();
		}
	}

	private processUiRequest(message: Record<string, unknown>): void {
		const id = typeof message["id"] === "string" ? message["id"] : undefined;
		if (id === undefined) {
			return;
		}
		const method = message["method"];
		if (method === "confirm") {
			this.writeCommand({
				type: "extension_ui_response",
				id,
				confirmed: false,
			});
			return;
		}
		this.writeCommand({ type: "extension_ui_response", id, cancelled: true });
	}

	private async finishActivePrompt(): Promise<void> {
		const prompt = this.activePrompt;
		if (prompt === undefined) {
			return;
		}
		this.activePrompt = undefined;
		if (prompt.lastAssistantMessage !== undefined) {
			prompt.resolve(prompt.lastAssistantMessage);
			return;
		}

		try {
			const fallback = await this.request("get_last_assistant_text", {});
			prompt.resolve(createAssistantMessage(readFallbackText(fallback)));
		} catch (error) {
			prompt.reject(
				error instanceof Error ? error : new Error("fallback failed"),
			);
		}
	}

	private rejectActivePrompt(error: Error): void {
		const prompt = this.activePrompt;
		if (prompt === undefined) {
			return;
		}
		this.activePrompt = undefined;
		prompt.reject(error);
	}
}

function readRpcError(message: Record<string, unknown>): string {
	return typeof message["error"] === "string"
		? message["error"]
		: "child RPC command failed";
}

function readFallbackText(data: unknown): string {
	return isRecord(data) && typeof data["text"] === "string" ? data["text"] : "";
}

function createAssistantMessage(content: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: content }],
		api: "unknown",
		provider: "unknown",
		model: "unknown",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	return isRecord(value) && value["role"] === "assistant";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retainUtf8Suffix(value: string, maxBytes: number): string {
	let result = value;
	while (TEXT_ENCODER.encode(result).byteLength > maxBytes) {
		result = result.slice(Math.max(1, Math.floor(result.length / 10)));
	}
	return result;
}
