import { createHash } from "node:crypto";

import { MAX_SOURCE_CHARACTERS, MAX_SOURCE_LINES } from "./limits.js";
import {
	MERMAID_DIAGRAM_TYPES,
	type MermaidDiagramType,
	type MermaidExtractionResult,
} from "./types.js";

/** Largest indentation accepted before a CommonMark fence. */
const MAX_FENCE_INDENT_PREFIX = "   ";
/** Opening Markdown fence with a Mermaid info token. */
const OPENING_FENCE_PATTERN =
	/^( {0,3})(`{3,}|~{3,})[\t ]*mermaid(?:[\t ].*)?$/;
/** First Mermaid source token used to select a supported renderer family. */
const TYPE_TOKEN_PATTERN = /^([A-Za-z][A-Za-z\d-]*)/;
/** Runtime membership check derived from the finite diagram type contract. */
const SUPPORTED_TYPES = new Set<MermaidDiagramType>(MERMAID_DIAGRAM_TYPES);

interface ExtractedSource {
	source: string;
}

/** Extracts Mermaid fenced blocks and applies source preflight checks. */
export function extractMermaidBlocks(
	textParts: readonly string[],
): MermaidExtractionResult[] {
	return textParts.flatMap(extractSourcesFromText).map(createExtractionResult);
}

/** Scans one Markdown text part without allowing fences to cross content-part boundaries. */
function extractSourcesFromText(text: string): ExtractedSource[] {
	const lines = text.split("\n");
	const sources: ExtractedSource[] = [];
	let lineIndex = 0;

	while (lineIndex < lines.length) {
		const openingMatch = OPENING_FENCE_PATTERN.exec(lines[lineIndex] ?? "");
		if (openingMatch === null) {
			lineIndex += 1;
			continue;
		}

		const marker = openingMatch[2];
		if (marker === undefined) {
			lineIndex += 1;
			continue;
		}
		const closingIndex = findClosingFence(lines, lineIndex + 1, marker);
		if (closingIndex === -1) {
			break;
		}

		const source = lines.slice(lineIndex + 1, closingIndex).join("\n");
		if (source.trim().length > 0) {
			sources.push({ source });
		}
		lineIndex = closingIndex + 1;
	}

	return sources;
}

/** Finds a closing fence with the same marker and at least the opening length. */
function findClosingFence(
	lines: readonly string[],
	startIndex: number,
	openingMarker: string,
): number {
	const markerCharacter = openingMarker[0];
	if (markerCharacter === undefined) {
		return -1;
	}

	for (let index = startIndex; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const trimmed = line.startsWith(MAX_FENCE_INDENT_PREFIX)
			? line.slice(MAX_FENCE_INDENT_PREFIX.length)
			: line.trimStart();
		const markerLength = countLeadingCharacter(trimmed, markerCharacter);
		if (
			markerLength >= openingMarker.length &&
			trimmed.slice(markerLength).trim().length === 0
		) {
			return index;
		}
	}
	return -1;
}

/** Counts one repeated fence marker at the beginning of a line. */
function countLeadingCharacter(value: string, character: string): number {
	let count = 0;
	while (value[count] === character) {
		count += 1;
	}
	return count;
}

/** Converts one extracted source into an accepted block or a finite preflight failure. */
function createExtractionResult(
	candidate: ExtractedSource,
): MermaidExtractionResult {
	const lineCount = candidate.source.split("\n").length;
	if (
		lineCount > MAX_SOURCE_LINES ||
		candidate.source.length > MAX_SOURCE_CHARACTERS
	) {
		return failedBlock(
			`Mermaid source exceeds the ${MAX_SOURCE_LINES}-line or ${MAX_SOURCE_CHARACTERS}-character limit.`,
		);
	}

	const diagramType = readDiagramType(candidate.source);
	if (diagramType === undefined) {
		return failedBlock("Unsupported Mermaid diagram type");
	}

	return {
		status: "accepted",
		block: {
			diagramType,
			source: candidate.source,
			sourceHash: hashSource(candidate.source),
		},
	};
}

/** Creates a rejected result without retaining Mermaid source or metadata. */
function failedBlock(explanation: string): MermaidExtractionResult {
	return { status: "failed", explanation };
}

/** Reads and narrows the top-level Mermaid type token. */
function readDiagramType(source: string): MermaidDiagramType | undefined {
	const token = readSourceToken(source);
	return token !== undefined && SUPPORTED_TYPES.has(token as MermaidDiagramType)
		? (token as MermaidDiagramType)
		: undefined;
}

/** Reads the first non-empty source line token for safe diagnostics. */
function readSourceToken(source: string): string | undefined {
	const firstLine = source.split("\n").find((line) => line.trim().length > 0);
	return firstLine === undefined
		? undefined
		: TYPE_TOKEN_PATTERN.exec(firstLine.trim())?.[1];
}

/** Computes the source identity used to validate worker responses. */
function hashSource(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}
