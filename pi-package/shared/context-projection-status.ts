/** Shared helpers for child-owned context projection status text. */

/** Identifies footer status updates for context projection savings. */
export const CONTEXT_PROJECTION_STATUS_KEY = "context-projection";

/** ASCII code for the escape character used by terminal control sequences. */
const ASCII_ESCAPE_CODE = 27;

/** Escape character used to build the SGR pattern without embedding a control character in source. */
const ESCAPE_CHARACTER = String.fromCharCode(ASCII_ESCAPE_CODE);

/** Matches terminal SGR sequences because child RPC status text can be themed. */
const ANSI_SGR_PATTERN = new RegExp(
	`${ESCAPE_CHARACTER}\\[[0-?]*[ -/]*[@-~]`,
	"g",
);

/** Matches positive compact projection savings such as `~65k`. */
const POSITIVE_PROJECTION_STATUS_PATTERN = /^~(\d+(?:\.\d+)?)(k?)$/;

/** Converts a compact thousands suffix to a complete token count. */
const TOKENS_PER_THOUSAND = 1_000;

/** Keeps only positive projection savings and removes child theme escape codes. */
export function normalizePositiveProjectionStatus(
	statusText: string | undefined,
): string | undefined {
	if (statusText === undefined) {
		return undefined;
	}

	const normalizedText = statusText
		.replace(ANSI_SGR_PATTERN, "")
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
	const match = POSITIVE_PROJECTION_STATUS_PATTERN.exec(normalizedText);
	if (match === null) {
		return undefined;
	}

	const savedTokens = Number(match[1]);
	if (!Number.isFinite(savedTokens) || savedTokens <= 0) {
		return undefined;
	}

	return `~${match[1]}${match[2] ?? ""}`;
}

/** Converts one positive projection status into its approximate saved-token count. */
export function projectionSavedTokensFromStatus(
	statusText: string | undefined,
): number | undefined {
	const normalized = normalizePositiveProjectionStatus(statusText);
	if (normalized === undefined) {
		return undefined;
	}

	const usesThousands = normalized.endsWith("k");
	const numericText = normalized.slice(1, usesThousands ? -1 : undefined);
	const savedTokens = Math.round(
		Number(numericText) * (usesThousands ? TOKENS_PER_THOUSAND : 1),
	);
	return Number.isSafeInteger(savedTokens) && savedTokens > 0
		? savedTokens
		: undefined;
}
