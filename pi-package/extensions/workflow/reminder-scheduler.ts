/** Counts model activity between workflow-state publications without depending on Pi. */
export class WorkflowReminderScheduler {
	private activityCount = 0;
	private workflowStatePublishedThisTurn = false;

	public constructor(private readonly interval: number) {}

	/** Starts one provider turn so later publication applies only to that turn. */
	public startTurn(): void {
		this.workflowStatePublishedThisTurn = false;
	}

	/** Starts a fresh interval and excludes the current turn's activity. */
	public workflowStatePublished(): void {
		this.activityCount = 0;
		this.workflowStatePublishedThisTurn = true;
	}

	/** Drops process-local progress after session or branch lifecycle changes. */
	public reset(): void {
		this.activityCount = 0;
		this.workflowStatePublishedThisTurn = false;
	}

	/** Returns one reminder decision for the completed turn and discards any overshoot. */
	public completeTurn(
		toolCallCount: number,
		hasReasoning: boolean,
		workflowActive: boolean,
		allToolResultsTerminate: boolean,
	): boolean {
		if (
			this.interval === 0 ||
			!workflowActive ||
			this.workflowStatePublishedThisTurn
		) {
			if (!workflowActive) {
				this.activityCount = 0;
			}
			return false;
		}
		const turnActivity = Math.max(toolCallCount, hasReasoning ? 1 : 0);
		if (turnActivity === 0) {
			return false;
		}
		this.activityCount += turnActivity;
		if (allToolResultsTerminate || this.activityCount < this.interval) {
			return false;
		}
		this.activityCount = 0;
		return true;
	}
}
