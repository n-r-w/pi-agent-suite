/** Identifies the process role for template selection. */
export type AgentKind = "mainAgent" | "childAgent";

/** Represents template text shared by both roles or restricted to one role. */
export interface TemplatePart {
	readonly text: string;
	readonly kind: AgentKind | undefined;
}

/** Represents validated template parts or a validation diagnostic. */
export type SectionParseResult =
	| { readonly kind: "valid"; readonly parts: readonly TemplatePart[] }
	| { readonly kind: "invalid"; readonly issue: string };

/** Matches spaces and tabs before a marker-only line's section marker. */
const LINE_PREFIX_PATTERN = /^[\t ]*$/;

/** Matches spaces, tabs, and an optional CR after a marker-only line's section marker. */
const LINE_SUFFIX_PATTERN = /^[\t ]*\r?$/;

/** Parses a template into validated role-specific text parts. */
export function parseTemplateSections(template: string): SectionParseResult {
	const parts: TemplatePart[] = [];
	let section: AgentKind | undefined;
	let cursor = 0;
	for (const match of template.matchAll(/{{\s*([#/])([^{}]*?)\s*}}/g)) {
		const name = match[2]?.trim();
		if (name !== "mainAgent" && name !== "childAgent") {
			return { kind: "invalid", issue: `unknown section kind: ${name}` };
		}
		const opening = match[1] === "#";
		if (opening && section !== undefined) {
			return { kind: "invalid", issue: `nested section: ${name}` };
		}
		if (!opening && section !== name) {
			return {
				kind: "invalid",
				issue: `unmatched or mismatched section: ${name}`,
			};
		}

		const { start, end } = getMarkerRange(
			template,
			match.index,
			match[0].length,
		);
		parts.push({ text: template.slice(cursor, start), kind: section });
		section = opening ? name : undefined;
		cursor = end;
	}
	if (section !== undefined) {
		return { kind: "invalid", issue: `unclosed section: ${section}` };
	}
	parts.push({ text: template.slice(cursor), kind: undefined });
	return { kind: "valid", parts };
}

/** Returns the source span to remove for a section marker. */
function getMarkerRange(
	template: string,
	start: number,
	length: number,
): { readonly start: number; readonly end: number } {
	const end = start + length;
	const lineStart = template.lastIndexOf("\n", start - 1) + 1;
	const newline = template.indexOf("\n", end);
	const lineEnd = newline === -1 ? template.length : newline;
	if (
		LINE_PREFIX_PATTERN.test(template.slice(lineStart, start)) &&
		LINE_SUFFIX_PATTERN.test(template.slice(end, lineEnd))
	) {
		return { start: lineStart, end: newline === -1 ? lineEnd : lineEnd + 1 };
	}
	return { start, end };
}

/** Returns template text for the selected process role. */
export function selectTemplateSections(
	parts: readonly TemplatePart[],
	kind: AgentKind,
): string {
	return parts
		.filter((part) => part.kind === undefined || part.kind === kind)
		.map((part) => part.text)
		.join("");
}
