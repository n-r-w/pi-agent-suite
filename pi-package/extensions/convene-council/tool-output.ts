import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { truncateToolTextOutput } from "../../shared/tool-output-truncation";

/** Formats model-facing tool output using the same truncation policy as consult_advisor. */
export async function formatToolOutput(
	text: string,
): Promise<AgentToolResult<unknown>> {
	const output = await truncateToolTextOutput(text, "pi-convene-council-");
	return {
		content: [{ type: "text", text: output.content }],
		details: output.details,
	};
}
