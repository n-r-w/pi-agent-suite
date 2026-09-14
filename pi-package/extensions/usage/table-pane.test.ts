import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { UsageRow } from "./aggregation";
import { renderTablePane } from "./table-pane";

const CELL_SEPARATOR_PATTERN = /\s+/;

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
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

interface ColumnExpectation {
	readonly width: number;
	readonly values: readonly [string, string, string, string];
}

function visibleColumnStart(
	line: string,
	value: string,
	columnWidth: number,
): number {
	const index = line.lastIndexOf(value);
	if (index < 0) {
		throw new Error(`Missing table value: ${value}`);
	}
	return (
		visibleWidth(line.slice(0, index)) -
		Math.max(0, columnWidth - visibleWidth(value))
	);
}

describe("usage table pane", () => {
	test("aligns every numeric column after the longest model label", () => {
		// Purpose: one long provider/model label must not shift only its numeric cells beyond the shared table columns.
		// Inputs and expected output: the header, Total, short-model, and long-model rows use identical visible starts for all numeric columns.
		// Edge case: the long model label exceeds the 24-column minimum while every row has distinct numeric values.
		// Dependencies: production table formatting and terminal visible-width measurement.
		const rows: UsageRow[] = [
			{
				label: "Total",
				costPercent: 100,
				tokens: 101,
				cacheRead: 1001,
				cacheWrite: 2001,
				hitPercent: 11.1,
				cost: 1.1111,
				saved: 2.1111,
			},
			{
				label: "short/model",
				costPercent: 10.2,
				tokens: 102,
				cacheRead: 1002,
				cacheWrite: 2002,
				hitPercent: 11.2,
				cost: 1.1112,
				saved: 2.1112,
			},
			{
				label: "provider/模型模型模型模型模型模型模型模型模型",
				costPercent: 10.3,
				tokens: 103,
				cacheRead: 1003,
				cacheWrite: 2003,
				hitPercent: 11.3,
				cost: 1.1113,
				saved: 2.1113,
			},
		];
		const lines = renderTablePane(rows, {
			width: 200,
			height: 10,
			verticalOffset: 0,
			horizontalOffset: 0,
			focused: false,
			theme,
		}).lines;
		const columns: readonly ColumnExpectation[] = [
			{ width: 8, values: ["Cost%", "100.0", "10.2", "10.3"] },
			{ width: 8, values: ["Tokens", "101", "102", "103"] },
			{ width: 9, values: ["CacheR", "2K", "2K", "2K"] },
			{ width: 9, values: ["CacheW", "3K", "3K", "3K"] },
			{ width: 8, values: ["Hit%", "11.1", "11.2", "11.3"] },
			{ width: 7, values: ["Cost", "1.1111", "1.1112", "1.1113"] },
			{ width: 7, values: ["Saved", "2.1111", "2.1112", "2.1113"] },
		];

		for (const column of columns) {
			const starts = column.values.map((value, row) =>
				visibleColumnStart(lines[row] ?? "", value, column.width),
			);
			expect(new Set(starts).size).toBe(1);
		}
	});

	test("renders token counts with upward rounding and unit promotion", () => {
		// Purpose: token columns must use the approved compact display contract.
		// Inputs and expected output: each boundary example renders identically in Tokens, Read, and Write.
		// Edge case: 999,999 and 999,999,999 promote to the next suffix after upward rounding.
		// Dependencies: production table rendering only.
		const examples = [
			[123, "123"],
			[1_000, "1K"],
			[1_001, "2K"],
			[200_001, "201K"],
			[999_999, "1.0M"],
			[1_000_000, "1.0M"],
			[2_000_001, "2.1M"],
			[999_999_999, "1.0B"],
			[1_000_000_000, "1.0B"],
			[1_000_000_001, "1.1B"],
		] as const;
		const rows = examples.map(
			([value], index): UsageRow => ({
				label: `example-${index}`,
				costPercent: 12.3,
				tokens: value,
				cacheRead: value,
				cacheWrite: value,
				hitPercent: 12.3,
				cost: 1.2345,
				saved: 2.3456,
			}),
		);
		const lines = renderTablePane(rows, {
			width: 200,
			height: 20,
			verticalOffset: 0,
			horizontalOffset: 0,
			focused: false,
			theme,
		}).lines;

		for (const [index, [, expected]] of examples.entries()) {
			const cells = (lines[index + 1] ?? "")
				.trim()
				.split(CELL_SEPARATOR_PATTERN);
			expect(cells.slice(2, 5)).toEqual([expected, expected, expected]);
		}
	});

	test("renders unit symbols only in table headers", () => {
		// Purpose: data cells must not repeat the units already communicated by the headers.
		// Inputs and expected output: Hit%, Cost, and Saved render exact symbol-free numeric values.
		// Edge case: decimal precision remains unchanged when the symbols are removed.
		// Dependencies: production row formatting.
		const lines = renderTablePane(
			[
				{
					label: "provider/model",
					costPercent: 45.6,
					tokens: 123,
					cacheRead: 456,
					cacheWrite: 789,
					hitPercent: 12.3,
					cost: 1.2345,
					saved: 2.3456,
				},
			],
			{
				width: 200,
				height: 4,
				verticalOffset: 0,
				horizontalOffset: 0,
				focused: false,
				theme,
			},
		).lines;
		const cells = (lines[1] ?? "").trim().split(CELL_SEPARATOR_PATTERN);

		expect(cells.slice(1)).toEqual([
			"45.6",
			"123",
			"456",
			"789",
			"12.3",
			"1.2345",
			"2.3456",
		]);
	});

	test("keeps monetary values within seven visible characters", () => {
		// Purpose: Cost and Saved must preserve useful precision without widening their cells.
		// Inputs and expected output: ordinary and large values use the greatest fitting precision and compact suffixes only when needed.
		// Edge case: rounding grows the integer part, and large values select M notation without a dollar sign.
		// Dependencies: production row formatting and terminal visible-width measurement.
		const values = [
			[0, "0.0000"],
			[1.23456, "1.2346"],
			[1551.75686, "1551.76"],
			[9_999_999.6, "10.000M"],
			[12_345_678, "12.346M"],
		] as const;
		const rows = values.map(
			([value], index): UsageRow => ({
				label: `money-${index}`,
				costPercent: 100,
				tokens: 0,
				cacheRead: 0,
				cacheWrite: 0,
				hitPercent: 0,
				cost: value,
				saved: value,
			}),
		);
		const lines = renderTablePane(rows, {
			width: 200,
			height: 10,
			verticalOffset: 0,
			horizontalOffset: 0,
			focused: false,
			theme,
		}).lines;

		for (const [index, [, expected]] of values.entries()) {
			const cells = (lines[index + 1] ?? "")
				.trim()
				.split(CELL_SEPARATOR_PATTERN);
			expect(cells.slice(-2)).toEqual([expected, expected]);
			expect(visibleWidth(expected)).toBeLessThanOrEqual(7);
			expect(expected).not.toContain("$");
		}
	});

	test("colors every header as one focus group and leaves data unstyled", () => {
		// Purpose: table focus must apply to the complete eight-column header instead of only Model.
		// Inputs and expected output: inactive headers use accent, active headers use borderAccent, and the data row has normal text color.
		// Edge case: all headers change together without styling any numeric data cell.
		// Dependencies: Pi theme foreground colors and production table rendering.
		const rows: UsageRow[] = [
			{
				label: "provider/model",
				costPercent: 100,
				tokens: 123,
				cacheRead: 456,
				cacheWrite: 789,
				hitPercent: 12.3,
				cost: 1.2345,
				saved: 2.3456,
			},
		];
		const render = (focused: boolean) =>
			renderTablePane(rows, {
				width: 200,
				height: 4,
				verticalOffset: 0,
				horizontalOffset: 0,
				focused,
				theme,
			}).lines;
		const inactive = render(false);
		const active = render(true);

		for (const header of [
			"Model",
			"Cost%",
			"Tokens",
			"CacheR",
			"CacheW",
			"Hit%",
			"Cost",
			"Saved",
		]) {
			expect(inactive[0]).toContain(`\u001b[31m${header}\u001b[39m`);
			expect(active[0]).toContain(`\u001b[36m${header}\u001b[39m`);
		}
		expect(inactive[1]).not.toContain("\u001b[");
		expect(active[1]).not.toContain("\u001b[");
	});

	test("colors vertical and horizontal scroll tracks with focus-dependent thumbs", () => {
		// Purpose: every table scroll indicator must match the /subagents color contract.
		// Inputs and expected output: tracks use muted while focused and inactive thumbs use border and borderMuted.
		// Edge case: a small two-axis viewport renders vertical and horizontal tracks at the same time.
		// Dependencies: shared scroll-thumb calculation, horizontal table overflow, and Pi theme colors.
		const rows = Array.from(
			{ length: 10 },
			(_, index): UsageRow => ({
				label: `provider/model-with-a-long-name-${index}`,
				costPercent: 10,
				tokens: index + 1,
				cacheRead: index + 2,
				cacheWrite: index + 3,
				hitPercent: 12.3,
				cost: 1.2345,
				saved: 2.3456,
			}),
		);
		const render = (focused: boolean) =>
			renderTablePane(rows, {
				width: 40,
				height: 6,
				verticalOffset: 2,
				horizontalOffset: 8,
				focused,
				theme,
			});
		const focused = render(true);
		const inactive = render(false);
		const focusedHorizontal = focused.lines.at(-1) ?? "";
		const inactiveHorizontal = inactive.lines.at(-1) ?? "";

		expect(focused.scroll.join("")).toContain("\u001b[90m░\u001b[39m");
		expect(focused.scroll.join("")).toContain("\u001b[32m█\u001b[39m");
		expect(inactive.scroll.join("")).toContain("\u001b[90m░\u001b[39m");
		expect(inactive.scroll.join("")).toContain("\u001b[33m█\u001b[39m");
		expect(focusedHorizontal).toContain("\u001b[90m░\u001b[39m");
		expect(focusedHorizontal).toContain("\u001b[32m█\u001b[39m");
		expect(inactiveHorizontal).toContain("\u001b[90m░\u001b[39m");
		expect(inactiveHorizontal).toContain("\u001b[33m█\u001b[39m");
	});
});
