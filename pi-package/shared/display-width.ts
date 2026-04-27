import { visibleWidth } from "@mariozechner/pi-tui";

/** Splits terminal text into user-perceived characters before width clipping. */
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
	granularity: "grapheme",
});

/** Returns plain text clipped to a display width without ANSI style resets. */
export function sliceTextByWidth(value: string, maxWidth: number): string {
	const safeMaxWidth = Math.max(0, Math.floor(maxWidth));
	if (safeMaxWidth === 0) {
		return "";
	}

	let output = "";
	let usedWidth = 0;
	for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
		const segmentWidth = visibleWidth(segment);
		if (usedWidth + segmentWidth > safeMaxWidth) {
			break;
		}
		output += segment;
		usedWidth += segmentWidth;
	}

	return output;
}

/** Returns plain text truncated with an ellipsis without ANSI style resets. */
export function truncateTextByWidth(
	value: string,
	maxWidth: number,
	ellipsis = "…",
): string {
	const safeMaxWidth = Math.max(0, Math.floor(maxWidth));
	if (safeMaxWidth === 0) {
		return "";
	}
	if (visibleWidth(value) <= safeMaxWidth) {
		return value;
	}
	if (ellipsis.length === 0) {
		return sliceTextByWidth(value, safeMaxWidth);
	}

	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsisWidth >= safeMaxWidth) {
		return sliceTextByWidth(ellipsis, safeMaxWidth);
	}

	return `${sliceTextByWidth(value, safeMaxWidth - ellipsisWidth)}${ellipsis}`;
}

/** Returns a plain-text suffix clipped to a display width without splitting graphemes. */
export function sliceTextSuffixByWidth(
	value: string,
	maxWidth: number,
): string {
	const safeMaxWidth = Math.max(0, Math.floor(maxWidth));
	if (safeMaxWidth === 0) {
		return "";
	}

	let output = "";
	let usedWidth = 0;
	const segments = Array.from(
		GRAPHEME_SEGMENTER.segment(value),
		(part) => part.segment,
	);
	for (const segment of segments.reverse()) {
		const segmentWidth = visibleWidth(segment);
		if (usedWidth + segmentWidth > safeMaxWidth) {
			break;
		}
		output = `${segment}${output}`;
		usedWidth += segmentWidth;
	}

	return output;
}
