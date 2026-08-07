import { describe, expect, test } from "bun:test";
import {
	isWorkflowTriggerType,
	WORKFLOW_TRIGGER_TYPES,
} from "./workflow-trigger-runtime";

describe("isWorkflowTriggerType", () => {
	test("returns true for local_knowledge_accumulation", () => {
		expect(isWorkflowTriggerType("local_knowledge_accumulation")).toBe(true);
	});

	test("returns true for global_knowledge_accumulation", () => {
		expect(isWorkflowTriggerType("global_knowledge_accumulation")).toBe(true);
	});

	test("returns false for unknown trigger type", () => {
		expect(isWorkflowTriggerType("unknown_trigger")).toBe(false);
	});

	test("returns false for empty string", () => {
		expect(isWorkflowTriggerType("")).toBe(false);
	});
});

describe("WORKFLOW_TRIGGER_TYPES", () => {
	test("contains exactly the known trigger types", () => {
		expect(WORKFLOW_TRIGGER_TYPES).toEqual([
			"local_knowledge_accumulation",
			"global_knowledge_accumulation",
		]);
	});
});
