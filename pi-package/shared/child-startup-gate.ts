/** Releases one child startup slot. Repeated calls have no effect. */
type ChildStartupRelease = () => void;

/** Tracks one queued startup and its independent cancellation lifecycle. */
interface ChildStartupWaiter {
	readonly resolve: (release: ChildStartupRelease | undefined) => void;
	readonly signal: AbortSignal | undefined;
	readonly onAbort: () => void;
}

/**
 * Serializes child Pi startup until prompt preflight resolves.
 * Completed preflight releases the slot while the child continues its full run.
 */
export class ChildStartupGate {
	/** Prevents more than one child from owning the credential-loading phase. */
	private active = false;
	/** Preserves request order so repeated bursts cannot starve one child. */
	private readonly waiters: ChildStartupWaiter[] = [];

	/** Acquires the startup slot, or returns undefined when cancelled while queued. */
	public acquire(
		signal: AbortSignal | undefined,
	): Promise<ChildStartupRelease | undefined> {
		if (signal?.aborted) {
			return Promise.resolve(undefined);
		}
		if (!this.active) {
			this.active = true;
			return Promise.resolve(this.createRelease());
		}

		return new Promise((resolve) => {
			const waiter: ChildStartupWaiter = {
				resolve,
				signal,
				onAbort: () => {
					// Active children use RPC abort; queued callers have no process to terminate.
					this.waiters.splice(this.waiters.indexOf(waiter), 1);
					resolve(undefined);
				},
			};
			this.waiters.push(waiter);
			signal?.addEventListener("abort", waiter.onAbort, { once: true });
		});
	}

	/** Prevents prompt response and process finalization from advancing the queue twice. */
	private createRelease(): ChildStartupRelease {
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			this.advance();
		};
	}

	/** Transfers startup ownership to the oldest waiter or marks the gate idle. */
	private advance(): void {
		const waiter = this.waiters.shift();
		if (waiter === undefined) {
			this.active = false;
			return;
		}
		waiter.signal?.removeEventListener("abort", waiter.onAbort);
		waiter.resolve(this.createRelease());
	}
}
