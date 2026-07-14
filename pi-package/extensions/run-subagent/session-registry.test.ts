import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	SUBAGENT_SESSION_CUSTOM_TYPE,
	SubagentSessionRegistry,
} from "./session-registry";

/** Creates one persisted extension entry for registry restoration tests. */
function sessionEntry(
	entryId: string,
	data: {
		readonly sessionId: number;
		readonly childSessionId: string;
		readonly childSessionDir: string;
		readonly agentId: string;
		readonly cwd: string;
	},
): SessionEntry {
	return {
		type: "custom",
		id: entryId,
		parentId: null,
		timestamp: "2026-07-14T00:00:00.000Z",
		customType: SUBAGENT_SESSION_CUSTOM_TYPE,
		data,
	};
}

describe("subagent session registry", () => {
	test("restores aliases and allocates after the largest persisted id", () => {
		// Purpose: short aliases must survive reopening the owning main-agent session.
		// Input and expected output: persisted sessions 2 and 4 resolve, and the next allocation receives 5.
		// Edge case: gaps in historical aliases are preserved instead of being reused.
		// Dependencies: only valid CustomEntry values are used.
		const registry = new SubagentSessionRegistry();
		registry.restore([
			sessionEntry("entry-2", {
				sessionId: 2,
				childSessionId: "child-2",
				childSessionDir: "/sessions",
				agentId: "Worker",
				cwd: "/project",
			}),
			sessionEntry("entry-4", {
				sessionId: 4,
				childSessionId: "child-4",
				childSessionDir: "/sessions",
				agentId: "Worker",
				cwd: "/project",
			}),
		]);

		expect(registry.get(2)?.childSessionId).toBe("child-2");
		expect(registry.get(4)?.childSessionId).toBe("child-4");
		expect(
			registry.create({
				childSessionId: "child-5",
				childSessionDir: "/sessions",
				agentId: "Worker",
				cwd: "/project",
			}).sessionId,
		).toBe(5);
	});

	test("keeps a conflicted alias unresolved after later duplicate entries", () => {
		// Purpose: conflicting persisted aliases must never select an arbitrary child session.
		// Input and expected output: alias 1 points to two UUIDs and remains unresolved even when one value appears again.
		// Edge case: a later duplicate of the first value must not clear the conflict.
		// Dependencies: registry restoration validates CustomEntry data before conflict handling.
		const registry = new SubagentSessionRegistry();
		const first = {
			sessionId: 1,
			childSessionId: "child-a",
			childSessionDir: "/sessions",
			agentId: "Worker",
			cwd: "/project",
		} as const;
		registry.restore([
			sessionEntry("entry-a", first),
			sessionEntry("entry-b", { ...first, childSessionId: "child-b" }),
			sessionEntry("entry-c", first),
		]);

		expect(registry.get(1)).toBeUndefined();
	});
});
