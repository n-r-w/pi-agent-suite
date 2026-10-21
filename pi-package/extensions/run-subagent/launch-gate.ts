import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Prefix of issues that the launch of a subagent reports. */
const ISSUE_PREFIX = "[subagents]";

/** Exit code of a process that could not apply the agent named by `--subagent`. */
const FAILED_LAUNCH_EXIT_CODE = 1;

/** Part of the Node process that marks the exit code of a failed launch. */
export interface ExitTarget {
	/** Exit code that the process ends with. */
	exitCode: number | string | null | undefined;
	/** Registers a listener that runs once when the process exits. */
	once(event: "exit", listener: () => void): unknown;
}

/**
 * Holds input until the session start has applied the agent named by `--subagent`,
 * and ends a process that could not apply it.
 */
export class LaunchGate {
	/** Settles when the latest session start has settled, and holds input until then. */
	private current: Promise<void>;
	/** Releases the gate that holds input from before the first session start. */
	private releaseInitial: () => void = () => undefined;
	/** True when the exit listener is registered, so that repeated failures register it once. */
	private exitMarked = false;
	/** True when the latest session start could not apply the agent. */
	private failedLaunch = false;

	/** Starts with a pending gate, because Pi can accept input before the first session start. */
	public constructor(private readonly exitTarget: ExitTarget = process) {
		this.current = new Promise<void>((resolve) => {
			this.releaseInitial = resolve;
		});
	}

	/** Returns true when the last session start could not apply the agent. */
	public get failed(): boolean {
		return this.failedLaunch;
	}

	/** Runs one session start, holds input until it settles, and returns its own result. */
	public run(session: () => Promise<void>): Promise<void> {
		this.failedLaunch = false;
		const result = session();
		// The first run also releases the gate that held input from before the session start.
		this.current = result
			.then(
				() => undefined,
				() => undefined,
			)
			.then(this.releaseInitial);
		return result;
	}

	/** Waits until the current session start settles. */
	public wait(): Promise<void> {
		return this.current;
	}

	/**
	 * Writes the reason why Pi cannot apply the agent to stderr and asks Pi to end the process.
	 * The exit code is nonzero in every mode, because Pi ends RPC mode with code 0.
	 */
	public fail(ctx: ExtensionContext, issue: string): void {
		this.failedLaunch = true;
		process.stderr.write(`${ISSUE_PREFIX} ${issue}\n`);
		this.markFailedExit();
		ctx.shutdown();
	}

	/** Sets the exit code at the exit event, which runs after Pi chooses its own code. */
	private markFailedExit(): void {
		if (this.exitMarked) {
			return;
		}
		this.exitMarked = true;
		this.exitTarget.once("exit", () => {
			this.exitTarget.exitCode = FAILED_LAUNCH_EXIT_CODE;
		});
	}
}
