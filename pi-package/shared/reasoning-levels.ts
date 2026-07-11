import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** Lists reasoning levels accepted by extension configuration boundaries. */
export const REASONING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ModelThinkingLevel[];

/** Identifies a reasoning level accepted by extension configuration boundaries. */
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** Rejects values outside the shared reasoning-level vocabulary. */
export function isReasoningLevel(value: unknown): value is ReasoningLevel {
	return (
		typeof value === "string" &&
		(REASONING_LEVELS as readonly string[]).includes(value)
	);
}
