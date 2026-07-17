import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	getKeybindings,
	Text,
} from "@earendil-works/pi-tui";

import { sliceTextByWidth } from "../../shared/display-width.js";
import {
	MERMAID_COMPATIBILITY_WARNING_CODES,
	type MermaidAsciiVariant,
	type MermaidAsciiVariants,
	type MermaidCompatibilityWarning,
	type MermaidCompatibilityWarningCode,
	type MermaidRenderEntry,
} from "./types.js";
import {
	parseMermaidAsciiVariant,
	parseMermaidExplanation,
} from "./validation.js";

/** Standard Pi action used to expand custom entry output. */
const EXPAND_ACTION = "app.tools.expand";
/** Maximum diagram rows shown before global expansion is enabled. */
const COLLAPSED_ROW_LIMIT = 10;
/** Exact durable entry states accepted during session replay. */
const ENTRY_STATUSES = new Set(["rendered", "warning", "failed"]);
/** Exact compatibility warning identifiers accepted during replay. */
const WARNING_CODES = new Set<MermaidCompatibilityWarningCode>(
	MERMAID_COMPATIBILITY_WARNING_CODES,
);

interface MermaidCustomEntry {
	data?: unknown;
}

interface MermaidRenderOptions {
	expanded: boolean;
}

/** Renders one durable Mermaid preview entry without trusting persisted data. */
export function renderMermaidEntry(
	entry: MermaidCustomEntry,
	options: MermaidRenderOptions,
	theme: Theme,
): Component {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	const parsed = parseMermaidRenderEntry(entry.data);
	if (parsed === undefined) {
		box.addChild(
			new Text(
				theme.fg("error", "Invalid persisted Mermaid preview data."),
				0,
				0,
			),
		);
		return box;
	}

	if (parsed.status === "failed") {
		box.addChild(new Text(theme.fg("error", parsed.explanation), 0, 0));
		return box;
	}

	box.addChild(
		new MermaidDiagramRows(parsed.variants, options.expanded, theme),
	);
	if (parsed.status === "warning") {
		for (const warning of parsed.warnings) {
			box.addChild(
				new Text(theme.fg("warning", `Warning: ${warning.explanation}`), 0, 0),
			);
		}
	}
	return box;
}

/** Clips diagram rows at render time because the enclosing Box determines content width. */
class MermaidDiagramRows implements Component {
	public constructor(
		private readonly variants: MermaidAsciiVariants,
		private readonly expanded: boolean,
		private readonly theme: Theme,
	) {}

	/** Renders fixed diagram rows without wrapping or terminal control sequences. */
	public render(width: number): string[] {
		const variant = selectVariant(this.variants, width);
		const allRows = variant.text.split("\n");
		const selectedRows = this.expanded
			? allRows
			: allRows.slice(0, COLLAPSED_ROW_LIMIT);
		const lines = selectedRows.map((row) =>
			this.theme.fg("customMessageText", sliceTextByWidth(row, width)),
		);

		if (!this.expanded && allRows.length > selectedRows.length) {
			const keys = getKeybindings().getKeys(EXPAND_ACTION).join("/");
			const hint =
				keys.length > 0
					? `... (${allRows.length - selectedRows.length} more rows, ${keys} to expand)`
					: `... (${allRows.length - selectedRows.length} more rows)`;
			lines.push(this.theme.fg("dim", sliceTextByWidth(hint, width)));
		}
		return lines;
	}

	/** Supports Pi component invalidation without retaining mutable render state. */
	public invalidate(): void {}
}

/** Chooses the spacious variant when it fits and the tight variant otherwise. */
function selectVariant(
	variants: MermaidAsciiVariants,
	width: number,
): MermaidAsciiVariant {
	return variants.default.maxLineWidth <= width
		? variants.default
		: variants.tight;
}

/** Validates custom entry data loaded from user-editable session storage. */
function parseMermaidRenderEntry(
	value: unknown,
): MermaidRenderEntry | undefined {
	if (
		!isRecord(value) ||
		typeof value["status"] !== "string" ||
		!ENTRY_STATUSES.has(value["status"])
	) {
		return undefined;
	}
	if (value["status"] === "failed") {
		const explanation = parseMermaidExplanation(value["explanation"]);
		return explanation === undefined
			? undefined
			: { status: "failed", explanation };
	}

	const variants = parseVariants(value["variants"]);
	if (variants === undefined) {
		return undefined;
	}
	if (value["status"] === "rendered") {
		return { status: "rendered", variants };
	}
	const warnings = parseWarnings(value["warnings"]);
	return warnings === undefined
		? undefined
		: { status: "warning", variants, warnings };
}

/** Validates both exact ASCII variant keys and their metadata. */
function parseVariants(value: unknown): MermaidAsciiVariants | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const defaultVariant = parseMermaidAsciiVariant(value["default"]);
	const tightVariant = parseMermaidAsciiVariant(value["tight"]);
	return defaultVariant === undefined || tightVariant === undefined
		? undefined
		: { default: defaultVariant, tight: tightVariant };
}

/** Validates compatibility warning arrays stored in warning entries. */
function parseWarnings(
	value: unknown,
): MermaidCompatibilityWarning[] | undefined {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.length > WARNING_CODES.size
	) {
		return undefined;
	}
	const codes = new Set<MermaidCompatibilityWarningCode>();
	const warnings: MermaidCompatibilityWarning[] = [];
	for (const warning of value) {
		if (!isRecord(warning) || !isWarningCode(warning["code"])) {
			return undefined;
		}
		const explanation = parseMermaidExplanation(warning["explanation"]);
		if (explanation === undefined || codes.has(warning["code"])) {
			return undefined;
		}
		codes.add(warning["code"]);
		warnings.push({ code: warning["code"], explanation });
	}
	return warnings;
}

/** Narrows one persisted warning identifier to the finite contract. */
function isWarningCode(
	value: unknown,
): value is MermaidCompatibilityWarningCode {
	return (
		typeof value === "string" &&
		WARNING_CODES.has(value as MermaidCompatibilityWarningCode)
	);
}

/** Narrows unknown persisted values before reading named fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
