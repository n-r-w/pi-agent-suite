import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { ContextFake, ExtensionApiFake } from "./fakes";

/** Returns the registered convene_council tool. */
export function getCouncilTool(pi: ExtensionApiFake): ToolDefinition {
	const tool = pi.tools.find(
		(candidate) => candidate.name === "convene_council",
	);
	if (tool === undefined) {
		throw new Error("expected convene_council tool");
	}
	return tool;
}

/** Executes the registered convene_council tool. */
export async function executeCouncil(
	pi: ExtensionApiFake,
	ctx: ContextFake,
	question: string,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	return executeCouncilWithOptions(pi, ctx, {
		question,
		...(signal !== undefined ? { signal } : {}),
	});
}

/** Executes convene_council with optional progress observation. */
export async function executeCouncilWithOptions(
	pi: ExtensionApiFake,
	ctx: ContextFake,
	options: {
		readonly question: string;
		readonly signal?: AbortSignal;
		readonly onUpdate?: (partial: AgentToolResult<unknown>) => void;
	},
): Promise<AgentToolResult<unknown>> {
	ensureReadTool(pi);
	return getCouncilTool(pi).execute(
		"call-council",
		{ question: options.question },
		options.signal,
		options.onUpdate,
		ctx as never,
	) as Promise<AgentToolResult<unknown>>;
}

/** Registers the mandatory read tool in tests that do not customize the registry. */
function ensureReadTool(pi: ExtensionApiFake): void {
	if (pi.tools.some((tool) => tool.name === "read")) {
		return;
	}
	pi.registerTool({
		name: "read",
		label: "Read",
		description: "test read tool",
		parameters: Type.Object({ path: Type.String() }),
		async execute() {
			return {
				content: [{ type: "text", text: "unused" }],
				details: undefined,
			};
		},
	});
}
