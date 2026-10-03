import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { truncateToolTextOutput } from "../../shared/tool-output-truncation";

/** Formats model-facing tool output with shared truncation that keeps start of text, as consult_advisor does. */
export async function formatToolOutput(
	text: string,
): Promise<AgentToolResult<unknown>> {
	const output = await truncateToolTextOutput(text, "pi-convene-council-");
	return {
		content: [{ type: "text", text: output.content }],
		details: output.details,
	};
}
