/** Lists the role section names, one for each process role. */
const ROLE_SECTIONS = ["mainAgent", "childAgent"] as const;

/** Identifies the process role for template selection. */
export type AgentKind = (typeof ROLE_SECTIONS)[number];

/** Names the section whose text only an agent that can start workflows receives. */
const WORKFLOW_SECTION = "workflowAgent";

/** Lists every section name that a template may use. */
type SectionName = AgentKind | typeof WORKFLOW_SECTION;

/** Represents template text with the role and workflow conditions of its enclosing sections. */
export interface TemplatePart {
	readonly text: string;
	readonly kind: AgentKind | undefined;
	readonly requiresWorkflows: boolean;
}

/** Describes the agent for which the extension selects template text. */
export interface TemplateAudience {
	readonly kind: AgentKind;
	readonly hasWorkflows: boolean;
}

/** Represents validated template parts or a validation diagnostic. */
export type SectionParseResult =
	| { readonly kind: "valid"; readonly parts: readonly TemplatePart[] }
	| { readonly kind: "invalid"; readonly issue: string };

/** Matches spaces and tabs before a marker-only line's section marker. */
const LINE_PREFIX_PATTERN = /^[\t ]*$/;

/** Matches spaces, tabs, and an optional CR after a marker-only line's section marker. */
const LINE_SUFFIX_PATTERN = /^[\t ]*\r?$/;

/** Parses a template into validated role-specific and workflow-specific text parts. */
export function parseTemplateSections(template: string): SectionParseResult {
	const parts: TemplatePart[] = [];
	const openSections: SectionName[] = [];
	let cursor = 0;
	for (const match of template.matchAll(/{{\s*([#/])([^{}]*?)\s*}}/g)) {
		const name = match[2]?.trim();
		if (!isSectionName(name)) {
			return { kind: "invalid", issue: `unknown section kind: ${name}` };
		}
		const opening = match[1] === "#";
		if (opening && !canOpenSection(openSections, name)) {
			return { kind: "invalid", issue: `nested section: ${name}` };
		}
		if (!opening && openSections.at(-1) !== name) {
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
		parts.push(createPart(template.slice(cursor, start), openSections));
		if (opening) {
			openSections.push(name);
		} else {
			openSections.pop();
		}
		cursor = end;
	}
	const unclosed = openSections.at(-1);
	if (unclosed !== undefined) {
		return { kind: "invalid", issue: `unclosed section: ${unclosed}` };
	}
	parts.push(createPart(template.slice(cursor), openSections));
	return { kind: "valid", parts };
}

/** Returns whether a template marker names a supported section. */
function isSectionName(name: string | undefined): name is SectionName {
	return ROLE_SECTIONS.includes(name as AgentKind) || name === WORKFLOW_SECTION;
}

/** Returns whether a section may open inside the currently open sections. */
function canOpenSection(
	open: readonly SectionName[],
	name: SectionName,
): boolean {
	// A workflow section may stand inside one role section; no other nesting exists.
	return (
		open.length === 0 ||
		(open.length === 1 &&
			open[0] !== WORKFLOW_SECTION &&
			name === WORKFLOW_SECTION)
	);
}

/** Creates a text part with the conditions of the currently open sections. */
function createPart(text: string, open: readonly SectionName[]): TemplatePart {
	return {
		text,
		kind: open.find((name): name is AgentKind => name !== WORKFLOW_SECTION),
		requiresWorkflows: open.includes(WORKFLOW_SECTION),
	};
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

/** Returns template text for the selected process role and workflow availability. */
export function selectTemplateSections(
	parts: readonly TemplatePart[],
	audience: TemplateAudience,
): string {
	return parts
		.filter(
			(part) =>
				(part.kind === undefined || part.kind === audience.kind) &&
				(!part.requiresWorkflows || audience.hasWorkflows),
		)
		.map((part) => part.text)
		.join("");
}
