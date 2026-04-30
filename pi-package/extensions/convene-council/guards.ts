import { PARTICIPANT_IDS, THINKING_VALUES } from "./constants";
import type { ParticipantId, Thinking } from "./types";

/** Returns true when model ID contains provider and model parts separated by the first slash. */
export function hasProviderModelShape(modelId: string): boolean {
	const separatorIndex = modelId.indexOf("/");
	return separatorIndex > 0 && separatorIndex < modelId.length - 1;
}

/** Returns true when an object contains only keys from a finite set. */
export function hasOnlyKeys(
	value: Record<string, unknown>,
	allowedKeys: readonly string[],
): boolean {
	return Object.keys(value).every((key) => allowedKeys.includes(key));
}

/** Returns true when a runtime value is a non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns true when a runtime value is an accepted thinking value. */
export function isThinking(value: unknown): value is Thinking {
	return (
		typeof value === "string" &&
		(THINKING_VALUES as readonly string[]).includes(value)
	);
}

/** Parses an unknown active thinking level into a participant reasoning value. */
export function parseThinking(value: unknown): Thinking | undefined {
	return isThinking(value) ? value : undefined;
}

/** Returns true when a runtime value is a supported participant ID. */
export function isParticipantId(value: unknown): value is ParticipantId {
	return (
		typeof value === "string" &&
		(PARTICIPANT_IDS as readonly string[]).includes(value)
	);
}

/** Returns true when a runtime value is an integer greater than zero. */
export function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Returns true when a runtime value is an integer greater than or equal to zero. */
export function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Returns true when a Node.js file operation failed because the target is absent. */
export function isFileNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { readonly code?: unknown }).code === "ENOENT"
	);
}

/** Converts unknown failures into safe diagnostics. */
export function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
