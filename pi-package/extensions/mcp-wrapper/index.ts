import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { McpClientManager, type ServerInstructions } from "./client-manager.ts";
import { type McpWrapperConfigResult, readMcpWrapperConfig } from "./config.ts";
import { renderMcpToolCall, renderMcpToolResult } from "./rendering.ts";
import { mapMcpToolResult } from "./result-mapper.ts";
import { createSdkMcpClient } from "./sdk-client-factory.ts";
import {
	buildPiToolCatalog,
	type PiToolCatalogEntry,
	type RejectedPiToolRoute,
} from "./tool-catalog.ts";

const ISSUE_PREFIX = "[mcp-wrapper]";
const STATUS_KEY_PREFIX = "mcp-";
const PROMPT_SNIPPET_MAX_LENGTH = 100;
const WORD_BOUNDARY_MIN_RATIO = 0.6;

type ValidMcpWrapperConfig = Extract<
	McpWrapperConfigResult,
	{ readonly kind: "valid" }
>["config"];

interface McpWrapperDependencies {
	readonly readConfig?: () => Promise<McpWrapperConfigResult>;
	readonly createManager?: (
		config: ValidMcpWrapperConfig,
	) => Pick<McpClientManager, "discoverServers" | "callTool">;
}

/** Extension entry point for registering configured MCP tools after session startup. */
export default function mcpWrapper(
	pi: ExtensionAPI,
	dependencies: McpWrapperDependencies = {},
): void {
	const readConfig = dependencies.readConfig ?? readMcpWrapperConfig;
	let activeServerInstructions: readonly ServerInstructions[] = [];

	pi.on("session_start", async (_event, ctx) => {
		activeServerInstructions = [];
		const configResult = await readConfig();
		if (configResult.kind === "invalid") {
			ctx.ui.notify(`${ISSUE_PREFIX} ${configResult.issue}`, "warning");
			return;
		}
		if (!configResult.config.enabled) {
			return;
		}
		if (Object.keys(configResult.config.mcpServers).length === 0) {
			return;
		}

		const manager =
			dependencies.createManager?.(configResult.config) ??
			new McpClientManager({
				createClient: createSdkMcpClient,
				timeouts: configResult.config.timeouts,
			});
		const discovery = await manager.discoverServers(
			configResult.config.mcpServers,
		);
		for (const failure of discovery.failures) {
			ctx.ui.setStatus(
				buildStatusKey(failure.serverKey),
				`${failure.serverKey}: ${failure.issue}`,
			);
		}

		const catalog = buildPiToolCatalog(discovery.serverToolLists);
		const registeredServerKeys = new Set(
			catalog.tools.map((entry) => entry.route.serverKey),
		);
		activeServerInstructions = discovery.serverInstructions.filter(
			(serverInstructions) =>
				registeredServerKeys.has(serverInstructions.serverKey),
		);
		for (const rejected of catalog.rejected) {
			ctx.ui.setStatus(
				buildStatusKey(rejected.serverKey),
				`${rejected.serverKey}: ${rejected.issue}`,
			);
		}
		for (const entry of catalog.tools) {
			pi.registerTool(
				buildToolDefinition(entry, manager, configResult.config.mcpServers),
			);
		}

		reportStartupDiagnostics(ctx, {
			connectedServers: discovery.serverToolLists.map(
				(serverToolList) => serverToolList.serverKey,
			),
			registeredTools: catalog.tools.map((entry) => entry.definition.name),
			failures: discovery.failures,
			rejected: catalog.rejected,
		});
	});

	pi.on("before_agent_start", (event) => {
		if (activeServerInstructions.length === 0) {
			return undefined;
		}

		return {
			systemPrompt: `${(event as BeforeAgentStartEventLike).systemPrompt}\n\n${renderMcpInstructions(activeServerInstructions)}`,
		};
	});
}

interface BeforeAgentStartEventLike {
	readonly systemPrompt: string;
}

function buildToolDefinition(
	entry: PiToolCatalogEntry,
	manager: Pick<McpClientManager, "callTool">,
	servers: ValidMcpWrapperConfig["mcpServers"],
): ToolDefinition {
	return {
		name: entry.definition.name,
		label: entry.definition.name,
		description: buildToolDescription(entry),
		promptSnippet: buildPromptSnippet(entry),
		parameters: entry.definition.parameters,
		renderCall: (args, theme) =>
			renderMcpToolCall(entry.definition.name, args, theme),
		renderResult: renderMcpToolResult,
		async execute(_toolCallId, params) {
			const serverConfig = servers[entry.route.serverKey];
			if (serverConfig === undefined) {
				throw new Error(
					`missing MCP server config for ${entry.route.serverKey}`,
				);
			}
			const result = await manager.callTool(
				entry.route,
				serverConfig,
				params as Record<string, unknown>,
			);
			return mapMcpToolResult(result as Parameters<typeof mapMcpToolResult>[0]);
		},
	};
}

function renderMcpInstructions(
	serverInstructions: readonly ServerInstructions[],
): string {
	return [
		"<mcp_instructions>",
		...serverInstructions.map(
			(instructions) =>
				`  <server name="${escapeMcpInstructionAttribute(instructions.serverKey)}">\n${escapeMcpInstructionText(instructions.instructions)}\n  </server>`,
		),
		"</mcp_instructions>",
	].join("\n");
}

function escapeMcpInstructionText(value: string): string {
	return value.replaceAll("<", "&lt;");
}

function escapeMcpInstructionAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;");
}

function buildToolDescription(entry: PiToolCatalogEntry): string {
	const serverName = JSON.stringify(entry.route.serverKey);
	const description = entry.definition.description?.trim();
	if (description === undefined || description.length === 0) {
		return `Tool from MCP server ${serverName}.`;
	}

	return `Tool from MCP server ${serverName}: ${description}`;
}

function buildPromptSnippet(entry: PiToolCatalogEntry): string {
	return truncateAtWord(
		buildToolDescription(entry).replaceAll(/\s+/g, " "),
		PROMPT_SNIPPET_MAX_LENGTH,
	);
}

function truncateAtWord(text: string, targetLength: number): string {
	if (text.length <= targetLength) {
		return text;
	}

	const truncated = text.slice(0, targetLength);
	const lastSpace = truncated.lastIndexOf(" ");
	if (lastSpace > targetLength * WORD_BOUNDARY_MIN_RATIO) {
		return `${truncated.slice(0, lastSpace)}...`;
	}

	return `${truncated}...`;
}

interface StartupDiagnostics {
	readonly connectedServers: readonly string[];
	readonly registeredTools: readonly string[];
	readonly failures: readonly {
		readonly serverKey: string;
		readonly issue: string;
	}[];
	readonly rejected: readonly RejectedPiToolRoute[];
}

function reportStartupDiagnostics(
	ctx: {
		readonly ui: { notify(message: string, type?: "info" | "warning"): void };
	},
	diagnostics: StartupDiagnostics,
): void {
	const message = formatStartupDiagnostics(diagnostics);
	if (message === undefined) {
		return;
	}

	ctx.ui.notify(
		`${ISSUE_PREFIX} MCPs: ${message}`,
		diagnostics.failures.length > 0 || diagnostics.rejected.length > 0
			? "warning"
			: "info",
	);
}

function formatStartupDiagnostics(
	diagnostics: StartupDiagnostics,
): string | undefined {
	const parts: string[] = [];
	if (diagnostics.connectedServers.length > 0) {
		parts.push(`connected: ${diagnostics.connectedServers.join(", ")}`);
	}
	if (diagnostics.registeredTools.length > 0) {
		parts.push(`tools: ${diagnostics.registeredTools.join(", ")}`);
	}
	if (diagnostics.failures.length > 0) {
		parts.push(
			`failed: ${diagnostics.failures
				.map((failure) => `${failure.serverKey} (${failure.issue})`)
				.join(", ")}`,
		);
	}
	if (diagnostics.rejected.length > 0) {
		parts.push(
			`rejected: ${diagnostics.rejected.map(formatRejectedTool).join(", ")}`,
		);
	}

	return parts.length === 0 ? undefined : parts.join("; ");
}

function formatRejectedTool(rejected: RejectedPiToolRoute): string {
	return rejected.kind === "tool"
		? `${rejected.serverKey}/${rejected.mcpToolName} (${rejected.issue})`
		: `${rejected.serverKey} (${rejected.issue})`;
}

function buildStatusKey(serverKey: string): string {
	const statusKey = serverKey
		.toLowerCase()
		.replaceAll(/[^a-z0-9_-]+/g, "-")
		.replaceAll(/^-+|-+$/g, "")
		.replaceAll(/-+/g, "-");
	return `${STATUS_KEY_PREFIX}${statusKey.length > 0 ? statusKey : "server"}`;
}
