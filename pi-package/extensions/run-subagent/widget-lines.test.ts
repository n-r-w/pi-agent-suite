import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	createSubagentWidgetEvent as createEvent,
	DEFAULT_SUBAGENT_WIDGET_WIDTH as DEFAULT_WIDTH,
	getSubagentWidgetContentLines as getContentLines,
	type SubagentWidgetRunFixture as RunFixture,
	renderStyledPinnedSubagentWidgetFixture as renderStyledPinnedWidget,
	renderSubagentWidgetFixture as renderWidget,
	type SubagentWidgetTheme as WidgetTheme,
} from "../../../test/support/subagent-widget";

const SGR_RESET = "\u001b[0m";
const FORBIDDEN_STANDALONE_CONTROLS = [
	"\u0000",
	"\u0007",
	"\u0008",
	"\u001b",
	"\u007f",
	"\u0081",
] as const;

describe("subagent widget styling", () => {
	test("colors context pressure, projection savings, and status icons independently", () => {
		// Purpose: compact rows must preserve status and context pressure colors while showing rounded token counts.
		// Input and expected output: token usage, projection savings, and status icons use their designated colors.
		// Edge case: unknown overflow usage stays uncolored while projection savings remain warning-colored.
		// Dependencies: a visible running root keeps all terminal children available to the selected-tree renderer.
		const theme: WidgetTheme = {
			fg(color: string, text: string): string {
				return `<${color}>${text}</${color}>`;
			},
		};
		const rendered = getContentLines(
			renderWidget(
				[
					{
						runId: "LowAgent",
						contextUsage: {
							tokens: 100400,
							contextWindow: 371600,
							percent: 27.02,
						},
						children: [
							{ runId: "SucceededAgent", status: "succeeded" },
							{ runId: "FailedAgent", status: "failed" },
							{ runId: "AbortedAgent", status: "aborted" },
						],
					},
					{
						runId: "WarningAgent",
						contextUsage: {
							tokens: 189600,
							contextWindow: 371600,
							percent: 51.02,
						},
						contextProjectionStatus: "~19.6k",
					},
					{
						runId: "ErrorAgent",
						contextUsage: {
							tokens: 220000,
							contextWindow: 272000,
							percent: 80.88,
						},
					},
					{
						runId: "EstimatedAgent",
						contextUsage: {
							tokens: null,
							estimatedTokens: 371600,
							contextWindow: 371600,
							percent: null,
						},
					},
				],
				8,
				DEFAULT_WIDTH,
				theme,
			),
		).join("\n");

		expect(rendered).toContain("<accent>⏳</accent> LowAgent");
		expect(rendered).toContain("LowAgent · 1s · 100k/372k");
		expect(rendered).not.toContain("<warning>100k/372k</warning>");
		expect(rendered).toContain(
			"WarningAgent · 1s · <warning>~20k</warning>/<warning>190k/372k</warning>",
		);
		expect(rendered).toContain("ErrorAgent · 1s · <error>220k/272k</error>");
		expect(rendered).toContain("EstimatedAgent · 1s · ~/372k");
		expect(rendered).toContain("<success>✓</success> SucceededAgent");
		expect(rendered).toContain("<error>✗</error> FailedAgent");
		expect(rendered).toContain("<error>■</error> AbortedAgent");
	});

	test("keeps selected runtime and event payloads at normal brightness", () => {
		// Purpose: selected-run details must remain readable while semantic icons and tool names keep their colors.
		// Input and expected output: runtime metadata and call/result payloads have no muted or dim wrapper.
		// Edge case: status, event direction, tool name, and elapsed time retain their existing semantic styles.
		// Dependencies: marker tags expose every color assignment without relying on a terminal theme.
		const theme: WidgetTheme = {
			fg(color: string, text: string): string {
				return `<${color}>${text}</${color}>`;
			},
		};
		const rendered = getContentLines(
			renderStyledPinnedWidget({
				roots: [
					{
						runId: "selected",
						agentId: "SubAgentSage",
						taskName: "Inspect selected colors",
						status: "succeeded",
						runtime: {
							modelId: "openai-codex/gpt-5.6-sol",
							thinking: "high",
							contextWindow: 372_000,
						},
						events: [
							createEvent("tool_call", "read", '{"path":"README.md"}', 1),
							createEvent("tool_result", "read", "file contents", 2),
						],
					},
				],
				pinnedRunId: "selected",
				lineBudget: 3,
				width: 160,
				theme,
			}),
		).join("\n");

		expect(rendered).toContain("<success>✓ </success>Root:");
		expect(rendered).toContain("openai-codex/gpt-5.6-sol/high");
		expect(rendered).not.toContain(
			"<muted> · openai-codex/gpt-5.6-sol/high</muted>",
		);
		expect(rendered).toContain(
			'<muted>→</muted><accent> read</accent> {"path":"README.md"}',
		);
		expect(rendered).toContain(
			"<success>←</success><accent> read</accent> file contents",
		);
		expect(rendered).not.toContain("├─");
		expect(rendered).not.toContain("└─");
		expect(rendered).not.toContain('<dim> {"path":"README.md"}</dim>');
		expect(rendered).not.toContain("<dim> file contents</dim>");
	});

	test("colors only positive aggregate header counts", () => {
		// Purpose: the header must emphasize active non-zero counts without coloring labels or zeroes.
		// Input and expected output: one failed and one completed run color their numbers while zero running stays plain.
		// Edge case: the all-terminal failure view still uses the same aggregate header contract.
		// Dependencies: the theme records semantic color names as readable tags.
		const theme: WidgetTheme = {
			fg(color: string, text: string): string {
				return `<${color}>${text}</${color}>`;
			},
		};
		const rendered = renderWidget(
			[
				{ runId: "FailedAgent", status: "failed" },
				{ runId: "SucceededAgent", status: "succeeded" },
			],
			1,
			DEFAULT_WIDTH,
			theme,
		).join("\n");

		expect(rendered).toContain(
			"Subagents: 0 running · <error>1</error> failed · <success>1</success> done",
		);
		expect(rendered).not.toContain("<accent>0</accent>");
		expect(rendered).not.toContain("<error>failed</error>");
		expect(rendered).not.toContain("<success>done</success>");
	});
});

describe("subagent widget compact rows", () => {
	test("formats elapsed time, context pressure, and tool activity compactly", () => {
		// Purpose: each row must communicate state with actual call arguments but without tool result payloads.
		// Input and expected output: read, grep-result, and custom-tool events retain their serialized input.
		// Edge case: projection savings remain associated with the same context percentage.
		// Dependencies: event title, kind, and prior matching tool call are available in run details.
		const rendered = getContentLines(
			renderWidget(
				[
					{
						runId: "Reader",
						elapsedMs: 130000,
						contextUsage: {
							tokens: 100000,
							contextWindow: 272000,
							percent: 36.76,
						},
						events: [
							createEvent(
								"tool_call",
								"read",
								JSON.stringify({ path: "service.ts", offset: 10 }),
								10,
							),
						],
					},
					{
						runId: "Searcher",
						elapsedMs: 44000,
						contextUsage: {
							tokens: 187300,
							contextWindow: 272000,
							percent: 68.86,
						},
						contextProjectionStatus: "~51k",
						events: [
							createEvent(
								"tool_call",
								"grep",
								JSON.stringify({ pattern: "PaymentView", path: "src" }),
								{ timestampMs: 20, toolCallId: "grep-1" },
							),
							createEvent("tool_result", "grep", "No matches found", {
								timestampMs: 21,
								toolCallId: "grep-1",
							}),
						],
					},
					{
						runId: "Custom",
						elapsedMs: 3723000,
						events: [
							createEvent(
								"tool_call",
								"custom_tool",
								JSON.stringify({ arbitrary: "private payload" }),
								30,
							),
						],
					},
				],
				4,
			),
		).join("\n");

		expect(rendered).toContain(
			'Reader · 2:10 · 100k/272k · read {"path":"service.ts","offset":10}',
		);
		expect(rendered).toContain(
			'Searcher · 44s · ~51k/187k/272k · grep {"pattern":"PaymentView","path":"src"} → no matches',
		);
		expect(rendered).toContain(
			'Custom · 1:02:03 · custom_tool {"arbitrary":"private payload"}',
		);
	});

	test("renders raw tool call arguments and clips long Unicode payloads", () => {
		// Purpose: live activity must expose the actual tool arguments without breaking terminal width.
		// Input and expected output: a team message lookup shows its full JSON at wide width and a clipped preview at narrow width.
		// Edge case: clipping retains complete family emoji graphemes before the ellipsis.
		// Dependencies: progress capture already bounds stored payloads, while row rendering applies the current terminal width.
		const family = "👨‍👩‍👧‍👦";
		const payload = JSON.stringify({
			message_id: `message-${family.repeat(20)}`,
		});
		const roots: readonly RunFixture[] = [
			{
				runId: "RawArgs",
				events: [
					createEvent("tool_call", "team_message_get", payload, {
						timestampMs: 10,
						toolCallId: "team-get-1",
					}),
				],
			},
		];
		const narrowWidth = 87;
		const wide = getContentLines(renderWidget(roots, 2, 200)).join("\n");
		const narrowLines = getContentLines(renderWidget(roots, 2, narrowWidth));
		const narrowActivity = narrowLines.find((line) =>
			line.includes("team_message_get"),
		);

		expect(wide).toContain(`team_message_get ${payload}`);
		expect(narrowActivity).toBeDefined();
		expect(narrowActivity).toContain(family);
		expect(narrowActivity).not.toContain(family.repeat(3));
		expect(narrowActivity).toEndWith("...");
		expect(visibleWidth(narrowActivity ?? "")).toBeLessThanOrEqual(narrowWidth);
	});

	test("correlates parallel same-name tool results by tool call ID", () => {
		// Purpose: a completed result must retain the argument of its own parallel tool call.
		// Input and expected output: grep A starts, grep B starts, then grep A completes first with no matches.
		// Edge case: title-only matching would incorrectly display the latest started grep B argument.
		// Dependencies: progress events carry Pi toolCallId values through the widget snapshot.
		const rendered = getContentLines(
			renderWidget(
				[
					{
						runId: "ParallelSearch",
						events: [
							createEvent(
								"tool_call",
								"grep",
								JSON.stringify({ pattern: "A.ts" }),
								{ timestampMs: 10, toolCallId: "grep-a" },
							),
							createEvent(
								"tool_call",
								"grep",
								JSON.stringify({ pattern: "B.ts" }),
								{ timestampMs: 11, toolCallId: "grep-b" },
							),
							createEvent("tool_result", "grep", "No matches found", {
								timestampMs: 12,
								toolCallId: "grep-a",
							}),
						],
					},
				],
				2,
			),
		).join("\n");

		expect(rendered).toContain('grep {"pattern":"A.ts"} → no matches');
		expect(rendered).not.toContain('grep {"pattern":"B.ts"} → no matches');
	});

	test("removes terminal controls while preserving Unicode activity", () => {
		// Purpose: untrusted agent and tool display fields must not emit terminal control sequences.
		// Input and expected output: ANSI, C0/C1 controls, and line breaks are removed or folded around valid Unicode text.
		// Edge case: Unicode spaces, combining marks, ZWJ, RTL text, and BiDi isolates remain unchanged.
		// Dependencies: the unthemed widget output contains no framework-owned ANSI sequences.
		const rendered = renderWidget(
			[
				{
					runId: "Unsafe",
					agentId:
						"Agent\u0000\u0007\u0008\u007f\u001b[0m⚠️\u00a0A\u2003B\u202fC",
					events: [
						createEvent(
							"tool_call",
							"read\u0007\u0081\u001b]0;bad\u0007",
							JSON.stringify({
								path: "данные/\u0000👩🏽‍💻é\tfile\u0081\u001b[2J.ts\u00a0X\u2003Y\u202fZ\u2067עברית\u2069",
							}),
							{ timestampMs: 10, toolCallId: "unsafe-read" },
						),
					],
				},
			],
			2,
			120,
		).join("\n");

		for (const control of FORBIDDEN_STANDALONE_CONTROLS) {
			expect(rendered).not.toContain(control);
		}
		expect(rendered).not.toContain("\nfile");
		expect(rendered).toContain("Agent⚠️\u00a0A\u2003B\u202fC");
		expect(rendered).toContain(
			'read {"path":"данные/\\u0000👩🏽‍💻é\\tfile\\u001b[2J.ts\u00a0X\u2003Y\u202fZ\u2067עברית\u2069"}',
		);
	});

	test("keeps styled Unicode rows within the Pi component width contract", () => {
		// Purpose: selected tree rows must remain one visual line for ANSI and multi-code-point graphemes.
		// Input and expected output: emoji, variation selectors, skin tone, ZWJ, and combining marks render within each supplied width.
		// Edge case: widths shorter than the connector or status glyph must not emit an SGR reset that breaks parent styling.
		// Dependencies: Pi visibleWidth measures the final component lines, including the separator.
		const theme: WidgetTheme = {
			fg(color: string, text: string): string {
				const code = color === "error" ? 31 : 36;
				return `\u001b[${code}m${text}\u001b[39m`;
			},
		};
		const roots: readonly RunFixture[] = [
			{
				runId: "UnicodeAgent⚠️👩🏽‍💻é",
				agentId: "UnicodeAgent⚠️👩🏽‍💻é",
				contextUsage: {
					tokens: 230000,
					contextWindow: 272000,
					percent: 84.56,
				},
				events: [
					createEvent(
						"tool_call",
						"read",
						JSON.stringify({ path: "данные/👨‍👩‍👧‍👦.ts" }),
						10,
					),
				],
			},
		];

		for (const width of [1, 2, 3, 8, 12, 24, 40]) {
			const rendered = renderWidget(roots, 2, width, theme);
			expect(rendered.length).toBeLessThanOrEqual(3);
			for (const line of rendered) {
				expect(line).not.toContain(SGR_RESET);
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});
