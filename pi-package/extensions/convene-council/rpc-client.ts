import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
	CHILD_RPC_STDERR_TEXT_LIMIT,
	CHILD_RPC_STDOUT_LINE_BUFFER_LIMIT,
	ChildRpcStreamParser,
} from "../../shared/child-rpc-stream";

export const COUNCIL_RPC_STDOUT_SUFFIX_MAX_BYTES =
	CHILD_RPC_STDOUT_LINE_BUFFER_LIMIT;
export const COUNCIL_RPC_STDERR_MAX_CHARS = CHILD_RPC_STDERR_TEXT_LIMIT;

export interface CouncilRpcTransport {
	write(line: string): void;
	onStdout(handler: (chunk: unknown) => void): void;
	onStderr(handler: (chunk: unknown) => void): void;
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
	private readonly parser = new ChildRpcStreamParser();
	readonly diagnostics = this.parser.diagnostics;

	private nextId = 1;
	private stdoutProcessing: Promise<void> = Promise.resolve();
	private stdoutProcessingPending = false;
	private readonly pendingCommands = new Map<string, PendingCommand>();
	private activePrompt: ActivePrompt | undefined;

	constructor(
		private readonly transport: CouncilRpcTransport,
		private readonly onSessionEvent?: (event: unknown) => void,
	) {
		this.transport.onStdout((chunk) => this.processStdout(chunk));
		this.transport.onStderr((chunk) => this.processStderr(chunk));
	}

	/** Sends an RPC abort command without closing the persistent child session. */
	abort(): void {
		const id = String(this.nextId);
		this.nextId += 1;
		this.writeCommand({ id, type: "abort" });
	}

	/** Sends one participant prompt and resolves only after the child turn ends. */
	async prompt(task: string): Promise<AssistantMessage> {
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

	private processStdout(chunk: unknown): void {
		const processChunk = () =>
			this.parser.processStdoutChunk(chunk, (message) => {
				this.processMessage(message);
			});
		const handleError = (error: string | undefined): void => {
			if (error !== undefined) {
				this.rejectTransportError(new Error(error));
			}
		};
		if (!this.stdoutProcessingPending) {
			const error = processChunk();
			if (!isPromiseLike(error)) {
				handleError(error);
				return;
			}
			this.stdoutProcessingPending = true;
			const processing = error.then(handleError);
			const trackedProcessing = processing.finally(() => {
				if (this.stdoutProcessing === trackedProcessing) {
					this.stdoutProcessingPending = false;
				}
			});
			this.stdoutProcessing = trackedProcessing;
			return;
		}

		const processing = this.stdoutProcessing.then(async () => {
			const error = await processChunk();
			handleError(error);
		});
		const trackedProcessing = processing.finally(() => {
			if (this.stdoutProcessing === trackedProcessing) {
				this.stdoutProcessingPending = false;
			}
		});
		this.stdoutProcessing = trackedProcessing;
	}

	private processStderr(chunk: unknown): void {
		this.parser.processStderrChunk(chunk);
	}

	private processMessage(message: unknown): void {
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

	private rejectTransportError(error: Error): void {
		this.rejectActivePrompt(error);
		for (const [id, pending] of this.pendingCommands) {
			this.pendingCommands.delete(id);
			pending.reject(error);
		}
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

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
	return isRecord(value) && typeof value["then"] === "function";
}
