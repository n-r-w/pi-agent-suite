import type { TSchema } from "typebox";
import { adaptMcpInputSchema } from "./schema-adapter.ts";

const MAX_PI_TOOL_NAME_LENGTH = 64;
const TOOL_NAME_SEPARATOR_COUNT = 1;
const PROVIDER_SAFE_FIRST_CHAR = /^[a-z_]$/;

export interface McpToolSummary {
	readonly name: string;
	readonly description?: string | undefined;
	readonly inputSchema: unknown;
}

export interface McpServerToolList {
	readonly serverKey: string;
	readonly tools: readonly McpToolSummary[];
}

export interface PiToolRoute {
	readonly serverKey: string;
	readonly mcpToolName: string;
}

export interface PiToolCatalogEntry {
	readonly definition: {
		readonly name: string;
		readonly description?: string;
		readonly parameters: TSchema;
	};
	readonly route: PiToolRoute;
}

export type RejectedPiToolRoute =
	| {
			readonly kind: "server";
			readonly serverKey: string;
			readonly issue: string;
	  }
	| {
			readonly kind: "tool";
			readonly serverKey: string;
			readonly mcpToolName: string;
			readonly issue: string;
	  };

export interface PiToolCatalog {
	readonly tools: readonly PiToolCatalogEntry[];
	readonly rejected: readonly RejectedPiToolRoute[];
}

export type PiToolNameResult =
	| { readonly kind: "valid"; readonly name: string }
	| { readonly kind: "invalid"; readonly issue: string };

export interface PiToolCatalogOptions {
	readonly buildName?: (
		serverKey: string,
		mcpToolName: string,
	) => PiToolNameResult;
}

export function buildPiToolCatalog(
	serverToolLists: readonly McpServerToolList[],
	options: PiToolCatalogOptions = {},
): PiToolCatalog {
	const buildName = options.buildName ?? buildPiToolName;
	const accepted: PiToolCatalogEntry[] = [];
	const rejected: RejectedPiToolRoute[] = [];

	for (const serverToolList of serverToolLists) {
		const serverNameCheck = buildName(serverToolList.serverKey, "probe");
		if (
			serverNameCheck.kind === "invalid" &&
			serverNameCheck.issue.startsWith("server key")
		) {
			rejected.push({
				kind: "server",
				serverKey: serverToolList.serverKey,
				issue: serverNameCheck.issue,
			});
			continue;
		}

		for (const tool of serverToolList.tools) {
			const routeResult = buildCatalogEntry(
				serverToolList.serverKey,
				tool,
				buildName,
			);
			if (routeResult.kind === "invalid") {
				rejected.push(routeResult.rejected);
				continue;
			}

			accepted.push(routeResult.entry);
		}
	}

	return rejectCollidingRoutes(accepted, rejected);
}

function buildCatalogEntry(
	serverKey: string,
	tool: McpToolSummary,
	buildName: (serverKey: string, mcpToolName: string) => PiToolNameResult,
):
	| { readonly kind: "valid"; readonly entry: PiToolCatalogEntry }
	| { readonly kind: "invalid"; readonly rejected: RejectedPiToolRoute } {
	const nameResult = buildName(serverKey, tool.name);
	if (nameResult.kind === "invalid") {
		return {
			kind: "invalid",
			rejected: buildToolRejection(serverKey, tool.name, nameResult.issue),
		};
	}

	const parametersResult = adaptMcpInputSchema(tool.inputSchema);

	return {
		kind: "valid",
		entry: {
			definition: {
				name: nameResult.name,
				...(tool.description !== undefined
					? { description: tool.description }
					: {}),
				parameters: parametersResult.parameters,
			},
			route: { serverKey, mcpToolName: tool.name },
		},
	};
}

function buildToolRejection(
	serverKey: string,
	mcpToolName: string,
	issue: string,
): RejectedPiToolRoute {
	return { kind: "tool", serverKey, mcpToolName, issue };
}

function rejectCollidingRoutes(
	accepted: readonly PiToolCatalogEntry[],
	rejected: readonly RejectedPiToolRoute[],
): PiToolCatalog {
	const nameCounts = new Map<string, number>();
	for (const entry of accepted) {
		nameCounts.set(
			entry.definition.name,
			(nameCounts.get(entry.definition.name) ?? 0) + 1,
		);
	}

	const tools: PiToolCatalogEntry[] = [];
	const finalRejected: RejectedPiToolRoute[] = [...rejected];
	for (const entry of accepted) {
		if ((nameCounts.get(entry.definition.name) ?? 0) > 1) {
			finalRejected.push({
				kind: "tool",
				serverKey: entry.route.serverKey,
				mcpToolName: entry.route.mcpToolName,
				issue: "generated Pi tool name collides with another MCP route",
			});
			continue;
		}

		tools.push(entry);
	}

	return { tools, rejected: finalRejected };
}

/** Builds a deterministic Pi tool name for one MCP server/tool route. */
export function buildPiToolName(
	serverKey: string,
	mcpToolName: string,
): PiToolNameResult {
	const serverSlug = createSlug(serverKey);
	if (serverSlug.length === 0) {
		return {
			kind: "invalid",
			issue: "server key must contain ASCII letters or digits",
		};
	}

	if (!PROVIDER_SAFE_FIRST_CHAR.test(serverSlug[0] ?? "")) {
		return {
			kind: "invalid",
			issue: "server key slug must start with an ASCII letter or underscore",
		};
	}

	const toolSlug = createSlug(mcpToolName);
	if (toolSlug.length === 0) {
		return {
			kind: "invalid",
			issue: "MCP tool name must contain ASCII letters or digits",
		};
	}

	const fullName = `${serverSlug}_${toolSlug}`;
	if (fullName.length <= MAX_PI_TOOL_NAME_LENGTH) {
		return { kind: "valid", name: fullName };
	}

	const slugBudget = MAX_PI_TOOL_NAME_LENGTH - TOOL_NAME_SEPARATOR_COUNT;
	const serverBudget = Math.max(1, Math.floor(slugBudget / 2));
	const toolBudget = Math.max(1, slugBudget - serverBudget);

	return {
		kind: "valid",
		name: `${serverSlug.slice(0, serverBudget)}_${toolSlug.slice(0, toolBudget)}`,
	};
}

/** Converts arbitrary MCP identifiers into provider-safe ASCII slug segments. */
function createSlug(value: string): string {
	return value
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "_")
		.replaceAll(/^_+|_+$/g, "")
		.replaceAll(/_+/g, "_");
}
