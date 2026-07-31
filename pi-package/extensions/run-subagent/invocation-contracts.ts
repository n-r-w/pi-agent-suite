import type { ChildProcess } from "node:child_process";
import type { ChildRpcRuntimeFacts } from "../../shared/child-rpc-completion";
import type { ChildStartupGate } from "../../shared/child-startup-gate";
import type { SubagentFailedCode } from "./contracts";
import type { LogicalSession, OwnerIdentity, SessionKey } from "./domain";
import type {
	RootRuntimeBridge,
	RuntimeChannelFailure,
} from "./runtime-bridge";
import type { RuntimeRequest } from "./runtime-wire";

/** Describes one accepted process invocation. */
export interface InvocationAcceptance {
	readonly invocationId: string;
	readonly runtimeLeaseId: string;
	readonly childPiSessionId: string;
	readonly childSessionDir: string;
	readonly childSessionFile: string;
	readonly modelId?: string;
	readonly thinking?: string;
	readonly contextWindow?: number;
}

/** Binds one nested start to the runtime lease that initiated it. */
export interface InvocationScope {
	readonly ownerRuntimeLeaseId?: string;
	readonly signal?: AbortSignal;
}

/** Describes one new invocation request. */
export interface NewInvocationRequest extends InvocationScope {
	readonly owner: OwnerIdentity;
	readonly sessionKey: SessionKey;
	readonly agentId: string;
	readonly taskName: string;
	readonly prompt: string;
}

/** Describes supervisor observations consumed by the coordinator. */
export type InvocationEvent =
	| {
			readonly kind: "terminal";
			readonly invocationId: string;
			readonly status: "success" | "failure" | "abort";
			readonly text: string;
			readonly contextTokens?: number;
			readonly projectionSavedTokens?: number;
	  }
	| {
			readonly kind: "accepted-exit";
			readonly invocationId: string;
			readonly exitCode: number | null;
			readonly signal: NodeJS.Signals | null;
			readonly contextTokens?: number;
			readonly projectionSavedTokens?: number;
	  };

/** Reserves active-steer authority at the last synchronous point before dispatch. */
export interface InvocationSteerScope {
	readonly signal?: AbortSignal;
	readonly beforeDispatch?: () => void;
}

/** Controls root-supervised Pi RPC invocation processes. */
export interface InvocationControl {
	start(request: NewInvocationRequest): Promise<InvocationAcceptance>;
	continue(
		session: LogicalSession,
		prompt: string,
		scope?: InvocationScope,
	): Promise<InvocationAcceptance>;
	steer(
		invocationId: string,
		prompt: string,
		scope?: InvocationSteerScope,
	): Promise<void>;
	terminateLease(runtimeLeaseId: string): Promise<void>;
}

/** Resolves model, tool policy, and process environment for one callable agent. */
export interface InvocationLaunchConfiguration {
	readonly cwd: string;
	readonly modelId: string;
	readonly provider: string;
	readonly thinking: string;
	readonly toolPatterns?: readonly string[];
	readonly workflowIds?: readonly string[];
	readonly depth: number;
	readonly parentAuthVerified: boolean;
	readonly runtimeFacts: ChildRpcRuntimeFacts;
}

/** Describes a worker launch that does not submit a provider prompt. */
export interface WorkerLaunchRequest extends InvocationScope {
	readonly owner: OwnerIdentity;
	readonly sessionKey: SessionKey;
	readonly agentId: string;
	readonly taskName: string;
	readonly childPiSessionId?: string;
	readonly childSessionDir?: string;
	readonly childSessionFile?: string;
	readonly launchConfiguration?: InvocationLaunchConfiguration;
}

/** Supplies process and runtime dependencies to the supervisor. */
export interface InvocationSupervisorOptions {
	readonly bridge: RootRuntimeBridge;
	readonly onEvent: (event: InvocationEvent) => Promise<void> | void;
	readonly onRuntimeFailure?: (failure: RuntimeChannelFailure) => void;
	readonly onRuntimeRequest?: (
		owner: OwnerIdentity,
		request: RuntimeRequest,
	) => Promise<unknown>;
	readonly resolveLaunch?: (
		request: NewInvocationRequest,
	) => Promise<InvocationLaunchConfiguration>;
	readonly sessionsDir?: string;
	readonly packagePath?: string;
	readonly command?: string;
	readonly childEnvironment?: Readonly<Record<string, string>>;
	readonly startupGate?: ChildStartupGate;
	readonly spawnProcess?: (
		command: string,
		args: readonly string[],
		options: {
			readonly cwd: string;
			readonly env: NodeJS.ProcessEnv;
			readonly stdio: ["pipe", "pipe", "pipe", "ipc"];
		},
	) => ChildProcess;
}

/** Carries a public start or message rejection class across coordinator ports. */
export class InvocationStartError extends Error {
	/** Preserves only stable public failure classes. */
	public constructor(
		public readonly code: Extract<
			SubagentFailedCode,
			"message_rejected" | "start_failed"
		>,
		message: string,
	) {
		super(message);
		this.name = "InvocationStartError";
	}
}
