import type { Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Builds the public schemas for tools active in the current Pi session. */
export function buildActiveToolDefinitions(
	pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
): NonNullable<Context["tools"]> {
	const activeNames = new Set(pi.getActiveTools());
	return pi
		.getAllTools()
		.filter((tool) => activeNames.has(tool.name))
		.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}));
}
