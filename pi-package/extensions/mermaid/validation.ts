import { visibleWidth } from "@earendil-works/pi-tui";

import { normalizeTerminalDisplayText } from "../../shared/terminal-display-text.js";
import {
	MAX_EXPLANATION_CHARACTERS,
	MAX_VARIANT_CHARACTERS,
	MAX_VARIANT_LINES,
} from "./limits.js";
import { sanitizeMermaidRow } from "./terminal-safety.js";
import type { MermaidAsciiVariant } from "./types.js";

/** Validates and sanitizes one untrusted ASCII variant in the parent process. */
export function parseMermaidAsciiVariant(
	value: unknown,
): MermaidAsciiVariant | undefined {
	if (!isRecord(value) || typeof value["text"] !== "string") {
		return undefined;
	}
	const rawText = value["text"];
	const rawLines = rawText.split("\n");
	if (
		rawText.length > MAX_VARIANT_CHARACTERS ||
		rawLines.length > MAX_VARIANT_LINES
	) {
		return undefined;
	}
	const lines = rawLines.map(sanitizeMermaidRow);
	const text = lines.join("\n");
	if (text.trim().length === 0) {
		return undefined;
	}
	return {
		text,
		maxLineWidth: Math.max(...lines.map((line) => visibleWidth(line))),
	};
}

/** Validates and normalizes finite untrusted diagnostic text. */
export function parseMermaidExplanation(value: unknown): string | undefined {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_EXPLANATION_CHARACTERS
	) {
		return undefined;
	}
	const explanation = normalizeTerminalDisplayText(value);
	return explanation.length > 0 ? explanation : undefined;
}

/** Narrows unknown objects before reading boundary fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
