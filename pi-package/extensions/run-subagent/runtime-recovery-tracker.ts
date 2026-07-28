type RecoveryFactory = () => Promise<void>;

type RecoverySettlement =
	| { readonly kind: "fulfilled" }
	| { readonly kind: "rejected"; readonly reason: unknown };

/** Owns runtime-failure recovery factories across root lifecycle transitions. */
export class RuntimeFailureRecoveryTracker {
	private readonly pending = new Set<Promise<RecoverySettlement>>();
	private admission: "open" | "closed" = "open";
	private failure: RecoverySettlement | undefined;
	private closedDrain: Promise<void> | undefined;

	/** Admits and starts recovery work only while root shutdown admission remains open. */
	public start(recoveryFactory: RecoveryFactory): boolean {
		if (this.admission === "closed") {
			return false;
		}
		this.track(recoveryFactory);
		return true;
	}

	/** Drains recoveries admitted before and during the current open drain. */
	public drain(): Promise<void> {
		return this.drainPending();
	}

	/** Closes admission before starting one root recovery and sharing its closed drain. */
	public closeAndDrain(rootRecoveryFactory: RecoveryFactory): Promise<void> {
		if (this.closedDrain !== undefined) {
			return this.closedDrain;
		}
		this.admission = "closed";
		this.track(rootRecoveryFactory);
		this.closedDrain = this.drain();
		return this.closedDrain;
	}

	/** Converts one factory result into a fulfilled settlement that cannot reject unobserved. */
	private track(recoveryFactory: RecoveryFactory): void {
		const settlement = Promise.resolve()
			.then(recoveryFactory)
			.then<RecoverySettlement, RecoverySettlement>(
				() => ({ kind: "fulfilled" }),
				(reason: unknown) => ({ kind: "rejected", reason }),
			);
		this.pending.add(settlement);
	}

	/** Repeats snapshots until every recovery admitted during a pending batch settles. */
	private async drainPending(): Promise<void> {
		const pending = [...this.pending];
		if (pending.length === 0) {
			this.throwFailure();
			return;
		}
		const settlements = await Promise.all(pending);
		for (const recovery of pending) {
			this.pending.delete(recovery);
		}
		for (const settlement of settlements) {
			if (settlement.kind === "rejected" && this.failure === undefined) {
				this.failure = settlement;
			}
		}
		return this.drainPending();
	}

	/** Propagates the first explicit rejection without treating undefined as fulfillment. */
	private throwFailure(): void {
		if (this.failure?.kind !== "rejected") {
			return;
		}
		throw this.failure.reason instanceof Error
			? this.failure.reason
			: new Error(String(this.failure.reason));
	}
}
