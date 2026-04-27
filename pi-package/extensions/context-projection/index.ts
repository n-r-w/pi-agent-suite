import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	type BeforeAgentStartEvent,
	type ContextEvent,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type SessionEntry,
} from "@mariozechner/pi-coding-agent";

/** Relative config location owned only by this extension. */
const CONTEXT_PROJECTION_CONFIG_PATH = join(
	"config",
	"context-projection.json",
);

/** Extension-owned custom entry type used for branch-local projection state. */
const CONTEXT_PROJECTION_CUSTOM_TYPE = "context-projection";

/** Footer status key owned by this extension. */
const CONTEXT_PROJECTION_STATUS_KEY = "context-projection";

/** Footer status text for an invalid projection config. */
const INVALID_STATUS_TEXT = "CP!";

/** Footer text for enabled projection when provider context is not reduced. */
const READY_STATUS_TEXT = "~0";

/** Character count used for the extension-local approximate token estimate. */
const APPROXIMATE_CHARS_PER_TOKEN = 4;

/** Threshold where compact token labels switch from exact counts to thousands. */
const TOKEN_COMPACT_THRESHOLD = 1_000;

/** Config key that disables or enables provider-context projection. */
const ENABLED_CONFIG_KEY = "enabled";

/** Config key for the remaining-token threshold that enables projection. */
const PROJECTION_REMAINING_TOKENS_CONFIG_KEY = "projectionRemainingTokens";

/** Config key for the minimum number of newest tool-use turns kept unprojected. */
const KEEP_RECENT_TURNS_CONFIG_KEY = "keepRecentTurns";

/** Config key for the newest tool-use turn ratio kept unprojected in long sessions. */
const KEEP_RECENT_TURNS_PERCENT_CONFIG_KEY = "keepRecentTurnsPercent";

/** Config key for the minimum combined text length eligible for projection. */
const MIN_TOOL_RESULT_CHARS_CONFIG_KEY = "minToolResultChars";

/** Config key for tool names whose successful text results must stay visible. */
const PROJECTION_IGNORED_TOOLS_CONFIG_KEY = "projectionIgnoredTools";

/** Config key for the exact replacement text used in projected tool results. */
const PLACEHOLDER_CONFIG_KEY = "placeholder";

/** Advisor tool output must stay visible because it carries decision-critical guidance. */
const CONSULT_ADVISOR_TOOL_NAME = "consult_advisor";

/** Built-in tool names whose results are excluded from projection. */
const BUILT_IN_PROJECTION_IGNORED_TOOLS = [CONSULT_ADVISOR_TOOL_NAME] as const;

/** Default remaining-token threshold for explicit projection enablement. */
const DEFAULT_PROJECTION_REMAINING_TOKENS = 49_152;

/** Default newest tool-use turns kept visible before projection. */
const DEFAULT_KEEP_RECENT_TURNS = 10;

/** Default newest tool-use turn ratio kept visible in long sessions. */
const DEFAULT_KEEP_RECENT_TURNS_PERCENT = 0.2;

/** Default minimum text size for projecting a tool result. */
const DEFAULT_MIN_TOOL_RESULT_CHARS = 3_000;

/** Default replacement text for projected old tool results. */
const DEFAULT_PLACEHOLDER =
	"[Old successful tool result omitted from current context]";

/** Config keys accepted by the context projection config object. */
const CONTEXT_PROJECTION_CONFIG_KEYS = [
	ENABLED_CONFIG_KEY,
	PROJECTION_REMAINING_TOKENS_CONFIG_KEY,
	KEEP_RECENT_TURNS_CONFIG_KEY,
	KEEP_RECENT_TURNS_PERCENT_CONFIG_KEY,
	MIN_TOOL_RESULT_CHARS_CONFIG_KEY,
	PROJECTION_IGNORED_TOOLS_CONFIG_KEY,
	PLACEHOLDER_CONFIG_KEY,
] as const;

/** Node.js error field used to detect absent config files. */
const ERROR_CODE_KEY = "code";

type ContextProjectionConfigResult =
	| { readonly kind: "valid"; readonly config: ContextProjectionConfig }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid" };

interface ContextProjectionConfig {
	readonly enabled: true;
	readonly projectionRemainingTokens: number;
	readonly keepRecentTurns: number;
	readonly keepRecentTurnsPercent: number;
	readonly minToolResultChars: number;
	readonly projectionIgnoredTools: readonly string[];
	readonly placeholder: string;
}

interface ProjectedEntryState {
	readonly entryId: string;
	readonly placeholder: string;
}

interface ContextProjectionStateEntryData {
	readonly projectedEntries: readonly ProjectedEntryState[];
}

interface MappedContextEntry {
	readonly entry: SessionEntry;
	readonly message: AgentMessage;
}

interface ProjectionDecision {
	readonly messages: AgentMessage[];
	readonly newProjectedEntries: ProjectedEntryState[];
	readonly savedChars: number;
	readonly changed: boolean;
}

interface ProjectContextMessagesOptions {
	readonly mappedContext: readonly MappedContextEntry[];
	readonly projectedPlaceholdersByEntryId: ReadonlyMap<string, string>;
	readonly config: ContextProjectionConfig;
	readonly loadedSkillRoots: readonly string[];
	readonly cwd: string;
	readonly discoverNewEntries: boolean;
}

interface HandleContextProjectionOptions {
	readonly pi: Pick<ExtensionAPI, "appendEntry">;
	readonly event: ContextEvent;
	readonly ctx: ExtensionContext;
	readonly projectedPlaceholdersByEntryId: Map<string, string>;
	readonly publishedStatusText: string | undefined;
	readonly loadedSkillRoots: readonly string[];
}

interface HandleContextProjectionResult {
	readonly contextResult: { readonly messages?: AgentMessage[] } | undefined;
	readonly statusText: string | undefined;
}

/** Extension entry point for provider-context projection of old tool results. */
export default function contextProjection(pi: ExtensionAPI): void {
	let projectedPlaceholdersByEntryId = new Map<string, string>();
	let publishedStatusText: string | undefined;
	let loadedSkillRoots: readonly string[] = [];

	const reconstructProjectionState = (ctx: {
		readonly sessionManager: { getBranch(): SessionEntry[] };
	}): void => {
		projectedPlaceholdersByEntryId = collectProjectedPlaceholders(
			ctx.sessionManager.getBranch(),
		);
	};

	const publishCurrentStatus = async (ctx: ExtensionContext): Promise<void> => {
		const config = await readContextProjectionConfig();
		publishedStatusText = publishProjectionStatus(
			ctx,
			config,
			0,
			publishedStatusText,
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		reconstructProjectionState(ctx);
		await publishCurrentStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstructProjectionState(ctx);
		await publishCurrentStatus(ctx);
	});

	pi.on("before_agent_start", (event) => {
		loadedSkillRoots = collectLoadedSkillRoots(event);
	});

	pi.on("context", async (event, ctx) => {
		const result = await handleContextProjection({
			pi,
			event,
			ctx,
			projectedPlaceholdersByEntryId,
			publishedStatusText,
			loadedSkillRoots,
		});
		publishedStatusText = result.statusText;
		return result.contextResult;
	});
}

/** Handles one context event by projecting eligible tool results when the active config and usage permit it. */
async function handleContextProjection({
	pi,
	event,
	ctx,
	projectedPlaceholdersByEntryId,
	publishedStatusText,
	loadedSkillRoots,
}: HandleContextProjectionOptions): Promise<HandleContextProjectionResult> {
	const config = await readContextProjectionConfig();
	if (config.kind !== "valid") {
		return createContextProjectionNoChangeResult(
			ctx,
			config,
			publishedStatusText,
		);
	}

	const shouldDiscoverNewEntries = isProjectionThresholdExceeded(
		ctx,
		config.config,
	);
	if (!shouldDiscoverNewEntries && projectedPlaceholdersByEntryId.size === 0) {
		return createContextProjectionNoChangeResult(
			ctx,
			config,
			publishedStatusText,
		);
	}

	const mappedContext = mapEventMessagesToBranchEntries(
		event.messages,
		ctx.sessionManager.getBranch(),
	);
	if (mappedContext === undefined) {
		return createContextProjectionNoChangeResult(
			ctx,
			config,
			publishedStatusText,
		);
	}

	const decision = projectContextMessages({
		mappedContext,
		projectedPlaceholdersByEntryId,
		config: config.config,
		loadedSkillRoots,
		cwd: ctx.cwd,
		discoverNewEntries: shouldDiscoverNewEntries,
	});
	if (!decision.changed) {
		return createContextProjectionNoChangeResult(
			ctx,
			config,
			publishedStatusText,
		);
	}

	recordNewProjectedEntries(
		pi,
		projectedPlaceholdersByEntryId,
		decision.newProjectedEntries,
	);
	return {
		contextResult: { messages: decision.messages },
		statusText: publishProjectionStatus(
			ctx,
			config,
			estimateSavedTokens(decision.savedChars),
			publishedStatusText,
		),
	};
}

/** Returns an unchanged provider context result while keeping footer status current. */
function createContextProjectionNoChangeResult(
	ctx: ExtensionContext,
	config: ContextProjectionConfigResult,
	publishedStatusText: string | undefined,
): HandleContextProjectionResult {
	return {
		contextResult: undefined,
		statusText: publishProjectionStatus(ctx, config, 0, publishedStatusText),
	};
}

/** Returns true when current context usage is known and has crossed the projection threshold. */
function isProjectionThresholdExceeded(
	ctx: ExtensionContext,
	config: ContextProjectionConfig,
): boolean {
	const usage = ctx.getContextUsage();
	if (usage === undefined || usage.tokens === null) {
		return false;
	}

	const remainingTokens = usage.contextWindow - usage.tokens;
	return remainingTokens <= config.projectionRemainingTokens;
}

/** Publishes compact footer state while leaving missing and disabled config hidden. */
function publishProjectionStatus(
	ctx: ExtensionContext,
	config: ContextProjectionConfigResult,
	savedTokens: number,
	publishedStatusText: string | undefined,
): string | undefined {
	const nextStatusText = formatProjectionStatus(ctx, config, savedTokens);
	if (ctx.hasUI !== false && nextStatusText !== publishedStatusText) {
		ctx.ui.setStatus(CONTEXT_PROJECTION_STATUS_KEY, nextStatusText);
	}

	return nextStatusText;
}

/** Formats the footer status text according to config validity and current projection savings. */
function formatProjectionStatus(
	ctx: ExtensionContext,
	config: ContextProjectionConfigResult,
	savedTokens: number,
): string | undefined {
	if (config.kind === "disabled") {
		return undefined;
	}
	if (config.kind === "invalid") {
		return ctx.ui.theme.fg("error", INVALID_STATUS_TEXT);
	}
	if (savedTokens > 0) {
		return ctx.ui.theme.fg("warning", `~${formatSavedTokens(savedTokens)}`);
	}

	return READY_STATUS_TEXT;
}

/** Persists newly projected entries as one branch-local extension-owned custom entry. */
function recordNewProjectedEntries(
	pi: Pick<ExtensionAPI, "appendEntry">,
	projectedPlaceholdersByEntryId: Map<string, string>,
	newProjectedEntries: readonly ProjectedEntryState[],
): void {
	if (newProjectedEntries.length === 0) {
		return;
	}

	for (const projectedEntry of newProjectedEntries) {
		projectedPlaceholdersByEntryId.set(
			projectedEntry.entryId,
			projectedEntry.placeholder,
		);
	}
	pi.appendEntry<ContextProjectionStateEntryData>(
		CONTEXT_PROJECTION_CUSTOM_TYPE,
		{ projectedEntries: newProjectedEntries },
	);
}

/** Reads and validates this extension config while absent config keeps projection disabled. */
async function readContextProjectionConfig(): Promise<ContextProjectionConfigResult> {
	const configPath = join(getAgentDir(), CONTEXT_PROJECTION_CONFIG_PATH);
	let content: string;
	try {
		content = await readFile(configPath, "utf8");
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return { kind: "disabled" };
		}

		return { kind: "invalid" };
	}

	try {
		const config: unknown = JSON.parse(content);

		return parseContextProjectionConfig(config);
	} catch {
		return { kind: "invalid" };
	}
}

/** Parses the config file into the complete projection settings contract. */
function parseContextProjectionConfig(
	config: unknown,
): ContextProjectionConfigResult {
	if (!isRecord(config)) {
		return { kind: "invalid" };
	}

	const unsupportedKey = Object.keys(config).find(
		(key) =>
			!CONTEXT_PROJECTION_CONFIG_KEYS.includes(
				key as (typeof CONTEXT_PROJECTION_CONFIG_KEYS)[number],
			),
	);
	if (unsupportedKey !== undefined) {
		return { kind: "invalid" };
	}

	const enabled = config[ENABLED_CONFIG_KEY];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return { kind: "invalid" };
	}
	if (enabled !== true) {
		return { kind: "disabled" };
	}

	const projectionRemainingTokens =
		config[PROJECTION_REMAINING_TOKENS_CONFIG_KEY] ??
		DEFAULT_PROJECTION_REMAINING_TOKENS;
	const keepRecentTurns =
		config[KEEP_RECENT_TURNS_CONFIG_KEY] ?? DEFAULT_KEEP_RECENT_TURNS;
	const keepRecentTurnsPercent =
		config[KEEP_RECENT_TURNS_PERCENT_CONFIG_KEY] ??
		DEFAULT_KEEP_RECENT_TURNS_PERCENT;
	const minToolResultChars =
		config[MIN_TOOL_RESULT_CHARS_CONFIG_KEY] ?? DEFAULT_MIN_TOOL_RESULT_CHARS;
	const projectionIgnoredTools =
		config[PROJECTION_IGNORED_TOOLS_CONFIG_KEY] ?? [];
	const placeholder = config[PLACEHOLDER_CONFIG_KEY] ?? DEFAULT_PLACEHOLDER;
	if (
		!isNonNegativeInteger(projectionRemainingTokens) ||
		!isNonNegativeInteger(keepRecentTurns) ||
		!isPercentNumber(keepRecentTurnsPercent) ||
		!isNonNegativeInteger(minToolResultChars) ||
		!isUniqueNonEmptyStringArray(projectionIgnoredTools) ||
		typeof placeholder !== "string"
	) {
		return { kind: "invalid" };
	}

	return {
		kind: "valid",
		config: {
			enabled: true,
			projectionRemainingTokens,
			keepRecentTurns,
			keepRecentTurnsPercent,
			minToolResultChars,
			projectionIgnoredTools,
			placeholder,
		},
	};
}

/** Collects projected entries from extension-owned custom entries on the active branch only. */
function collectProjectedPlaceholders(
	branchEntries: readonly SessionEntry[],
): Map<string, string> {
	const projectedPlaceholdersByEntryId = new Map<string, string>();
	for (const entry of branchEntries) {
		if (
			entry.type !== "custom" ||
			entry.customType !== CONTEXT_PROJECTION_CUSTOM_TYPE ||
			!isProjectionStateEntryData(entry.data)
		) {
			continue;
		}

		for (const projectedEntry of entry.data.projectedEntries) {
			projectedPlaceholdersByEntryId.set(
				projectedEntry.entryId,
				projectedEntry.placeholder,
			);
		}
	}

	return projectedPlaceholdersByEntryId;
}

/** Maps provider-context messages back to active branch entries only when the mapping is exact. */
function mapEventMessagesToBranchEntries(
	eventMessages: readonly AgentMessage[],
	branchEntries: readonly SessionEntry[],
): MappedContextEntry[] | undefined {
	const mappedEntries = buildContextEntryMapping(branchEntries);
	if (mappedEntries.length !== eventMessages.length) {
		return undefined;
	}

	const eventMappedEntries: MappedContextEntry[] = [];
	for (let index = 0; index < mappedEntries.length; index += 1) {
		const mappedEntry = mappedEntries[index];
		const eventMessage = eventMessages[index];
		if (
			mappedEntry === undefined ||
			eventMessage === undefined ||
			!isDeepStrictEqual(mappedEntry.message, eventMessage)
		) {
			return undefined;
		}

		eventMappedEntries.push({
			entry: mappedEntry.entry,
			message: eventMessage,
		});
	}

	return eventMappedEntries;
}

/** Builds the same branch message sequence that pi uses, but keeps the source entry beside each message. */
function buildContextEntryMapping(
	branchEntries: readonly SessionEntry[],
): MappedContextEntry[] {
	const mappedEntries: MappedContextEntry[] = [];
	const appendContextEntry = (entry: SessionEntry): void => {
		const message = createContextMessageForEntry(entry);
		if (message !== undefined) {
			mappedEntries.push({ entry, message });
		}
	};

	const compactionIndex = findLastEntryIndex(
		branchEntries,
		(entry) => entry.type === "compaction",
	);
	if (compactionIndex === -1) {
		for (const entry of branchEntries) {
			appendContextEntry(entry);
		}
		return mappedEntries;
	}

	const compactionEntry = branchEntries[compactionIndex];
	if (compactionEntry?.type !== "compaction") {
		return mappedEntries;
	}

	mappedEntries.push({
		entry: compactionEntry,
		message: createCompactionSummaryMessage(compactionEntry),
	});

	let foundFirstKeptEntry = false;
	for (let index = 0; index < compactionIndex; index += 1) {
		const entry = branchEntries[index];
		if (entry === undefined) {
			continue;
		}
		if (entry.id === compactionEntry.firstKeptEntryId) {
			foundFirstKeptEntry = true;
		}
		if (foundFirstKeptEntry) {
			appendContextEntry(entry);
		}
	}

	for (
		let index = compactionIndex + 1;
		index < branchEntries.length;
		index += 1
	) {
		const entry = branchEntries[index];
		if (entry !== undefined) {
			appendContextEntry(entry);
		}
	}

	return mappedEntries;
}

/** Creates the model-visible message that corresponds to a session entry. */
function createContextMessageForEntry(
	entry: SessionEntry,
): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return {
			role: "custom",
			customType: entry.customType,
			content: entry.content,
			display: entry.display,
			details: entry.details,
			timestamp: new Date(entry.timestamp).getTime(),
		} as AgentMessage;
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return {
			role: "branchSummary",
			summary: entry.summary,
			fromId: entry.fromId,
			timestamp: new Date(entry.timestamp).getTime(),
		} as AgentMessage;
	}

	return undefined;
}

/** Creates the model-visible compaction summary message that pi emits for the latest compaction. */
function createCompactionSummaryMessage(
	entry: Extract<SessionEntry, { type: "compaction" }>,
): AgentMessage {
	return {
		role: "compactionSummary",
		summary: entry.summary,
		tokensBefore: entry.tokensBefore,
		timestamp: new Date(entry.timestamp).getTime(),
	} as AgentMessage;
}

/** Collects loaded skill root directories from the prompt options available before an agent turn. */
function collectLoadedSkillRoots(
	event: BeforeAgentStartEvent,
): readonly string[] {
	return (
		event.systemPromptOptions.skills?.map((skill) => resolve(skill.baseDir)) ??
		[]
	);
}

/** Collects resolved read paths by tool call ID so matching tool results can be classified. */
function collectReadPathsByToolCallId(
	mappedContext: readonly MappedContextEntry[],
	cwd: string,
): ReadonlyMap<string, string> {
	const readPathsByToolCallId = new Map<string, string>();
	for (const { message } of mappedContext) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}

		for (const contentBlock of message.content) {
			if (contentBlock.type !== "toolCall" || contentBlock.name !== "read") {
				continue;
			}

			const readPath = getReadToolCallPath(contentBlock.arguments);
			if (readPath !== undefined) {
				readPathsByToolCallId.set(
					contentBlock.id,
					resolveReadInputPath(readPath, cwd),
				);
			}
		}
	}

	return readPathsByToolCallId;
}

/** Returns the path argument accepted by pi's read tool. */
function getReadToolCallPath(args: unknown): string | undefined {
	if (!isRecord(args)) {
		return undefined;
	}

	const path = args["path"];
	if (typeof path === "string") {
		return path;
	}

	const filePath = args["file_path"];
	return typeof filePath === "string" ? filePath : undefined;
}

/** Resolves read input paths with the same cwd, tilde, and @-prefix semantics used by pi's read tool. */
function resolveReadInputPath(inputPath: string, cwd: string): string {
	const withoutAtPrefix = inputPath.startsWith("@")
		? inputPath.slice(1)
		: inputPath;
	const expandedPath = expandHomePath(withoutAtPrefix);
	return isAbsolute(expandedPath)
		? resolve(expandedPath)
		: resolve(cwd, expandedPath);
}

/** Expands the home directory shorthand accepted by pi path tools. */
function expandHomePath(inputPath: string): string {
	if (inputPath === "~") {
		return homedir();
	}
	if (inputPath.startsWith("~/")) {
		return join(homedir(), inputPath.slice(2));
	}

	return inputPath;
}

/** Returns true when a read result belongs to a loaded skill root and must stay visible. */
function isLoadedSkillReadResult(
	message: Extract<AgentMessage, { role: "toolResult" }>,
	readPathsByToolCallId: ReadonlyMap<string, string>,
	loadedSkillRoots: readonly string[],
): boolean {
	if (message.toolName !== "read") {
		return false;
	}

	const readPath = readPathsByToolCallId.get(message.toolCallId);
	return (
		readPath !== undefined &&
		loadedSkillRoots.some((skillRoot) =>
			isPathInsideOrEqual(readPath, skillRoot),
		)
	);
}

/** Returns true when the target path is the root path or a descendant of it. */
function isPathInsideOrEqual(targetPath: string, rootPath: string): boolean {
	const relativePath = relative(resolve(rootPath), resolve(targetPath));
	return (
		relativePath === "" ||
		(!relativePath.startsWith("..") && !isAbsolute(relativePath))
	);
}

/** Returns projected provider-context messages and newly persisted projection state. */
function projectContextMessages({
	mappedContext,
	projectedPlaceholdersByEntryId,
	config,
	loadedSkillRoots,
	cwd,
	discoverNewEntries,
}: ProjectContextMessagesOptions): ProjectionDecision {
	const protectedEntryIds = collectProtectedEntryIds(mappedContext, config);
	const readPathsByToolCallId = collectReadPathsByToolCallId(
		mappedContext,
		cwd,
	);
	const ignoredTools = getProjectionIgnoredTools(config);
	const newProjectedEntries: ProjectedEntryState[] = [];
	let savedChars = 0;
	let changed = false;
	const messages = mappedContext.map(({ entry, message }) => {
		if (entry.type !== "message" || !isSuccessfulTextToolResult(message)) {
			return message;
		}
		if (
			shouldKeepToolResultVisible(
				message,
				readPathsByToolCallId,
				loadedSkillRoots,
				ignoredTools,
			)
		) {
			return message;
		}

		const originalTextLength = getTextToolResultLength(message);
		const alreadyProjected = projectedPlaceholdersByEntryId.has(entry.id);
		const newlyEligible =
			discoverNewEntries &&
			!protectedEntryIds.has(entry.id) &&
			originalTextLength >= config.minToolResultChars;
		if (!alreadyProjected && !newlyEligible) {
			return message;
		}

		const placeholder = alreadyProjected
			? (projectedPlaceholdersByEntryId.get(entry.id) ?? config.placeholder)
			: config.placeholder;
		savedChars += calculateProjectedTextSavings(
			originalTextLength,
			placeholder.length,
		);
		changed = true;
		if (!alreadyProjected) {
			newProjectedEntries.push({ entryId: entry.id, placeholder });
		}

		return {
			...message,
			content: [{ type: "text" as const, text: placeholder }],
		};
	});

	return { messages, newProjectedEntries, savedChars, changed };
}

/** Returns the approximate token count removed from provider context. */
function estimateSavedTokens(savedChars: number): number {
	return Math.ceil(savedChars / APPROXIMATE_CHARS_PER_TOKEN);
}

/** Formats approximate saved-token counts for compact footer display. */
function formatSavedTokens(savedTokens: number): string {
	if (savedTokens < TOKEN_COMPACT_THRESHOLD) {
		return savedTokens.toString();
	}

	return `${Math.round(savedTokens / TOKEN_COMPACT_THRESHOLD)}k`;
}

/** Returns the text length removed after the original content is replaced by placeholder text. */
function calculateProjectedTextSavings(
	originalTextLength: number,
	placeholderLength: number,
): number {
	return Math.max(0, originalTextLength - placeholderLength);
}

/** Returns true when projection must not hide this successful text tool result. */
function shouldKeepToolResultVisible(
	message: Extract<AgentMessage, { role: "toolResult" }>,
	readPathsByToolCallId: ReadonlyMap<string, string>,
	loadedSkillRoots: readonly string[],
	ignoredTools: ReadonlySet<string>,
): boolean {
	return (
		ignoredTools.has(message.toolName) ||
		isLoadedSkillReadResult(message, readPathsByToolCallId, loadedSkillRoots)
	);
}

/** Returns tool result entry IDs from the newest assistant tool-use turns protected from first-time projection. */
function collectProtectedEntryIds(
	mappedContext: readonly MappedContextEntry[],
	config: ContextProjectionConfig,
): Set<string> {
	let currentToolUseTurnOrdinal: number | undefined;
	let toolUseTurnCount = 0;
	const toolResultTurns = new Map<string, number>();
	for (const { entry, message } of mappedContext) {
		if (message.role === "assistant") {
			if (isAssistantToolUseMessage(message)) {
				currentToolUseTurnOrdinal = toolUseTurnCount;
				toolUseTurnCount += 1;
			} else {
				currentToolUseTurnOrdinal = undefined;
			}
			continue;
		}
		if (
			entry.type === "message" &&
			message.role === "toolResult" &&
			currentToolUseTurnOrdinal !== undefined
		) {
			toolResultTurns.set(entry.id, currentToolUseTurnOrdinal);
		}
	}

	const effectiveKeepRecentTurns = getEffectiveKeepRecentTurns(
		toolUseTurnCount,
		config,
	);
	if (effectiveKeepRecentTurns === 0) {
		return new Set();
	}

	const firstProtectedTurn = Math.max(
		0,
		toolUseTurnCount - effectiveKeepRecentTurns,
	);
	const protectedEntryIds = new Set<string>();
	for (const [entryId, turnOrdinal] of toolResultTurns) {
		if (turnOrdinal >= firstProtectedTurn) {
			protectedEntryIds.add(entryId);
		}
	}

	return protectedEntryIds;
}

/** Returns the recent-turn protection window from fixed minimum and session-relative ratio. */
function getEffectiveKeepRecentTurns(
	toolUseTurnCount: number,
	config: ContextProjectionConfig,
): number {
	return Math.max(
		config.keepRecentTurns,
		Math.ceil(toolUseTurnCount * config.keepRecentTurnsPercent),
	);
}

/** Returns true when an assistant message starts a tool-use turn. */
function isAssistantToolUseMessage(
	message: Extract<AgentMessage, { role: "assistant" }>,
): boolean {
	return (
		Array.isArray(message.content) &&
		message.content.some((contentBlock) => contentBlock.type === "toolCall")
	);
}

/** Returns true when the message is a successful tool result that contains only text blocks. */
function isSuccessfulTextToolResult(
	message: AgentMessage,
): message is Extract<AgentMessage, { role: "toolResult" }> {
	return (
		message.role === "toolResult" &&
		message.isError !== true &&
		Array.isArray(message.content) &&
		message.content.every((contentBlock) => contentBlock.type === "text")
	);
}

/** Returns the combined character length of text blocks in a text-only tool result. */
function getTextToolResultLength(
	message: Extract<AgentMessage, { role: "toolResult" }>,
): number {
	return message.content.reduce((length, contentBlock) => {
		if (contentBlock.type !== "text") {
			return length;
		}

		return length + contentBlock.text.length;
	}, 0);
}

/** Returns true when custom entry data matches the projection state contract. */
function isProjectionStateEntryData(
	data: unknown,
): data is ContextProjectionStateEntryData {
	if (!isRecord(data)) {
		return false;
	}

	const projectedEntries = data["projectedEntries"];
	return (
		Array.isArray(projectedEntries) &&
		projectedEntries.every(isProjectedEntryState)
	);
}

/** Returns true when a custom-entry item identifies one projected entry and its stable placeholder. */
function isProjectedEntryState(value: unknown): value is ProjectedEntryState {
	return (
		isRecord(value) &&
		typeof value["entryId"] === "string" &&
		typeof value["placeholder"] === "string"
	);
}

/** Finds the last index that satisfies a predicate without relying on newer runtime APIs. */
function findLastEntryIndex<T>(
	values: readonly T[],
	predicate: (value: T) => boolean,
): number {
	for (let index = values.length - 1; index >= 0; index -= 1) {
		const value = values[index];
		if (value !== undefined && predicate(value)) {
			return index;
		}
	}

	return -1;
}

/** Returns true when the value is a non-negative integer. */
function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Returns true when the value is a ratio from zero to one. */
function isPercentNumber(value: unknown): value is number {
	return typeof value === "number" && value >= 0 && value <= 1;
}

/** Returns true when a value is a duplicate-free list of non-empty tool names. */
function isUniqueNonEmptyStringArray(
	value: unknown,
): value is readonly string[] {
	if (!Array.isArray(value)) {
		return false;
	}

	const seenValues = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string" || item.trim() === "") {
			return false;
		}
		if (seenValues.has(item)) {
			return false;
		}
		seenValues.add(item);
	}

	return true;
}

/** Returns configured and built-in tool names whose results must stay visible. */
function getProjectionIgnoredTools(
	config: ContextProjectionConfig,
): Set<string> {
	return new Set([
		...BUILT_IN_PROJECTION_IGNORED_TOOLS,
		...config.projectionIgnoredTools,
	]);
}

/** Returns true when a runtime value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns true when a failed config read means the config file is missing. */
function isFileNotFoundError(error: unknown): boolean {
	return isRecord(error) && error[ERROR_CODE_KEY] === "ENOENT";
}
