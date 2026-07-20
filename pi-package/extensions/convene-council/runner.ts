import { spawn } from "node:child_process";
import { env as processEnv } from "node:process";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	isChildAuthStartupError,
	withChildAuthStartupRetry,
} from "../../shared/child-auth-startup";
import { resolveChildRpcRuntimeFacts } from "../../shared/child-rpc-runtime-facts";
import { ChildStartupGate } from "../../shared/child-startup-gate";
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
	on(event: "exit", handler: () => void): unknown;
	kill(signal?: string): boolean;
}

export interface ParticipantRunnerFactoryDependencies {
	setTimeout?: (callback: () => void, delayMs: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
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
	const startupGate = new ChildStartupGate();
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
			cwd: options.ctx.cwd,
			env: startup.env,
		});
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
			provider: options.runtime.model.provider,
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

/** Creates the production RPC participant runner. */
export const createRpcParticipantRunner: ParticipantRunnerFactory =
	createParticipantRunnerFactory({
		spawnPi(command, args, options) {
			return spawn(command, [...args], {
				cwd: options.cwd,
				env: { ...filterProcessEnv(), ...options.env },
				stdio: ["pipe", "pipe", "pipe"],
			}) as unknown as SpawnedParticipantProcess;
		},
	});

/** Holds mutable lifecycle state for one participant process attempt. */
interface ActiveParticipantProcess {
	readonly activity: { observed: boolean };
	readonly child: SpawnedParticipantProcess;
	readonly client: CouncilRpcClient;
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
	readonly onSessionEvent: ((event: unknown) => void) | undefined;
	readonly timers: ParticipantRunnerTimers;
}

/** Carries the original prompt failure through bounded auth retry backoff. */
class RetryableParticipantAuthStartupError extends Error {
	constructor(readonly failure: Error) {
		super(failure.message);
		this.name = "RetryableParticipantAuthStartupError";
	}
}

/** Participant runner that serializes fresh process startup and then reuses one RPC process. */
class RpcParticipantRunner implements ParticipantRunner {
	private active: ActiveParticipantProcess | undefined;
	private disposed = false;

	constructor(private readonly options: RpcParticipantRunnerOptions) {}

	prompt(
		task: string,
		signal: AbortSignal | undefined,
	): Promise<AssistantMessage> {
		const active = this.active;
		return active === undefined
			? this.startFirstPrompt(task, signal)
			: this.promptActive(active, task, signal);
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

	/** Retries only a fresh child auth miss before prompt preflight or session activity. */
	private async startFirstPrompt(
		task: string,
		signal: AbortSignal | undefined,
	): Promise<AssistantMessage> {
		try {
			return await withChildAuthStartupRetry(
				async () => this.runFirstPromptAttempt(task, signal),
				{
					signal,
					shouldRetry: (error) =>
						error instanceof RetryableParticipantAuthStartupError,
				},
			);
		} catch (error) {
			if (error instanceof RetryableParticipantAuthStartupError) {
				throw error.failure;
			}
			throw error;
		}
	}

	/** Owns one serialized process launch and its prompt preflight result. */
	private async runFirstPromptAttempt(
		task: string,
		signal: AbortSignal | undefined,
	): Promise<AssistantMessage> {
		const releaseStartup = await this.options.startupGate.acquire(signal);
		if (releaseStartup === undefined) {
			throw new Error("participant request aborted");
		}
		let promptAccepted = false;
		try {
			if (this.disposed) {
				throw new Error("participant runner disposed");
			}
			const active = this.activate();
			try {
				return await this.promptActive(active, task, signal, () => {
					promptAccepted = true;
					releaseStartup();
				});
			} catch (error) {
				if (
					!promptAccepted &&
					!active.activity.observed &&
					error instanceof Error &&
					isChildAuthStartupError(error.message, this.options.provider)
				) {
					this.disposeActive(active);
					throw new RetryableParticipantAuthStartupError(error);
				}
				throw error;
			}
		} finally {
			releaseStartup();
		}
	}

	/** Creates one persistent child process after startup ownership is granted. */
	private activate(): ActiveParticipantProcess {
		const activity = { observed: false };
		const launched = this.options.launch((event) => {
			activity.observed = true;
			this.options.onSessionEvent?.(event);
		});
		const active: ActiveParticipantProcess = {
			activity,
			child: launched.child,
			client: launched.client,
			abortTimer: undefined,
			exited: false,
			termTimer: undefined,
		};
		this.active = active;
		active.child.on("error", (error) => this.markProcessError(active, error));
		active.child.on("exit", () => this.markExited(active));
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

	/** Closes one process attempt without affecting a replacement process. */
	private disposeActive(active: ActiveParticipantProcess): void {
		this.clearEscalationTimers(active);
		active.client.close();
		if (!active.exited) {
			active.child.kill("SIGTERM");
		}
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
		active.exited = true;
		this.clearEscalationTimers(active);
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
