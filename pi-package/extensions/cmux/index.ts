import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { env as processEnv } from "node:process";
import type {
	AgentEndEvent,
	ExtensionAPI,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isReadToolResult,
	isWriteToolResult,
} from "@earendil-works/pi-coding-agent";
import {
	getSuiteConfigLocation,
	isFileNotFoundError,
} from "../../shared/agent-suite-storage";
import { isChildAgentProcess } from "../../shared/child-agent-environment";

/** Suite directory owned only by this extension. */
const CMUX_EXTENSION_DIR = "cmux";

/** Config key that disables all behavior owned by this extension. */
const ENABLED_CONFIG_KEY = "enabled";

/** Config keys accepted by the cmux config object. */
const CMUX_CONFIG_KEYS = [ENABLED_CONFIG_KEY] as const;

/** Command timeout that prevents unavailable cmux from delaying pi indefinitely. */
const CMUX_NOTIFY_TIMEOUT_MS = 5_000;

/** Minimum duration before a non-fallback body includes elapsed time. */
const LONG_RUN_THRESHOLD_MS = 15_000;

/** Full second used to convert millisecond durations into display text. */
const SECOND_MS = 1_000;

/** Full minute used to format display durations. */
const MINUTE_SECONDS = 60;

/** Runtime state collected for one top-level pi run. */
interface RunState {
	readonly startedAt: number;
	readonly readFiles: Set<string>;
	readonly changedFiles: Set<string>;
	searchCount: number;
	shellCount: number;
}

/** Raw config values accepted after strict JSON validation. */
interface CmuxRawConfig {
	readonly enabled?: boolean;
}

/** Effective config used by lifecycle handlers after defaults are applied. */
interface CmuxConfig {
	readonly enabled: boolean;
}

/** Config read result that keeps invalid config fail-closed. */
type CmuxConfigResult =
	| { readonly kind: "valid"; readonly config: CmuxConfig }
	| { readonly kind: "invalid"; readonly issue: string };

/** Narrow session context shape used only for config warning notifications. */
interface CmuxSessionContext {
	readonly hasUI?: boolean;
	readonly ui?: {
		notify(message: string, type: "warning"): void;
	};
}

type AssistantAgentMessage = Extract<
	AgentEndEvent["messages"][number],
	{ readonly role: "assistant" }
>;

/** Optional dependencies that isolate environment and clock side effects. */
export interface CmuxDependencies {
	readonly env?: NodeJS.ProcessEnv;
	readonly now?: () => number;
}

/** Registers cmux completion notification lifecycle handlers. */
export default function cmux(
	pi: ExtensionAPI,
	dependencies?: CmuxDependencies,
): void {
	const runtimeEnv = dependencies?.env ?? processEnv;
	const now = dependencies?.now ?? Date.now;
	let runState = createEmptyRunState(now());

	pi.on("session_start", async (_event, ctx) => {
		const config = await readCmuxConfig();
		if (config.kind === "invalid") {
			reportConfigIssue(ctx as CmuxSessionContext, config.issue);
		}
	});

	pi.on("agent_start", async () => {
		runState = createEmptyRunState(now());
	});

	pi.on("tool_result", async (event) => {
		collectToolResult(runState, event);
	});

	pi.on("agent_end", async (event) => {
		if (isChildAgentProcess(runtimeEnv) || !isCompletedWorkEvent(event)) {
			return;
		}

		const config = await readCmuxConfig();
		if (config.kind === "invalid" || !config.config.enabled) {
			return;
		}

		const durationMs = now() - runState.startedAt;
		const body = summarizeSuccess(runState, durationMs);
		await sendNotification(pi, body);
	});
}

/** Returns true only for agent endings that represent completed assistant work. */
function isCompletedWorkEvent(event: AgentEndEvent): boolean {
	const lastAssistantMessage = findLastAssistantMessage(event.messages);
	return (
		lastAssistantMessage !== undefined &&
		lastAssistantMessage.stopReason !== "error" &&
		lastAssistantMessage.stopReason !== "aborted"
	);
}

/** Finds the latest assistant message because tool results can follow assistant turns. */
function findLastAssistantMessage(
	messages: AgentEndEvent["messages"],
): AssistantAgentMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant") {
			return message;
		}
	}

	return undefined;
}

/** Creates an empty run state for one agent run start time. */
function createEmptyRunState(startedAt: number): RunState {
	return {
		startedAt,
		readFiles: new Set<string>(),
		changedFiles: new Set<string>(),
		searchCount: 0,
		shellCount: 0,
	};
}

/** Tracks successful built-in tool results that make completion notifications useful. */
function collectToolResult(state: RunState, event: ToolResultEvent): void {
	if (event.isError) {
		return;
	}

	if (isReadToolResult(event)) {
		const path = getPathFromInput(event);
		if (path !== undefined) {
			state.readFiles.add(path);
		}
		return;
	}

	if (isEditToolResult(event) || isWriteToolResult(event)) {
		const path = getPathFromInput(event);
		if (path !== undefined) {
			state.changedFiles.add(path);
		}
		return;
	}

	if (isGrepToolResult(event) || isFindToolResult(event)) {
		state.searchCount += 1;
		return;
	}

	if (isBashToolResult(event)) {
		state.shellCount += 1;
	}
}

/** Extracts the path value shared by built-in file-oriented tool result inputs. */
function getPathFromInput(event: ToolResultEvent): string | undefined {
	const path = event.input["path"];
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

/** Reads and validates config while missing config keeps cmux notifications enabled. */
async function readCmuxConfig(): Promise<CmuxConfigResult> {
	const configLocation = getSuiteConfigLocation(CMUX_EXTENSION_DIR);

	let content: string;
	try {
		content = await readFile(configLocation.path, "utf8");
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return {
				kind: "valid",
				config: buildCmuxConfig({}),
			};
		}

		return invalidConfig(`failed to read config: ${formatError(error)}`);
	}

	try {
		const config: unknown = JSON.parse(content);

		return parseCmuxConfig(config);
	} catch (error) {
		return invalidConfig(`failed to parse config: ${formatError(error)}`);
	}
}

/** Parses config JSON before lifecycle logic uses it to call a local cmux command. */
function parseCmuxConfig(config: unknown): CmuxConfigResult {
	if (!isRecord(config)) {
		return invalidConfig("config must be an object");
	}

	const unsupportedKey = Object.keys(config).find(
		(key) =>
			!CMUX_CONFIG_KEYS.includes(key as (typeof CMUX_CONFIG_KEYS)[number]),
	);
	if (unsupportedKey !== undefined) {
		return invalidConfig("config contains unsupported keys");
	}

	const rawConfig = parseCmuxFields(config);
	if (rawConfig.kind === "invalid") {
		return rawConfig;
	}

	return {
		kind: "valid",
		config: buildCmuxConfig(rawConfig.config),
	};
}

/** Parses known config fields after object shape and key ownership are proven. */
function parseCmuxFields(
	config: Record<string, unknown>,
):
	| { readonly kind: "valid"; readonly config: CmuxRawConfig }
	| { readonly kind: "invalid"; readonly issue: string } {
	const enabled = config[ENABLED_CONFIG_KEY];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return invalidConfig("enabled must be a boolean");
	}

	return {
		kind: "valid",
		config: {
			...(enabled !== undefined ? { enabled } : {}),
		},
	};
}

/** Builds effective config by applying extension defaults to omitted fields. */
function buildCmuxConfig(config: CmuxRawConfig): CmuxConfig {
	return {
		enabled: config.enabled ?? true,
	};
}

/** Builds fail-closed config result with an isolated extension issue. */
function invalidConfig(issue: string): CmuxConfigResult {
	return {
		kind: "invalid",
		issue,
	};
}

/** Reports invalid config without interrupting other extensions. */
function reportConfigIssue(ctx: CmuxSessionContext, issue: string): void {
	if (ctx.hasUI === false) {
		return;
	}

	ctx.ui?.notify(`[cmux] ${issue}`, "warning");
}

/** Summarizes successful run activity for the cmux notification body. */
function summarizeSuccess(state: RunState, durationMs: number): string {
	const changedCount = state.changedFiles.size;
	if (changedCount === 1) {
		const file = getOnlySetValue(state.changedFiles);
		return withLongDuration(`Updated ${basename(file)}`, durationMs);
	}
	if (changedCount > 1) {
		return withLongDuration(
			`Updated ${changedCount} ${pluralize(changedCount, "file")}`,
			durationMs,
		);
	}

	const readCount = state.readFiles.size;
	if (readCount === 1) {
		const file = getOnlySetValue(state.readFiles);
		return withLongDuration(`Reviewed ${basename(file)}`, durationMs);
	}
	if (readCount > 1) {
		return withLongDuration(
			`Reviewed ${readCount} ${pluralize(readCount, "file")}`,
			durationMs,
		);
	}

	if (state.searchCount > 0 && state.shellCount > 0) {
		return withLongDuration(
			`Ran ${state.searchCount} ${pluralize(state.searchCount, "search", "searches")} and ${state.shellCount} ${pluralize(state.shellCount, "shell command")}`,
			durationMs,
		);
	}
	if (state.searchCount > 0) {
		const summary =
			state.searchCount === 1
				? "Searched the codebase"
				: `Ran ${state.searchCount} searches`;
		return withLongDuration(summary, durationMs);
	}
	if (state.shellCount > 0) {
		return withLongDuration(
			`Ran ${state.shellCount} ${pluralize(state.shellCount, "shell command")}`,
			durationMs,
		);
	}

	return `Finished in ${formatDuration(durationMs)}`;
}

/** Appends duration only for non-fallback long-run summaries. */
function withLongDuration(summary: string, durationMs: number): string {
	return durationMs >= LONG_RUN_THRESHOLD_MS
		? `${summary} in ${formatDuration(durationMs)}`
		: summary;
}

/** Returns the only value from a set after the caller has proven it has size one. */
function getOnlySetValue(values: ReadonlySet<string>): string {
	const value = values.values().next().value;
	if (value === undefined) {
		throw new Error("expected set to contain one value");
	}

	return value;
}

/** Formats elapsed time in compact cmux notification text. */
function formatDuration(ms: number): string {
	const totalSeconds = Math.max(1, Math.round(ms / SECOND_MS));
	const minutes = Math.floor(totalSeconds / MINUTE_SECONDS);
	const seconds = totalSeconds % MINUTE_SECONDS;
	if (minutes === 0) {
		return `${seconds}s`;
	}
	if (seconds === 0) {
		return `${minutes}m`;
	}
	return `${minutes}m ${seconds}s`;
}

/** Returns a singular or plural label for one counted summary part. */
function pluralize(
	count: number,
	singular: string,
	plural = `${singular}s`,
): string {
	return count === 1 ? singular : plural;
}

/** Sends the cmux notification and absorbs cmux failures. */
async function sendNotification(pi: ExtensionAPI, body: string): Promise<void> {
	try {
		await pi.exec(
			"cmux",
			[
				"notify",
				"--title",
				"Pi",
				"--subtitle",
				"Task Complete",
				"--body",
				body,
			],
			{ timeout: CMUX_NOTIFY_TIMEOUT_MS },
		);
	} catch {
		return;
	}
}

/** Returns true when a value is a JSON object suitable for strict config parsing. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Converts unknown failures into safe diagnostics for config issue messages. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
