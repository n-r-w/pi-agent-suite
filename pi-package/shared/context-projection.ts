import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	type BeforeAgentStartEvent,
	getAgentDir,
	type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { countProjectionTextTokens } from "./context-size";

/** Relative config location owned by context-projection. */
const CONTEXT_PROJECTION_CONFIG_PATH = join(
	"config",
	"context-projection.json",
);

/** Extension-owned custom entry type used for branch-local projection state. */
export const CONTEXT_PROJECTION_CUSTOM_TYPE = "context-projection";

/** Config key that disables or enables provider-context projection. */
const ENABLED_CONFIG_KEY = "enabled";

/** Config key for the remaining-token threshold that enables projection. */
const PROJECTION_REMAINING_TOKENS_CONFIG_KEY = "projectionRemainingTokens";

/** Config key for the minimum number of newest tool-use turns kept unprojected. */
const KEEP_RECENT_TURNS_CONFIG_KEY = "keepRecentTurns";

/** Config key for the newest tool-use turn ratio kept unprojected in long sessions. */
const KEEP_RECENT_TURNS_PERCENT_CONFIG_KEY = "keepRecentTurnsPercent";

/** Config key for the minimum combined token count eligible for projection. */
const MIN_TOOL_RESULT_TOKENS_CONFIG_KEY = "minToolResultTokens";

/** Config key for tool names whose successful text results must stay visible. */
const PROJECTION_IGNORED_TOOLS_CONFIG_KEY = "projectionIgnoredTools";

/** Config key for the exact replacement text used in projected tool results. */
const PLACEHOLDER_CONFIG_KEY = "placeholder";

/** Config key for optional summaries generated before projecting tool results. */
const SUMMARY_CONFIG_KEY = "summary";

/** Config key that enables summary generation. */
const SUMMARY_ENABLED_CONFIG_KEY = "enabled";

/** Config key for the model used by summary generation. */
const SUMMARY_MODEL_CONFIG_KEY = "model";

/** Config key for the thinking level used by summary generation. */
const SUMMARY_THINKING_CONFIG_KEY = "thinking";

/** Config key for the maximum number of concurrent summary requests. */
const SUMMARY_MAX_CONCURRENCY_CONFIG_KEY = "maxConcurrency";

/** Config key for retry attempts after the first summary request fails. */
const SUMMARY_RETRY_COUNT_CONFIG_KEY = "retryCount";

/** Config key for the pause between summary retry attempts in milliseconds. */
const SUMMARY_RETRY_DELAY_MS_CONFIG_KEY = "retryDelayMs";

/** Config key for the custom summary system prompt path. */
const SUMMARY_SYSTEM_PROMPT_FILE_CONFIG_KEY = "systemPromptFile";

/** Config key for the custom summary user prompt path. */
const SUMMARY_USER_PROMPT_FILE_CONFIG_KEY = "userPromptFile";

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

/** Default minimum token count for projecting a tool result. */
const DEFAULT_MIN_TOOL_RESULT_TOKENS = 2_000;

/** Default replacement text for projected old tool results. */
const DEFAULT_PLACEHOLDER =
	"[Result omitted. Run tool again if you want to see it]";

/** Default summary request concurrency. */
const DEFAULT_SUMMARY_MAX_CONCURRENCY = 1;

/** Default retry attempts after the first failed summary request. */
const DEFAULT_SUMMARY_RETRY_COUNT = 1;

/** Default pause between summary retry attempts. */
const DEFAULT_SUMMARY_RETRY_DELAY_MS = 5_000;

/** Thinking values accepted by context projection summary configuration. */
const SUMMARY_THINKING_VALUES = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

/** Config keys accepted by the summary config object. */
const CONTEXT_PROJECTION_SUMMARY_CONFIG_KEYS = [
	SUMMARY_ENABLED_CONFIG_KEY,
	SUMMARY_MODEL_CONFIG_KEY,
	SUMMARY_THINKING_CONFIG_KEY,
	SUMMARY_MAX_CONCURRENCY_CONFIG_KEY,
	SUMMARY_RETRY_COUNT_CONFIG_KEY,
	SUMMARY_RETRY_DELAY_MS_CONFIG_KEY,
	SUMMARY_SYSTEM_PROMPT_FILE_CONFIG_KEY,
	SUMMARY_USER_PROMPT_FILE_CONFIG_KEY,
] as const;

/** Config keys accepted by the context projection config object. */
const CONTEXT_PROJECTION_CONFIG_KEYS = [
	ENABLED_CONFIG_KEY,
	PROJECTION_REMAINING_TOKENS_CONFIG_KEY,
	KEEP_RECENT_TURNS_CONFIG_KEY,
	KEEP_RECENT_TURNS_PERCENT_CONFIG_KEY,
	MIN_TOOL_RESULT_TOKENS_CONFIG_KEY,
	PROJECTION_IGNORED_TOOLS_CONFIG_KEY,
	PLACEHOLDER_CONFIG_KEY,
	SUMMARY_CONFIG_KEY,
] as const;

/** Node.js error field used to detect absent config files. */
const ERROR_CODE_KEY = "code";

export type ContextProjectionConfigResult =
	| { readonly kind: "valid"; readonly config: ContextProjectionConfig }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid" };

type ContextProjectionSummaryThinking =
	(typeof SUMMARY_THINKING_VALUES)[number];

interface EnabledSummaryConfigValues {
	readonly maxConcurrency: number;
	readonly retryCount: number;
	readonly retryDelayMs: number;
	readonly model?: string;
	readonly thinking?: ContextProjectionSummaryThinking;
	readonly systemPromptFile?: string;
	readonly userPromptFile?: string;
}

export interface ContextProjectionSummaryConfig {
	readonly enabled: boolean;
	readonly model?: string;
	readonly thinking?: ContextProjectionSummaryThinking;
	readonly maxConcurrency: number;
	readonly retryCount: number;
	readonly retryDelayMs: number;
	readonly systemPromptFile?: string;
	readonly userPromptFile?: string;
}

export interface ContextProjectionConfig {
	readonly enabled: true;
	readonly projectionRemainingTokens: number;
	readonly keepRecentTurns: number;
	readonly keepRecentTurnsPercent: number;
	readonly minToolResultTokens: number;
	readonly projectionIgnoredTools: readonly string[];
	readonly placeholder: string;
	readonly summary: ContextProjectionSummaryConfig;
}

export interface ProjectedEntryState {
	readonly entryId: string;
	readonly placeholder: string;
}

interface ContextProjectionStateEntryData {
	readonly projectedEntries: readonly ProjectedEntryState[];
}

export interface MappedContextEntry {
	readonly entry: SessionEntry;
	readonly message: AgentMessage;
}

export interface ProjectionDecision {
	readonly messages: AgentMessage[];
	readonly newProjectedEntries: ProjectedEntryState[];
	readonly savedTokens: number;
	readonly newSavedTokens: number;
	readonly changed: boolean;
}

interface ProjectContextMessagesOptions {
	readonly mappedContext: readonly MappedContextEntry[];
	readonly projectedPlaceholdersByEntryId: ReadonlyMap<string, string>;
	readonly replacementTextByEntryId?: ReadonlyMap<string, string>;
	readonly config: ContextProjectionConfig;
	readonly loadedSkillRoots: readonly string[];
	readonly cwd: string;
	readonly discoverNewEntries: boolean;
}

interface ProjectionSavingsEstimateOptions {
	readonly branchEntries: readonly SessionEntry[];
	readonly cwd: string;
	readonly projectedPlaceholdersByEntryId: ReadonlyMap<string, string>;
	readonly config: ContextProjectionConfig;
	readonly loadedSkillRoots?: readonly string[];
}

interface ProjectMappedContextEntryOptions {
	readonly entry: SessionEntry;
	readonly message: AgentMessage;
	readonly protectedEntryIds: ReadonlySet<string>;
	readonly readPathsByToolCallId: ReadonlyMap<string, string>;
	readonly loadedSkillRoots: readonly string[];
	readonly ignoredTools: ReadonlySet<string>;
	readonly projectedPlaceholdersByEntryId: ReadonlyMap<string, string>;
	readonly replacementTextByEntryId: ReadonlyMap<string, string> | undefined;
	readonly config: ContextProjectionConfig;
	readonly discoverNewEntries: boolean;
}

type ProjectMappedContextEntryResult =
	| { readonly kind: "unchanged"; readonly message: AgentMessage }
	| {
			readonly kind: "projected";
			readonly message: AgentMessage;
			readonly projectedEntry: ProjectedEntryState | undefined;
			readonly savedTokens: number;
	  };

/** Input needed to reconstruct advisor-visible context with recorded projection applied. */
export interface ContextProjectionReplayOptions {
	readonly branchEntries: readonly SessionEntry[];
	readonly cwd: string;
	readonly loadedSkillRoots?: readonly string[];
}

const runtimeProjectedPlaceholdersByScope = new Map<
	string,
	Map<string, string>
>();

/** Reads and validates context-projection config while absent config keeps projection disabled. */
export async function readContextProjectionConfig(): Promise<ContextProjectionConfigResult> {
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
	const minToolResultTokens =
		config[MIN_TOOL_RESULT_TOKENS_CONFIG_KEY] ?? DEFAULT_MIN_TOOL_RESULT_TOKENS;
	const projectionIgnoredTools =
		config[PROJECTION_IGNORED_TOOLS_CONFIG_KEY] ?? [];
	const placeholder = config[PLACEHOLDER_CONFIG_KEY] ?? DEFAULT_PLACEHOLDER;
	const summary = parseContextProjectionSummaryConfig(
		config[SUMMARY_CONFIG_KEY],
	);
	if (
		!isNonNegativeInteger(projectionRemainingTokens) ||
		!isNonNegativeInteger(keepRecentTurns) ||
		!isPercentNumber(keepRecentTurnsPercent) ||
		!isNonNegativeInteger(minToolResultTokens) ||
		!isUniqueNonEmptyStringArray(projectionIgnoredTools) ||
		!isNonEmptyString(placeholder) ||
		summary === undefined
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
			minToolResultTokens,
			projectionIgnoredTools,
			placeholder,
			summary,
		},
	};
}

/** Parses optional summary config while keeping summary disabled by default. */
function parseContextProjectionSummaryConfig(
	config: unknown,
): ContextProjectionSummaryConfig | undefined {
	if (config === undefined) {
		return createDisabledSummaryConfig();
	}
	if (!isRecord(config)) {
		return undefined;
	}

	const unsupportedKey = Object.keys(config).find(
		(key) =>
			!CONTEXT_PROJECTION_SUMMARY_CONFIG_KEYS.includes(
				key as (typeof CONTEXT_PROJECTION_SUMMARY_CONFIG_KEYS)[number],
			),
	);
	if (unsupportedKey !== undefined) {
		return undefined;
	}

	const enabled = config[SUMMARY_ENABLED_CONFIG_KEY];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return undefined;
	}
	if (enabled !== true) {
		return createDisabledSummaryConfig();
	}

	const model = config[SUMMARY_MODEL_CONFIG_KEY];
	const thinking = config[SUMMARY_THINKING_CONFIG_KEY];
	const maxConcurrency =
		config[SUMMARY_MAX_CONCURRENCY_CONFIG_KEY] ??
		DEFAULT_SUMMARY_MAX_CONCURRENCY;
	const retryCount =
		config[SUMMARY_RETRY_COUNT_CONFIG_KEY] ?? DEFAULT_SUMMARY_RETRY_COUNT;
	const retryDelayMs =
		config[SUMMARY_RETRY_DELAY_MS_CONFIG_KEY] ?? DEFAULT_SUMMARY_RETRY_DELAY_MS;
	const systemPromptFile = config[SUMMARY_SYSTEM_PROMPT_FILE_CONFIG_KEY];
	const userPromptFile = config[SUMMARY_USER_PROMPT_FILE_CONFIG_KEY];
	const values = parseEnabledSummaryConfigValues({
		model,
		thinking,
		maxConcurrency,
		retryCount,
		retryDelayMs,
		systemPromptFile,
		userPromptFile,
	});
	if (values === undefined) {
		return undefined;
	}

	return {
		enabled: true,
		...values,
	};
}

/** Parses enabled summary fields after defaults are applied. */
function parseEnabledSummaryConfigValues({
	model,
	thinking,
	maxConcurrency,
	retryCount,
	retryDelayMs,
	systemPromptFile,
	userPromptFile,
}: {
	readonly model: unknown;
	readonly thinking: unknown;
	readonly maxConcurrency: unknown;
	readonly retryCount: unknown;
	readonly retryDelayMs: unknown;
	readonly systemPromptFile: unknown;
	readonly userPromptFile: unknown;
}): EnabledSummaryConfigValues | undefined {
	if (
		!isOptionalModelId(model) ||
		!isOptionalSummaryThinking(thinking) ||
		!isPositiveInteger(maxConcurrency) ||
		!isNonNegativeInteger(retryCount) ||
		!isNonNegativeInteger(retryDelayMs) ||
		!isOptionalNonEmptyString(systemPromptFile) ||
		!isOptionalNonEmptyString(userPromptFile)
	) {
		return undefined;
	}

	return {
		maxConcurrency,
		retryCount,
		retryDelayMs,
		...(typeof model === "string" ? { model } : {}),
		...(isSummaryThinking(thinking) ? { thinking } : {}),
		...(typeof systemPromptFile === "string" ? { systemPromptFile } : {}),
		...(typeof userPromptFile === "string" ? { userPromptFile } : {}),
	};
}

/** Builds the default disabled summary config. */
function createDisabledSummaryConfig(): ContextProjectionSummaryConfig {
	return {
		enabled: false,
		maxConcurrency: DEFAULT_SUMMARY_MAX_CONCURRENCY,
		retryCount: DEFAULT_SUMMARY_RETRY_COUNT,
		retryDelayMs: DEFAULT_SUMMARY_RETRY_DELAY_MS,
	};
}

/** Returns branch context with persisted projection state applied when projection is active. */
export async function replayContextProjection({
	branchEntries,
	cwd,
	loadedSkillRoots = [],
}: ContextProjectionReplayOptions): Promise<AgentMessage[]> {
	const mappedContext = buildContextEntryMapping(branchEntries);
	const originalMessages = mappedContext.map(({ message }) => message);
	const config = await readContextProjectionConfig();
	if (config.kind !== "valid") {
		return originalMessages;
	}

	const projectedPlaceholdersByEntryId = mergeProjectedPlaceholders(
		collectProjectedPlaceholders(branchEntries),
		getRuntimeProjectedPlaceholders(cwd),
	);
	if (projectedPlaceholdersByEntryId.size === 0) {
		return originalMessages;
	}

	const decision = projectContextMessages({
		mappedContext,
		projectedPlaceholdersByEntryId,
		config: config.config,
		loadedSkillRoots,
		cwd,
		discoverNewEntries: false,
	});
	return decision.changed ? decision.messages : originalMessages;
}

/** Collects projected entries from extension-owned custom entries on the active branch only. */
export function collectProjectedPlaceholders(
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

/** Publishes active in-memory projection state for other extension entry points in the same process. */
export function publishRuntimeProjectedPlaceholders(
	cwd: string,
	projectedPlaceholdersByEntryId: ReadonlyMap<string, string>,
): void {
	runtimeProjectedPlaceholdersByScope.set(
		getRuntimeProjectionScope(cwd),
		new Map(projectedPlaceholdersByEntryId),
	);
}

/** Estimates current projected token savings from branch-local projection state. */
export function estimateProjectedSavedTokens({
	branchEntries,
	cwd,
	projectedPlaceholdersByEntryId,
	config,
	loadedSkillRoots = [],
}: ProjectionSavingsEstimateOptions): number {
	if (projectedPlaceholdersByEntryId.size === 0) {
		return 0;
	}

	const decision = projectContextMessages({
		mappedContext: buildContextEntryMapping(branchEntries),
		projectedPlaceholdersByEntryId,
		config,
		loadedSkillRoots,
		cwd,
		discoverNewEntries: false,
	});
	return estimateSavedTokens(decision.savedTokens);
}

/** Maps provider-context messages back to active branch entries only when the mapping is exact. */
export function mapEventMessagesToBranchEntries(
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

/** Returns projected provider-context messages and newly persisted projection state. */
export function projectContextMessages({
	mappedContext,
	projectedPlaceholdersByEntryId,
	replacementTextByEntryId,
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
	let savedTokens = 0;
	let newSavedTokens = 0;
	let changed = false;
	const messages = mappedContext.map(({ entry, message }) => {
		const result = projectMappedContextEntry({
			entry,
			message,
			protectedEntryIds,
			readPathsByToolCallId,
			loadedSkillRoots,
			ignoredTools,
			projectedPlaceholdersByEntryId,
			replacementTextByEntryId,
			config,
			discoverNewEntries,
		});
		if (result.kind === "unchanged") {
			return result.message;
		}

		savedTokens += result.savedTokens;
		changed = true;
		if (result.projectedEntry !== undefined) {
			newSavedTokens += result.savedTokens;
			newProjectedEntries.push(result.projectedEntry);
		}

		return result.message;
	});

	return {
		messages,
		newProjectedEntries,
		savedTokens,
		newSavedTokens,
		changed,
	};
}

/** Projects one mapped context entry or returns it unchanged when projection rules reject it. */
function projectMappedContextEntry({
	entry,
	message,
	protectedEntryIds,
	readPathsByToolCallId,
	loadedSkillRoots,
	ignoredTools,
	projectedPlaceholdersByEntryId,
	replacementTextByEntryId,
	config,
	discoverNewEntries,
}: ProjectMappedContextEntryOptions): ProjectMappedContextEntryResult {
	if (entry.type !== "message" || !isSuccessfulTextToolResult(message)) {
		return { kind: "unchanged", message };
	}
	if (
		shouldKeepToolResultVisible(
			message,
			readPathsByToolCallId,
			loadedSkillRoots,
			ignoredTools,
		)
	) {
		return { kind: "unchanged", message };
	}

	const alreadyProjected = projectedPlaceholdersByEntryId.has(entry.id);
	const newlyEligible =
		discoverNewEntries &&
		!protectedEntryIds.has(entry.id) &&
		countProjectionTextTokens(getTextToolResultText(message)) >=
			config.minToolResultTokens;
	if (!alreadyProjected && !newlyEligible) {
		return { kind: "unchanged", message };
	}

	const placeholder = alreadyProjected
		? (projectedPlaceholdersByEntryId.get(entry.id) ?? config.placeholder)
		: (replacementTextByEntryId?.get(entry.id) ?? config.placeholder);
	return {
		kind: "projected",
		message: {
			...message,
			content: [{ type: "text" as const, text: placeholder }],
		},
		projectedEntry: alreadyProjected
			? undefined
			: { entryId: entry.id, placeholder },
		savedTokens: calculateProjectedTokenSavings(
			getTextToolResultText(message),
			placeholder,
		),
	};
}

/** Collects loaded skill root directories from the prompt options available before an agent turn. */
export function collectLoadedSkillRoots(
	event: BeforeAgentStartEvent,
): readonly string[] {
	return (
		event.systemPromptOptions?.skills?.map((skill) => resolve(skill.baseDir)) ??
		[]
	);
}

/** Returns the approximate token count removed from provider context. */
export function estimateSavedTokens(savedTokens: number): number {
	return savedTokens;
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
	let currentToolUseTurn:
		| { readonly ordinal: number; readonly toolCallIds: ReadonlySet<string> }
		| undefined;
	let toolUseTurnCount = 0;
	const toolResultTurns = new Map<string, number>();
	for (const { entry, message } of mappedContext) {
		const toolCallIds = collectAssistantToolCallIds(message);
		if (toolCallIds.size > 0) {
			currentToolUseTurn = {
				ordinal: toolUseTurnCount,
				toolCallIds,
			};
			toolUseTurnCount += 1;
			continue;
		}
		if (message.role !== "toolResult") {
			currentToolUseTurn = undefined;
			continue;
		}
		if (
			entry.type === "message" &&
			currentToolUseTurn !== undefined &&
			currentToolUseTurn.toolCallIds.has(message.toolCallId)
		) {
			toolResultTurns.set(entry.id, currentToolUseTurn.ordinal);
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

/** Collects tool-call IDs when an assistant message starts a tool-use turn. */
function collectAssistantToolCallIds(message: AgentMessage): Set<string> {
	const toolCallIds = new Set<string>();
	if (message.role !== "assistant" || !Array.isArray(message.content)) {
		return toolCallIds;
	}

	for (const contentBlock of message.content) {
		if (contentBlock.type === "toolCall") {
			toolCallIds.add(contentBlock.id);
		}
	}

	return toolCallIds;
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

/** Returns the combined text content of a text-only tool result. */
function getTextToolResultText(
	message: Extract<AgentMessage, { role: "toolResult" }>,
): string {
	return message.content
		.map((contentBlock) =>
			contentBlock.type === "text" ? contentBlock.text : "",
		)
		.join("");
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
		isNonEmptyString(value["entryId"]) &&
		isNonEmptyString(value["placeholder"])
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

/** Returns true when the value is a positive integer. */
function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** Returns true when the value is a ratio from zero to one. */
function isPercentNumber(value: unknown): value is number {
	return typeof value === "number" && value >= 0 && value <= 1;
}

/** Returns true when a value is a non-empty string after whitespace is ignored. */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

/** Returns true when an optional string field is absent, null, or non-empty. */
function isOptionalNonEmptyString(
	value: unknown,
): value is string | null | undefined {
	return value === undefined || value === null || isNonEmptyString(value);
}

/** Returns true when an optional model ID is absent, null, or provider/model. */
function isOptionalModelId(value: unknown): value is string | null | undefined {
	if (value === undefined || value === null) {
		return true;
	}
	if (typeof value !== "string") {
		return false;
	}

	const separatorIndex = value.indexOf("/");
	return separatorIndex > 0 && separatorIndex < value.length - 1;
}

/** Returns true when an optional thinking field is absent, null, or supported. */
function isOptionalSummaryThinking(
	value: unknown,
): value is ContextProjectionSummaryThinking | null | undefined {
	return value === undefined || value === null || isSummaryThinking(value);
}

/** Returns true when a value is a supported summary thinking level. */
function isSummaryThinking(
	value: unknown,
): value is ContextProjectionSummaryThinking {
	return (
		typeof value === "string" &&
		(SUMMARY_THINKING_VALUES as readonly string[]).includes(value)
	);
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

function getRuntimeProjectedPlaceholders(
	cwd: string,
): ReadonlyMap<string, string> {
	return (
		runtimeProjectedPlaceholdersByScope.get(getRuntimeProjectionScope(cwd)) ??
		new Map()
	);
}

function getRuntimeProjectionScope(cwd: string): string {
	return `${getAgentDir()}\0${cwd}`;
}

function mergeProjectedPlaceholders(
	persistedPlaceholders: ReadonlyMap<string, string>,
	runtimePlaceholders: ReadonlyMap<string, string>,
): Map<string, string> {
	return new Map([...persistedPlaceholders, ...runtimePlaceholders]);
}

/** Returns true when a runtime value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns true when a failed config read means the config file is missing. */
function isFileNotFoundError(error: unknown): boolean {
	return isRecord(error) && error[ERROR_CODE_KEY] === "ENOENT";
}

/** Returns the token count removed after the original content is replaced by placeholder text. */
function calculateProjectedTokenSavings(
	originalText: string,
	placeholder: string,
): number {
	return Math.max(
		0,
		countProjectionTextTokens(originalText) -
			countProjectionTextTokens(placeholder),
	);
}
