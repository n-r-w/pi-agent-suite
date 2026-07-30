import { describe, expect, test } from "bun:test";
import { formatDuration } from "./semantic-layout";

describe("semantic layout", () => {
	test("formats every elapsed duration with the shared compact units", () => {
		// Purpose: every subagent surface must use one duration format.
		// Inputs and expected output: seconds, minute-second, and hour-minute ranges use stable compact fields.
		// Edge case: exact minute and hour boundaries retain their lower zero-valued field.
		// Dependencies: shared semantic duration formatting only.
		expect([
			formatDuration(12_999),
			formatDuration(59_999),
			formatDuration(60_000),
			formatDuration(68_999),
			formatDuration(3_600_000),
			formatDuration(4_200_999),
		]).toEqual(["12s", "59s", "1m", "1m8s", "1h", "1h10m"]);
	});
});
