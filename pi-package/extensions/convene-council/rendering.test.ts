import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	renderConveneCouncilCall,
	renderConveneCouncilResult,
} from "./rendering.ts";

const THEME = {
	bold: (value: string) => value,
	fg: (_name: string, value: string) => value,
};

describe("convene-council collapsed text normalization", () => {
	test("normalizes only the collapsed question", () => {
		// Purpose: compact council questions must remove layout whitespace while expansion preserves the submitted question.
		// Input and expected output: a multiline question becomes one spaced preview and remains multiline when expanded.
		// Edge case: duplicate spaces after a tab remain observable only in the expanded view.
		// Dependencies: the public call renderer selects presentation from the expansion flag.
		const question = "first\n\tsecond  third";

		const collapsed = renderConveneCouncilCall(
			{ question },
			THEME as never,
			{ expanded: false } as never,
		).render(200);
		const expanded = renderConveneCouncilCall(
			{ question },
			THEME as never,
			{ expanded: true } as never,
		).render(200);

		expect(collapsed).toEqual(["convene_council: first second third"]);
		expect(expanded).toEqual(["convene_council: first", "\tsecond  third"]);
	});

	test("normalizes JSON escapes only in collapsed answers", () => {
		// Purpose: council previews must use the package-wide JSON-aware normalization contract.
		// Input and expected output: escaped formatting collapses in preview while expanded answers keep the original JSON text.
		// Edge case: a literal escaped newline used as data remains unchanged.
		// Dependencies: the public result renderer owns collapsed Text and expanded Markdown paths.
		const text = String.raw`{"body":"first\n\tsecond  third","regex":"\\n+"}`;
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text }],
			details: undefined,
		};

		const collapsed = renderConveneCouncilResult(
			result,
			{ expanded: false },
			THEME as never,
			{ isError: false },
		)
			.render(200)
			.join("\n");
		const expanded = renderConveneCouncilResult(
			result,
			{ expanded: true },
			THEME as never,
			{ isError: false },
		)
			.render(200)
			.join("\n");

		expect(collapsed).toContain('"body":"first second third"');
		expect(collapsed).toContain(String.raw`"regex":"\\n+"`);
		expect(collapsed).not.toContain(String.raw`first\n\tsecond`);
		expect(expanded).toContain(String.raw`first\n\tsecond  third`);
	});
});
