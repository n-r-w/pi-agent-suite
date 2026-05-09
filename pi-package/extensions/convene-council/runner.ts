import { spawn } from "node:child_process";
import { env as processEnv } from "node:process";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { resolveChildRpcRuntimeFacts } from "../../shared/child-rpc-runtime-facts";
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

/** Creates a participant runner factory from process dependencies. */
export function createParticipantRunnerFactory(
	dependencies: ParticipantRunnerFactoryDependencies,
): ParticipantRunnerFactory {
	return async (options) => {
		const startup = buildChildParticipantStartupFromToolArgs({
			plan: options.startupPlan,
			runtime: options.runtime,
			sessionFile: options.sessionFile,
			sessionDir: options.sessionDir,
			systemPrompt: options.systemPrompt,
			toolArgs: options.toolArgs,
		});
		const child = dependencies.spawnPi("pi", startup.args, {
			cwd: options.ctx.cwd,
			env: startup.env,
		});
		const client = new CouncilRpcClient(
			createProcessTransport(child),
			resolveChildRpcRuntimeFacts({
				modelId: `${options.runtime.model.provider}/${options.runtime.model.id}`,
				modelRegistry: options.ctx.modelRegistry,
				cwd: options.ctx.cwd,
				env: startup.env,
			}),
			options.onSessionEvent,
		);
		return new RpcParticipantRunner(child, client, {
			setTimeout: dependencies.setTimeout ?? globalThis.setTimeout,
			clearTimeout:
				dependencies.clearTimeout ??
				((handle) => globalThis.clearTimeout(handle as never)),
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

/** Participant runner backed by one persistent child RPC process. */
class RpcParticipantRunner implements ParticipantRunner {
	private abortTimer: unknown;
	private disposed = false;
	private exited = false;
	private termTimer: unknown;

	constructor(
		private readonly child: SpawnedParticipantProcess,
		private readonly client: CouncilRpcClient,
		private readonly timers: {
			readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
			readonly clearTimeout: (handle: unknown) => void;
		},
	) {
		this.child.on("error", (error) => this.markProcessError(error));
		this.child.on("exit", () => this.markExited());
	}

	prompt(
		task: string,
		signal: AbortSignal | undefined,
	): Promise<AssistantMessage> {
		const abort = (): void => this.startAbortEscalation();
		if (signal?.aborted === true) {
			abort();
		} else {
			signal?.addEventListener("abort", abort, { once: true });
		}
		return this.client.prompt(task).finally(() => {
			signal?.removeEventListener("abort", abort);
		});
	}

	async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.clearEscalationTimers();
		this.client.close();
		if (!this.exited) {
			this.child.kill("SIGTERM");
		}
	}

	private startAbortEscalation(): void {
		this.client.abort();
		if (this.abortTimer !== undefined || this.exited) {
			return;
		}
		this.abortTimer = this.timers.setTimeout(() => {
			this.abortTimer = undefined;
			if (this.exited) {
				return;
			}
			this.child.kill("SIGTERM");
			this.termTimer = this.timers.setTimeout(() => {
				this.termTimer = undefined;
				if (!this.exited) {
					this.child.kill("SIGKILL");
				}
			}, COUNCIL_RPC_TERM_GRACE_MS);
		}, COUNCIL_RPC_ABORT_GRACE_MS);
	}

	private markExited(): void {
		this.exited = true;
		this.clearEscalationTimers();
		this.client.handleTransportFailure(new Error("child process exited"));
	}

	private markProcessError(error: Error): void {
		this.client.handleTransportFailure(error);
	}

	private clearEscalationTimers(): void {
		if (this.abortTimer !== undefined) {
			this.timers.clearTimeout(this.abortTimer);
			this.abortTimer = undefined;
		}
		if (this.termTimer !== undefined) {
			this.timers.clearTimeout(this.termTimer);
			this.termTimer = undefined;
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
