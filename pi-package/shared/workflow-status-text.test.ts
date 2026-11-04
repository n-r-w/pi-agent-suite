import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderWorkflowStatusText } from "./workflow-status-text";

describe("workflow status text", () => {
	test.each([
		"Workflow: Root➡Middle➡Current · Active stage",
		"Workflow: …➡Middle➡Current · Active stage",
		"Workflow: …➡Current · Active stage",
		"Workflow: …➡Current · Act…",
		"Workflow: Current",
		"Workflow: Cur…",
	])("keeps the nearest context that fits %s", (expected) => {
		const width = visibleWidth(expected);
		const row = renderWorkflowStatusText(
			"Root➡Middle➡Current",
			"Active stage",
			width,
		);
		expect(stripVTControlCharacters(row)).toBe(expected);
		expect(visibleWidth(row)).toBeLessThanOrEqual(width);
	});

	test("bounds Unicode workflow names at every viewport width", () => {
		const path = "Root➡检查👩‍💻";
		const current = "Workflow: 检查👩‍💻";
		for (let width = 0; width <= 60; width++) {
			const row = renderWorkflowStatusText(path, " Check\tresults. ", width);
			expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			expect(row).not.toContain("\n");
			if (width >= visibleWidth(current)) {
				expect(stripVTControlCharacters(row)).toContain("检查👩‍💻");
			}
		}
		expect(renderWorkflowStatusText(path, " Check\tresults. ", 100)).toBe(
			"Workflow: Root➡检查👩‍💻 · Check results",
		);
	});
});
