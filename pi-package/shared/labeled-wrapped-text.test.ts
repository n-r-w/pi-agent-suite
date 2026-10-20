import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderLabeledWrappedText } from "./labeled-wrapped-text.ts";

/** Marks the label role without changing its display width. */
const labelStyle = (value: string): string => `\x1b[33m${value}\x1b[39m`;
/** Marks value rows separately from the label. */
const textStyle = (value: string): string => `\x1b[36m${value}\x1b[39m`;

describe("renderLabeledWrappedText", () => {
	test.each([
		{
			label: "From:",
			text: "review",
			width: 6,
			expected: ["From: ", "review"],
		},
		{ label: "L:", text: "界ab", width: 4, expected: ["L: ", "界ab"] },
	])("moves the value below an unavailable first row: $label/$width", ({
		label,
		text,
		width,
		expected,
	}) => {
		const rows = renderLabeledWrappedText({
			label,
			text,
			width,
			labelStyle,
			textStyle,
		});
		expect(rows.map(stripVTControlCharacters)).toEqual([...expected]);
		for (const row of rows) {
			expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
		expect(rows[0]).toBe(`${labelStyle(label)}${textStyle(" ")}`);
		expect(rows.slice(1).join("")).toBe(textStyle(text));
		expect(rows.slice(1).map(stripVTControlCharacters).join("")).toBe(text);
	});

	test.each([
		{ width: 12, expected: ["From: review"] },
		{ width: 9, expected: ["From: rev", "iew"] },
		{ width: 7, expected: ["From: r", "eview"] },
	])("retains label and value sharing a row at width $width", ({
		width,
		expected,
	}) => {
		const rows = renderLabeledWrappedText({
			label: "From:",
			text: "review",
			width,
			labelStyle,
			textStyle,
		});
		expect(rows.map(stripVTControlCharacters)).toEqual([...expected]);
		for (const row of rows) {
			expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
		expect(rows[0]).toBe(
			`${labelStyle("From:")}${textStyle(expected[0]?.slice(5) ?? "")}`,
		);
		expect(rows.map(stripVTControlCharacters).join("")).toBe("From: review");
	});
});
