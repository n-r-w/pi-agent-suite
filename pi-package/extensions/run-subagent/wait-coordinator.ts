import type { SubagentNormalResult } from "./contracts";
import type { OwnerIdentity } from "./domain";

/** Describes one admitted wait settlement target. */
export interface WaitCorrelation {
	readonly owner: OwnerIdentity;
	readonly toolCallId: string;
	readonly requestId: string;
	readonly runtimeLeaseId?: string;
}

/** Adds one monotonic deadline to an exact wait correlation. */
export interface WaitAdmission extends WaitCorrelation {
	readonly expiresAt: number;
}

/** Separates wait resolver mechanics from coordination decisions. */
export interface WaitRuntime {
	admit(
		admission: WaitAdmission,
		onTimeout: () => void,
	): Promise<SubagentNormalResult>;
	settle(owner: OwnerIdentity, result: SubagentNormalResult): boolean;
	cancel(correlation: WaitCorrelation, reason: Error): boolean;
	cancelOwner(owner: OwnerIdentity): void;
	cancelLease(runtimeLeaseId: string): void;
}

/** Supplies monotonic timer mechanics to the wait coordinator. */
interface WaitCoordinatorOptions {
	readonly now?: () => number;
	readonly setTimer?: (handler: () => void, delayMs: number) => NodeJS.Timeout;
	readonly clearTimer?: (timer: NodeJS.Timeout) => void;
}

interface PendingWait {
	readonly admission: WaitAdmission;
	readonly resolve: (result: SubagentNormalResult) => void;
	readonly reject: (error: Error) => void;
	timer: NodeJS.Timeout | undefined;
}

/** Owns pending wait resolvers, deadlines, and nested correlations. */
export class WaitCoordinator implements WaitRuntime {
	private readonly pending = new Map<string, PendingWait>();
	private readonly now: () => number;
	private readonly setTimer: NonNullable<WaitCoordinatorOptions["setTimer"]>;
	private readonly clearTimer: NonNullable<
		WaitCoordinatorOptions["clearTimer"]
	>;

	/** Creates resolver mechanics with injectable monotonic timers. */
	public constructor(options: WaitCoordinatorOptions = {}) {
		this.now = options.now ?? (() => performance.now());
		this.setTimer = options.setTimer ?? setTimeout;
		this.clearTimer = options.clearTimer ?? clearTimeout;
	}

	/** Registers one pending wait resolver. */
	public admit(
		admission: WaitAdmission,
		onTimeout: () => void,
	): Promise<SubagentNormalResult> {
		const key = ownerKey(admission.owner);
		if (this.pending.has(key)) {
			return Promise.reject(new Error("owner wait resolver already exists"));
		}
		return new Promise((resolve, reject) => {
			const pending: PendingWait = {
				admission,
				resolve,
				reject,
				timer: undefined,
			};
			this.pending.set(key, pending);
			this.armTimeout(key, pending, onTimeout);
		});
	}

	/** Settles one pending root or nested wait. */
	public settle(owner: OwnerIdentity, result: SubagentNormalResult): boolean {
		const key = ownerKey(owner);
		const pending = this.pending.get(key);
		if (pending === undefined) {
			return false;
		}
		this.pending.delete(key);
		if (pending.timer !== undefined) {
			this.clearTimer(pending.timer);
		}
		pending.resolve(result);
		return true;
	}

	/** Cancels one exact wait correlation without producing a result. */
	public cancel(correlation: WaitCorrelation, reason: Error): boolean {
		const key = ownerKey(correlation.owner);
		const pending = this.pending.get(key);
		if (
			pending === undefined ||
			!sameWaitCorrelation(pending.admission, correlation)
		) {
			return false;
		}
		// Resolver and timer ownership end before rejection becomes observable.
		this.pending.delete(key);
		if (pending.timer !== undefined) {
			this.clearTimer(pending.timer);
		}
		pending.reject(reason);
		return true;
	}

	/** Cancels one owner's resolver and timer without producing a result. */
	public cancelOwner(owner: OwnerIdentity): void {
		this.cancelPending(ownerKey(owner));
	}

	/** Cancels every pending correlation owned by one failed runtime lease. */
	public cancelLease(runtimeLeaseId: string): void {
		for (const [key, pending] of this.pending) {
			if (pending.admission.runtimeLeaseId === runtimeLeaseId) {
				this.cancelPending(key);
			}
		}
	}

	/** Re-arms an early timer until the monotonic wait deadline is reached. */
	private armTimeout(
		key: string,
		pending: PendingWait,
		onTimeout: () => void,
	): void {
		const delayMs = Math.max(0, pending.admission.expiresAt - this.now());
		pending.timer = this.setTimer(() => {
			if (this.pending.get(key) !== pending) {
				return;
			}
			const remainingMs = pending.admission.expiresAt - this.now();
			if (remainingMs > 0) {
				this.armTimeout(key, pending, onTimeout);
				return;
			}
			onTimeout();
		}, delayMs);
	}

	/** Rejects one pending resolver so no normal response is produced. */
	private cancelPending(key: string): void {
		const pending = this.pending.get(key);
		if (pending === undefined) {
			return;
		}
		this.pending.delete(key);
		if (pending.timer !== undefined) {
			this.clearTimer(pending.timer);
		}
		pending.reject(new Error("subagent wait ceased with its runtime lease"));
	}
}

/** Requires every owner and request identity field to match before cancellation. */
function sameWaitCorrelation(
	admission: WaitAdmission,
	correlation: WaitCorrelation,
): boolean {
	return (
		admission.owner.ownerPiSessionId === correlation.owner.ownerPiSessionId &&
		admission.owner.ownerSessionFile === correlation.owner.ownerSessionFile &&
		admission.toolCallId === correlation.toolCallId &&
		admission.requestId === correlation.requestId &&
		admission.runtimeLeaseId === correlation.runtimeLeaseId
	);
}

/** Keys resolver state by direct owner identity. */
function ownerKey(owner: OwnerIdentity): string {
	return owner.ownerPiSessionId;
}
