const XML_ESCAPE_PATTERN = /[&<>"']/g;

const XML_ESCAPE_MAP: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&apos;",
};

/** Escapes XML delimiter characters before inserting untrusted text into XML-like prompts or output. */
export function escapeXmlText(value: string): string {
	return value.replace(
		XML_ESCAPE_PATTERN,
		(character) => XML_ESCAPE_MAP[character] ?? character,
	);
}
