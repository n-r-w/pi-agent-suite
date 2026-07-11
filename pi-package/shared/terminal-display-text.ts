/**
 * Terminal-safe single-line text normalization.
 *
 * The normalizer removes terminal controls and folds only characters that can
 * create terminal line breaks or control spacing. Other Unicode content,
 * including non-breaking spaces and direction controls, remains unchanged.
 */

import { stripVTControlCharacters } from "node:util";

/** Defines the final C0 control code point. */
const C0_CONTROL_END = 0x1f;
/** Defines the ASCII space used when folding terminal line whitespace. */
const ASCII_SPACE = 0x20;
/** Defines the DEL control and start of the C1 range. */
const C1_CONTROL_START = 0x7f;
/** Defines the final C1 control code point. */
const C1_CONTROL_END = 0x9f;
/** Defines terminal whitespace characters that create row breaks or spacing. */
const LINE_CONTROL_WHITESPACE = new Set([
	"\t",
	"\n",
	"\v",
	"\f",
	"\r",
	"\u0085",
	"\u2028",
	"\u2029",
]);

/** Removes terminal controls while preserving non-control Unicode code points. */
export function normalizeTerminalDisplayText(value: string): string {
	let normalized = "";
	for (const character of stripVTControlCharacters(value)) {
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined) {
			continue;
		}
		if (LINE_CONTROL_WHITESPACE.has(character)) {
			if (!normalized.endsWith(" ")) {
				normalized += " ";
			}
			continue;
		}
		if (
			codePoint <= C0_CONTROL_END ||
			(codePoint >= C1_CONTROL_START && codePoint <= C1_CONTROL_END)
		) {
			continue;
		}
		normalized += character;
	}
	return trimAsciiSpaces(normalized);
}

/** Trims only ASCII spaces without applying Unicode whitespace semantics. */
function trimAsciiSpaces(value: string): string {
	let start = 0;
	while (value.codePointAt(start) === ASCII_SPACE) {
		start += 1;
	}
	let end = value.length;
	while (end > start && value.codePointAt(end - 1) === ASCII_SPACE) {
		end -= 1;
	}
	return value.slice(start, end);
}
