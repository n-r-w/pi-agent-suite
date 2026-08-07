import { describe, expect, test } from "bun:test";
import {
	parseRuntimeOperationPayload,
	parseRuntimeResponseResult,
} from "./runtime-wire";

const SCOPE = {
	projectDirectoryName: `project-${"a".repeat(64)}`,
	branchName: "feature/a",
} as const;

describe("knowledge runtime wire integration", () => {
	/** Ensures the common runtime envelope delegates one operation and response to the knowledge parser. */
	test("delegates knowledge parsing through the common runtime envelope", () => {
		// ARRANGE
		const payload = { scope: SCOPE };
		const response = { global: "global", local: null };

		// ACT
		const operation = parseRuntimeOperationPayload("knowledge_read", payload);
		const result = parseRuntimeResponseResult("knowledge_read", response);

		// ASSERT
		expect(operation).toEqual({
			operation: "knowledge_read",
			payload,
		});
		expect(result).toEqual(response);
	});
});
