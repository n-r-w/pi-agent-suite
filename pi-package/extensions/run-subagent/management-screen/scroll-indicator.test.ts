import { describe, expect, test } from "bun:test";
import { calculateScrollThumb } from "./scroll-indicator";

describe("management scroll indicator", () => {
	test("maps scroll offsets to top, middle, and bottom thumb rows", () => {
		// Purpose: pane borders must expose the current viewport position without changing content width.
		// Inputs and expected output: equal metrics at top, middle, and bottom map across the complete track.
		// Edge case: content that fits returns no thumb.
		// Dependencies: pure scroll metrics only.
		expect([
			calculateScrollThumb({ offset: 0, total: 100, viewport: 10 }, 10),
			calculateScrollThumb({ offset: 45, total: 100, viewport: 10 }, 10),
			calculateScrollThumb({ offset: 90, total: 100, viewport: 10 }, 10),
			calculateScrollThumb({ offset: 0, total: 10, viewport: 10 }, 10),
		]).toEqual([
			{ start: 0, length: 1 },
			{ start: 5, length: 1 },
			{ start: 9, length: 1 },
			undefined,
		]);
	});

	test("scales the thumb to the visible content fraction", () => {
		// Purpose: larger visible fractions must produce longer border thumbs.
		// Inputs and expected output: half-visible content occupies two of five track rows at the bottom.
		// Edge case: zero track height cannot produce a thumb.
		// Dependencies: pure scroll metrics only.
		expect([
			calculateScrollThumb({ offset: 5, total: 10, viewport: 5 }, 5),
			calculateScrollThumb({ offset: 0, total: 10, viewport: 5 }, 0),
		]).toEqual([{ start: 3, length: 2 }, undefined]);
	});
});
