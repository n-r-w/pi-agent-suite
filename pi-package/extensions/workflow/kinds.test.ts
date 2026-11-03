import { expect, test } from "bun:test";
import { requireKnownWorkflowKind, validateWorkflowKinds } from "./kinds";

test("kind definitions preserve order and require unique closed ID/description entries", () => {
	const kinds = [
		{ id: "review", description: "Review work" },
		{ id: "task", description: "Whole task" },
	];
	expect(validateWorkflowKinds(kinds)).toEqual(kinds);
	expect(validateWorkflowKinds([])).toEqual([]);
	for (const value of [
		null,
		{},
		[null],
		[{ id: "review" }],
		[{ id: "", description: "Work" }],
		[{ id: "a\nb", description: "Work" }],
		[{ id: "a\u2028b", description: "Work" }],
		[{ id: "review", description: "a\u0085b" }],
		[
			{ id: "é", description: "Work" },
			{ id: "e\u0301", description: "Duplicate" },
		],
		[{ id: "review", description: "" }],
		[{ ...kinds[0], extra: true }],
		[kinds[0], kinds[0]],
	]) {
		expect(() => validateWorkflowKinds(value)).toThrow();
	}
});

test("one membership rule accepts absence and known IDs but rejects unknown IDs", () => {
	const kinds = [{ id: "review", description: "Review work" }];
	expect(() => requireKnownWorkflowKind(undefined, [])).not.toThrow();
	expect(() => requireKnownWorkflowKind("review", kinds)).not.toThrow();
	for (const id of ["review", "unknown"]) {
		expect(() => requireKnownWorkflowKind(id, [])).toThrow(
			"unknown workflow kind",
		);
	}
	expect(() => requireKnownWorkflowKind("Review", kinds)).toThrow(
		"unknown workflow kind",
	);
});
