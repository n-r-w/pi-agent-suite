import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	createSubagentWidgetEvent as createEvent,
	getSubagentWidgetContentLines as getContentLines,
	type SubagentWidgetRunFixture as RunFixture,
	renderSubagentWidgetFixture as renderWidget,
} from "../../../test/support/subagent-widget";

describe("subagent widget hierarchy", () => {
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

	test("collapses a fully successful widget to its aggregate header", () => {
		// Purpose: completed successful history must not keep occupying the live status area.
		// Input and expected output: two successful roots with a successful child render only the header.
		// Edge case: header totals still include the nested child.
		// Dependencies: the all-terminal policy is evaluated before body allocation.
		const rendered = getContentLines(
			renderWidget(
				[
					{
						runId: "DoneRootA",
						status: "succeeded",
						children: [{ runId: "DoneChild", status: "succeeded" }],
					},
					{ runId: "DoneRootB", status: "succeeded" },
				],
				7,
			),
		);

		expect(rendered).toEqual(["Subagents: 0 running · 0 failed · 3 done"]);
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
				],
			},
			{
				budget: 3,
				visible: ["RootA", "RootB"],
				hidden: ["ChildA", "GrandchildA", "DoneLeafA", "FailedChildB"],
			},
			{
				budget: 4,
				visible: ["RootA", "ChildA", "RootB"],
				hidden: ["GrandchildA", "DoneLeafA", "FailedChildB"],
			},
			{
				budget: 5,
				visible: ["RootA", "ChildA", "RootB", "FailedChildB"],
				hidden: ["GrandchildA", "DoneLeafA"],
			},
			{
				budget: 6,
				visible: ["RootA", "ChildA", "GrandchildA", "DoneLeafA", "RootB"],
				hidden: ["FailedChildB"],
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
				hidden: [],
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
			expect(text).not.toContain("DoneRootC");
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
		expect(local).toContain("3 more: ⏳1 ✗1 ✓1");
		expect(global).toContain("3 roots: ⏳1 ✗1 ✓1");
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
