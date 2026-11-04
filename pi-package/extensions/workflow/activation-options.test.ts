import { expect, test } from "bun:test";
import { groupWorkflowActivationOptions } from "./activation-options";
import type { WorkflowDefinition } from "./workflow";

/** Supplies already validated options without involving prompt wording. */
function option(id: string, kind?: string): WorkflowDefinition {
	return {
		id,
		description: id,
		stages: [],
		transitions: [],
		...(kind === undefined ? {} : { kind }),
	};
}

test("renderer grouping uses file order, retains option order, and separates unclassified options", () => {
	const kinds = [
		{ id: "task", description: "Whole task" },
		{ id: "unused", description: "Empty" },
		{ id: "review", description: "Review work" },
	] as const;
	const options = [
		option("check", "review"),
		option("legacy"),
		option("work", "task"),
		option("plain"),
		option("check-two", "review"),
	] as const;
	expect(groupWorkflowActivationOptions(options, kinds)).toEqual([
		{ kind: kinds[0], workflows: [options[2]] },
		{ kind: kinds[2], workflows: [options[0], options[4]] },
		{ workflows: [options[1], options[3]] },
	]);
	expect(groupWorkflowActivationOptions([options[1], options[3]], [])).toEqual([
		{ workflows: [options[1], options[3]] },
	]);
	expect(groupWorkflowActivationOptions([], kinds)).toEqual([]);
});
