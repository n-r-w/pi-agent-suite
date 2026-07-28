import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerPackageToolPresentation } from "../../shared/tool-presentation/registry.ts";
import { McpClientManager, type ServerInstructions } from "./client-manager.ts";
import {
	type McpServerConfig,
	type McpWrapperConfigResult,
	readMcpWrapperConfig,
} from "./config.ts";
import {
	cachedServerToolList,
	computeMcpServerConfigHash,
	loadMcpWrapperCache,
	type McpWrapperMetadataCache,
	saveMcpWrapperCache,
} from "./metadata-cache.ts";
import { renderMcpToolCall, renderMcpToolResult } from "./rendering.ts";
import { mapMcpToolResult } from "./result-mapper.ts";
import { createSdkMcpClient } from "./sdk-client-factory.ts";
import {
	buildPiToolCatalog,
	type McpServerToolList,
	type PiToolCatalog,
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

type McpManagerLike = Pick<
	McpClientManager,
	"discoverServers" | "callTool" | "closeAll"
>;
type McpManagerFactory = (config: ValidMcpWrapperConfig) => McpManagerLike;

interface McpWrapperDependencies {
	readonly readConfig?: () => Promise<McpWrapperConfigResult>;
	readonly createManager?: McpManagerFactory;
	readonly loadCache?: () => Promise<McpWrapperMetadataCache | null>;
	readonly saveCache?: (cache: McpWrapperMetadataCache) => Promise<void>;
}

/** Extension entry point for registering configured MCP tools after session startup. */
export default function mcpWrapper(
	pi: ExtensionAPI,
	dependencies: McpWrapperDependencies = {},
): void {
	const readConfig = dependencies.readConfig ?? readMcpWrapperConfig;
	const loadCache = dependencies.loadCache ?? loadMcpWrapperCache;
	const saveCache = dependencies.saveCache ?? saveMcpWrapperCache;
	const createManager =
		dependencies.createManager ?? createDefaultMcpClientManager;
	let activeManager: McpManagerLike | undefined;
	let lifecycleVersion = 0;
	let metadataWriteGeneration = 0;
	let serverInstructionRecords: readonly ServerInstructionRecord[] = [];
	const queueCacheSave = createQueuedCacheSave(saveCache);

	registerMcpRefreshCommand(pi, {
		readConfig,
		createManager,
		queueCacheSave,
		invalidateBackgroundCacheWrites: () => {
			metadataWriteGeneration += 1;
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const sessionVersion = lifecycleVersion + 1;
		lifecycleVersion = sessionVersion;
		serverInstructionRecords = [];
		await activeManager?.closeAll();
		activeManager = undefined;

		const result = await handleSessionStart({
			pi,
			ctx,
			readConfig,
			createManager,
			activateManager: (manager) => {
				if (sessionVersion !== lifecycleVersion) {
					manager.closeAll().catch(() => {});
					return;
				}
				activeManager = manager;
			},
			loadCache,
			saveCache: queueCacheSave,
			getMetadataWriteGeneration: () => metadataWriteGeneration,
		});
		if (sessionVersion !== lifecycleVersion) {
			return;
		}
		activeManager = result.manager;
		serverInstructionRecords = result.serverInstructionRecords;
	});

	pi.on("session_shutdown", async () => {
		lifecycleVersion += 1;
		serverInstructionRecords = [];
		const manager = activeManager;
		activeManager = undefined;
		await manager?.closeAll();
	});

	pi.on("before_agent_start", (event) => {
		if (serverInstructionRecords.length === 0) {
			return undefined;
		}

		const activeToolNames = new Set(pi.getActiveTools());
		const visibleServerInstructions = serverInstructionRecords.filter(
			(serverInstructions) =>
				serverInstructions.registeredPiToolNames.some((toolName) =>
					activeToolNames.has(toolName),
				),
		);
		if (visibleServerInstructions.length === 0) {
			return undefined;
		}

		return {
			systemPrompt: `${(event as BeforeAgentStartEventLike).systemPrompt}\n\n${renderMcpInstructions(visibleServerInstructions)}`,
		};
	});
}

interface BeforeAgentStartEventLike {
	readonly systemPrompt: string;
}

interface SessionStartContextLike {
	readonly sessionManager: ExtensionContext["sessionManager"];
	readonly ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string): void;
	};
}

interface HandleSessionStartOptions {
	readonly pi: ExtensionAPI;
	readonly ctx: SessionStartContextLike;
	readonly readConfig: () => Promise<McpWrapperConfigResult>;
	readonly createManager: McpManagerFactory;
	readonly activateManager: (manager: McpManagerLike) => void;
	readonly loadCache: () => Promise<McpWrapperMetadataCache | null>;
	readonly saveCache: (cache: McpWrapperMetadataCache) => Promise<void>;
	readonly getMetadataWriteGeneration: () => number;
}

interface HandleSessionStartResult {
	readonly manager: McpManagerLike | undefined;
	readonly serverInstructionRecords: readonly ServerInstructionRecord[];
}

interface HandleManualRefreshOptions {
	readonly ctx: ExtensionCommandContext;
	readonly readConfig: () => Promise<McpWrapperConfigResult>;
	readonly createManager: McpManagerFactory;
	readonly queueCacheSave: (cache: McpWrapperMetadataCache) => Promise<void>;
	readonly invalidateBackgroundCacheWrites: () => void;
}

type QueuedCacheSave = (cache: McpWrapperMetadataCache) => Promise<void>;

interface ServerInstructionRecord extends ServerInstructions {
	/** Accepted generated Pi tool names that make this server instruction visible when active. */
	readonly registeredPiToolNames: readonly string[];
}

/** Serializes cache writes so a later manual refresh cannot be overwritten by an older background write. */
function createQueuedCacheSave(
	saveCache: (cache: McpWrapperMetadataCache) => Promise<void>,
): QueuedCacheSave {
	let cacheWriteQueue = Promise.resolve();
	return async (cache) => {
		const write = cacheWriteQueue.then(() => saveCache(cache));
		cacheWriteQueue = write.catch(() => {});
		await write;
	};
}

/** Registers the user command that rebuilds MCP metadata cache and reloads runtime state. */
function registerMcpRefreshCommand(
	pi: ExtensionAPI,
	options: Omit<HandleManualRefreshOptions, "ctx">,
): void {
	pi.registerCommand("mcp-refresh", {
		description: "Refresh cached MCP tool metadata and reload pi runtime",
		handler: async (_args, ctx) => {
			await handleManualRefresh({ ctx, ...options });
		},
	});
}

async function handleSessionStart(
	options: HandleSessionStartOptions,
): Promise<HandleSessionStartResult> {
	const configResult = await options.readConfig();
	if (configResult.kind === "invalid") {
		options.ctx.ui.notify(`${ISSUE_PREFIX} ${configResult.issue}`, "warning");
		return { manager: undefined, serverInstructionRecords: [] };
	}
	if (!configResult.config.enabled) {
		return { manager: undefined, serverInstructionRecords: [] };
	}
	if (Object.keys(configResult.config.mcpServers).length === 0) {
		return { manager: undefined, serverInstructionRecords: [] };
	}

	const manager = options.createManager(configResult.config);
	options.activateManager(manager);
	const startup = await loadStartupMetadata(
		configResult.config.mcpServers,
		manager,
		options.loadCache,
		options.ctx.ui.notify.bind(options.ctx.ui) as (
			message: string,
			type?: "info" | "warning",
		) => void,
	);
	const startupCache = await saveStartupCache(
		configResult.config.mcpServers,
		startup,
		options,
	);
	const cachedServers = pickServers(
		configResult.config.mcpServers,
		startup.cachedServerKeys,
	);
	if (Object.keys(cachedServers).length > 0) {
		const refreshGeneration = options.getMetadataWriteGeneration();
		refreshCacheInBackground({
			manager: options.createManager(configResult.config),
			servers: cachedServers,
			startupCache,
			saveCache: options.saveCache,
			canSave: () => refreshGeneration === options.getMetadataWriteGeneration(),
			notify: options.ctx.ui.notify.bind(options.ctx.ui) as (
				message: string,
				type?: "info" | "warning",
			) => void,
		});
	}

	const catalog = buildPiToolCatalog(startup.serverToolLists);
	registerStartupCatalog({
		options,
		startup,
		catalog,
		manager,
		config: configResult.config,
	});

	return {
		manager,
		serverInstructionRecords: buildActiveServerInstructions(
			startup.serverInstructions,
			catalog.tools,
		),
	};
}

/** Publishes one startup catalog through normal registration and shared runtime presentation. */
function registerStartupCatalog({
	options,
	startup,
	catalog,
	manager,
	config,
}: {
	readonly options: HandleSessionStartOptions;
	readonly startup: StartupMetadata;
	readonly catalog: PiToolCatalog;
	readonly manager: McpManagerLike;
	readonly config: ValidMcpWrapperConfig;
}): void {
	reportStatuses(options.ctx, startup, catalog.rejected);
	registerCatalogTools({
		pi: options.pi,
		presentationOwner: options.ctx.sessionManager,
		tools: catalog.tools,
		manager,
		servers: config.mcpServers,
		widgetLineBudget: config.widgetLineBudget,
	});
	reportStartupDiagnostics(options.ctx, {
		connectedServers: startup.discoveredServerKeys,
		cachedServers: startup.cachedServerKeys,
		registeredTools: catalog.tools.map((entry) => entry.definition.name),
		failures: startup.failures,
		rejected: catalog.rejected,
	});
}

/** Rebuilds MCP metadata from live discovery and reloads pi only after the cache is saved. */
async function handleManualRefresh(
	options: HandleManualRefreshOptions,
): Promise<void> {
	await options.ctx.waitForIdle();
	const configResult = await options.readConfig();
	if (configResult.kind === "invalid") {
		options.ctx.ui.notify(`${ISSUE_PREFIX} ${configResult.issue}`, "warning");
		return;
	}
	if (!configResult.config.enabled) {
		options.ctx.ui.notify(`${ISSUE_PREFIX} MCP wrapper is disabled`, "warning");
		return;
	}
	if (Object.keys(configResult.config.mcpServers).length === 0) {
		options.ctx.ui.notify(
			`${ISSUE_PREFIX} no MCP servers configured`,
			"warning",
		);
		return;
	}

	options.invalidateBackgroundCacheWrites();
	const manager = options.createManager(configResult.config);
	try {
		const discovery = await manager.discoverServers(
			configResult.config.mcpServers,
		);
		const cache = buildCacheFromStartup(configResult.config.mcpServers, {
			serverToolLists: discovery.serverToolLists,
			serverInstructions: discovery.serverInstructions,
			failures: discovery.failures,
			cachedServerKeys: [],
			discoveredServerKeys: discovery.serverToolLists.map(
				(serverToolList) => serverToolList.serverKey,
			),
		});
		try {
			await options.queueCacheSave(cache);
		} catch (error) {
			options.ctx.ui.notify(
				`${ISSUE_PREFIX} failed to save MCP metadata cache: ${formatError(error)}`,
				"warning",
			);
			return;
		}
		if (discovery.failures.length > 0) {
			options.ctx.ui.notify(
				`${ISSUE_PREFIX} MCP refresh completed with failures: ${discovery.failures.map((failure) => `${failure.serverKey} (${failure.issue})`).join(", ")}`,
				"warning",
			);
		}
		try {
			await options.ctx.reload();
		} catch (error) {
			options.ctx.ui.notify(
				`${ISSUE_PREFIX} failed to reload after MCP refresh: ${formatError(error)}`,
				"warning",
			);
		}
	} catch (error) {
		options.ctx.ui.notify(
			`${ISSUE_PREFIX} failed to refresh MCP metadata cache: ${formatError(error)}`,
			"warning",
		);
	} finally {
		await manager.closeAll();
	}
}

function createDefaultMcpClientManager(
	config: ValidMcpWrapperConfig,
): McpManagerLike {
	return new McpClientManager({
		createClient: createSdkMcpClient,
		timeouts: config.timeouts,
	});
}

/** Links server instructions to accepted Pi tool names for active-tool prompt filtering. */
function buildActiveServerInstructions(
	serverInstructions: readonly ServerInstructions[],
	tools: readonly PiToolCatalogEntry[],
): readonly ServerInstructionRecord[] {
	const toolNamesByServer = new Map<string, string[]>();
	for (const entry of tools) {
		const toolNames = toolNamesByServer.get(entry.route.serverKey) ?? [];
		toolNames.push(entry.definition.name);
		toolNamesByServer.set(entry.route.serverKey, toolNames);
	}

	return serverInstructions.flatMap((instructions) => {
		const registeredPiToolNames = toolNamesByServer.get(instructions.serverKey);
		return registeredPiToolNames === undefined
			? []
			: [{ ...instructions, registeredPiToolNames }];
	});
}

type McpDiscoveryResult = Awaited<
	ReturnType<McpClientManager["discoverServers"]>
>;
type McpDiscoveryFailure = McpDiscoveryResult["failures"][number];
interface StartupMetadata {
	readonly serverToolLists: readonly McpServerToolList[];
	readonly serverInstructions: readonly ServerInstructions[];
	readonly failures: readonly McpDiscoveryFailure[];
	readonly cachedServerKeys: readonly string[];
	readonly discoveredServerKeys: readonly string[];
}

async function loadStartupMetadata(
	servers: Readonly<Record<string, McpServerConfig>>,
	manager: McpManagerLike,
	loadCache: () => Promise<McpWrapperMetadataCache | null>,
	notify: (message: string, type?: "info" | "warning") => void,
): Promise<StartupMetadata> {
	const cache = await loadCache();
	const cachedServerKeys: string[] = [];
	const cachedServerToolLists: McpServerToolList[] = [];
	const cachedServerInstructions: ServerInstructions[] = [];
	const missingServers: Record<string, McpServerConfig> = {};

	for (const [serverKey, serverConfig] of Object.entries(servers)) {
		const cachedServer = cache?.servers[serverKey];
		if (
			cachedServer !== undefined &&
			cachedServer.configHash === computeMcpServerConfigHash(serverConfig)
		) {
			cachedServerKeys.push(serverKey);
			cachedServerToolLists.push(cachedServerToolList(serverKey, cachedServer));
			if (
				cachedServer.instructions !== undefined &&
				cachedServer.instructions.trim().length > 0
			) {
				cachedServerInstructions.push({
					serverKey,
					instructions: cachedServer.instructions,
				});
			}
			continue;
		}

		missingServers[serverKey] = serverConfig;
	}

	const missingServerKeys = Object.keys(missingServers);
	if (missingServerKeys.length === 0) {
		return {
			serverToolLists: cachedServerToolLists,
			serverInstructions: cachedServerInstructions,
			failures: [],
			cachedServerKeys,
			discoveredServerKeys: [],
		};
	}

	notify(
		`${ISSUE_PREFIX} ${formatMissingCacheMessage(cache, missingServerKeys)}`,
		"info",
	);
	const discovery = await manager.discoverServers(missingServers);

	return {
		serverToolLists: [...cachedServerToolLists, ...discovery.serverToolLists],
		serverInstructions: [
			...cachedServerInstructions,
			...discovery.serverInstructions,
		],
		failures: discovery.failures,
		cachedServerKeys,
		discoveredServerKeys: discovery.serverToolLists.map(
			(serverToolList) => serverToolList.serverKey,
		),
	};
}

function formatMissingCacheMessage(
	cache: McpWrapperMetadataCache | null,
	missingServerKeys: readonly string[],
): string {
	const serverList = missingServerKeys.join(", ");
	if (cache === null) {
		return `MCP cache is empty. Discovering MCP tools before startup continues: ${serverList}`;
	}

	const serverWord = missingServerKeys.length === 1 ? "server" : "servers";
	return `MCP cache is missing for ${missingServerKeys.length} ${serverWord}. Discovering MCP tools before startup continues: ${serverList}`;
}

function buildCacheFromStartup(
	servers: Readonly<Record<string, McpServerConfig>>,
	startup: StartupMetadata,
): McpWrapperMetadataCache {
	const instructionsByServer = new Map(
		startup.serverInstructions.map((instructions) => [
			instructions.serverKey,
			instructions.instructions,
		]),
	);
	const cacheServers: McpWrapperMetadataCache["servers"] = Object.fromEntries(
		startup.serverToolLists.flatMap((serverToolList) => {
			const serverConfig = servers[serverToolList.serverKey];
			if (serverConfig === undefined) {
				return [];
			}
			const instructions = instructionsByServer.get(serverToolList.serverKey);
			return [
				[
					serverToolList.serverKey,
					{
						configHash: computeMcpServerConfigHash(serverConfig),
						cachedAt: Date.now(),
						tools: serverToolList.tools,
						...(instructions !== undefined && instructions.trim().length > 0
							? { instructions }
							: {}),
					},
				],
			];
		}),
	);

	return { version: 1, servers: cacheServers };
}

async function saveStartupCache(
	servers: Readonly<Record<string, McpServerConfig>>,
	startup: StartupMetadata,
	options: Pick<HandleSessionStartOptions, "ctx" | "saveCache">,
): Promise<McpWrapperMetadataCache> {
	const cache = buildCacheFromStartup(servers, startup);
	try {
		await options.saveCache(cache);
	} catch (error) {
		options.ctx.ui.notify(
			`${ISSUE_PREFIX} failed to save MCP metadata cache: ${formatError(error)}`,
			"warning",
		);
	}
	return cache;
}

function reportStatuses(
	ctx: SessionStartContextLike,
	startup: StartupMetadata,
	rejected: readonly RejectedPiToolRoute[],
): void {
	for (const failure of startup.failures) {
		ctx.ui.setStatus(
			buildStatusKey(failure.serverKey),
			`${failure.serverKey}: ${failure.issue}`,
		);
	}
	for (const item of rejected) {
		ctx.ui.setStatus(
			buildStatusKey(item.serverKey),
			`${item.serverKey}: ${item.issue}`,
		);
	}
}

function registerCatalogTools(options: {
	readonly pi: ExtensionAPI;
	readonly presentationOwner: ExtensionContext["sessionManager"];
	readonly tools: readonly PiToolCatalogEntry[];
	readonly manager: McpManagerLike;
	readonly servers: ValidMcpWrapperConfig["mcpServers"];
	readonly widgetLineBudget: number;
}): void {
	for (const entry of options.tools) {
		const definition = buildToolDefinition(
			entry,
			options.manager,
			options.servers,
			options.widgetLineBudget,
		);
		// Dynamic MCP names have no reliable prefix, so normal registration owns
		// classification and publishes its exact renderer function identities.
		registerPackageToolPresentation(options.presentationOwner, definition);
		options.pi.registerTool(definition);
	}
}

function pickServers(
	servers: Readonly<Record<string, McpServerConfig>>,
	serverKeys: readonly string[],
): Readonly<Record<string, McpServerConfig>> {
	return Object.fromEntries(
		serverKeys.flatMap((serverKey) => {
			const serverConfig = servers[serverKey];
			return serverConfig === undefined ? [] : [[serverKey, serverConfig]];
		}),
	);
}

function refreshCacheInBackground({
	manager,
	servers,
	startupCache,
	saveCache,
	canSave,
	notify,
}: {
	readonly manager: McpManagerLike;
	readonly servers: Readonly<Record<string, McpServerConfig>>;
	readonly startupCache: McpWrapperMetadataCache;
	readonly saveCache: (cache: McpWrapperMetadataCache) => Promise<void>;
	readonly canSave: () => boolean;
	readonly notify: (message: string, type?: "info" | "warning") => void;
}): void {
	const refreshedServerKeys = new Set(Object.keys(servers));
	if (refreshedServerKeys.size === 0) {
		return;
	}

	manager
		.discoverServers(servers)
		.then((discovery) => {
			if (!canSave()) {
				return undefined;
			}
			const refreshedCache = buildCacheFromStartup(servers, {
				serverToolLists: discovery.serverToolLists,
				serverInstructions: discovery.serverInstructions,
				failures: discovery.failures,
				cachedServerKeys: [],
				discoveredServerKeys: discovery.serverToolLists.map(
					(serverToolList) => serverToolList.serverKey,
				),
			});
			return saveCache({
				version: startupCache.version,
				servers: {
					...Object.fromEntries(
						Object.entries(startupCache.servers).filter(
							([serverKey]) => !refreshedServerKeys.has(serverKey),
						),
					),
					...refreshedCache.servers,
				},
			});
		})
		.catch((error: unknown) => {
			notify(
				`${ISSUE_PREFIX} failed to refresh MCP metadata cache: ${formatError(error)}`,
				"warning",
			);
		})
		.finally(() => manager.closeAll());
}

function buildToolDefinition(
	entry: PiToolCatalogEntry,
	manager: Pick<McpClientManager, "callTool">,
	servers: ValidMcpWrapperConfig["mcpServers"],
	widgetLineBudget: number,
): ToolDefinition {
	return {
		name: entry.definition.name,
		label: entry.definition.name,
		description: buildToolDescription(entry),
		promptSnippet: buildPromptSnippet(entry),
		parameters: entry.definition.parameters,
		renderCall: (args, theme, context) =>
			renderMcpToolCall(entry.definition.name, args, theme, context),
		renderResult: (result, options, theme, context) =>
			renderMcpToolResult(result, options, theme, {
				isError: context.isError,
				widgetLineBudget,
			}),
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
	readonly cachedServers: readonly string[];
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
	if (diagnostics.cachedServers.length > 0) {
		parts.push(`cached: ${diagnostics.cachedServers.join(", ")}`);
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

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function buildStatusKey(serverKey: string): string {
	const statusKey = serverKey
		.toLowerCase()
		.replaceAll(/[^a-z0-9_-]+/g, "-")
		.replaceAll(/^-+|-+$/g, "")
		.replaceAll(/-+/g, "-");
	return `${STATUS_KEY_PREFIX}${statusKey.length > 0 ? statusKey : "server"}`;
}
