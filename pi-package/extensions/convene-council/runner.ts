import { spawn } from "node:child_process";
import { env as processEnv } from "node:process";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type ChildAuthStartupAttemptRecord,
	type ChildParentAuthResult,
	normalizeChildPrompt,
	runChildAuthStartup,
} from "../../shared/child-auth-startup";
import { resolveChildRpcRuntimeFacts } from "../../shared/child-rpc-runtime-facts";
import type {
	ChildStartupAuthRetryConfig,
	ChildStartupConfig,
} from "../../shared/child-startup-config";
import {
	type ChildStartupGate,
	sharedChildStartupGate,
} from "../../shared/child-startup-gate";
import { CouncilRpcClient, type CouncilRpcTransport } from "./rpc-client";
import { buildChildParticipantStartupFromToolArgs } from "./startup";
import type { ParticipantRunner, ParticipantRunnerFactory } from "./types";

export const COUNCIL_RPC_ABORT_GRACE_MS = 10_000;
export const COUNCIL_RPC_TERM_GRACE_MS = 5_000;

export interface SpawnedParticipantProcess {
	readonly stdin: {
		write(chunk: string): boolean;
		on(event: "error", handler: (error: Error) => void): unknown;
	};
	readonly stdout: {
		on(event: "data", handler: (chunk: unknown) => void): unknown;
	};
	readonly stderr: {
		on(event: "data", handler: (chunk: unknown) => void): unknown;
	};
	on(event: "error", handler: (error: Error) => void): unknown;
	on(event: "exit" | "close", handler: () => void): unknown;
	kill(signal?: string): boolean;
}

export interface ParticipantRunnerFactoryDependencies {
	setTimeout?: (callback: () => void, delayMs: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
	startupGate?: ChildStartupGate;
	childStartupConfig: ChildStartupConfig;
	recordChildStartupAttempt: (record: ChildAuthStartupAttemptRecord) => void;
	spawnPi(
		command: string,
		args: readonly string[],
		options: { readonly cwd: string; readonly env: Record<string, string> },
	): SpawnedParticipantProcess;
}

/** Creates a participant runner factory whose participants share one startup gate. */
export function createParticipantRunnerFactory(
	dependencies: ParticipantRunnerFactoryDependencies,
): ParticipantRunnerFactory {
	const startupGate = dependencies.startupGate ?? sharedChildStartupGate;
	return async (options) => {
		const startup = buildChildParticipantStartupFromToolArgs({
			plan: options.startupPlan,
			runtime: options.runtime,
			sessionFile: options.sessionFile,
			sessionDir: options.sessionDir,
			systemPrompt: options.systemPrompt,
			toolArgs: options.toolArgs,
		});
		const runtimeFacts = resolveChildRpcRuntimeFacts({
			modelId: `${options.runtime.model.provider}/${options.runtime.model.id}`,
			modelRegistry: options.ctx.modelRegistry,
		});
		const model = options.runtime.model;
		return new RpcParticipantRunner({
			launch(onSessionEvent) {
				const child = dependencies.spawnPi("pi", startup.args, {
					cwd: options.ctx.cwd,
					env: startup.env,
				});
				return {
					child,
					client: new CouncilRpcClient(
						createProcessTransport(child),
						runtimeFacts,
						onSessionEvent,
					),
				};
			},
			startupGate,
			provider: model.provider,
			providerConfigured: options.ctx.modelRegistry.hasConfiguredAuth(model),
			checkParentAuth: async () => {
				const auth = await options.ctx.modelRegistry.getApiKeyAndHeaders(model);
				return auth.ok ? { ok: true } : { ok: false, error: auth.error };
			},
			retry: dependencies.childStartupConfig.authRetry,
			recordChildStartupAttempt: dependencies.recordChildStartupAttempt,
			onSessionEvent: options.onSessionEvent,
			timers: {
				setTimeout: dependencies.setTimeout ?? globalThis.setTimeout,
				clearTimeout:
					dependencies.clearTimeout ??
					((handle) => globalThis.clearTimeout(handle as never)),
			},
		});
	};
}

/** Creates the production RPC participant runner with startup-owned dependencies. */
export function createRpcParticipantRunnerFactory(options: {
	readonly childStartupConfig: ChildStartupConfig;
	readonly recordChildStartupAttempt: (
		record: ChildAuthStartupAttemptRecord,
	) => void;
}): ParticipantRunnerFactory {
	return createParticipantRunnerFactory({
		...options,
		spawnPi(command, args, spawnOptions) {
			return spawn(command, [...args], {
				cwd: spawnOptions.cwd,
				env: { ...filterProcessEnv(), ...spawnOptions.env },
				stdio: ["pipe", "pipe", "pipe"],
			}) as unknown as SpawnedParticipantProcess;
		},
	});
}

/** Holds mutable lifecycle state for one participant process attempt. */
interface ActiveParticipantProcess {
	readonly child: SpawnedParticipantProcess;
	readonly client: CouncilRpcClient;
	readonly exitWaiters: Set<() => void>;
	abortTimer: unknown;
	exited: boolean;
	termTimer: unknown;
}

/** Supplies cancellable process-escalation timers to the participant runner. */
interface ParticipantRunnerTimers {
	readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
	readonly clearTimeout: (handle: unknown) => void;
}

/** Creates one child process and its RPC client for a startup attempt. */
type LaunchParticipantProcess = (onSessionEvent: (event: unknown) => void) => {
	readonly child: SpawnedParticipantProcess;
	readonly client: CouncilRpcClient;
};

/** Groups process launch, recovery, event, and timer dependencies for one runner. */
interface RpcParticipantRunnerOptions {
	readonly launch: LaunchParticipantProcess;
	readonly startupGate: ChildStartupGate;
	readonly provider: string;
	readonly providerConfigured: boolean;
	readonly checkParentAuth: () => Promise<ChildParentAuthResult>;
	readonly retry: ChildStartupAuthRetryConfig;
	readonly recordChildStartupAttempt: (
		record: ChildAuthStartupAttemptRecord,
	) => void;
	readonly onSessionEvent: ((event: unknown) => void) | undefined;
	readonly timers: ParticipantRunnerTimers;
}

/** Participant runner that serializes fresh process startup and then reuses one RPC process. */
class RpcParticipantRunner implements ParticipantRunner {
	private active: ActiveParticipantProcess | undefined;
	private disposed = false;

	constructor(private readonly options: RpcParticipantRunnerOptions) {}

	async prompt(
		task: string,
		signal: AbortSignal | undefined,
	): Promise<AssistantMessage> {
		const prompt = normalizeChildPrompt(task);
		const active = this.active;
		return active === undefined
			? this.startFirstPrompt(prompt, signal)
			: this.promptActive(active, prompt, signal);
	}

	/** Stops the active participant process and prevents delayed startup. */
	async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		const active = this.active;
		if (active !== undefined) {
			this.disposeActive(active);
		}
	}

	/** Delegates the first prompt lifecycle to shared authentication recovery. */
	private startFirstPrompt(
		task: string,
		signal: AbortSignal | undefined,
	): Promise<AssistantMessage> {
		return runChildAuthStartup({
			owner: "convene-council",
			provider: this.options.provider,
			providerConfigured: this.options.providerConfigured,
			retry: this.options.retry,
			startupGate: this.options.startupGate,
			signal,
			cancellationError: () => new Error("participant request aborted"),
			checkParentAuth: this.options.checkParentAuth,
			start: async () => {
				if (signal?.aborted) {
					throw new Error("participant request aborted");
				}
				if (this.disposed) {
					throw new Error("participant runner disposed");
				}
				return this.activate();
			},
			prompt: (active, onAccepted) =>
				this.promptActive(active, task, signal, onAccepted),
			stop: (active) => this.stopFailedAttempt(active),
			recordAttempt: this.options.recordChildStartupAttempt,
		});
	}

	/** Creates one persistent child process after startup ownership is granted. */
	private activate(): ActiveParticipantProcess {
		const launched = this.options.launch((event) => {
			this.options.onSessionEvent?.(event);
		});
		const active: ActiveParticipantProcess = {
			child: launched.child,
			client: launched.client,
			exitWaiters: new Set(),
			abortTimer: undefined,
			exited: false,
			termTimer: undefined,
		};
		this.active = active;
		active.child.on("error", (error) => this.markProcessError(active, error));
		active.child.on("exit", () => this.markExited(active));
		active.child.on("close", () => this.markExited(active));
		return active;
	}

	/** Sends a prompt and ties parent cancellation to the active process only. */
	private promptActive(
		active: ActiveParticipantProcess,
		task: string,
		signal: AbortSignal | undefined,
		onPromptAccepted?: () => void,
	): Promise<AssistantMessage> {
		const abort = (): void => this.startAbortEscalation(active);
		if (signal?.aborted === true) {
			abort();
		} else {
			signal?.addEventListener("abort", abort, { once: true });
		}
		return active.client.prompt(task, onPromptAccepted).finally(() => {
			signal?.removeEventListener("abort", abort);
		});
	}

	/** Stops a failed startup process before shared recovery can launch a replacement. */
	private async stopFailedAttempt(
		active: ActiveParticipantProcess,
	): Promise<void> {
		this.clearEscalationTimers(active);
		active.client.close();
		if (!active.exited) {
			const gracefulExit = this.waitForExit(active, COUNCIL_RPC_TERM_GRACE_MS);
			active.child.kill("SIGTERM");
			if (!(await gracefulExit)) {
				const forcedExit = this.waitForExit(active, COUNCIL_RPC_TERM_GRACE_MS);
				active.child.kill("SIGKILL");
				if (!(await forcedExit)) {
					throw new Error("participant process remained active after SIGKILL");
				}
			}
		}
		this.detachActive(active);
	}

	/** Waits for one process exit with a bounded owner-supplied timer. */
	private waitForExit(
		active: ActiveParticipantProcess,
		timeoutMs: number,
	): Promise<boolean> {
		if (active.exited) {
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			let settled = false;
			let timer: unknown;
			const finish = (exited: boolean): void => {
				if (settled) {
					return;
				}
				settled = true;
				active.exitWaiters.delete(onExit);
				if (exited) {
					this.options.timers.clearTimeout(timer);
				}
				resolve(exited);
			};
			const onExit = (): void => finish(true);
			active.exitWaiters.add(onExit);
			timer = this.options.timers.setTimeout(() => finish(false), timeoutMs);
		});
	}

	/** Closes one process without waiting when the whole runner is being disposed. */
	private disposeActive(active: ActiveParticipantProcess): void {
		this.clearEscalationTimers(active);
		active.client.close();
		if (!active.exited) {
			active.child.kill("SIGTERM");
		}
		this.detachActive(active);
	}

	/** Removes one attempt only when it still owns the persistent runner slot. */
	private detachActive(active: ActiveParticipantProcess): void {
		if (this.active === active) {
			this.active = undefined;
		}
	}

	/** Escalates parent cancellation from RPC abort to process termination. */
	private startAbortEscalation(active: ActiveParticipantProcess): void {
		active.client.abort();
		if (active.abortTimer !== undefined || active.exited) {
			return;
		}
		active.abortTimer = this.options.timers.setTimeout(() => {
			active.abortTimer = undefined;
			if (active.exited) {
				return;
			}
			active.child.kill("SIGTERM");
			active.termTimer = this.options.timers.setTimeout(() => {
				active.termTimer = undefined;
				if (!active.exited) {
					active.child.kill("SIGKILL");
				}
			}, COUNCIL_RPC_TERM_GRACE_MS);
		}, COUNCIL_RPC_ABORT_GRACE_MS);
	}

	/** Records process exit and rejects RPC work still waiting on that process. */
	private markExited(active: ActiveParticipantProcess): void {
		if (active.exited) {
			return;
		}
		active.exited = true;
		this.clearEscalationTimers(active);
		for (const waiter of active.exitWaiters) {
			waiter();
		}
		active.exitWaiters.clear();
		active.client.handleTransportFailure(new Error("child process exited"));
	}

	/** Routes process creation failures to the matching RPC client. */
	private markProcessError(
		active: ActiveParticipantProcess,
		error: Error,
	): void {
		active.client.handleTransportFailure(error);
	}

	/** Cancels termination timers owned by one process attempt. */
	private clearEscalationTimers(active: ActiveParticipantProcess): void {
		if (active.abortTimer !== undefined) {
			this.options.timers.clearTimeout(active.abortTimer);
			active.abortTimer = undefined;
		}
		if (active.termTimer !== undefined) {
			this.options.timers.clearTimeout(active.termTimer);
			active.termTimer = undefined;
		}
	}
}

/** Adapts a spawned child process to the RPC transport interface. */
function createProcessTransport(
	child: SpawnedParticipantProcess,
): CouncilRpcTransport {
	let failed = false;
	return {
		write(line: string): void {
			if (failed) {
				return;
			}
			try {
				child.stdin.write(line);
			} catch (error) {
				failed = true;
				throw error;
			}
		},
		onStdout(handler: (chunk: unknown) => void): void {
			child.stdout.on("data", handler);
		},
		onStderr(handler: (chunk: unknown) => void): void {
			child.stderr.on("data", handler);
		},
		onError(handler: (error: Error) => void): void {
			child.stdin.on("error", (error) => {
				failed = true;
				handler(error);
			});
		},
	};
}

/** Copies defined process environment values for child process inheritance. */
function filterProcessEnv(): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(processEnv)) {
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}
