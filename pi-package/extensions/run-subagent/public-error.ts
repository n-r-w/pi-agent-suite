import { truncateTextByCodeUnits } from "../../shared/display-width.ts";
import { normalizeTerminalDisplayText } from "../../shared/terminal-display-text.ts";

/** Bounds raw work before terminal normalization examines untrusted diagnostics. */
const RAW_PUBLIC_ERROR_CODE_UNIT_LIMIT = 8_000;
/** Bounds model-visible diagnostics without splitting user-perceived characters. */
const PUBLIC_ERROR_CODE_UNIT_LIMIT = 2_000;
const UNKNOWN_ERROR_MESSAGE = "Unknown error";
const ARABIC_LETTER_MARK = 0x061c;
const LEFT_TO_RIGHT_MARK = 0x200e;
const RIGHT_TO_LEFT_MARK = 0x200f;
const BIDIRECTIONAL_EMBEDDING_START = 0x202a;
const BIDIRECTIONAL_OVERRIDE_END = 0x202e;
const BIDIRECTIONAL_ISOLATE_START = 0x2066;
const BIDIRECTIONAL_CONTROL_END = 0x206f;

/** Converts one error message to bounded terminal-safe single-line text. */
export function sanitizePublicSubagentErrorMessage(message: string): string {
	const rawWasTruncated = message.length > RAW_PUBLIC_ERROR_CODE_UNIT_LIMIT;
	const rawPrefix = rawWasTruncated
		? message.slice(0, RAW_PUBLIC_ERROR_CODE_UNIT_LIMIT)
		: message;
	const normalized = removeBidirectionalControls(
		normalizeTerminalDisplayText(rawPrefix),
	);
	if (normalized.length === 0) {
		return UNKNOWN_ERROR_MESSAGE;
	}
	const marked = rawWasTruncated ? `${normalized}…` : normalized;
	return truncateTextByCodeUnits(marked, PUBLIC_ERROR_CODE_UNIT_LIMIT, "…");
}

/** Removes invisible direction overrides that can reorder displayed diagnostics. */
function removeBidirectionalControls(value: string): string {
	let safe = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && !isBidirectionalControl(codePoint)) {
			safe += character;
		}
	}
	return safe;
}

/** Identifies Unicode bidirectional marks, embeddings, overrides, and isolates. */
function isBidirectionalControl(codePoint: number): boolean {
	return (
		codePoint === ARABIC_LETTER_MARK ||
		codePoint === LEFT_TO_RIGHT_MARK ||
		codePoint === RIGHT_TO_LEFT_MARK ||
		(codePoint >= BIDIRECTIONAL_EMBEDDING_START &&
			codePoint <= BIDIRECTIONAL_OVERRIDE_END) ||
		(codePoint >= BIDIRECTIONAL_ISOLATE_START &&
			codePoint <= BIDIRECTIONAL_CONTROL_END)
	);
}
