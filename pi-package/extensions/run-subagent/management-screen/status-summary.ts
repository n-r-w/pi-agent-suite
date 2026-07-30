import type { ProjectionNode } from "../projection";

/** Contains the four lifecycle counts shared by the main window and management tree. */
export const AGENT_STATUS_ICONS = {
	running: "⧗",
	done: "✓",
	failed: "✗",
	aborted: "■",
} as const;

export interface AgentStatusCounts {
	readonly running: number;
	readonly failed: number;
	readonly done: number;
	readonly aborted: number;
}

/** Counts every projected descendant without changing owner-local identity rules. */
export function countAgentStatuses(
	nodes: readonly ProjectionNode[],
): AgentStatusCounts {
	let running = 0;
	let failed = 0;
	let done = 0;
	let aborted = 0;
	for (const node of nodes) {
		switch (node.state) {
			case "starting":
			case "active":
				running += 1;
				break;
			case "terminal-failure":
				failed += 1;
				break;
			case "terminal-success":
				done += 1;
				break;
			case "terminal-aborted":
				aborted += 1;
				break;
		}
	}
	return { running, failed, done, aborted };
}
