import { visibleWidth } from "@earendil-works/pi-tui";

import {
	MERMAID_COMPATIBILITY_WARNING_CODES,
	type MermaidCompatibilityWarning,
	type MermaidCompatibilityWarningCode,
	type MermaidSourceBlock,
	type MermaidStructuralWarningCode,
} from "./types.js";

/** Sequence note syntax that the renderer can omit before the first message. */
const SEQUENCE_NOTE_PATTERN = /^\s*note\s+(?:left of|right of|over)\b/i;
/** Message forms accepted by the pinned sequence parser. */
const SEQUENCE_MESSAGE_PATTERN =
	/^\s*\S+?\s*(?:->>|-->>|-\)|--\)|-x|--x|->|-->)\s*[+-]?\S+?\s*:/;
/** Inline formatting tags that beautiful-mermaid can display literally. */
const INLINE_HTML_PATTERN = /<\/?(?:b|strong|i|em|u)\b[^>]*>/i;
/** Mermaid comment lines that do not contribute to rendered output. */
const COMMENT_LINE_PATTERN = /^\s*%%/;

/** Stable user-facing explanations for known beautiful-mermaid 1.1.3 defects. */
const WARNING_EXPLANATIONS: Record<MermaidCompatibilityWarningCode, string> = {
	circle_edge_omission:
		'The renderer can omit the target node or edge for "--o".',
	cross_edge_omission:
		'The renderer can omit the target node or edge for "--x".',
	early_sequence_note_omission:
		"The renderer can omit sequence notes placed before the first message.",
	subgraph_endpoint_phantom_node:
		"The renderer can create phantom nodes for edges connected to a subgraph identifier.",
	literal_html_tag:
		"The renderer can display inline HTML formatting tags literally.",
	wide_character_alignment:
		"CJK or emoji labels can be misaligned in the ASCII preview.",
};

/** Combines parser-owned structural findings with small display-risk checks. */
export function detectCompatibilityWarnings(
	block: MermaidSourceBlock,
	structuralCodes: readonly MermaidStructuralWarningCode[] = [],
): MermaidCompatibilityWarning[] {
	const lines = block.source
		.split("\n")
		.filter((line) => !COMMENT_LINE_PATTERN.test(line));
	const renderedSource = lines.join("\n");
	const codes = new Set<MermaidCompatibilityWarningCode>(structuralCodes);
	if (hasEarlySequenceNote(block, lines)) {
		codes.add("early_sequence_note_omission");
	}
	if (INLINE_HTML_PATTERN.test(renderedSource)) {
		codes.add("literal_html_tag");
	}
	if (hasTerminalWideCharacter(renderedSource)) {
		codes.add("wide_character_alignment");
	}
	return MERMAID_COMPATIBILITY_WARNING_CODES.filter((code) =>
		codes.has(code),
	).map((code) => ({ code, explanation: WARNING_EXPLANATIONS[code] }));
}

/** Detects a sequence note whose line precedes the first sequence message. */
function hasEarlySequenceNote(
	block: MermaidSourceBlock,
	lines: readonly string[],
): boolean {
	if (block.diagramType !== "sequenceDiagram") {
		return false;
	}
	const bodyLines = lines.slice(1);
	const noteIndex = bodyLines.findIndex((line) =>
		SEQUENCE_NOTE_PATTERN.test(line),
	);
	if (noteIndex === -1) {
		return false;
	}
	const messageIndex = bodyLines.findIndex((line) =>
		SEQUENCE_MESSAGE_PATTERN.test(line),
	);
	return messageIndex === -1 || noteIndex < messageIndex;
}

/** Uses Pi's display-width authority for CJK and emoji compatibility warnings. */
function hasTerminalWideCharacter(source: string): boolean {
	return [...source].some((character) => visibleWidth(character) > 1);
}
