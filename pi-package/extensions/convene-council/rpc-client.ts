import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type ChildRpcPromptCompletion,
	type ChildRpcPromptDecision,
	type ChildRpcRuntimeFacts,
	createChildRpcPromptCompletion,
} from "../../shared/child-rpc-completion";
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
	onError(handler: (error: Error) => void): void;
}

interface PendingCommand {
	readonly command: string;
	resolve(value: unknown): void;
	reject(error: Error): void;
}

interface ActivePrompt {
	readonly completion: ChildRpcPromptCompletion;
	readonly resolve: (message: AssistantMessage) => void;
	readonly reject: (error: Error) => void;
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
	private transportClosed = false;

	constructor(
		private readonly transport: CouncilRpcTransport,
		private readonly runtimeFacts: ChildRpcRuntimeFacts,
		private readonly onSessionEvent?: (event: unknown) => void,
	) {
		this.transport.onStdout((chunk) => this.processStdout(chunk));
		this.transport.onStderr((chunk) => this.processStderr(chunk));
		this.transport.onError((error) => this.handleTransportFailure(error));
	}

	/** Stops future RPC writes and rejects work that still depends on the child transport. */
	close(): void {
		this.handleTransportFailure(new Error("child RPC transport closed"));
	}

	/** Sends an RPC abort command without closing the persistent child session. */
	abort(): void {
		this.activePrompt?.completion.recordParentAbort();
		const id = String(this.nextId);
		this.nextId += 1;
		this.writeCommand({ id, type: "abort" });
	}

	/** Rejects active prompt and pending commands after child transport termination. */
	handleTransportFailure(error: Error): void {
		if (this.transportClosed) {
			return;
		}
		this.transportClosed = true;
		const prompt = this.activePrompt;
		if (prompt !== undefined) {
			const decision = prompt.completion.recordTransportFailure(error.message);
			this.applyPromptDecision(decision);
		}
		for (const [id, pending] of this.pendingCommands) {
			this.pendingCommands.delete(id);
			pending.reject(error);
		}
	}

	/** Sends one participant prompt and resolves only after the child turn ends. */
	async prompt(
		task: string,
		onPromptAccepted?: () => void,
	): Promise<AssistantMessage> {
		if (this.transportClosed) {
			throw new Error("child RPC transport closed");
		}
		if (this.activePrompt !== undefined) {
			throw new Error("participant prompt is already running");
		}

		return new Promise<AssistantMessage>((resolve, reject) => {
			this.activePrompt = {
				completion: createChildRpcPromptCompletion(this.runtimeFacts),
				resolve,
				reject,
			};
			this.request("prompt", { message: task }).then(
				() => onPromptAccepted?.(),
				(error) => {
					if (this.activePrompt !== undefined) {
						this.activePrompt = undefined;
						reject(error instanceof Error ? error : new Error("prompt failed"));
					}
				},
			);
		});
	}

	private request(
		command: string,
		data: Record<string, unknown>,
	): Promise<unknown> {
		if (this.transportClosed) {
			return Promise.reject(new Error("child RPC transport closed"));
		}
		const id = String(this.nextId);
		this.nextId += 1;
		return new Promise((resolve, reject) => {
			this.pendingCommands.set(id, { command, resolve, reject });
			this.writeCommand({ id, type: command, ...data });
		});
	}

	private writeCommand(command: Record<string, unknown>): void {
		if (this.transportClosed) {
			return;
		}
		try {
			this.transport.write(`${JSON.stringify(command)}\n`);
		} catch (error) {
			this.handleTransportFailure(
				error instanceof Error
					? error
					: new Error("child RPC transport write failed"),
			);
		}
	}

	private processStdout(chunk: unknown): void {
		if (this.transportClosed) {
			return;
		}
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
		if (isPromptCompletionEvent(message)) {
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
		const prompt = this.activePrompt;
		if (prompt === undefined) {
			return;
		}
		const completionEvent = normalizePromptCompletionEvent(message);
		const decision = prompt.completion.handleSessionEvent(completionEvent);
		this.applyPromptDecision(decision);
	}

	private applyPromptDecision(decision: ChildRpcPromptDecision): void {
		if (decision.kind === "wait") {
			return;
		}
		if (decision.kind === "success") {
			this.finishActivePrompt(decision.message);
			return;
		}
		this.rejectActivePrompt(new Error(decision.reason));
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

	private async finishActivePrompt(
		assistantMessage: AssistantMessage | undefined,
	): Promise<void> {
		const prompt = this.activePrompt;
		if (prompt === undefined) {
			return;
		}
		this.activePrompt = undefined;
		if (assistantMessage !== undefined) {
			prompt.resolve(assistantMessage);
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
		this.handleTransportFailure(error);
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

function normalizePromptCompletionEvent(
	message: Record<string, unknown>,
): Record<string, unknown> {
	if (message["type"] !== "message_end") {
		return message;
	}
	const rpcMessage = normalizeAssistantMessage(message["message"]);
	return rpcMessage === undefined
		? message
		: { ...message, message: rpcMessage };
}

function normalizeAssistantMessage(
	value: unknown,
): AssistantMessage | undefined {
	if (!isAssistantMessage(value)) {
		return undefined;
	}
	const record = value as AssistantMessage & { readonly content: unknown };
	return typeof record.content === "string"
		? { ...value, content: [{ type: "text", text: record.content }] }
		: value;
}

function isPromptCompletionEvent(message: Record<string, unknown>): boolean {
	return (
		message["type"] === "message_end" ||
		message["type"] === "agent_end" ||
		message["type"] === "auto_retry_start" ||
		message["type"] === "auto_retry_end" ||
		message["type"] === "compaction_end"
	);
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	return (
		isRecord(value) &&
		value["role"] === "assistant" &&
		(typeof value["content"] === "string" || Array.isArray(value["content"])) &&
		typeof value["api"] === "string" &&
		typeof value["provider"] === "string" &&
		typeof value["model"] === "string" &&
		isRecord(value["usage"]) &&
		typeof value["stopReason"] === "string" &&
		typeof value["timestamp"] === "number"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
	return isRecord(value) && typeof value["then"] === "function";
}
