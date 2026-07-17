import { stripVTControlCharacters } from "node:util";

/** Final C0 control code removed from terminal display rows. */
const C0_CONTROL_END = 0x1f;
/** First C1 control code removed from terminal display rows. */
const C1_CONTROL_START = 0x7f;
/** Final C1 control code removed from terminal display rows. */
const C1_CONTROL_END = 0x9f;

/** Removes terminal controls while preserving every layout-significant space. */
export function sanitizeMermaidRow(value: string): string {
	let sanitized = "";
	for (const character of stripVTControlCharacters(value)) {
		const codePoint = character.codePointAt(0);
		if (
			codePoint !== undefined &&
			codePoint > C0_CONTROL_END &&
			(codePoint < C1_CONTROL_START || codePoint > C1_CONTROL_END)
		) {
			sanitized += character;
		}
	}
	return sanitized;
}
