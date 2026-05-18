import { visibleWidth } from "@earendil-works/pi-tui";
import { sliceTextByWidth, truncateTextByWidth } from "./display-width.ts";

const SEPARATOR = " ";

/** Defines the styled label and plain text that must wrap inside one TUI row width. */
interface LabeledWrappedTextOptions {
	readonly label: string;
	readonly text: string;
	readonly width: number;
	readonly labelStyle: (value: string) => string;
	readonly textStyle: (value: string) => string;
}

/** Renders a styled label followed by wrapped text without exceeding the provided display width. */
export function renderLabeledWrappedText(
	options: LabeledWrappedTextOptions,
): string[] {
	const safeWidth = Math.max(0, Math.floor(options.width));
	if (safeWidth === 0) {
		return [];
	}

	const labelWidth = visibleWidth(options.label);
	if (labelWidth >= safeWidth) {
		return [
			options.labelStyle(truncateTextByWidth(options.label, safeWidth, "…")),
			...wrapTextByWidth(options.text, safeWidth).map(options.textStyle),
		];
	}

	const firstTextWidth = safeWidth - labelWidth - visibleWidth(SEPARATOR);
	const wrappedText = wrapTextWithFirstLineWidth(
		options.text,
		firstTextWidth,
		safeWidth,
	);
	if (wrappedText.length === 0) {
		return [options.labelStyle(options.label)];
	}

	const [firstLine = "", ...restLines] = wrappedText;
	return [
		`${options.labelStyle(options.label)}${options.textStyle(`${SEPARATOR}${firstLine}`)}`,
		...restLines.map(options.textStyle),
	];
}

/** Wraps text while reserving a shorter width for the first row after the label. */
function wrapTextWithFirstLineWidth(
	text: string,
	firstLineWidth: number,
	otherLineWidth: number,
): string[] {
	if (text.length === 0) {
		return [];
	}
	if (firstLineWidth <= 0) {
		return wrapTextByWidth(text, otherLineWidth);
	}

	const [firstParagraph = "", ...remainingParagraphs] = text.split("\n");
	const firstChunk = sliceTextByWidth(firstParagraph, firstLineWidth);
	if (firstChunk.length === 0 && firstParagraph.length > 0) {
		return wrapTextByWidth(text, otherLineWidth);
	}

	const remainder = [
		firstParagraph.slice(firstChunk.length),
		...remainingParagraphs,
	].join("\n");
	return [
		firstChunk,
		...wrapTextByWidth(remainder, otherLineWidth).filter(
			(line, index) => index > 0 || line.length > 0,
		),
	];
}

/** Splits plain text into display-width-bounded rows without inserting ellipses. */
function wrapTextByWidth(text: string, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (paragraph.length === 0) {
			lines.push("");
			continue;
		}

		let remaining = paragraph;
		while (remaining.length > 0) {
			const line = sliceTextByWidth(remaining, safeWidth);
			if (line.length === 0) {
				break;
			}
			lines.push(line);
			remaining = remaining.slice(line.length);
		}
	}
	return lines;
}
