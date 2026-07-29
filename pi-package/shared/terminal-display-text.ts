/**
 * Terminal-safe single-line text normalization.
 *
 * The normalizer removes terminal controls and folds ASCII spaces and characters
 * that can create terminal line breaks or control spacing. Other Unicode content,
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
/** Matches complete JSON string tokens after the enclosing JSON text is parsed. */
const JSON_STRING_TOKEN_PATTERN = /"(?:\\[\s\S]|[^"\\])*"/g;

/** Removes terminal controls and folds single-line spacing without rewriting visible Unicode. */
export function normalizeTerminalDisplayText(value: string): string {
	let normalized = "";
	for (const character of stripVTControlCharacters(value)) {
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined) {
			continue;
		}
		if (codePoint === ASCII_SPACE || LINE_CONTROL_WHITESPACE.has(character)) {
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

/**
 * Produces one terminal-safe collapsed tool line.
 *
 * Valid JSON string tokens are decoded separately so formatting controls are
 * normalized without parsing and reserializing number or object values.
 */
export function normalizeCollapsedToolText(value: string): string {
	return normalizeTerminalDisplayText(normalizeJsonStringTokens(value));
}

/** Normalizes decoded JSON strings while retaining every non-string JSON lexeme. */
function normalizeJsonStringTokens(value: string): string {
	try {
		// Only complete JSON may interpret textual escape sequences as controls.
		JSON.parse(value);
	} catch {
		return value;
	}

	return value.replace(JSON_STRING_TOKEN_PATTERN, (token) => {
		const decoded: unknown = JSON.parse(token);
		if (typeof decoded !== "string") {
			return token;
		}
		const normalized = normalizeTerminalDisplayText(decoded);
		return normalized === decoded ? token : JSON.stringify(normalized);
	});
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
