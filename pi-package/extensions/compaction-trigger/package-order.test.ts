import { describe, expect, test } from "bun:test";
import packageJson from "../../package.json" with { type: "json" };

/** Identifies the source-mapping handler that precedes restoration. */
const CONTEXT_PROJECTION_EXTENSION = "./extensions/context-projection/index.ts";
/** Identifies the context-only skill insertion handler. */
const SKILL_RESTORATION_EXTENSION = "./extensions/skill-restoration/index.ts";
/** Identifies the request blocker that follows restoration. */
const COMPACTION_TRIGGER_EXTENSION = "./extensions/compaction-trigger/index.ts";

describe("compaction trigger package order", () => {
	test("loads restoration exactly once between context projection and compaction trigger", () => {
		const extensions = packageJson.pi.extensions;
		const projectionIndex = extensions.indexOf(CONTEXT_PROJECTION_EXTENSION);

		expect(projectionIndex).toBeGreaterThanOrEqual(0);
		expect(
			extensions.filter(
				(extension) => extension === COMPACTION_TRIGGER_EXTENSION,
			),
		).toHaveLength(1);
		expect(
			extensions.filter(
				(extension) => extension === SKILL_RESTORATION_EXTENSION,
			),
		).toHaveLength(1);
		expect(extensions[projectionIndex + 1]).toBe(SKILL_RESTORATION_EXTENSION);
		expect(extensions[projectionIndex + 2]).toBe(COMPACTION_TRIGGER_EXTENSION);
	});
});
