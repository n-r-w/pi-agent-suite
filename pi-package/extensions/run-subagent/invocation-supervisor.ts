import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	createChildAuthStartupRetryError,
	normalizeChildPrompt,
	withChildAuthStartupRetry,
} from "../../shared/child-auth-startup";
import {
	type ChildRpcPromptCompletion,
	type ChildRpcPromptDecision,
	createChildRpcPromptCompletion,
} from "../../shared/child-rpc-completion";
import { ChildRpcStreamParser } from "../../shared/child-rpc-stream";
import {
	type ChildStartupGate,
	sharedChildStartupGate,
} from "../../shared/child-startup-gate";
import {
	CONTEXT_PROJECTION_STATUS_KEY,
	normalizePositiveProjectionStatus,
} from "../../shared/context-projection-status";
import {
	SUBAGENT_AGENT_ID_ENV,
	SUBAGENT_DEPTH_ENV,
	SUBAGENT_OWNER_SESSION_ENV,
	SUBAGENT_RUNTIME_LEASE_ENV,
	SUBAGENT_TOOL_PATTERNS_ENV,
} from "../../shared/subagent-environment";
import {
	readField,
	readNonEmptyString as readString,
} from "./boundary-validation";
import { readCancellationError } from "./cancellation-reason";
import type { LogicalSession } from "./domain";
import { createChildEnvironment } from "./environment";
import { errorMessage } from "./error-message";
import {
	type InvocationAcceptance,
	type InvocationControl,
	type InvocationLaunchConfiguration,
	type InvocationScope,
	InvocationStartError,
	type InvocationSteerScope,
	type InvocationSupervisorOptions,
	type NewInvocationRequest,
	type WorkerLaunchRequest,
} from "./invocation-contracts";
import {
	buildChildArgs,
	defaultPackagePath,
	defaultRuntimeFacts,
	defaultSpawnProcess,
	formatExitFailure,
	readAssistantText,
	terminalObservation,
	terminateProcess,
	withTimeout,
} from "./invocation-process";
import type { RuntimeRequest } from "./runtime-wire";
import { parseConversationSessionEntry } from "./session-entry-validation";

const PROMPT_COMMAND_ID = "prompt";
const WORKER_READY_TIMEOUT_MS = 10_000;
/** Converts compact k-suffixed projection counts to complete token counts. */
const TOKENS_PER_THOUSAND = 1_000;

interface RpcPending {
	readonly command: "prompt" | "steer" | "get_entries";
	readonly resolve: (data?: unknown) => void;
	readonly reject: (error: Error) => void;
}

/** One validated append-order page returned by Pi's get_entries RPC command. */
export interface ActiveConversationEntries {
	readonly entries: readonly SessionEntry[];
	readonly leafId: string | null;
}

/** Carries one prompt-bearing RPC and its optional dispatch reservation. */
interface PromptRpcCommand {
	readonly id: string;
	readonly command: "prompt" | "steer";
	readonly message: string;
	readonly beforeDispatch?: () => void;
}

interface InvocationHandle {
	readonly acceptance: InvocationAcceptance;
	readonly ownerRuntimeLeaseId?: string;
	readonly launchDepth: number;
	readonly process: ChildProcess;
	readonly parser: ChildRpcStreamParser;
	readonly completion: ChildRpcPromptCompletion;
	readonly pending: Map<string, RpcPending>;
	readonly startupFailure: Promise<never>;
	readonly rejectStartupFailure: (error: Error) => void;
	processing: Promise<void>;
	accepted: boolean;
	activityObserved: boolean;
	terminalObserved: boolean;
	teardown: Promise<void> | undefined;
	lastAssistantText: string;
	contextTokens: number | undefined;
	projectionSavedTokens: number | undefined;
}

/** Owns one process, RPC stream, and runtime lease per invocation. */
export class InvocationSupervisor implements InvocationControl {
	private readonly handles = new Map<string, InvocationHandle>();
	private readonly activityListeners = new Set<
		(invocationId: string) => void
	>();
	private readonly spawnProcess: NonNullable<
		InvocationSupervisorOptions["spawnProcess"]
	>;
	private readonly startupGate: ChildStartupGate;

	/** Binds process supervision to the production bridge and event sinks. */
	public constructor(private readonly options: InvocationSupervisorOptions) {
		this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
		this.startupGate = options.startupGate ?? sharedChildStartupGate;
	}

	/** Reads one active invocation entry page through documented Pi RPC. */
	public async readActiveEntries(
		invocationId: string,
		since?: string,
	): Promise<ActiveConversationEntries> {
		const handle = this.handles.get(invocationId);
		if (
			handle === undefined ||
			handle.teardown !== undefined ||
			handle.process.stdin === null ||
			!handle.process.stdin.writable
		) {
			throw new Error("active child Pi conversation is unavailable");
		}
		const requestId = `entries-${randomUUID()}`;
		const data = new Promise<unknown>((resolve, reject) => {
			handle.pending.set(requestId, {
				command: "get_entries",
				resolve,
				reject,
			});
		});
		handle.process.stdin.write(
			`${JSON.stringify({ id: requestId, type: "get_entries", ...(since === undefined ? {} : { since }) })}\n`,
		);
		return activeEntriesFromRpcData(await data);
	}

	/** Subscribes one read-only listener to live child session activity. */
	public subscribeActivity(
		listener: (invocationId: string) => void,
	): () => void {
		this.activityListeners.add(listener);
		return () => this.activityListeners.delete(listener);
	}

	/** Starts a new saved Pi session and returns after prompt acceptance. */
	public start(request: NewInvocationRequest): Promise<InvocationAcceptance> {
		return this.launchAndAccept(request);
	}

	/** Reopens a saved session and returns after prompt acceptance. */
	public async continue(
		session: LogicalSession,
		prompt: string,
		scope: InvocationScope = {},
	): Promise<InvocationAcceptance> {
		// Same-session continuation joins the prior writer teardown before any new launch work.
		await awaitWithSignal(
			this.awaitPriorSessionTeardown(session),
			scope.signal,
		);
		const request: NewInvocationRequest = {
			owner: {
				ownerPiSessionId: session.key.ownerPiSessionId,
				ownerSessionFile: "",
			},
			sessionKey: session.key,
			agentId: session.agentId,
			taskName: session.taskName,
			prompt,
			...scope,
		};
		return this.launchAndAccept(request, session);
	}

	/** Owns the shared startup, retry, acceptance, and cancellation sequence. */
	private async launchAndAccept(
		request: NewInvocationRequest,
		savedSession?: LogicalSession,
	): Promise<InvocationAcceptance> {
		const launch = await this.requireLaunch(request);
		let acceptedHandle: InvocationHandle | undefined;
		try {
			return await withChildAuthStartupRetry(
				async () => {
					const release = requireStartupRelease(
						await this.startupGate.acquire(request.signal),
					);
					let handle: InvocationHandle | undefined;
					try {
						handle = await this.launchWorkerProcess(
							{
								...request,
								...(savedSession === undefined
									? {}
									: {
											childPiSessionId: savedSession.childPiSessionId,
											childSessionDir: savedSession.childSessionDir,
											childSessionFile: savedSession.childSessionFile,
										}),
								launchConfiguration: launch,
							},
							request.signal,
						);
						await awaitWithSignal(
							this.sendRpc(handle, {
								id: PROMPT_COMMAND_ID,
								command: "prompt",
								message: normalizeChildPrompt(request.prompt),
							}),
							request.signal,
						);
						handle.accepted = true;
						acceptedHandle = handle;
						return handle.acceptance;
					} catch (error) {
						if (handle !== undefined) {
							await this.stopHandle(handle);
						}
						if (request.signal?.aborted) {
							throw readCancellationError(request.signal);
						}
						const failure = toInvocationStartError(error);
						const retry = createChildAuthStartupRetryError({
							activityObserved: handle?.activityObserved ?? false,
							failure,
							parentAuthVerified: launch.parentAuthVerified,
							provider: launch.provider,
						});
						throw retry ?? failure;
					} finally {
						release();
					}
				},
				{ signal: request.signal },
			);
		} catch (error) {
			if (acceptedHandle !== undefined) {
				await this.stopHandle(acceptedHandle);
			}
			throw error;
		}
	}

	/** Launches one package-loaded worker without submitting a provider prompt. */
	public async launchWorker(
		request: WorkerLaunchRequest,
	): Promise<InvocationAcceptance> {
		return (await this.launchWorkerProcess(request)).acceptance;
	}

	/** Creates the process handle used by prompt-backed and prompt-free launches. */
	private async launchWorkerProcess(
		request: WorkerLaunchRequest,
		signal?: AbortSignal,
	): Promise<InvocationHandle> {
		const handle = this.createInvocationHandle(request);
		this.handles.set(handle.acceptance.invocationId, handle);
		this.attachProcess(handle);
		this.registerRuntimeLease(handle);
		const onProcessError = (error: Error): void =>
			handle.rejectStartupFailure(error);
		const onProcessClose = (
			code: number | null,
			processSignal: NodeJS.Signals | null,
		): void => {
			handle.rejectStartupFailure(
				new InvocationStartError(
					"start_failed",
					formatExitFailure(
						code,
						processSignal,
						handle.parser.diagnostics.stderr,
					),
				),
			);
		};
		handle.process.once("error", onProcessError);
		handle.process.once("close", onProcessClose);
		try {
			await awaitWithSignal(
				Promise.race([
					withTimeout(
						this.options.bridge.waitUntilReady(
							handle.acceptance.runtimeLeaseId,
						),
						WORKER_READY_TIMEOUT_MS,
						"worker Pi did not establish Node IPC",
					),
					handle.startupFailure,
				]),
				signal,
			);
			return handle;
		} catch (error) {
			await this.stopHandle(handle);
			if (signal?.aborted) {
				throw readCancellationError(signal);
			}
			if (error instanceof InvocationStartError) {
				throw error;
			}
			const stderr = handle.parser.diagnostics.stderr.trim();
			const message = errorMessage(error);
			throw new InvocationStartError(
				"start_failed",
				stderr.length === 0 ? message : `${message}: ${stderr}`,
			);
		} finally {
			handle.process.off("error", onProcessError);
			handle.process.off("close", onProcessClose);
		}
	}

	/** Creates one invocation handle and its single child process. */
	private createInvocationHandle(
		request: WorkerLaunchRequest,
	): InvocationHandle {
		const invocationId = randomUUID();
		const runtimeLeaseId = randomUUID();
		const childPiSessionId = request.childPiSessionId ?? randomUUID();
		const childSessionDir =
			request.childSessionDir ?? this.requireSessionsDir();
		mkdirSync(childSessionDir, { recursive: true });
		const process = this.spawnWorkerProcess(
			request,
			runtimeLeaseId,
			childPiSessionId,
			childSessionDir,
		);
		const launch = request.launchConfiguration;
		let rejectStartupFailure: (error: Error) => void = () => undefined;
		const startupFailure = new Promise<never>((_resolve, reject) => {
			rejectStartupFailure = reject;
		});
		startupFailure.catch(() => undefined);
		return {
			acceptance: {
				invocationId,
				runtimeLeaseId,
				childPiSessionId,
				childSessionDir,
				childSessionFile: request.childSessionFile ?? "",
				...(launch === undefined ? {} : { modelId: launch.modelId }),
				...(launch === undefined ? {} : { thinking: launch.thinking }),
				...(launch === undefined
					? {}
					: { contextWindow: launch.runtimeFacts.contextWindow }),
			},
			...(request.ownerRuntimeLeaseId === undefined
				? {}
				: { ownerRuntimeLeaseId: request.ownerRuntimeLeaseId }),
			launchDepth: request.launchConfiguration?.depth ?? 0,
			process,
			parser: new ChildRpcStreamParser(),
			completion: createChildRpcPromptCompletion(
				request.launchConfiguration?.runtimeFacts ?? defaultRuntimeFacts(),
			),
			pending: new Map(),
			startupFailure,
			rejectStartupFailure,
			processing: Promise.resolve(),
			accepted: false,
			activityObserved: false,
			terminalObserved: false,
			teardown: undefined,
			lastAssistantText: "",
			contextTokens: undefined,
			projectionSavedTokens: undefined,
		};
	}

	/** Spawns one child with RPC stdio and exactly one Node IPC descriptor. */
	private spawnWorkerProcess(
		request: WorkerLaunchRequest,
		runtimeLeaseId: string,
		childPiSessionId: string,
		childSessionDir: string,
	): ChildProcess {
		const launch = request.launchConfiguration;
		const args = buildChildArgs({
			packagePath: this.options.packagePath ?? defaultPackagePath(),
			childPiSessionId,
			childSessionDir,
			...(request.childSessionFile === undefined
				? {}
				: { childSessionFile: request.childSessionFile }),
			...(launch === undefined ? {} : { launch }),
		});
		const env = createChildEnvironment({
			...this.options.childEnvironment,
			[SUBAGENT_RUNTIME_LEASE_ENV]: runtimeLeaseId,
			[SUBAGENT_OWNER_SESSION_ENV]: childPiSessionId,
			[SUBAGENT_AGENT_ID_ENV]: request.agentId,
			[SUBAGENT_DEPTH_ENV]: String(launch?.depth ?? 0),
			...(launch?.toolPatterns === undefined
				? {}
				: {
						[SUBAGENT_TOOL_PATTERNS_ENV]: JSON.stringify(launch.toolPatterns),
					}),
		});
		return this.spawnProcess(this.options.command ?? "pi", args, {
			cwd: launch?.cwd ?? process.cwd(),
			env,
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		});
	}

	/** Registers one child handle as one validated runtime lease. */
	private registerRuntimeLease(handle: InvocationHandle): void {
		this.options.bridge.registerLease({
			runtimeLeaseId: handle.acceptance.runtimeLeaseId,
			owner: {
				ownerPiSessionId: handle.acceptance.childPiSessionId,
				ownerSessionFile: handle.acceptance.childSessionFile,
			},
			process: handle.process,
			onRequest: (request) => this.handleRuntimeRequest(handle, request),
			onFailure: (failure) => this.options.onRuntimeFailure?.(failure),
			onReady: (owner) => {
				Object.assign(handle.acceptance, {
					childSessionFile: owner.ownerSessionFile,
				});
			},
		});
	}

	/** Routes one child request with the owner file learned from worker readiness. */
	private handleRuntimeRequest(
		handle: InvocationHandle,
		request: RuntimeRequest,
	): Promise<unknown> {
		if (this.options.onRuntimeRequest === undefined) {
			return Promise.reject(
				new Error("root runtime request handler is unavailable"),
			);
		}
		return this.options.onRuntimeRequest(
			{
				ownerPiSessionId: request.ownerPiSessionId,
				ownerSessionFile: handle.acceptance.childSessionFile,
			},
			request,
		);
	}

	/** Joins the retained prior invocation teardown for one saved logical session. */
	private awaitPriorSessionTeardown(session: LogicalSession): Promise<void> {
		const priorHandle = this.handles.get(session.invocationId);
		return priorHandle === undefined
			? Promise.resolve()
			: this.stopHandle(priorHandle);
	}

	/** Submits active Pi RPC steering and returns after acceptance. */
	public async steer(
		invocationId: string,
		prompt: string,
		scope: InvocationSteerScope = {},
	): Promise<void> {
		const handle = this.handles.get(invocationId);
		if (
			handle === undefined ||
			!handle.accepted ||
			handle.terminalObserved ||
			handle.teardown !== undefined
		) {
			throw new InvocationStartError(
				"message_rejected",
				"active invocation cannot accept steering",
			);
		}
		if (scope.signal?.aborted) {
			throw readCancellationError(scope.signal);
		}
		await this.sendRpc(handle, {
			id: `steer-${randomUUID()}`,
			command: "steer",
			message: normalizeChildPrompt(prompt),
			// Dispatch authority is reserved after transport validation and before Pi can queue the prompt.
			...(scope.beforeDispatch === undefined
				? {}
				: { beforeDispatch: scope.beforeDispatch }),
		});
	}

	/** Terminates a failed worker and its complete retained handle closure. */
	public async terminateLease(runtimeLeaseId: string): Promise<void> {
		const handles = [...this.handles.values()];
		const runtimeLeaseIds = new Set([runtimeLeaseId]);
		let expanded = true;
		while (expanded) {
			expanded = false;
			for (const handle of handles) {
				if (
					handle.ownerRuntimeLeaseId !== undefined &&
					runtimeLeaseIds.has(handle.ownerRuntimeLeaseId) &&
					!runtimeLeaseIds.has(handle.acceptance.runtimeLeaseId)
				) {
					// Retained normal teardown handles keep deeper ownership reachable and joinable.
					runtimeLeaseIds.add(handle.acceptance.runtimeLeaseId);
					expanded = true;
				}
			}
		}
		const affected = handles.filter((handle) =>
			runtimeLeaseIds.has(handle.acceptance.runtimeLeaseId),
		);
		const results = await Promise.allSettled(
			affected.map((handle) => this.stopHandle(handle)),
		);
		const rejected = results.find((result) => result.status === "rejected");
		if (rejected !== undefined) {
			// Recovery sees one failure only after every selected process has settled its teardown.
			throw rejected.reason instanceof Error
				? rejected.reason
				: new Error(errorMessage(rejected.reason));
		}
	}

	/** Returns one active worker's root-relative depth by runtime lease. */
	public findRuntimeDepth(runtimeLeaseId: string): number | undefined {
		return [...this.handles.values()].find(
			(handle) =>
				handle.acceptance.runtimeLeaseId === runtimeLeaseId &&
				handle.teardown === undefined,
		)?.launchDepth;
	}

	/** Returns the active worker lease for one Pi owner session. */
	public findRuntimeLeaseForOwner(
		ownerPiSessionId: string,
	): string | undefined {
		return [...this.handles.values()].find(
			(handle) =>
				handle.acceptance.childPiSessionId === ownerPiSessionId &&
				handle.teardown === undefined,
		)?.acceptance.runtimeLeaseId;
	}

	/** Resolves one command response before terminal event processing continues. */
	private sendRpc(
		handle: InvocationHandle,
		request: PromptRpcCommand,
	): Promise<void> {
		if (handle.process.stdin === null || !handle.process.stdin.writable) {
			return Promise.reject(
				new InvocationStartError("start_failed", "child Pi stdin is closed"),
			);
		}
		request.beforeDispatch?.();
		const response = new Promise<void>((resolve, reject) => {
			handle.pending.set(request.id, {
				command: request.command,
				resolve: () => resolve(),
				reject,
			});
		});
		handle.process.stdin.write(
			`${JSON.stringify({ id: request.id, type: request.command, message: request.message })}\n`,
		);
		return response;
	}

	/** Installs bounded RPC parsing and first-observation process lifecycle handlers. */
	private attachProcess(handle: InvocationHandle): void {
		handle.process.stdout?.on("data", (chunk: unknown) => {
			handle.processing = handle.processing.then(async () => {
				const error = await handle.parser.processStdoutChunk(chunk, (event) => {
					this.handleRpcEvent(handle, event);
				});
				if (error !== undefined) {
					this.rejectPending(handle, new Error(error));
				}
			});
		});
		handle.process.stderr?.on("data", (chunk: unknown) => {
			handle.parser.processStderrChunk(chunk);
		});
		handle.process.on("error", (error) => {
			this.rejectPending(handle, error);
		});
		handle.process.on("close", (code, signal) => {
			handle.processing
				.then(() => this.handleProcessClose(handle, code, signal))
				.catch(() => undefined);
		});
	}

	/** Finalizes buffered diagnostics and accepted state after one child exits. */
	private async handleProcessClose(
		handle: InvocationHandle,
		code: number | null,
		signal: NodeJS.Signals | null,
	): Promise<void> {
		const parseError = await handle.parser.flushStdout((event) => {
			this.handleRpcEvent(handle, event);
		});
		handle.parser.flushStderr();
		if (parseError !== undefined) {
			this.rejectPending(handle, new Error(parseError));
		}
		this.rejectPending(
			handle,
			new InvocationStartError(
				"start_failed",
				formatExitFailure(code, signal, handle.parser.diagnostics.stderr),
			),
		);
		if (
			handle.accepted &&
			!handle.terminalObserved &&
			handle.teardown === undefined
		) {
			await this.options.onEvent({
				kind: "accepted-exit",
				invocationId: handle.acceptance.invocationId,
				exitCode: code,
				signal,
				...(handle.contextTokens === undefined
					? {}
					: { contextTokens: handle.contextTokens }),
				...(handle.projectionSavedTokens === undefined
					? {}
					: { projectionSavedTokens: handle.projectionSavedTokens }),
			});
		}
		// A terminal or overlapping teardown leaves removal to the shared teardown promise.
		if (!handle.terminalObserved && handle.teardown === undefined) {
			this.handles.delete(handle.acceptance.invocationId);
		}
	}

	/** Routes only documented RPC response and session-event fields. */
	private handleRpcEvent(handle: InvocationHandle, value: unknown): void {
		const type = readString(value, "type");
		if (type === "extension_error" && !handle.accepted) {
			const startupError = readString(value, "error");
			if (startupError !== undefined) {
				handle.rejectStartupFailure(
					new InvocationStartError("start_failed", startupError),
				);
				return;
			}
		}
		if (type === "response") {
			this.handleRpcResponse(handle, value);
			return;
		}
		if (type !== undefined) {
			handle.activityObserved = true;
			for (const listener of this.activityListeners) {
				listener(handle.acceptance.invocationId);
			}
		}
		const projectionUpdate = readProjectionUpdate(value);
		if (projectionUpdate !== undefined) {
			handle.projectionSavedTokens = projectionUpdate.savedTokens;
		}
		if (type === "message_end") {
			const message = readField(value, "message");
			const text = readAssistantText(message);
			if (text !== undefined) {
				handle.lastAssistantText = text;
			}
			if (readString(message, "role") === "assistant") {
				handle.contextTokens = readContextTokens(message);
			}
		}
		this.handleCompletionDecision(
			handle,
			handle.completion.handleSessionEvent(value),
		);
	}

	/** Resolves one documented Pi RPC command response. */
	private handleRpcResponse(handle: InvocationHandle, value: unknown): void {
		const id = readString(value, "id");
		const command = readString(value, "command");
		if (id === undefined || command === undefined) {
			return;
		}
		const pending = handle.pending.get(id);
		if (pending === undefined || pending.command !== command) {
			return;
		}
		handle.pending.delete(id);
		if (readField(value, "success") === true) {
			if (command === "prompt") {
				handle.accepted = true;
			}
			pending.resolve(readField(value, "data"));
			return;
		}
		const message =
			readString(value, "error") ?? "child Pi rejected the request";
		pending.reject(
			command === "get_entries"
				? new Error(message)
				: new InvocationStartError("message_rejected", message),
		);
	}

	/** Emits the first completion decision and retains process teardown ownership. */
	private handleCompletionDecision(
		handle: InvocationHandle,
		decision: ChildRpcPromptDecision,
	): void {
		if (decision.kind === "wait" || handle.terminalObserved) {
			return;
		}
		handle.terminalObserved = true;
		const terminal = terminalObservation(decision, handle.lastAssistantText);
		Promise.resolve(
			this.options.onEvent({
				kind: "terminal",
				invocationId: handle.acceptance.invocationId,
				...terminal,
				...(handle.contextTokens === undefined
					? {}
					: { contextTokens: handle.contextTokens }),
				...(handle.projectionSavedTokens === undefined
					? {}
					: { projectionSavedTokens: handle.projectionSavedTokens }),
			}),
		)
			.then(
				() => this.stopHandle(handle),
				() => this.stopHandle(handle),
			)
			.catch(() => undefined);
	}

	/** Rejects every command correlation through one observed transport failure. */
	private rejectPending(handle: InvocationHandle, error: Error): void {
		for (const pending of handle.pending.values()) {
			pending.reject(error);
		}
		handle.pending.clear();
	}

	/** Returns the one joinable teardown promise for every observation of this handle. */
	private stopHandle(handle: InvocationHandle): Promise<void> {
		if (handle.teardown === undefined) {
			// Assignment precedes process signaling so concurrent close and failure observers can join it.
			handle.teardown = Promise.resolve().then(() =>
				this.teardownHandle(handle),
			);
		}
		return handle.teardown;
	}

	/** Owns process cessation, bridge closure, and handle removal as one operation. */
	private async teardownHandle(handle: InvocationHandle): Promise<void> {
		this.options.bridge.beginCloseLease(handle.acceptance.runtimeLeaseId);
		let processStopped = false;
		try {
			await terminateProcess(handle.process);
			processStopped = true;
		} finally {
			this.options.bridge.closeLease(handle.acceptance.runtimeLeaseId);
			// Failed cessation retains the rejected promise so later recovery cannot release the writer.
			if (processStopped) {
				this.handles.delete(handle.acceptance.invocationId);
			}
		}
	}

	/** Resolves required launch configuration for provider-backed starts. */
	private requireLaunch(
		request: NewInvocationRequest,
	): Promise<InvocationLaunchConfiguration> {
		if (this.options.resolveLaunch === undefined) {
			return Promise.reject(
				new InvocationStartError(
					"start_failed",
					"invocation launch configuration is unavailable",
				),
			);
		}
		return this.options.resolveLaunch(request);
	}

	/** Returns the package-owned persistent child session directory. */
	private requireSessionsDir(): string {
		if (this.options.sessionsDir === undefined) {
			throw new InvocationStartError(
				"start_failed",
				"subagent sessions directory is unavailable",
			);
		}
		return this.options.sessionsDir;
	}
}

/** Converts queued startup cancellation to one explicit pre-acceptance failure. */
function requireStartupRelease(release: (() => void) | undefined): () => void {
	if (release === undefined) {
		throw new InvocationStartError(
			"start_failed",
			"child startup was cancelled before process launch",
		);
	}
	return release;
}

/** Converts any pre-acceptance failure to one approved public class. */
function toInvocationStartError(error: unknown): InvocationStartError {
	return error instanceof InvocationStartError
		? error
		: new InvocationStartError("start_failed", errorMessage(error));
}

/** Validates documented get_entries data for caller-owned incremental branch assembly. */
function activeEntriesFromRpcData(data: unknown): ActiveConversationEntries {
	if (!isRecord(data)) {
		throw new Error("child Pi returned invalid conversation data");
	}
	const rawEntries = data["entries"];
	const leafId = data["leafId"];
	if (
		!Array.isArray(rawEntries) ||
		!(leafId === null || typeof leafId === "string")
	) {
		throw new Error("child Pi returned invalid conversation entries");
	}
	return {
		entries: rawEntries.map((value) =>
			parseConversationSessionEntry(value, "child Pi"),
		),
		leafId,
	};
}

/** Reads one projection status update, including an explicit savings clear. */
function readProjectionUpdate(
	value: unknown,
): { readonly savedTokens?: number } | undefined {
	if (
		readString(value, "type") !== "extension_ui_request" ||
		readString(value, "method") !== "setStatus" ||
		readString(value, "statusKey") !== CONTEXT_PROJECTION_STATUS_KEY
	) {
		return undefined;
	}
	const normalized = normalizePositiveProjectionStatus(
		readString(value, "statusText"),
	);
	if (normalized === undefined) {
		return {};
	}
	const usesThousands = normalized.endsWith("k");
	const numericText = normalized.slice(1, usesThousands ? -1 : undefined);
	const numericValue = Number(numericText);
	const tokens = Math.round(
		numericValue * (usesThousands ? TOKENS_PER_THOUSAND : 1),
	);
	return Number.isSafeInteger(tokens) && tokens > 0
		? { savedTokens: tokens }
		: {};
}

/** Reads finalized assistant context usage from the documented Pi RPC message. */
function readContextTokens(message: unknown): number | undefined {
	const totalTokens = readField(readField(message, "usage"), "totalTokens");
	return typeof totalTokens === "number" &&
		Number.isSafeInteger(totalTokens) &&
		totalTokens >= 0
		? totalTokens
		: undefined;
}

/** Narrows unknown RPC values before field access. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Races one supervisor boundary with Pi cancellation without abandoning its owner. */
async function awaitWithSignal<T>(
	pending: Promise<T>,
	signal: AbortSignal | undefined,
): Promise<T> {
	if (signal === undefined) {
		return pending;
	}
	signal.throwIfAborted();
	let onAbort = (): void => undefined;
	const cancelled = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(readCancellationError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([pending, cancelled]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
