import { describe, expect, test } from "bun:test";
import packageJson from "../../package.json" with { type: "json" };

const CONTEXT_PROJECTION_EXTENSION = "./extensions/context-projection/index.ts";
const COMPACTION_TRIGGER_EXTENSION = "./extensions/compaction-trigger/index.ts";

describe("compaction trigger package order", () => {
	test("loads exactly once immediately after context projection", () => {
		// Purpose: the trigger must estimate the final projected provider context.
		// Input and expected output: the package extension list contains one trigger directly after context-projection.
		// Edge case: duplicate or later registration would violate the handler chain contract.
		// Dependencies: Pi package extension registration order.
		const extensions = packageJson.pi.extensions;
		const projectionIndex = extensions.indexOf(CONTEXT_PROJECTION_EXTENSION);

		expect(projectionIndex).toBeGreaterThanOrEqual(0);
		expect(
			extensions.filter(
				(extension) => extension === COMPACTION_TRIGGER_EXTENSION,
			),
		).toHaveLength(1);
		expect(extensions[projectionIndex + 1]).toBe(COMPACTION_TRIGGER_EXTENSION);
	});
});
