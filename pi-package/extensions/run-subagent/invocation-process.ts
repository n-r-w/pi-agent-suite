import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ChildRpcPromptDecision,
	ChildRpcRuntimeFacts,
} from "../../shared/child-rpc-completion";
import {
	readField,
	readNonEmptyString as readString,
} from "./boundary-validation";
import type { InvocationLaunchConfiguration } from "./invocation-contracts";

const ABORT_COMMAND_ID = "abort";
const ABORT_GRACE_MS = 10_000;
const TERMINATE_GRACE_MS = 5_000;

/** Builds an isolated package-loaded Pi RPC worker command. */
export function buildChildArgs(options: {
	readonly packagePath: string;
	readonly childPiSessionId: string;
	readonly childSessionDir: string;
	readonly childSessionFile?: string;
	readonly launch?: InvocationLaunchConfiguration;
}): string[] {
	const sessionArgs =
		options.childSessionFile === undefined
			? [
					"--session-dir",
					options.childSessionDir,
					"--session-id",
					options.childPiSessionId,
				]
			: [
					"--session-dir",
					options.childSessionDir,
					"--session",
					options.childSessionFile,
				];
	return [
		"--mode",
		"rpc",
		"--no-extensions",
		"-e",
		options.packagePath,
		...sessionArgs,
		...(options.launch === undefined
			? []
			: [
					"--model",
					options.launch.modelId,
					"--thinking",
					options.launch.thinking,
				]),
	];
}

/** Spawns the production Node child with separate RPC and IPC channels. */
export function defaultSpawnProcess(
	command: string,
	args: readonly string[],
	options: {
		readonly cwd: string;
		readonly env: NodeJS.ProcessEnv;
		readonly stdio: ["pipe", "pipe", "pipe", "ipc"];
	},
): ChildProcess {
	return spawn(command, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: options.stdio,
	});
}

/** Resolves the package directory loaded into every supervised worker. */
export function defaultPackagePath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "../..");
}

/** Supplies conservative completion facts for prompt-free production channel checks. */
export function defaultRuntimeFacts(): ChildRpcRuntimeFacts {
	return {
		modelProvider: "",
		modelId: "",
		contextWindow: 0,
		retryEnabled: "unverified",
		compactionEnabled: "unverified",
	};
}

/** Maps the shared completion decision to one supervisor terminal observation. */
export function terminalObservation(
	decision: Exclude<ChildRpcPromptDecision, { kind: "wait" }>,
	lastAssistantText: string,
): {
	readonly status: "success" | "failure" | "abort";
	readonly text: string;
} {
	if (decision.kind === "success") {
		return {
			status: "success",
			text: readAssistantText(decision.message) ?? lastAssistantText,
		};
	}
	return {
		status: decision.kind === "failure" ? "failure" : "abort",
		text: decision.reason,
	};
}

/** Reads the final assistant text without trusting RPC message payloads. */
export function readAssistantText(value: unknown): string | undefined {
	if (readString(value, "role") !== "assistant") {
		return undefined;
	}
	const content = readField(value, "content");
	if (!Array.isArray(content)) {
		return undefined;
	}
	const parts = content.flatMap((part) => {
		if (
			typeof part === "object" &&
			part !== null &&
			readString(part, "type") === "text"
		) {
			const text = readString(part, "text");
			return text === undefined ? [] : [text];
		}
		return [];
	});
	return parts.length === 0 ? undefined : parts.join("\n");
}

/** Escalates one worker process only when graceful RPC shutdown does not exit. */
export async function terminateProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	if (child.stdin?.writable) {
		child.stdin.end(
			`${JSON.stringify({ id: ABORT_COMMAND_ID, type: "abort" })}\n`,
		);
	}
	if (await waitForExit(child, ABORT_GRACE_MS)) {
		return;
	}
	child.kill("SIGTERM");
	if (await waitForExit(child, TERMINATE_GRACE_MS)) {
		return;
	}
	child.kill("SIGKILL");
	if (!(await waitForExit(child, TERMINATE_GRACE_MS))) {
		throw new Error("child process remained active after SIGKILL");
	}
}

/** Waits for process close with one owned timer. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve(true);
	}
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.removeListener("close", onClose);
			resolve(false);
		}, timeoutMs);
		const onClose = (): void => {
			clearTimeout(timer);
			resolve(true);
		};
		child.once("close", onClose);
	});
}

/** Applies one startup deadline without retaining its timer after settlement. */
export function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/** Formats pre-acceptance exit diagnostics without raw RPC payloads. */
export function formatExitFailure(
	code: number | null,
	signal: NodeJS.Signals | null,
	stderr: string,
): string {
	let processFact = "unknown process exit";
	if (code !== null) {
		processFact = `exit code ${code}`;
	} else if (signal !== null) {
		processFact = `signal ${signal}`;
	}
	const diagnostic = stderr.trim();
	return diagnostic.length === 0
		? processFact
		: `${processFact}: ${diagnostic}`;
}
