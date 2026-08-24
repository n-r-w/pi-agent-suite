/** Counts completed tool calls between workflow-state publications without depending on Pi. */
export class WorkflowReminderScheduler {
	private toolCallCount = 0;
	private workflowStatePublishedThisTurn = false;

	public constructor(private readonly interval: number) {}

	/** Starts one provider turn so later publication applies only to that turn. */
	public startTurn(): void {
		this.workflowStatePublishedThisTurn = false;
	}

	/** Starts a fresh interval and excludes the current turn's complete tool batch. */
	public workflowStatePublished(): void {
		this.toolCallCount = 0;
		this.workflowStatePublishedThisTurn = true;
	}

	/** Drops process-local progress after session or branch lifecycle changes. */
	public reset(): void {
		this.toolCallCount = 0;
		this.workflowStatePublishedThisTurn = false;
	}

	/** Returns one reminder decision for the complete batch and discards any overshoot. */
	public completeTurn(
		toolCallCount: number,
		workflowActive: boolean,
		allToolResultsTerminate: boolean,
	): boolean {
		if (
			this.interval === 0 ||
			!workflowActive ||
			this.workflowStatePublishedThisTurn
		) {
			if (!workflowActive) {
				this.toolCallCount = 0;
			}
			return false;
		}
		if (toolCallCount === 0) {
			return false;
		}
		this.toolCallCount += toolCallCount;
		if (allToolResultsTerminate || this.toolCallCount < this.interval) {
			return false;
		}
		this.toolCallCount = 0;
		return true;
	}
}
