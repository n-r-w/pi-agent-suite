import { expect, test } from "bun:test";
import { parseConversationSessionEntry } from "./session-entry-validation";

test("preserves a structurally valid unknown Pi session entry", () => {
	// Purpose: active-conversation RPC must remain forward-compatible with new persisted entry kinds owned by Pi.
	// Input and expected output: an unknown type with the common branch fields crosses the boundary unchanged.
	// Edge case: the parser must validate branch topology without requiring a closed list of Pi entry types.
	// Dependencies: the production child-RPC boundary parser only.
	const entry = {
		type: "future_pi_entry",
		id: "future-entry",
		parentId: "known-parent",
		timestamp: "2026-01-01T00:00:00.000Z",
		payload: { addedByPi: true },
	};

	expect(parseConversationSessionEntry(entry, "child Pi") as unknown).toBe(
		entry,
	);
});
