import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	createSubagentWidgetEvent as createEvent,
	getSubagentWidgetContentLines as getContentLines,
	type SubagentWidgetRunFixture as RunFixture,
	renderPinnedSubagentWidgetFixture as renderPinnedWidget,
	renderSubagentWidgetFixture as renderWidget,
} from "../../../test/support/subagent-widget";

describe("subagent widget hierarchy", () => {
	test("shows visible totals and the browser shortcut when sessions are hidden", () => {
		// Purpose: users must know that the bounded automatic view omits selectable sessions.
		// Input and expected output: three active roots with two body rows render one concrete row, one summary, and a 1/3 browser hint.
		// Edge case: aggregate summary rows do not count as displayed sessions.
		// Dependencies: header metadata is derived after automatic forest selection.
		const header = getContentLines(
			renderWidget(
				[{ runId: "RootA" }, { runId: "RootB" }, { runId: "RootC" }],
				3,
			),
		)[0];

		expect(header).toContain("1/3 shown");
		expect(header).toContain("Ctrl+Shift+G");
	});

	test("keeps the browser shortcut visible when every session fits", () => {
		// Purpose: users must retain direct browser access even when the current overview has no omissions.
		// Input and expected output: two completed roots fit in the body while the header still names Ctrl+Shift+G.
		// Edge case: displayed and total session counts are equal.
		// Dependencies: the browser shortcut is an overview action, not only an omission warning.
		const header = getContentLines(
			renderWidget(
				[
					{ runId: "RootA", status: "succeeded" },
					{ runId: "RootB", status: "succeeded" },
				],
				3,
			),
		)[0];

		expect(header).toContain("2/2 shown");
		expect(header).toContain("Ctrl+Shift+G");
	});

	test("shows a selected child with its parent and latest tool events", () => {
		// Purpose: selecting a child must replace the overview with bounded run details rather than a full ancestry path.
		// Input and expected output: two header rows leave room for the latest call and result as separate rows.
		// Edge case: a later assistant event is excluded and every rendered row obeys the width contract.
		// Dependencies: the presentation tree supplies the direct parent and relative nesting depth.
		const rendered = getContentLines(
			renderPinnedWidget(
				[
					{
						runId: "architect",
						agentId: "SubAgentArchitect",
						taskName: "Design widget model",
						children: [
							{
								runId: "sage",
								agentId: "SubAgentSage",
								taskName: "Review widget model",
								status: "succeeded",
								elapsedMs: 85_300,
								runtime: {
									modelId: "openai-codex/gpt-5.6-luna",
									thinking: "low",
									contextWindow: 372_000,
								},
								contextUsage: {
									tokens: 18_000,
									contextWindow: 372_000,
									percent: 4.84,
								},
								events: [
									createEvent("tool_call", "read", '{"path":"old"}', 1),
									createEvent("tool_result", "read", "old result", 2),
									createEvent("tool_call", "bash", '{"command":"bun test"}', 3),
									createEvent("tool_result", "bash", "27 pass", 4),
									createEvent("assistant", "assistant", "done", 5),
									createEvent("error", "assistant", "late failure", 6),
								],
							},
						],
					},
				],
				"sage",
				4,
				120,
			),
		);
		const text = rendered.join("\n");

		expect(rendered).toHaveLength(4);
		expect(rendered[0]).toContain(
			"✓ Child: SubAgentSage #1 · Review widget model · openai-codex/gpt-5.6-luna/low · 18k/372k · 85.3s",
		);
		expect(rendered[1]).toBe(
			"Parent: SubAgentArchitect #1 · Design widget model · Depth 1",
		);
		expect(rendered[2]).toContain('→ bash {"command":"bun test"}');
		expect(rendered[3]).toContain("← bash 27 pass");
		expect(text).not.toContain("old result");
		expect(text).not.toContain("assistant");
		for (const line of rendered) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(120);
		}
	});

	test("shows a selected root with the latest events under one header", () => {
		// Purpose: a selected root must spend every row after its header on recent tool activity.
		// Input and expected output: a three-line budget renders one Root header and the latest call/result pair.
		// Edge case: older tool events are discarded by the visual line budget without a summary row.
		// Dependencies: each retained event is one non-wrapping widget row.
		const rendered = getContentLines(
			renderPinnedWidget(
				[
					{
						runId: "root",
						agentId: "YandexExtractor",
						taskName: "Delegate identity checks",
						events: [
							createEvent("tool_call", "grep", "old query", 1),
							createEvent("tool_call", "read", "latest input", 2),
							createEvent("tool_result", "read", "latest output", 3),
						],
					},
				],
				"root",
				3,
				80,
			),
		);
		const text = rendered.join("\n");

		expect(rendered).toHaveLength(3);
		expect(rendered[0]).toContain(
			"➜ Root: YandexExtractor #1 · Delegate identity checks",
		);
		expect(rendered[1]).toContain("→ read latest input");
		expect(rendered[2]).toContain("← read latest output");
		expect(text).not.toContain("old query");
	});

	test("shows every selected-session state before the root label", () => {
		// Purpose: selected-session completion must remain visible even when no final assistant event row is shown.
		// Input and expected output: new and resumed running roots use invocation icons while terminal roots use final status icons.
		// Edge case: a one-line budget preserves the icon because it precedes all width-sensitive details.
		// Dependencies: selected-session headers share status semantics with automatic overview rows.
		const cases = [
			{ status: "running", isResume: false, icon: "➜" },
			{ status: "running", isResume: true, icon: "⇆" },
			{ status: "succeeded", isResume: true, icon: "✓" },
			{ status: "failed", isResume: true, icon: "✗" },
			{ status: "aborted", isResume: true, icon: "■" },
		] as const;

		for (const item of cases) {
			const [header] = getContentLines(
				renderPinnedWidget(
					[
						{
							runId: `${item.status}-${item.isResume}`,
							status: item.status,
							isResume: item.isResume,
						},
					],
					`${item.status}-${item.isResume}`,
					1,
					24,
				),
			);

			expect(header).toStartWith(`${item.icon} Root:`);
			expect(visibleWidth(header ?? "")).toBeLessThanOrEqual(24);
		}
	});

	test("keeps the latest tool activity after assistant completion", () => {
		// Purpose: overview rows must describe the latest tool operation instead of generic assistant completion.
		// Input and expected output: a tool result followed by an assistant event still renders the matching tool call.
		// Edge case: result correlation recovers call arguments through toolCallId.
		// Dependencies: automatic mode retains the existing priority and hierarchy selection.
		const rendered = getContentLines(
			renderWidget(
				[
					{
						runId: "root",
						events: [
							createEvent("tool_call", "read", '{"path":"README.md"}', {
								timestampMs: 1,
								toolCallId: "call-1",
							}),
							createEvent("tool_result", "read", "contents", {
								timestampMs: 2,
								toolCallId: "call-1",
							}),
							createEvent("assistant", "assistant", "done", 3),
							createEvent("error", "assistant", "late failure", 4),
						],
					},
				],
				2,
			),
		).join("\n");

		expect(rendered).toContain('read {"path":"README.md"}');
		expect(rendered).not.toContain("assistant completed");
	});

	test("shows the local session number for a unique agent run", () => {
		// Purpose: every started invocation must expose the short session label used for continuation.
		// Input and expected output: one Sage root renders #1 between its type and task.
		// Edge case: no second same-agent invocation is needed to make the label visible.
		// Dependencies: visible identity comes from persisted session metadata.
		const rendered = getContentLines(
			renderWidget(
				[
					{
						runId: "single",
						agentId: "SubAgentSage",
						taskName: "Inspect unique task",
					},
				],
				2,
			),
		).join("\n");

		expect(rendered).toContain("Sage #1 · Inspect unique task");
	});

	test("keeps session labels when other sessions are hidden", () => {
		// Purpose: automatic selection must not remove the stable continuation label from a visible row.
		// Input and expected output: three roots exceed the body budget and the selected row still includes its #N session label.
		// Edge case: omission summary rows do not replace the visible invocation identity.
		// Dependencies: automatic selection and identity formatting use the persisted sessionId independently.
		const rendered = getContentLines(
			renderWidget(
				[
					{ runId: "first", agentId: "SubAgentExtractor" },
					{ runId: "second", agentId: "SubAgentExtractor" },
					{ runId: "third", agentId: "SubAgentExtractor" },
				],
				3,
			),
		).join("\n");

		expect(rendered).toContain("Extractor #");
		expect(rendered).not.toContain("Extractor · Inspect");
	});

	test("returns a resumed child session to running without adding a row", () => {
		// Purpose: one widget row represents the long-lived child session rather than each tool invocation.
		// Input and expected output: a completed root with one child is resumed under a new runId; the root returns to running and its completed child remains.
		// Edge case: the latest task and continuation icon replace the prior root presentation while the session count stays two nodes.
		// Dependencies: root and child merging use childSessionId recursively.
		const childSessionId = "019f0000-0000-7000-8000-000000000002";
		const roots: RunFixture[] = [
			{
				runId: "initial",
				agentId: "SubAgentExtractor",
				taskName: "Collect validation evidence",
				sessionId: 2,
				childSessionId,
				status: "succeeded",
				children: [
					{
						runId: "nested",
						agentId: "SubAgentCritic",
						taskName: "Review validation evidence",
						sessionId: 1,
						childSessionId: "019f0000-0000-7000-8000-000000000003",
						status: "succeeded",
					},
				],
			},
			{
				runId: "continued",
				agentId: "SubAgentExtractor",
				taskName: "Verify project quality gates",
				sessionId: 2,
				childSessionId,
				isResume: true,
			},
		];
		const automatic = getContentLines(renderWidget(roots, 3, 120)).join("\n");

		expect(automatic).toContain("1 running · 0 failed · 1 done · 2/2 shown");
		expect(automatic).not.toContain("Collect validation evidence");
		expect(automatic).toContain(
			"⇆ Extractor #2 · Verify project quality gates",
		);
		expect(automatic).toContain("Critic #1 · Review validation evidence");
	});

	test("uses local numbers across root and nested sessions", () => {
		// Purpose: widget identity must use persisted local session labels instead of a computed same-agent sequence.
		// Input and expected output: a root and its nested session may both show #1, while another root keeps its own #2.
		// Edge case: duplicate local numbers do not merge distinct runId values or hierarchy branches.
		// Dependencies: each owning Pi runtime allocates its own numeric session namespace.
		const rendered = renderWidget(
			[
				{
					runId: "root-a",
					agentId: "SubAgentSage",
					taskName: "Trace TUI redraws",
					sessionId: 1,
					children: [
						{
							runId: "nested-a",
							agentId: "SubAgentSage",
							taskName: "Audit widget state",
						},
					],
				},
				{
					runId: "root-b",
					agentId: "SubAgentSage",
					taskName: "Design browser navigation",
					sessionId: 2,
				},
			],
			10,
		).join("\n");

		expect(rendered).toContain("Sage #1 · Trace TUI redraws");
		expect(rendered).toContain("Sage #1 · Audit widget state");
		expect(rendered).toContain("Sage #2 · Design browser navigation");
	});

	test("keeps a nested failure with its complete ancestor path", () => {
		// Purpose: a high-priority descendant must never be rendered without every ancestor.
		// Input and expected output: one active path and three terminal leaves fit as root, child, failed leaf, and a local summary.
		// Edge case: newer completed siblings must not displace an older required ancestor.
		// Dependencies: the public widget state and component factory exercise the complete render contract.
		const rendered = getContentLines(
			renderWidget(
				[
					{
						runId: "RootA",
						status: "succeeded",
						children: [
							{
								runId: "ChildA",
								children: [
									{
										runId: "FailedLeaf",
										status: "failed",
										events: [createEvent("error", "typecheck", "failed", 10)],
									},
									{
										runId: "DoneLeaf1",
										status: "succeeded",
										events: [createEvent("assistant", "assistant", "done", 30)],
									},
									{
										runId: "DoneLeaf2",
										status: "succeeded",
										events: [createEvent("assistant", "assistant", "done", 40)],
									},
								],
							},
						],
					},
				],
				5,
			),
		);
		const text = rendered.join("\n");

		expect(rendered).toHaveLength(5);
		expect(text).toContain("RootA");
		expect(text).toContain("ChildA");
		expect(text).toContain("FailedLeaf");
		expect(text).not.toContain("DoneLeaf1");
		expect(text).not.toContain("DoneLeaf2");
		expect(rendered.find((line) => line.includes("FailedLeaf"))).toStartWith(
			"      ├─",
		);
		const summary = rendered.find((line) => line.includes("2 more"));
		expect(summary).toStartWith("      └─");
		expect(summary).toContain("2 done");
	});

	test("keeps an incomplete deep path collapsed inside its nearest visible ancestor", () => {
		// Purpose: a descendant path that exceeds the budget must remain represented by its visible ancestor.
		// Input and expected output: a three-node active/failure chain with two body rows shows root and child only.
		// Edge case: the hidden failed leaf is summarized inline without adding an eighth-style orphan row.
		// Dependencies: the configured line budget includes the header and both visible nodes.
		const rendered = getContentLines(
			renderWidget(
				[
					{
						runId: "RootA",
						children: [
							{
								runId: "ChildA",
								children: [{ runId: "FailedLeaf", status: "failed" }],
							},
						],
					},
				],
				3,
			),
		);
		const text = rendered.join("\n");

		expect(rendered).toHaveLength(3);
		expect(text).toContain("RootA");
		expect(text).toContain("ChildA");
		expect(text).not.toContain("FailedLeaf");
		expect(rendered.find((line) => line.includes("ChildA"))).toContain(
			"1 nested failed",
		);
	});

	test("keeps omitted root branches in one root-level summary", () => {
		// Purpose: global overflow counts root branches rather than flattened descendant rows.
		// Input and expected output: three active roots fit before a global summary for two completed roots.
		// Edge case: one omitted root has a child that contributes status totals but not another root count.
		// Dependencies: insertion order defines display order for equal-priority roots.
		const rendered = getContentLines(
			renderWidget(
				[
					{ runId: "RootA" },
					{ runId: "RootB" },
					{ runId: "RootC" },
					{ runId: "RootD", status: "succeeded" },
					{
						runId: "RootE",
						status: "succeeded",
						children: [{ runId: "DoneChild", status: "succeeded" }],
					},
				],
				5,
			),
		);
		const text = rendered.join("\n");

		expect(rendered).toHaveLength(5);
		expect(text).toContain("RootA");
		expect(text).toContain("RootB");
		expect(text).toContain("RootC");
		expect(text).not.toContain("RootD");
		expect(text).not.toContain("RootE");
		expect(text).not.toContain("DoneChild");
		const summary = rendered.at(-1);
		expect(summary).toStartWith("└─");
		expect(summary).toContain("2 root agents");
		expect(summary).toContain("3 done");
	});

	test("uses spare rows for completed roots before summarizing overflow", () => {
		// Purpose: completed roots should occupy spare rows without displacing active work or hiding real overflow.
		// Input and expected output: one completed root and its child use spare rows, while multiple completed roots share spare rows with an aggregate.
		// Edge case: root overflow keeps its aggregate before completed children expand, and a one-row body keeps the active root.
		// Dependencies: completed roots are admitted after active and failed paths.
		const roomy = getContentLines(
			renderWidget(
				[
					{ runId: "ActiveRoot" },
					{
						runId: "CompletedRoot",
						status: "succeeded",
						children: [{ runId: "CompletedChild", status: "succeeded" }],
					},
				],
				7,
			),
		).join("\n");
		const overflow = getContentLines(
			renderWidget(
				[
					{ runId: "ActiveRoot" },
					{
						runId: "DoneRootA",
						status: "succeeded",
						children: [{ runId: "OverflowChildA", status: "succeeded" }],
					},
					{
						runId: "DoneRootB",
						status: "succeeded",
						children: [{ runId: "OverflowChildB", status: "succeeded" }],
					},
					{
						runId: "DoneRootC",
						status: "succeeded",
						children: [{ runId: "OverflowChildC", status: "succeeded" }],
					},
				],
				4,
			),
		).join("\n");
		const minimal = getContentLines(
			renderWidget(
				[
					{ runId: "ActiveRoot" },
					{ runId: "CompletedRoot", status: "succeeded" },
				],
				2,
			),
		).join("\n");

		expect(roomy).toContain("ActiveRoot");
		expect(roomy).toContain("CompletedRoot");
		expect(roomy).toContain("CompletedChild");
		expect(roomy).not.toContain("root agent:");
		expect(overflow).toContain("ActiveRoot");
		expect(
			["DoneRootA", "DoneRootB", "DoneRootC"].filter((runId) =>
				overflow.includes(runId),
			),
		).toHaveLength(1);
		expect(overflow).not.toContain("OverflowChild");
		expect(overflow).toContain("2 root agents: 4 done");
		expect(minimal).toContain("ActiveRoot");
		expect(minimal).not.toContain("CompletedRoot");
		expect(minimal).not.toContain("root agent:");
	});

	test("shows completed descendants with spare rows and summarizes them under pressure", () => {
		// Purpose: completed descendants remain useful without displacing running root branches.
		// Input and expected output: the roomy render shows two completed children; the constrained render keeps their count inline.
		// Edge case: five completed root branches remain in the global summary in both layouts.
		// Dependencies: both renders use the same immutable source tree with different budgets.
		const roots: readonly RunFixture[] = [
			{
				runId: "RootA",
				children: [
					{ runId: "DoneChild1", status: "succeeded" },
					{ runId: "DoneChild2", status: "succeeded" },
				],
			},
			{ runId: "RootB" },
			...Array.from({ length: 5 }, (_, index) => ({
				runId: `DoneRoot${index + 1}`,
				status: "succeeded" as const,
			})),
		];
		const roomy = getContentLines(renderWidget(roots, 6)).join("\n");
		const constrained = getContentLines(renderWidget(roots, 3)).join("\n");

		expect(roomy).toContain("DoneChild1");
		expect(roomy).toContain("DoneChild2");
		expect(roomy).toContain("5 root agents");
		expect(constrained).not.toContain("DoneChild1");
		expect(constrained).not.toContain("DoneChild2");
		expect(constrained).toContain("RootA");
		expect(constrained).toContain("2 nested done");
		expect(constrained).toContain("RootB");
	});

	test("shows the most recently updated completed root", () => {
		// Purpose: automatic view must retain useful terminal context after all work finishes.
		// Input and expected output: one body row plus the required hidden summary selects the newest of three successful roots.
		// Edge case: the oldest root owns a successful child, and every session still contributes to header totals.
		// Dependencies: completed root admission uses subtree updatedAtMs ordering.
		const rendered = getContentLines(
			renderWidget(
				[
					{
						runId: "DoneRootA",
						status: "succeeded",
						events: [createEvent("assistant", "older", undefined, 10)],
						children: [{ runId: "DoneChild", status: "succeeded" }],
					},
					{
						runId: "DoneRootB",
						status: "succeeded",
						events: [createEvent("assistant", "newer", undefined, 20)],
					},
					{
						runId: "DoneRootC",
						status: "succeeded",
						events: [createEvent("assistant", "newest", undefined, 30)],
					},
				],
				3,
			),
		);
		const text = rendered.join("\n");

		expect(text).toContain("DoneRootC");
		expect(text).not.toContain("DoneRootA");
		expect(text).not.toContain("DoneRootB");
		expect(rendered[0]).toContain("4 done");
	});

	test("prioritizes failed work before newer running work", () => {
		// Purpose: the smallest automatic view must reserve attention for terminal failure before active progress.
		// Input and expected output: one failed root and two newer running roots compete for two body rows, and the failed root is shown.
		// Edge case: recency must not override status priority while hidden work retains an aggregate row.
		// Dependencies: root admission order defines ownership of the constrained body budget.
		const rendered = getContentLines(
			renderWidget(
				[
					{
						runId: "FailedRoot",
						status: "failed",
						events: [createEvent("error", "failed", undefined, 10)],
					},
					{
						runId: "RunningRootA",
						events: [createEvent("assistant", "running", undefined, 20)],
					},
					{
						runId: "RunningRootB",
						events: [createEvent("assistant", "newest", undefined, 30)],
					},
				],
				3,
			),
		).join("\n");

		expect(rendered).toContain("FailedRoot");
		expect(rendered).toContain("root agent");
	});

	test("keeps a terminal failure visible with its ancestor path", () => {
		// Purpose: an all-terminal widget must retain failures that require attention.
		// Input and expected output: a failed nested child remains below its successful parent while unrelated success uses a spare row.
		// Edge case: a successful ancestor is selected first because it owns the failed path.
		// Dependencies: terminal subtree severity drives priority while rendering preserves source order.
		const rendered = getContentLines(
			renderWidget(
				[
					{
						runId: "RootA",
						status: "succeeded",
						children: [{ runId: "FailedChild", status: "failed" }],
					},
					{ runId: "DoneRoot", status: "succeeded" },
				],
				4,
			),
		);
		const text = rendered.join("\n");

		expect(text).toContain("RootA");
		expect(text).toContain("FailedChild");
		expect(text).toContain("DoneRoot");
		expect(rendered.find((line) => line.includes("FailedChild"))).toStartWith(
			"│  └─",
		);
		expect(text).not.toContain("root agent:");
	});

	test("preserves ancestor closure and height across constrained budgets", () => {
		// Purpose: every configured budget must produce a bounded forest without exposing a partial ancestor path.
		// Input and expected output: two active deep branches and one completed root are rendered for budgets one through seven.
		// Edge case: admission, inline summaries, local summaries, and the global summary compete for the same rows.
		// Dependencies: short unique agent IDs make ancestor implications observable through final rows.
		const roots: readonly RunFixture[] = [
			{
				runId: "RootA",
				children: [
					{
						runId: "ChildA",
						children: [
							{ runId: "GrandchildA" },
							{ runId: "DoneLeafA", status: "succeeded" },
						],
					},
				],
			},
			{
				runId: "RootB",
				children: [{ runId: "FailedChildB", status: "failed" }],
			},
			{ runId: "DoneRootC", status: "succeeded" },
		];

		const expectations = [
			{
				budget: 1,
				visible: [],
				hidden: [
					"RootA",
					"ChildA",
					"GrandchildA",
					"DoneLeafA",
					"RootB",
					"FailedChildB",
					"DoneRootC",
				],
			},
			{
				budget: 2,
				visible: ["3 root agents"],
				hidden: [
					"RootA",
					"ChildA",
					"GrandchildA",
					"DoneLeafA",
					"RootB",
					"FailedChildB",
					"DoneRootC",
				],
			},
			{
				budget: 3,
				visible: ["RootA", "RootB"],
				hidden: [
					"ChildA",
					"GrandchildA",
					"DoneLeafA",
					"FailedChildB",
					"DoneRootC",
				],
			},
			{
				budget: 4,
				visible: ["RootA", "RootB", "FailedChildB"],
				hidden: ["ChildA", "GrandchildA", "DoneLeafA", "DoneRootC"],
			},
			{
				budget: 5,
				visible: ["RootA", "ChildA", "RootB", "FailedChildB"],
				hidden: ["GrandchildA", "DoneLeafA", "DoneRootC"],
			},
			{
				budget: 6,
				visible: ["RootA", "ChildA", "RootB", "FailedChildB", "DoneRootC"],
				hidden: ["GrandchildA", "DoneLeafA"],
			},
			{
				budget: 7,
				visible: [
					"RootA",
					"ChildA",
					"GrandchildA",
					"DoneLeafA",
					"RootB",
					"FailedChildB",
				],
				hidden: ["DoneRootC"],
			},
		] as const;
		for (const expectation of expectations) {
			const rendered = renderWidget(roots, expectation.budget, 80);
			const content = getContentLines(rendered);
			const text = content.join("\n");
			expect(content.length).toBeLessThanOrEqual(expectation.budget);
			expect(rendered.length).toBeLessThanOrEqual(expectation.budget + 1);
			for (const visible of expectation.visible) {
				expect(text).toContain(visible);
			}
			for (const hidden of expectation.hidden) {
				expect(text).not.toContain(hidden);
			}
			for (const line of rendered) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(80);
			}
		}
	});

	test("reserves inline attention ownership before optional row details", () => {
		// Purpose: a zero-row hidden-child aggregate must survive clipping on a normal narrow terminal.
		// Input and expected output: context and long read activity yield space to the owning failed-child summary.
		// Edge case: the row still stays within 80 visible columns after activity is reduced.
		// Dependencies: one body row forces the failed child to remain inline on its running parent.
		const rendered = renderWidget(
			[
				{
					runId: "SubAgentSage",
					elapsedMs: 44000,
					contextUsage: {
						tokens: 220000,
						contextWindow: 272000,
						percent: 80.88,
					},
					events: [
						createEvent(
							"tool_call",
							"read",
							JSON.stringify({
								path: "src/very/long/payment/service/implementation.ts",
							}),
							{ timestampMs: 10, toolCallId: "read-1" },
						),
					],
					children: [{ runId: "FailedChild", status: "failed" }],
				},
			],
			2,
			80,
		);
		const row = getContentLines(rendered).at(1);

		expect(row).toContain("SubAgentSage");
		expect(row).toContain("1 nested failed");
		expect(visibleWidth(row ?? "")).toBeLessThanOrEqual(80);
	});

	test("uses compact mixed ownership summaries at forty columns", () => {
		// Purpose: inline, local, and root summaries must preserve every lifecycle count when verbose text cannot fit.
		// Input and expected output: mixed running, failed, and completed omissions use status icons at width forty.
		// Edge case: optional agent and activity detail yield before required ownership counts.
		// Dependencies: the compact form uses the same status icons as visible widget rows.
		const inline = getContentLines(
			renderWidget(
				[
					{
						runId: "InlineOwner",
						children: [
							{ runId: "HiddenRunning" },
							{ runId: "HiddenFailed", status: "failed" },
							{ runId: "HiddenDone", status: "succeeded" },
						],
					},
				],
				2,
				40,
			),
		).join("\n");
		const local = getContentLines(
			renderWidget(
				[
					{
						runId: "LocalOwner",
						children: [
							{
								runId: "VisibleRunning",
								events: [createEvent("tool_call", "read", undefined, 100)],
							},
							{
								runId: "HiddenRunning",
								events: [createEvent("tool_call", "read", undefined, 90)],
							},
							{ runId: "HiddenFailed", status: "failed" },
							{ runId: "HiddenFailedB", status: "failed" },
							{ runId: "HiddenDone", status: "succeeded" },
						],
					},
				],
				4,
				40,
			),
		).join("\n");
		const global = getContentLines(
			renderWidget(
				[
					{
						runId: "VisibleRoot",
						events: [createEvent("tool_call", "read", undefined, 100)],
					},
					{
						runId: "HiddenRunning",
						events: [createEvent("tool_call", "read", undefined, 90)],
					},
					{
						runId: "HiddenFailed",
						status: "failed",
						events: [createEvent("error", "assistant", "failed", 80)],
					},
					{
						runId: "HiddenFailedB",
						status: "failed",
						events: [createEvent("error", "assistant", "failed", 75)],
					},
					{
						runId: "HiddenDone",
						status: "succeeded",
						events: [createEvent("assistant", "assistant", "done", 70)],
					},
				],
				3,
				40,
			),
		).join("\n");

		expect(inline).toContain("3 nested: ⏳1 ✗1 ✓1");
		expect(local).toContain("4 more: ⏳2 ✗1 ✓1");
		expect(global).toContain("4 roots: ⏳2 ✗1 ✓1");
		for (const text of [inline, local, global]) {
			for (const line of text.split("\n")) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(40);
			}
		}
	});

	test("uses exact mandatory root summaries for tiny active budgets", () => {
		// Purpose: hidden running roots must retain one aggregate row before optional details.
		// Input and expected output: three equal-recency running roots progress from summary-only to one root plus summary to all roots.
		// Edge case: the final root replaces the required summary without exceeding the budget.
		// Dependencies: equal event timestamps make source order the final selection key.
		const roots: readonly RunFixture[] = ["RootA", "RootB", "RootC"].map(
			(runId) => ({
				runId,
				events: [
					createEvent("tool_call", "read", undefined, {
						timestampMs: 10,
						toolCallId: runId,
					}),
				],
			}),
		);
		const budgetTwo = getContentLines(renderWidget(roots, 2)).join("\n");
		const budgetThree = getContentLines(renderWidget(roots, 3)).join("\n");
		const budgetFour = getContentLines(renderWidget(roots, 4)).join("\n");

		expect(budgetTwo).not.toContain("RootA");
		expect(budgetTwo).toContain("3 root agents: 3 running");
		expect(budgetThree).toContain("RootA");
		expect(budgetThree).not.toContain("RootB");
		expect(budgetThree).toContain("2 root agents: 2 running");
		expect(budgetFour).toContain("RootA");
		expect(budgetFour).toContain("RootB");
		expect(budgetFour).toContain("RootC");
		expect(budgetFour).not.toContain("root agents:");
	});

	test("selects an active descendant before a completed descendant", () => {
		// Purpose: the final descendant row must represent live work rather than completed history.
		// Input and expected output: two visible roots compete for one child row under the same budget.
		// Edge case: the completed child remains owned inline by its parent.
		// Dependencies: root source order cannot override the active-before-completed phase boundary.
		const rendered = getContentLines(
			renderWidget(
				[
					{ runId: "RootA", children: [{ runId: "ActiveChild" }] },
					{
						runId: "RootB",
						children: [{ runId: "DoneChild", status: "succeeded" }],
					},
				],
				4,
			),
		).join("\n");

		expect(rendered).toContain("ActiveChild");
		expect(rendered).not.toContain("✓ DoneChild");
		expect(rendered).toContain("RootB");
		expect(rendered).toContain("1 nested done");
	});

	test("keeps a constrained deep aborted path out of all-success collapse", () => {
		// Purpose: aborted work must remain attention state even when every ancestor succeeded.
		// Input and expected output: the root and child fit while the aborted leaf remains an inline failed aggregate.
		// Edge case: no running node exists to prevent collapse independently.
		// Dependencies: aborted status contributes to both attention severity and the failed aggregate.
		const rendered = getContentLines(
			renderWidget(
				[
					{
						runId: "DoneRoot",
						status: "succeeded",
						children: [
							{
								runId: "DoneChild",
								status: "succeeded",
								children: [{ runId: "AbortedLeaf", status: "aborted" }],
							},
						],
					},
				],
				3,
			),
		).join("\n");

		expect(rendered).toContain("DoneRoot");
		expect(rendered).toContain("DoneChild");
		expect(rendered).not.toContain("AbortedLeaf");
		expect(rendered).toContain("1 nested failed");
	});
});
