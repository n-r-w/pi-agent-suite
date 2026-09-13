import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderAgentPane } from "./agent-pane";

const theme = {
	fg: (color: string, text: string) => {
		const codes: Record<string, number> = {
			accent: 31,
			borderAccent: 36,
			border: 32,
			borderMuted: 33,
			muted: 90,
		};
		return `\u001b[${codes[color]}m${text}\u001b[39m`;
	},
	bg: (color: string, text: string) =>
		color === "selectedBg"
			? `\u001b[44m${text}\u001b[49m`
			: `\u001b[45m${text}\u001b[49m`,
	bold: (text: string) => text,
} as Theme;

describe("usage agent pane", () => {
	test("highlights the complete selected row without a marker", () => {
		// Purpose: agent selection must match the full-row background treatment used by /subagents.
		// Inputs and expected output: the same selected agent uses selectedBg with focus and toolPendingBg without focus.
		// Edge case: clipping and padding happen before the background wraps the complete visible row.
		// Dependencies: Pi theme backgrounds and visible-width measurement.
		const render = (focused: boolean) =>
			renderAgentPane(
				["agent-with-a-long-name", "other"],
				"agent-with-a-long-name",
				{
					width: 12,
					height: 4,
					focused,
					theme,
				},
			).lines;
		const focused = render(true);
		const inactive = render(false);

		expect(focused[2]).toStartWith("\u001b[44m");
		expect(focused[2]).toEndWith("\u001b[49m");
		expect(inactive[2]).toStartWith("\u001b[45m");
		expect(inactive[2]).toEndWith("\u001b[49m");
		expect(visibleWidth(focused[2] ?? "")).toBe(12);
		expect(focused[2]).toContain(" agent-with");
		expect(focused[1]).not.toContain("\u001b[4");
	});

	test("colors the vertical track and focus-dependent thumb", () => {
		// Purpose: the Agents scroll indicator must use the /subagents track and thumb colors.
		// Inputs and expected output: track rows use muted while focused and inactive thumbs use border and borderMuted.
		// Edge case: selecting the final agent forces a non-zero viewport offset with both track and thumb rows.
		// Dependencies: shared scroll-thumb calculation and Pi theme foreground colors.
		const agentIds = Array.from({ length: 8 }, (_, index) => `agent-${index}`);
		const render = (focused: boolean) =>
			renderAgentPane(agentIds, "agent-7", {
				width: 20,
				height: 5,
				focused,
				theme,
			}).scroll.join("");
		const focused = render(true);
		const inactive = render(false);

		expect(focused).toContain("\u001b[90m░\u001b[39m");
		expect(focused).toContain("\u001b[32m█\u001b[39m");
		expect(inactive).toContain("\u001b[90m░\u001b[39m");
		expect(inactive).toContain("\u001b[33m█\u001b[39m");
	});
});
