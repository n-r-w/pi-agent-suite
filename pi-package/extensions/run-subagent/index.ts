import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
	type AgentDefinition,
	loadAgentDefinitions,
} from "../../shared/agent-registry";
import {
	getAgentRuntimeComposition,
	type MainAgentRuntimeInfo,
} from "../../shared/agent-runtime-composition";
import {
	SUBAGENT_AGENT_ID_ENV,
	SUBAGENT_DEPTH_ENV,
	SUBAGENT_TOOLS_ENV,
} from "../../shared/subagent-environment";
import { truncateToolTextOutput } from "../../shared/tool-output-truncation";
import { resolveToolPolicy } from "../../shared/tool-policy";
import {
	createChildEnvironment,
	readSubagentAgentId,
	readSubagentDepth,
} from "./environment";
import {
	appendSubagentStderr,
	createSubagentProgressState,
	finalizeSubagentProgressState,
	recordSubagentSessionEvent,
	type SubagentRunDetails,
	type SubagentRunStatus,
	toSubagentRunDetails,
} from "./progress";
import { renderRunSubagentCall, renderRunSubagentResult } from "./rendering";
import {
	createSubagentWidgetFactory,
	createSubagentWidgetState,
	recordSubagentWidgetRun,
	SUBAGENT_WIDGET_KEY,
} from "./widget";

/** CommonJS loader used for the stream-json parser package exported as CommonJS. */
const requireStreamJson = createRequire(import.meta.url);
/** Streaming JSON parser factory used only for oversized child RPC JSONL projection. */
const streamJsonParser = requireStreamJson("stream-json/parser.js") as {
	readonly parser: StreamJsonParserFactory;
};

const TOOL_NAME = "run_subagent";
const ISSUE_PREFIX = "[run-subagent]";
const CONFIG_PATH = join("config", "run-subagent.json");
const ENABLED_CONFIG_KEY = "enabled";
/** Default maximum child-subagent nesting depth when config omits maxDepth. */
const DEFAULT_MAX_DEPTH = 1;
/** Default number of lines kept in the live subagent widget. */
const DEFAULT_WIDGET_LINE_BUDGET = 7;
/** Minimum time between non-forced widget updates to avoid excessive UI redraws. */
const WIDGET_UPDATE_THROTTLE_MS = 120;
/** Milliseconds in one second for elapsed-time formatting. */
const SECOND_MS = 1000;
/** Fraction digits shown for elapsed seconds. */
const ELAPSED_SECONDS_FRACTION_DIGITS = 1;
/** Grace period for child RPC abort before sending SIGTERM. */
const CHILD_ABORT_FALLBACK_TIMEOUT_MS = 10_000;
/** Grace period after SIGTERM before escalating child termination to SIGKILL. */
const CHILD_ABORT_KILL_TIMEOUT_MS = 5_000;
/** Maximum stored child stderr diagnostics. */
const CHILD_STDERR_TEXT_LIMIT = 64_000;
/** Bytes in one kibibyte for child stream limits. */
const BYTES_PER_KIB = 1024;
/** Kibibytes in one mebibyte for child stream limits. */
const KIB_PER_MIB = 1024;
/** Bytes in one mebibyte for child stream limits. */
const BYTES_PER_MIB = BYTES_PER_KIB * KIB_PER_MIB;
/** Bounded JSONL suffix size kept for normal child stdout event parsing. */
const CHILD_STDOUT_LINE_BUFFER_KIB = 256;
/** Bounded JSONL suffix size in bytes kept for normal child stdout event parsing. */
const CHILD_STDOUT_LINE_BUFFER_LIMIT =
	CHILD_STDOUT_LINE_BUFFER_KIB * BYTES_PER_KIB;
/** Maximum streamed final-answer text stored before failing closed. */
const CHILD_STREAMED_TEXT_MIB_LIMIT = 100;
/** Maximum streamed final-answer text in bytes stored before failing closed. */
const CHILD_STREAMED_TEXT_BYTES_LIMIT =
	CHILD_STREAMED_TEXT_MIB_LIMIT * BYTES_PER_MIB;
/** Error returned when a large child RPC event cannot be projected safely. */
const OVERSIZED_CHILD_JSON_EVENT_ERROR =
	"child pi output exceeded supported JSON event size before final response could be parsed";
/** Error returned when streamed final-answer accumulation exceeds its memory bound. */
const OVERSIZED_CHILD_FINAL_RESPONSE_ERROR = `child pi final response exceeded ${CHILD_STREAMED_TEXT_MIB_LIMIT} MiB memory limit`;
/** Error returned for invalid child RPC JSONL records. */
const MALFORMED_CHILD_RPC_OUTPUT_ERROR =
	"child pi emitted malformed RPC output";
/** Synthetic content part marking text skipped from an oversized assistant message. */
const SKIPPED_TEXT_PART_TYPE = "run_subagent_text_skipped";
/** Maximum JSON object key text collected while projecting oversized RPC events. */
const CHILD_RPC_PROJECTED_KEY_TEXT_LIMIT = 128;
/** Maximum scalar control-field text collected while projecting oversized RPC events. */
const CHILD_RPC_PROJECTED_SCALAR_TEXT_LIMIT = 4096;
/** Error returned when child exits before the prompt completion event. */
const INCOMPLETE_CHILD_RPC_RUN_ERROR =
	"subagent exited before completing the task";
/** Error returned when child completed without a usable final assistant answer. */
const MISSING_CHILD_FINAL_ANSWER_ERROR =
	"subagent completed without a final answer";
/** Error returned when parent abort cancels an incomplete child run. */
const ABORTED_CHILD_RPC_RUN_ERROR = "subagent execution aborted";
/** RPC command id used for the child prompt request. */
const PROMPT_COMMAND_ID = "run-subagent-prompt";
/** RPC command id used for the child abort request. */
const ABORT_COMMAND_ID = "run-subagent-abort";
/** Valid canonical non-negative integer format for child nesting depth. */
const DEPTH_PATTERN = /^(0|[1-9][0-9]*)$/;

const RunSubagentParameters = Type.Object({
	agentId: Type.String({ description: "Callable agent ID to run" }),
	prompt: Type.String({ description: "Task prompt for the selected subagent" }),
});

interface RunSubagentParams {
	readonly agentId: string;
	readonly prompt: string;
}

interface RunSubagentConfig {
	readonly enabled: boolean;
	readonly maxDepth: number;
	readonly widgetLineBudget: number;
	readonly issue?: string;
}

interface RunSubagentContext extends ExtensionContext {
	readonly model: Model<Api> | undefined;
}

interface SpawnOptions {
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly signal: AbortSignal | undefined;
}

interface DepthResult {
	readonly value?: number;
	readonly issue?: string;
}

interface SpawnedProcess {
	readonly stdin: {
		write(data: string): boolean;
		end(): void;
		on(event: "error", handler: (error: Error) => void): void;
	};
	readonly stdout: {
		on(event: "data", handler: (data: unknown) => void): void;
	};
	readonly stderr: {
		on(event: "data", handler: (data: unknown) => void): void;
	};
	kill(signal?: string): boolean;
	on(event: "close", handler: (code: number | null) => void): void;
	on(event: "error", handler: (error: Error) => void): void;
}

interface RunSubagentDependencies {
	readonly spawnPi?: (
		command: string,
		args: string[],
		options: SpawnOptions,
	) => SpawnedProcess;
}

interface ChildToolPolicy {
	readonly args: string[];
	readonly env: Record<string, string>;
}

type ChildRunStatus = "succeeded" | "failed" | "aborted";

interface ChildRunResult {
	readonly exitCode: number;
	readonly status: ChildRunStatus;
	readonly errorMessage?: string;
	readonly stdoutText: string;
	readonly stderrText: string;
	readonly stdoutLineExceededLimit: boolean;
	readonly streamedTextExceededLimit: boolean;
}

interface ChildStreamState {
	stdoutBuffer: string;
	stdoutProjection: ChildRpcLineProjection | undefined;
	stdoutBufferTruncated: boolean;
	stdoutLineExceededLimit: boolean;
	stderrText: string;
	stderrTextTruncated: boolean;
	streamedText: string;
	streamedTextBytes: number;
	streamedTextExceededLimit: boolean;
	finalText: string;
}

interface ExecuteRunSubagentOptions {
	readonly pi: ExtensionAPI;
	readonly spawnPi: NonNullable<RunSubagentDependencies["spawnPi"]>;
	readonly subagentWidgetState: ReturnType<typeof createSubagentWidgetState>;
	readonly toolCallId: string;
	readonly params: RunSubagentParams;
	readonly signal: AbortSignal | undefined;
	readonly onUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined;
	readonly ctx: RunSubagentContext;
}

interface ResolvedRunSubagentExecution {
	readonly config: RunSubagentConfig;
	readonly depth: number;
	readonly agent: AgentDefinition;
	readonly modelId: string;
	readonly childTools: ChildToolPolicy;
	readonly thinking: string;
}

interface BuildRunSubagentPromptOptions {
	readonly pi: ExtensionAPI;
	readonly callableAgents: readonly AgentDefinition[];
	readonly mainAgent: MainAgentRuntimeInfo | undefined;
	readonly childAgentId: string | undefined;
	readonly isDepthAvailable: boolean;
}

interface StreamJsonToken {
	readonly name: string;
	readonly value?: unknown;
}

interface StreamJsonParserStream {
	write(chunk: string): boolean;
	end(): void;
	on(event: "data", handler: (token: StreamJsonToken) => void): this;
	on(event: "error", handler: (error: Error) => void): this;
	on(event: "end", handler: () => void): this;
}

interface StreamJsonParserFactory {
	asStream(options: {
		readonly packKeys: boolean;
		readonly streamKeys: boolean;
		readonly packStrings: boolean;
		readonly streamStrings: boolean;
		readonly packNumbers: boolean;
		readonly streamNumbers: boolean;
	}): StreamJsonParserStream;
}

interface ChildRpcLineProjection {
	readonly stream: StreamJsonParserStream;
	readonly state: ChildRpcLineProjectionState;
	readonly done: Promise<void>;
	error: string | undefined;
}

interface ChildRpcLineProjectionState {
	readonly stack: JsonProjectionContainer[];
	currentString: JsonProjectionString | undefined;
	eventType: string | undefined;
	role: string | undefined;
	stopReason: string | undefined;
	assistantMessageEventType: string | undefined;
	assistantMessageEventDelta: string | undefined;
	assistantMessageEventDeltaBytes: number;
	assistantMessageEventDeltaExceededLimit: boolean;
	hasSkippedText: boolean;
	hasToolCall: boolean;
}

interface JsonProjectionContainer {
	readonly kind: "object" | "array";
	readonly path: readonly string[];
	pendingKey: string | undefined;
	readonly contentPart: JsonProjectionContentPart | undefined;
}

interface JsonProjectionContentPart {
	type: string | undefined;
	hasText: boolean;
}

interface JsonProjectionString {
	readonly kind: "key" | "value";
	readonly path: readonly string[];
	text: string;
	truncated: boolean;
}

/** Extension entry point for subagent execution behavior. */
export default async function runSubagent(
	pi: ExtensionAPI,
	dependencies: RunSubagentDependencies = {},
): Promise<void> {
	const startupConfig = await readRunSubagentConfig();
	if (!startupConfig.enabled) {
		return;
	}

	const spawnPi = dependencies.spawnPi ?? defaultSpawnPi;
	const subagentWidgetState = createSubagentWidgetState();
	await publishRunSubagentPromptContribution(pi);

	pi.registerTool({
		name: TOOL_NAME,
		label: "Run subagent",
		description: "Run one configured callable agent in a child pi process.",
		parameters: RunSubagentParameters,
		executionMode: "parallel",
		async execute(...[toolCallId, params, signal, onUpdate, ctx]) {
			return executeRunSubagent({
				pi,
				spawnPi,
				subagentWidgetState,
				toolCallId,
				params: params as RunSubagentParams,
				signal,
				onUpdate,
				ctx: ctx as RunSubagentContext,
			});
		},
		renderCall: renderRunSubagentCall,
		renderResult: renderRunSubagentResult,
	});
}

/** Publishes callable-agent guidance and child prompt through runtime composition. */
async function publishRunSubagentPromptContribution(
	pi: ExtensionAPI,
): Promise<void> {
	const composition = getAgentRuntimeComposition(pi);
	const callableAgents = await loadCallableAgents();
	composition.setRunSubagentContribution({
		buildPrompt: async () =>
			buildRunSubagentPrompt({
				pi,
				callableAgents,
				mainAgent: composition.getMainAgentContribution()?.agent,
				childAgentId: readSubagentAgentId(),
				isDepthAvailable: await isRunSubagentDepthAvailable(),
			}),
	});
	composition.setRunSubagentActiveToolFilter(filterRunSubagentByDepth);
}

/** Removes run_subagent from active tools when this process is already at the configured subagent depth limit. */
async function filterRunSubagentByDepth(
	toolNames: readonly string[],
): Promise<readonly string[]> {
	if (!toolNames.includes(TOOL_NAME)) {
		return toolNames;
	}

	return (await isRunSubagentDepthAvailable())
		? toolNames
		: toolNames.filter((toolName) => toolName !== TOOL_NAME);
}

/** Checks whether the current process may expose another run_subagent call. */
async function isRunSubagentDepthAvailable(): Promise<boolean> {
	const config = await readRunSubagentConfig();
	const currentDepth = readCurrentDepth();
	if (currentDepth.issue !== undefined) {
		return false;
	}

	const depth = currentDepth.value ?? 0;
	return config.enabled && depth < config.maxDepth;
}

/** Builds the prompt section that exposes the callable agents available to the current effective agent. */
function buildRunSubagentPrompt({
	pi,
	callableAgents,
	mainAgent,
	childAgentId,
	isDepthAvailable,
}: BuildRunSubagentPromptOptions): string | undefined {
	const effectiveAgent = resolveEffectiveAgentPolicy(
		callableAgents,
		mainAgent,
		childAgentId,
	);
	const prompts: string[] = [];
	if (childAgentId !== undefined) {
		const childAgent = callableAgents.find(
			(agent) => agent.id === childAgentId,
		);
		if (childAgent?.prompt) {
			prompts.push(childAgent.prompt);
		}
	}

	if (
		!isDepthAvailable ||
		!isRunSubagentAllowedForEffectiveAgent(pi, effectiveAgent)
	) {
		return prompts.length > 0 ? prompts.join("\n\n") : undefined;
	}

	prompts.push(
		formatCallableAgentsPrompt(
			filterCallableAgents(callableAgents, effectiveAgent),
		),
	);
	return prompts.join("\n\n");
}

/** Resolves the agent whose subagent policy controls the current process. */
function resolveEffectiveAgentPolicy(
	callableAgents: readonly AgentDefinition[],
	mainAgent: MainAgentRuntimeInfo | undefined,
	childAgentId: string | undefined,
): MainAgentRuntimeInfo | AgentDefinition | undefined {
	if (childAgentId === undefined) {
		return mainAgent;
	}

	return callableAgents.find((agent) => agent.id === childAgentId);
}

/** Applies the effective agent's explicit subagent allowlist to callable agents. */
function filterCallableAgents(
	callableAgents: readonly AgentDefinition[],
	effectiveAgent: MainAgentRuntimeInfo | AgentDefinition | undefined,
): readonly AgentDefinition[] {
	if (effectiveAgent?.agents === undefined) {
		return callableAgents;
	}

	const allowedIds = new Set(effectiveAgent.agents);
	return callableAgents.filter((agent) => allowedIds.has(agent.id));
}

/** Checks whether the effective agent can call run_subagent under its tool allowlist. */
function isRunSubagentAllowedForEffectiveAgent(
	pi: ExtensionAPI,
	effectiveAgent: MainAgentRuntimeInfo | AgentDefinition | undefined,
): boolean {
	if (effectiveAgent?.tools === undefined) {
		return true;
	}

	const availableToolNames = pi.getAllTools().map((tool) => tool.name);
	const resolved = resolveToolPolicy(effectiveAgent.tools, availableToolNames);
	return !("issue" in resolved) && resolved.tools.includes(TOOL_NAME);
}

/** Formats callable agent ids and descriptions for the parent model context. */
function formatCallableAgentsPrompt(
	callableAgents: readonly AgentDefinition[],
): string {
	const rows =
		callableAgents.length > 0
			? callableAgents
					.map(
						(agent) =>
							`- agentId: ${agent.id}\n  description: ${agent.description}`,
					)
					.join("\n")
			: "none";

	return [
		"Callable agents available through run_subagent:",
		rows,
		"Use run_subagent with exactly one agentId and one prompt.",
		"For independent work, emit multiple run_subagent tool calls in the same assistant response so pi can run them in parallel.",
	].join("\n");
}

/** Runs the selected callable agent after config, depth, model, and tool-policy checks. */
async function executeRunSubagent(
	options: ExecuteRunSubagentOptions,
): Promise<AgentToolResult<unknown>> {
	const resolution = await resolveRunSubagentExecution(options);
	if ("result" in resolution) {
		return resolution.result;
	}

	const progress = createRunSubagentProgress(options, resolution.plan);
	progress.emit("running", undefined, true);
	const run = await runResolvedChildPi(options, resolution.plan, progress);
	return finishRunSubagentExecution(run, progress);
}

/** Resolves all fail-closed checks before spawning the child pi process. */
async function resolveRunSubagentExecution({
	pi,
	params,
	ctx,
}: ExecuteRunSubagentOptions): Promise<
	| { readonly plan: ResolvedRunSubagentExecution }
	| { readonly result: AgentToolResult<unknown> }
> {
	const config = await readRunSubagentConfig();
	if (config.issue !== undefined) {
		reportIssue(ctx, config.issue);
	}

	const depthResult = resolveNextSubagentDepth(config);
	if ("result" in depthResult) {
		return depthResult;
	}

	const agentResult = await resolveCallableAgent(pi, params);
	if ("result" in agentResult) {
		return agentResult;
	}

	const { agent } = agentResult;
	const modelId = resolveChildModelId(agent, ctx.model);
	if (modelId === undefined) {
		return {
			result: errorResult(
				`agent ${agent.id} has no model and no current model is available`,
			),
		};
	}

	const childTools = resolveChildToolPolicy(pi, agent);
	if ("issue" in childTools) {
		return { result: errorResult(childTools.issue) };
	}

	return {
		plan: {
			config,
			depth: depthResult.depth,
			agent,
			modelId,
			childTools,
			thinking: agent.model?.thinking ?? pi.getThinkingLevel(),
		},
	};
}

/** Resolves the next child depth while enforcing the configured maximum depth. */
function resolveNextSubagentDepth(
	config: RunSubagentConfig,
): { readonly depth: number } | { readonly result: AgentToolResult<unknown> } {
	const currentDepth = readCurrentDepth();
	if (currentDepth.issue !== undefined) {
		return { result: errorResult(currentDepth.issue) };
	}

	const depth = currentDepth.value ?? 0;
	return depth >= config.maxDepth
		? {
				result: errorResult(
					`subagent depth ${depth} reached maxDepth ${config.maxDepth}`,
				),
			}
		: { depth };
}

/** Resolves the requested callable agent after applying the effective allowlist. */
async function resolveCallableAgent(
	pi: ExtensionAPI,
	params: RunSubagentParams,
): Promise<
	| { readonly agent: AgentDefinition }
	| { readonly result: AgentToolResult<unknown> }
> {
	const agents = await loadCallableAgents();
	const effectiveAgent = resolveEffectiveAgentPolicy(
		agents,
		getAgentRuntimeComposition(pi).getMainAgentContribution()?.agent,
		readSubagentAgentId(),
	);
	const allowedAgents = filterCallableAgents(agents, effectiveAgent);
	const agent = allowedAgents.find(
		(candidate) => candidate.id === params.agentId,
	);
	return agent === undefined
		? { result: errorResult(`agent ${params.agentId} was not found`) }
		: { agent };
}

/** Creates progress state and throttled UI updates for the child run. */
function createRunSubagentProgress(
	options: ExecuteRunSubagentOptions,
	plan: ResolvedRunSubagentExecution,
): {
	readonly state: ReturnType<typeof createSubagentProgressState>;
	readonly emit: (
		status: SubagentRunStatus,
		exitCode?: number,
		forceWidgetUpdate?: boolean,
	) => SubagentRunDetails;
} {
	let lastWidgetUpdateAt = 0;
	const state = createSubagentProgressState({
		agentId: plan.agent.id,
		depth: plan.depth + 1,
		startedAtMs: Date.now(),
		runtime: resolveSubagentRuntimeDetails(
			plan.modelId,
			plan.thinking,
			options.ctx,
		),
		runId: options.toolCallId,
	});

	return {
		state,
		emit(status, exitCode, forceWidgetUpdate = false) {
			const details = createSubagentRunDetails(state, status, exitCode);
			reportSubagentProgress(options.onUpdate, details);
			lastWidgetUpdateAt = updateSubagentWidget({
				options,
				plan,
				details,
				lastWidgetUpdateAt,
				forceWidgetUpdate,
			});
			return details;
		},
	};
}

/** Converts current progress state into serializable run details. */
function createSubagentRunDetails(
	state: ReturnType<typeof createSubagentProgressState>,
	status: SubagentRunStatus,
	exitCode: number | undefined,
): SubagentRunDetails {
	return status === "running"
		? toSubagentRunDetails(state, status, Date.now(), exitCode)
		: finalizeSubagentProgressState(state, status, Date.now(), exitCode ?? 0);
}

/** Emits progress details to the tool-call update stream. */
function reportSubagentProgress(
	onUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined,
	details: SubagentRunDetails,
): void {
	onUpdate?.({
		content: [{ type: "text", text: formatSubagentProgressContent(details) }],
		details,
	});
}

/** Updates the subagent widget when the UI is available and the throttle allows it. */
function updateSubagentWidget({
	options,
	plan,
	details,
	lastWidgetUpdateAt,
	forceWidgetUpdate,
}: {
	readonly options: ExecuteRunSubagentOptions;
	readonly plan: ResolvedRunSubagentExecution;
	readonly details: SubagentRunDetails;
	readonly lastWidgetUpdateAt: number;
	readonly forceWidgetUpdate: boolean;
}): number {
	const now = Date.now();
	if (!(options.ctx.hasUI ?? true)) {
		return lastWidgetUpdateAt;
	}

	recordSubagentWidgetRun(options.subagentWidgetState, details, now);
	if (
		!forceWidgetUpdate &&
		lastWidgetUpdateAt !== 0 &&
		now - lastWidgetUpdateAt < WIDGET_UPDATE_THROTTLE_MS
	) {
		return lastWidgetUpdateAt;
	}

	options.ctx.ui.setWidget(
		SUBAGENT_WIDGET_KEY,
		createSubagentWidgetFactory(
			options.subagentWidgetState,
			plan.config.widgetLineBudget,
		),
	);
	return now;
}

/** Runs the child process and records RPC session progress events. */
async function runResolvedChildPi(
	options: ExecuteRunSubagentOptions,
	plan: ResolvedRunSubagentExecution,
	progress: ReturnType<typeof createRunSubagentProgress>,
): Promise<ChildRunResult> {
	return runChildPi(options.spawnPi, {
		args: buildChildArgs({
			modelId: plan.modelId,
			thinking: plan.thinking,
			toolPolicy: plan.childTools,
		}),
		cwd: options.ctx.cwd,
		env: createChildEnvironment({
			[SUBAGENT_AGENT_ID_ENV]: plan.agent.id,
			[SUBAGENT_DEPTH_ENV]: String(plan.depth + 1),
			...plan.childTools.env,
		}),
		signal: options.signal,
		prompt: options.params.prompt,
		onSessionEvent(event) {
			if (recordSubagentSessionEvent(progress.state, event, Date.now())) {
				progress.emit("running");
			}
		},
	});
}

/** Converts the child process result into the final tool output. */
async function finishRunSubagentExecution(
	run: ChildRunResult,
	progress: ReturnType<typeof createRunSubagentProgress>,
): Promise<AgentToolResult<unknown>> {
	if (run.stderrText.length > 0) {
		appendSubagentStderr(progress.state, run.stderrText);
	}

	if (run.status === "aborted") {
		const details = progress.emit("aborted", run.exitCode, true);
		return errorResult(
			run.errorMessage ?? ABORTED_CHILD_RPC_RUN_ERROR,
			details,
		);
	}

	if (run.streamedTextExceededLimit) {
		const details = progress.emit("failed", run.exitCode, true);
		return errorResult(OVERSIZED_CHILD_FINAL_RESPONSE_ERROR, details);
	}

	if (run.status === "failed" || run.exitCode !== 0) {
		const details = progress.emit("failed", run.exitCode, true);
		return errorResult(
			run.errorMessage ||
				run.stderrText ||
				`child pi exited with code ${run.exitCode}`,
			details,
		);
	}

	const details = progress.emit("succeeded", run.exitCode, true);
	if (run.stdoutText.length === 0 && run.stdoutLineExceededLimit) {
		return errorResult(OVERSIZED_CHILD_JSON_EVENT_ERROR, details);
	}

	const output = await truncateToolTextOutput(
		run.stdoutText,
		"pi-run-subagent-",
	);
	return {
		content: [{ type: "text", text: output.content }],
		details:
			output.details === undefined
				? details
				: {
						...details,
						...output.details,
					},
	};
}

/** Reads and validates run-subagent configuration from the isolated pi agent directory. */
async function readRunSubagentConfig(): Promise<RunSubagentConfig> {
	let raw: string;
	try {
		raw = await readFile(join(getAgentDir(), CONFIG_PATH), "utf8");
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return {
				enabled: true,
				maxDepth: DEFAULT_MAX_DEPTH,
				widgetLineBudget: DEFAULT_WIDGET_LINE_BUDGET,
			};
		}

		return invalidConfig(`failed to read config: ${formatError(error)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return invalidConfig(`failed to parse config: ${formatError(error)}`);
	}

	return parseRunSubagentConfig(parsed);
}

/** Parses strict config and moves the tool to fail-closed state on invalid input. */
function parseRunSubagentConfig(value: unknown): RunSubagentConfig {
	if (!isRecord(value)) {
		return invalidConfig("config must be an object");
	}
	if (
		!hasOnlyKeys(value, [ENABLED_CONFIG_KEY, "maxDepth", "widgetLineBudget"])
	) {
		return invalidConfig("config contains unsupported keys");
	}

	const { enabled, maxDepth, widgetLineBudget } = value;
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return invalidConfig(`${ENABLED_CONFIG_KEY} must be a boolean`);
	}
	if (enabled === false) {
		return {
			enabled: false,
			maxDepth: 0,
			widgetLineBudget: DEFAULT_WIDGET_LINE_BUDGET,
		};
	}
	if (
		maxDepth !== undefined &&
		(typeof maxDepth !== "number" ||
			!Number.isInteger(maxDepth) ||
			maxDepth < 0)
	) {
		return invalidConfig(
			"maxDepth must be an integer greater than or equal to 0",
		);
	}
	if (
		widgetLineBudget !== undefined &&
		(typeof widgetLineBudget !== "number" ||
			!Number.isInteger(widgetLineBudget) ||
			widgetLineBudget < 1)
	) {
		return invalidConfig(
			"widgetLineBudget must be an integer greater than or equal to 1",
		);
	}

	return {
		enabled: true,
		maxDepth: maxDepth ?? DEFAULT_MAX_DEPTH,
		widgetLineBudget: widgetLineBudget ?? DEFAULT_WIDGET_LINE_BUDGET,
	};
}

/** Builds fail-closed config while preserving the default widget size. */
function invalidConfig(issue: string): RunSubagentConfig {
	return {
		enabled: true,
		maxDepth: 0,
		widgetLineBudget: DEFAULT_WIDGET_LINE_BUDGET,
		issue,
	};
}

/** Loads agents callable by run_subagent. */
async function loadCallableAgents(): Promise<AgentDefinition[]> {
	const agents = await loadAgentDefinitions();
	return agents.filter(
		(agent) => agent.type === "subagent" || agent.type === "both",
	);
}

/** Resolves the child model from the callable agent or current parent model. */
function resolveChildModelId(
	agent: AgentDefinition,
	currentModel: Model<Api> | undefined,
): string | undefined {
	if (agent.model?.id !== undefined) {
		return agent.model.id;
	}
	if (currentModel === undefined) {
		return undefined;
	}

	return `${currentModel.provider}/${currentModel.id}`;
}

/** Builds runtime metadata shown in subagent progress UI. */
function resolveSubagentRuntimeDetails(
	modelId: string,
	thinking: string,
	ctx: RunSubagentContext,
): { modelId: string; thinking: string; contextWindow: number } {
	const [provider, ...modelParts] = modelId.split("/");
	const modelName = modelParts.join("/");
	const configuredModel =
		provider !== undefined && modelName.length > 0
			? ctx.modelRegistry.find(provider, modelName)
			: undefined;
	return {
		modelId,
		thinking,
		contextWindow:
			configuredModel?.contextWindow ?? ctx.model?.contextWindow ?? 0,
	};
}

/** Builds compact progress text while details drive width-aware TUI rendering. */
function formatSubagentProgressContent(details: SubagentRunDetails): string {
	const lastEvent = details.events.at(-1);
	const lastEventText = lastEvent
		? ` Last event: ${lastEvent.title}${lastEvent.text ? ` — ${lastEvent.text}` : ""}.`
		: "";
	const runtimeText = details.runtime
		? ` with ${details.runtime.modelId} thinking=${details.runtime.thinking}`
		: "";
	return `Subagent "${details.agentId}" ${details.status}${runtimeText} for ${formatElapsedMs(details.elapsedMs)}.${lastEventText}`;
}

/** Formats elapsed milliseconds into compact progress text. */
function formatElapsedMs(elapsedMs: number): string {
	if (elapsedMs < SECOND_MS) {
		return `${elapsedMs}ms`;
	}

	return `${(elapsedMs / SECOND_MS).toFixed(ELAPSED_SECONDS_FRACTION_DIGITS)}s`;
}

/** Resolves child tool flags and environment from the callable agent tool policy. */
function resolveChildToolPolicy(
	pi: ExtensionAPI,
	agent: AgentDefinition,
): ChildToolPolicy | { readonly issue: string } {
	if (agent.tools === undefined) {
		return { args: [], env: {} };
	}
	if (agent.tools.length === 0) {
		return { args: ["--no-tools"], env: { [SUBAGENT_TOOLS_ENV]: "" } };
	}

	const availableToolNames = pi.getAllTools().map((tool) => tool.name);
	const resolved = resolveToolPolicy(agent.tools, availableToolNames);
	if ("issue" in resolved) {
		return resolved;
	}

	const toolsValue = resolved.tools.join(",");
	return {
		args: ["--tools", toolsValue],
		env: { [SUBAGENT_TOOLS_ENV]: toolsValue },
	};
}

/** Builds the child pi command-line arguments. */
function buildChildArgs(options: {
	readonly modelId: string;
	readonly thinking: string;
	readonly toolPolicy: ChildToolPolicy;
}): string[] {
	return [
		"--mode",
		"rpc",
		"--no-session",
		"--model",
		options.modelId,
		"--thinking",
		options.thinking,
		...options.toolPolicy.args,
	];
}

/** Runs the child pi process and extracts final assistant text from RPC session events. */
async function runChildPi(
	spawnPi: NonNullable<RunSubagentDependencies["spawnPi"]>,
	options: {
		readonly args: string[];
		readonly cwd: string;
		readonly env: Record<string, string>;
		readonly signal: AbortSignal | undefined;
		readonly prompt: string;
		readonly onSessionEvent: (event: unknown) => void;
	},
): Promise<ChildRunResult> {
	return new Promise((resolve) => {
		const child = spawnPi("pi", options.args, {
			cwd: options.cwd,
			env: options.env,
			signal: undefined,
		});
		const rpcState = createChildRpcState();
		const closeStdin = () => closeChildStdin(child, rpcState);
		const writeRpcCommand = (command: Record<string, unknown>) =>
			writeChildRpcCommand(child, rpcState, command, closeStdin);
		const abort = () => abortChildRpcRun(child, rpcState, writeRpcCommand);
		const handleRpcMessage = (message: unknown) =>
			handleChildRpcMessage({
				message,
				rpcState,
				onSessionEvent: options.onSessionEvent,
				writeRpcCommand,
				closeStdin,
			});
		const finish = (code: number | null) =>
			finishChildRpcRun({
				code,
				rpcState,
				signal: options.signal,
				abort,
				handleRpcMessage,
				resolve,
			});

		attachChildRpcProcessHandlers(child, rpcState, handleRpcMessage, finish);
		startChildRpcPrompt(options.signal, options.prompt, abort, writeRpcCommand);
	});
}

interface ChildRpcState {
	readonly streamState: ChildStreamState;
	readonly stdoutDecoder: StringDecoder;
	readonly stderrDecoder: StringDecoder;
	stdoutProcessing: Promise<void>;
	stdoutProcessingPending: boolean;
	agentCompleted: boolean;
	aborted: boolean;
	fatalError: string | undefined;
	stdinClosed: boolean;
	stdinFailed: boolean;
	resolved: boolean;
	abortFallbackTimer: ReturnType<typeof setTimeout> | undefined;
	abortKillTimer: ReturnType<typeof setTimeout> | undefined;
}

/** Creates mutable state for one child RPC process. */
function createChildRpcState(): ChildRpcState {
	return {
		streamState: {
			stdoutBuffer: "",
			stdoutProjection: undefined,
			stdoutBufferTruncated: false,
			stdoutLineExceededLimit: false,
			stderrText: "",
			stderrTextTruncated: false,
			streamedText: "",
			streamedTextBytes: 0,
			streamedTextExceededLimit: false,
			finalText: "",
		},
		stdoutDecoder: new StringDecoder("utf8"),
		stderrDecoder: new StringDecoder("utf8"),
		stdoutProcessing: Promise.resolve(),
		stdoutProcessingPending: false,
		agentCompleted: false,
		aborted: false,
		fatalError: undefined,
		stdinClosed: false,
		stdinFailed: false,
		resolved: false,
		abortFallbackTimer: undefined,
		abortKillTimer: undefined,
	};
}

/** Closes RPC stdin once so the child can shut down after completion or failure. */
function closeChildStdin(child: SpawnedProcess, state: ChildRpcState): void {
	if (state.stdinClosed) {
		return;
	}
	state.stdinClosed = true;
	if (state.stdinFailed) {
		return;
	}
	try {
		child.stdin.end();
	} catch (error) {
		state.stdinFailed = true;
		state.fatalError ??= `failed to close child stdin: ${formatError(error)}`;
	}
}

/** Writes one JSONL RPC command to child stdin and fails closed on pipe errors. */
function writeChildRpcCommand(
	child: SpawnedProcess,
	state: ChildRpcState,
	command: Record<string, unknown>,
	closeStdin: () => void,
): void {
	if (state.stdinClosed || state.stdinFailed) {
		return;
	}
	try {
		child.stdin.write(`${JSON.stringify(command)}\n`);
	} catch (error) {
		state.stdinFailed = true;
		state.fatalError ??= `failed to write child RPC command: ${formatError(error)}`;
		closeStdin();
	}
}

/** Sends an RPC abort command and starts the force-termination fallback timer. */
function abortChildRpcRun(
	child: SpawnedProcess,
	state: ChildRpcState,
	writeRpcCommand: (command: Record<string, unknown>) => void,
): void {
	if (state.agentCompleted || state.resolved) {
		return;
	}
	if (state.fatalError !== undefined) {
		scheduleChildTerminationFallback(child, state);
		return;
	}
	if (state.aborted) {
		return;
	}
	state.aborted = true;
	writeRpcCommand({ id: ABORT_COMMAND_ID, type: "abort" });
	scheduleChildTerminationFallback(child, state);
}

/** Schedules idempotent child termination fallback for aborted or failed runs. */
function scheduleChildTerminationFallback(
	child: SpawnedProcess,
	state: ChildRpcState,
): void {
	if (state.abortFallbackTimer !== undefined) {
		return;
	}
	state.abortFallbackTimer = setTimeout(() => {
		child.kill("SIGTERM");
		state.abortKillTimer = setTimeout(() => {
			child.kill("SIGKILL");
		}, CHILD_ABORT_KILL_TIMEOUT_MS);
	}, CHILD_ABORT_FALLBACK_TIMEOUT_MS);
}

/** Sends the single subagent prompt unless the parent was already aborted. */
function startChildRpcPrompt(
	signal: AbortSignal | undefined,
	prompt: string,
	abort: () => void,
	writeRpcCommand: (command: Record<string, unknown>) => void,
): void {
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) {
		abort();
		return;
	}
	writeRpcCommand({ id: PROMPT_COMMAND_ID, type: "prompt", message: prompt });
}

/** Attaches stdout, stderr, close, and error handlers for one child RPC process. */
function attachChildRpcProcessHandlers(
	child: SpawnedProcess,
	state: ChildRpcState,
	handleRpcMessage: (message: unknown) => void,
	finish: (code: number | null) => void,
): void {
	child.stdin.on("error", (error) => {
		state.stdinFailed = true;
		state.stdinClosed = true;
		state.fatalError ??= `child stdin error: ${error.message}`;
	});
	child.stdout.on("data", (data) => {
		const processData = () =>
			handleChildStdoutData(
				state.streamState,
				state.stdoutDecoder.write(toBuffer(data)),
				handleRpcMessage,
			);
		const handleLineError = (lineError: string | undefined) => {
			if (lineError !== undefined) {
				state.fatalError ??= lineError;
				closeChildStdin(child, state);
			}
		};
		if (!state.stdoutProcessingPending) {
			const lineError = processData();
			if (!isPromiseLike(lineError)) {
				handleLineError(lineError);
				return;
			}
			state.stdoutProcessingPending = true;
			const processing = lineError.then(handleLineError);
			const trackedProcessing = processing.finally(() => {
				if (state.stdoutProcessing === trackedProcessing) {
					state.stdoutProcessingPending = false;
				}
			});
			state.stdoutProcessing = trackedProcessing;
			return;
		}

		const processing = state.stdoutProcessing.then(async () => {
			const lineError = await processData();
			handleLineError(lineError);
		});
		const trackedProcessing = processing.finally(() => {
			if (state.stdoutProcessing === trackedProcessing) {
				state.stdoutProcessingPending = false;
			}
		});
		state.stdoutProcessing = trackedProcessing;
	});
	child.stderr.on("data", (data) => {
		handleChildStderrData(
			state.streamState,
			state.stderrDecoder.write(toBuffer(data)),
		);
	});
	child.on("close", finish);
	child.on("error", (error) => {
		state.fatalError ??= error.message;
		finish(1);
	});
}

/** Finalizes one child RPC run after the process exits or emits an error. */
function finishChildRpcRun(options: {
	readonly code: number | null;
	readonly rpcState: ChildRpcState;
	readonly signal: AbortSignal | undefined;
	readonly abort: () => void;
	readonly handleRpcMessage: (message: unknown) => void;
	readonly resolve: (result: ChildRunResult) => void;
}): void {
	const { rpcState } = options;
	if (rpcState.resolved) {
		return;
	}
	rpcState.resolved = true;
	const stdoutProcessing = rpcState.stdoutProcessing;
	rpcState.stdoutProcessing = finishChildRpcRunAfterStdout(
		options,
		stdoutProcessing,
	);
}

/** Completes child RPC finalization after queued stdout parsing has finished. */
async function finishChildRpcRunAfterStdout(
	options: {
		readonly code: number | null;
		readonly rpcState: ChildRpcState;
		readonly signal: AbortSignal | undefined;
		readonly abort: () => void;
		readonly handleRpcMessage: (message: unknown) => void;
		readonly resolve: (result: ChildRunResult) => void;
	},
	stdoutProcessing: Promise<void>,
): Promise<void> {
	const { rpcState } = options;
	clearAbortFallbackTimer(rpcState);
	options.signal?.removeEventListener("abort", options.abort);
	try {
		await stdoutProcessing;
		handleChildStderrData(rpcState.streamState, rpcState.stderrDecoder.end());
		rpcState.fatalError ??= await flushRemainingChildStdout(
			rpcState,
			options.handleRpcMessage,
		);
	} catch (error) {
		rpcState.fatalError ??= formatError(error);
	}
	options.resolve(buildChildRunResult(options.code ?? 0, rpcState));
}

/** Clears the abort fallback timer when a child process exits. */
function clearAbortFallbackTimer(state: ChildRpcState): void {
	if (state.abortFallbackTimer !== undefined) {
		clearTimeout(state.abortFallbackTimer);
	}
	if (state.abortKillTimer !== undefined) {
		clearTimeout(state.abortKillTimer);
	}
}

/** Processes the final unterminated RPC stdout line after child process exit. */
async function flushRemainingChildStdout(
	state: ChildRpcState,
	handleRpcMessage: (message: unknown) => void,
): Promise<string | undefined> {
	const remainingText = state.stdoutDecoder.end();
	if (remainingText.length > 0) {
		const appendError = appendChildStdoutLineSegment(
			state.streamState,
			remainingText,
		);
		if (appendError !== undefined) {
			return appendError;
		}
	}
	return processChildStdoutLine(state.streamState, handleRpcMessage);
}

/** Builds the child process result while preserving exact optional property semantics. */
function buildChildRunResult(
	exitCode: number,
	state: ChildRpcState,
): ChildRunResult {
	const status = resolveChildRunStatus({
		exitCode,
		aborted: state.aborted,
		agentCompleted: state.agentCompleted,
		fatalError: state.fatalError,
		hasFinalAnswer: state.streamState.finalText.length > 0,
	});
	const result = {
		exitCode,
		status,
		stdoutText: state.streamState.finalText,
		stderrText: formatBoundedChildText(
			state.streamState.stderrText,
			state.streamState.stderrTextTruncated,
			"child stderr",
		),
		stdoutLineExceededLimit: state.streamState.stdoutLineExceededLimit,
		streamedTextExceededLimit: state.streamState.streamedTextExceededLimit,
	};
	const errorMessage = resolveChildRunErrorMessage(exitCode, status, state);
	return errorMessage === undefined ? result : { ...result, errorMessage };
}

/** Resolves the user-facing child run error message for failed or aborted runs. */
function resolveChildRunErrorMessage(
	exitCode: number,
	status: ChildRunStatus,
	state: ChildRpcState,
): string | undefined {
	if (state.fatalError !== undefined) {
		return state.fatalError;
	}
	if (status === "aborted") {
		return ABORTED_CHILD_RPC_RUN_ERROR;
	}
	if (status !== "failed" || exitCode !== 0) {
		return undefined;
	}
	return state.agentCompleted
		? MISSING_CHILD_FINAL_ANSWER_ERROR
		: INCOMPLETE_CHILD_RPC_RUN_ERROR;
}

/** Classifies one RPC stdout message and updates progress or protocol state. */
function handleChildRpcMessage(options: {
	readonly message: unknown;
	readonly rpcState: ChildRpcState;
	readonly onSessionEvent: (event: unknown) => void;
	readonly writeRpcCommand: (command: Record<string, unknown>) => void;
	readonly closeStdin: () => void;
}): void {
	const { message, rpcState } = options;
	if (!isRecord(message)) {
		return;
	}
	if (message["type"] === "response") {
		handleChildRpcResponse(message, rpcState, options.closeStdin);
		return;
	}
	if (message["type"] === "extension_ui_request") {
		options.onSessionEvent(message);
		handleExtensionUiRequest(message, options.writeRpcCommand);
		return;
	}
	handleChildRpcSessionEvent(message, options);
}

/** Handles RPC command responses without exposing them as progress events. */
function handleChildRpcResponse(
	message: Record<string, unknown>,
	state: ChildRpcState,
	closeStdin: () => void,
): void {
	if (message["command"] !== "prompt" || message["success"] !== false) {
		return;
	}
	state.fatalError =
		typeof message["error"] === "string"
			? message["error"]
			: "child pi rejected the prompt";
	closeStdin();
}

/** Routes one RPC session event to progress and final-output extraction. */
function handleChildRpcSessionEvent(
	message: Record<string, unknown>,
	options: {
		readonly rpcState: ChildRpcState;
		readonly onSessionEvent: (event: unknown) => void;
		readonly closeStdin: () => void;
	},
): void {
	if (options.rpcState.agentCompleted) {
		return;
	}
	resetChildAssistantDeltaOnStart(options.rpcState.streamState, message);
	recordChildAssistantDelta(options.rpcState.streamState, message);
	const assistantText = recordChildAssistantText(
		options.rpcState.streamState,
		message,
	);
	options.onSessionEvent(projectChildProgressEvent(message, assistantText));
	if (message["type"] === "agent_end") {
		options.rpcState.agentCompleted = true;
		options.closeStdin();
	}
}

/** Appends streamed assistant deltas from RPC session events. */
function recordChildAssistantDelta(
	state: ChildStreamState,
	message: unknown,
): void {
	if (isProjectedTextDeltaExceeded(message)) {
		state.streamedText = "";
		state.streamedTextExceededLimit = true;
		return;
	}
	const delta = extractAssistantTextDelta(message);
	if (delta !== undefined) {
		appendStreamedTextDelta(state, delta);
	}
}

/** Stores the latest completed assistant text observed before completion. */
function recordChildAssistantText(
	state: ChildStreamState,
	message: unknown,
): string | undefined {
	const text = extractAssistantText(state, message);
	if (text !== undefined) {
		state.finalText = text;
	}
	if (isAssistantMessageEnd(message)) {
		state.streamedText = "";
		state.streamedTextBytes = 0;
	}
	return text;
}

/** Provides progress with fallback text when bounded parsing skipped the full message content. */
function projectChildProgressEvent(
	message: Record<string, unknown>,
	assistantText: string | undefined,
): Record<string, unknown> {
	if (assistantText === undefined || message["type"] !== "message_end") {
		return message;
	}
	const childMessage = message["message"];
	if (!isRecord(childMessage) || !Array.isArray(childMessage["content"])) {
		return message;
	}
	if (!childMessage["content"].some(isSkippedTextPart)) {
		return message;
	}
	return {
		...message,
		message: {
			...childMessage,
			content: [{ type: "text", text: assistantText }],
		},
	};
}

/** Starts a new provisional streamed-text buffer for each assistant message. */
function resetChildAssistantDeltaOnStart(
	state: ChildStreamState,
	message: unknown,
): void {
	if (!isAssistantMessageStart(message)) {
		return;
	}
	state.streamedText = "";
	state.streamedTextBytes = 0;
}

/** Converts child process chunks into bytes for UTF-8 safe decoding. */
function toBuffer(data: unknown): Buffer {
	if (Buffer.isBuffer(data)) {
		return data;
	}
	if (data instanceof Uint8Array) {
		return Buffer.from(data);
	}
	return Buffer.from(String(data));
}

/** Processes one stdout chunk from the child RPC stream. */
function handleChildStdoutData(
	state: ChildStreamState,
	data: unknown,
	onRpcMessage: (message: unknown) => void,
): string | Promise<string | undefined> | undefined {
	return processChildStdoutSegments(
		state,
		String(data).split("\n"),
		0,
		onRpcMessage,
	);
}

/** Processes stdout line segments and switches to async only for oversized JSON projection finalization. */
function processChildStdoutSegments(
	state: ChildStreamState,
	segments: readonly string[],
	startIndex: number,
	onRpcMessage: (message: unknown) => void,
): string | Promise<string | undefined> | undefined {
	for (let index = startIndex; index < segments.length; index += 1) {
		const appendError = appendChildStdoutLineSegment(
			state,
			segments[index] ?? "",
		);
		if (appendError !== undefined) {
			return appendError;
		}
		if (index === segments.length - 1) {
			break;
		}
		const lineError = processChildStdoutLine(state, onRpcMessage);
		resetChildStdoutLine(state);
		if (isPromiseLike(lineError)) {
			return lineError.then(
				(error) =>
					error ??
					processChildStdoutSegments(state, segments, index + 1, onRpcMessage),
			);
		}
		if (lineError !== undefined) {
			return lineError;
		}
	}
	return undefined;
}

/** Appends one stdout segment while preserving a bounded suffix and streaming oversized lines through JSON projection. */
function appendChildStdoutLineSegment(
	state: ChildStreamState,
	segment: string,
): string | undefined {
	if (!state.stdoutBufferTruncated) {
		const nextLine = state.stdoutBuffer + segment;
		if (nextLine.length <= CHILD_STDOUT_LINE_BUFFER_LIMIT) {
			state.stdoutBuffer = nextLine;
			return undefined;
		}

		state.stdoutBufferTruncated = true;
		state.stdoutLineExceededLimit = true;
		state.stdoutProjection = createChildRpcLineProjection();
		state.stdoutBuffer = nextLine.slice(-CHILD_STDOUT_LINE_BUFFER_LIMIT);
		return writeChildRpcLineProjectionSegment(state.stdoutProjection, nextLine);
	}

	state.stdoutBuffer = (state.stdoutBuffer + segment).slice(
		-CHILD_STDOUT_LINE_BUFFER_LIMIT,
	);
	if (state.stdoutProjection === undefined) {
		return MALFORMED_CHILD_RPC_OUTPUT_ERROR;
	}
	return writeChildRpcLineProjectionSegment(state.stdoutProjection, segment);
}

/** Resets per-line stdout buffers after one JSONL record has been processed. */
function resetChildStdoutLine(state: ChildStreamState): void {
	state.stdoutBuffer = "";
	state.stdoutProjection = undefined;
	state.stdoutBufferTruncated = false;
}

/** Processes one stderr chunk from the child process diagnostics stream. */
function handleChildStderrData(state: ChildStreamState, data: unknown): void {
	const boundedStderr = appendBoundedText(
		state.stderrText,
		String(data),
		CHILD_STDERR_TEXT_LIMIT,
	);
	state.stderrText = boundedStderr.text;
	state.stderrTextTruncated =
		state.stderrTextTruncated || boundedStderr.truncated;
}

/** Parses one child stdout JSONL record and routes the decoded RPC message. */
function processChildStdoutLine(
	state: ChildStreamState,
	onRpcMessage: (message: unknown) => void,
): string | Promise<string | undefined> | undefined {
	const line = state.stdoutBuffer.endsWith("\r")
		? state.stdoutBuffer.slice(0, -1)
		: state.stdoutBuffer;
	if (line.trim().length === 0 && !state.stdoutBufferTruncated) {
		return undefined;
	}

	if (state.stdoutBufferTruncated) {
		return projectOversizedChildRpcLine(state.stdoutProjection).then(
			(event) => {
				if (event === undefined) {
					return MALFORMED_CHILD_RPC_OUTPUT_ERROR;
				}
				onRpcMessage(event);
				return undefined;
			},
		);
	}

	const event = parseJsonLine(line);
	if (event === undefined) {
		return MALFORMED_CHILD_RPC_OUTPUT_ERROR;
	}
	onRpcMessage(event);
	return undefined;
}

/** Resolves final child run status from RPC and process lifecycle state. */
function resolveChildRunStatus(options: {
	readonly exitCode: number;
	readonly aborted: boolean;
	readonly agentCompleted: boolean;
	readonly fatalError: string | undefined;
	readonly hasFinalAnswer: boolean;
}): ChildRunStatus {
	if (options.aborted) {
		return "aborted";
	}
	if (
		options.fatalError !== undefined ||
		options.exitCode !== 0 ||
		!options.hasFinalAnswer
	) {
		return "failed";
	}
	return options.agentCompleted ? "succeeded" : "failed";
}

/** Answers blocking RPC UI requests so child extensions cannot hang the subagent run. */
function handleExtensionUiRequest(
	message: Record<string, unknown>,
	writeRpcCommand: (command: Record<string, unknown>) => void,
): void {
	const id = message["id"];
	const method = message["method"];
	if (typeof id !== "string") {
		return;
	}
	if (method === "confirm") {
		writeRpcCommand({ type: "extension_ui_response", id, confirmed: false });
		return;
	}
	if (method === "select" || method === "input" || method === "editor") {
		writeRpcCommand({ type: "extension_ui_response", id, cancelled: true });
	}
}

/** Appends one assistant text delta while enforcing the streamed-answer memory limit. */
function appendStreamedTextDelta(state: ChildStreamState, delta: string): void {
	if (state.streamedTextExceededLimit) {
		return;
	}

	const nextBytes = state.streamedTextBytes + Buffer.byteLength(delta, "utf8");
	if (nextBytes > CHILD_STREAMED_TEXT_BYTES_LIMIT) {
		state.streamedText = "";
		state.streamedTextExceededLimit = true;
		return;
	}

	state.streamedText += delta;
	state.streamedTextBytes = nextBytes;
}

/** Appends a text chunk while preserving only the latest text inside the configured limit. */
function appendBoundedText(
	currentText: string,
	chunkText: string,
	limit: number,
): { readonly text: string; readonly truncated: boolean } {
	const combinedText = currentText + chunkText;
	if (combinedText.length <= limit) {
		return { text: combinedText, truncated: false };
	}

	return { text: combinedText.slice(-limit), truncated: true };
}

/** Adds a visible truncation marker when child-process text exceeded its streaming limit. */
function formatBoundedChildText(
	text: string,
	truncated: boolean,
	label: string,
): string {
	if (!truncated) {
		return text;
	}

	return `[${label} truncated to last ${text.length} characters]\n${text}`;
}

/** Creates streaming projection state for one oversized child RPC JSONL record. */
function createChildRpcLineProjection(): ChildRpcLineProjection {
	const state: ChildRpcLineProjectionState = {
		stack: [],
		currentString: undefined,
		eventType: undefined,
		role: undefined,
		stopReason: undefined,
		assistantMessageEventType: undefined,
		assistantMessageEventDelta: undefined,
		assistantMessageEventDeltaBytes: 0,
		assistantMessageEventDeltaExceededLimit: false,
		hasSkippedText: false,
		hasToolCall: false,
	};
	const stream = streamJsonParser.parser.asStream({
		packKeys: false,
		streamKeys: true,
		packStrings: false,
		streamStrings: true,
		packNumbers: false,
		streamNumbers: false,
	});
	let resolveDone: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		resolveDone = resolve;
	});
	const projection: ChildRpcLineProjection = {
		stream,
		state,
		done,
		error: undefined,
	};
	stream.on("data", (token) => recordChildRpcProjectionToken(state, token));
	stream.on("error", (error) => {
		projection.error = error.message;
		resolveDone();
	});
	stream.on("end", resolveDone);
	return projection;
}

/** Streams one segment into the oversized RPC projection parser. */
function writeChildRpcLineProjectionSegment(
	projection: ChildRpcLineProjection,
	segment: string,
): string | undefined {
	try {
		projection.stream.write(segment);
		return undefined;
	} catch (error) {
		return formatError(error);
	}
}

/** Finalizes an oversized RPC JSONL projection without materializing unneeded payloads. */
async function projectOversizedChildRpcLine(
	projection: ChildRpcLineProjection | undefined,
): Promise<unknown | undefined> {
	if (projection === undefined) {
		return undefined;
	}
	projection.stream.end();
	await projection.done;
	if (projection.error !== undefined) {
		return undefined;
	}
	return buildProjectedChildRpcEvent(projection.state);
}

/** Records one streaming JSON token into the bounded RPC event projection. */
function recordChildRpcProjectionToken(
	state: ChildRpcLineProjectionState,
	token: StreamJsonToken,
): void {
	switch (token.name) {
		case "startObject":
			pushJsonProjectionContainer(state, "object");
			return;
		case "endObject":
			popJsonProjectionContainer(state, "object");
			return;
		case "startArray":
			pushJsonProjectionContainer(state, "array");
			return;
		case "endArray":
			popJsonProjectionContainer(state, "array");
			return;
		case "startKey":
			state.currentString = createJsonProjectionString("key", []);
			return;
		case "endKey":
			finishJsonProjectionKey(state);
			return;
		case "startString":
			startJsonProjectionStringValue(state);
			return;
		case "endString":
			finishJsonProjectionStringValue(state);
			return;
		case "stringChunk":
			recordJsonProjectionStringChunk(state, token.value);
			return;
		case "numberValue":
		case "trueValue":
		case "falseValue":
		case "nullValue":
			consumeJsonProjectionValuePath(state);
			return;
		default:
			return;
	}
}

/** Pushes a JSON container and records whether it is a message content part. */
function pushJsonProjectionContainer(
	state: ChildRpcLineProjectionState,
	kind: "object" | "array",
): void {
	const path = consumeJsonProjectionValuePath(state);
	state.stack.push({
		kind,
		path,
		pendingKey: undefined,
		contentPart:
			kind === "object" && isJsonProjectionPath(path, "message", "content", "*")
				? { type: undefined, hasText: false }
				: undefined,
	});
}

/** Pops a JSON container and records completed message content metadata. */
function popJsonProjectionContainer(
	state: ChildRpcLineProjectionState,
	kind: "object" | "array",
): void {
	const container = state.stack.pop();
	if (container?.kind !== kind) {
		return;
	}
	const { contentPart } = container;
	if (contentPart === undefined) {
		return;
	}
	if (contentPart.type === "text" && contentPart.hasText) {
		state.hasSkippedText = true;
	}
	if (contentPart.type === "toolCall") {
		state.hasToolCall = true;
	}
}

/** Starts collecting a string value only when its path can affect control flow. */
function startJsonProjectionStringValue(
	state: ChildRpcLineProjectionState,
): void {
	const path = consumeJsonProjectionValuePath(state);
	const contentPart = getCurrentJsonProjectionContentPart(state);
	if (
		contentPart !== undefined &&
		isJsonProjectionPath(path, "message", "content", "*", "text")
	) {
		contentPart.hasText = true;
	}
	state.currentString = createJsonProjectionString("value", path);
}

/** Creates bounded string collection state for a key or scalar value. */
function createJsonProjectionString(
	kind: "key" | "value",
	path: readonly string[],
): JsonProjectionString {
	return { kind, path, text: "", truncated: false };
}

/** Records one string chunk without collecting large final-answer text payloads. */
function recordJsonProjectionStringChunk(
	state: ChildRpcLineProjectionState,
	value: unknown,
): void {
	if (typeof value !== "string" || state.currentString === undefined) {
		return;
	}
	if (state.currentString.kind === "value") {
		if (
			isJsonProjectionPath(
				state.currentString.path,
				"message",
				"content",
				"*",
				"text",
			)
		) {
			return;
		}
		if (
			isJsonProjectionPath(
				state.currentString.path,
				"assistantMessageEvent",
				"delta",
			)
		) {
			appendProjectedAssistantDelta(state, value);
			return;
		}
	}
	appendJsonProjectionStringChunk(state.currentString, value);
}

/** Appends projected text_delta chunks with the same memory limit as normal streamed text. */
function appendProjectedAssistantDelta(
	state: ChildRpcLineProjectionState,
	chunk: string,
): void {
	if (state.assistantMessageEventDeltaExceededLimit) {
		return;
	}
	const nextBytes =
		state.assistantMessageEventDeltaBytes + Buffer.byteLength(chunk, "utf8");
	if (nextBytes > CHILD_STREAMED_TEXT_BYTES_LIMIT) {
		state.assistantMessageEventDelta = undefined;
		state.assistantMessageEventDeltaBytes = 0;
		state.assistantMessageEventDeltaExceededLimit = true;
		return;
	}
	state.assistantMessageEventDelta =
		(state.assistantMessageEventDelta ?? "") + chunk;
	state.assistantMessageEventDeltaBytes = nextBytes;
}

/** Appends bounded key or scalar text and marks overlarge values as unusable. */
function appendJsonProjectionStringChunk(
	state: JsonProjectionString,
	chunk: string,
): void {
	if (state.truncated) {
		return;
	}
	const limit =
		state.kind === "key"
			? CHILD_RPC_PROJECTED_KEY_TEXT_LIMIT
			: CHILD_RPC_PROJECTED_SCALAR_TEXT_LIMIT;
	const nextText = state.text + chunk;
	if (nextText.length > limit) {
		state.text = "";
		state.truncated = true;
		return;
	}
	state.text = nextText;
}

/** Stores a completed object key on the current object container. */
function finishJsonProjectionKey(state: ChildRpcLineProjectionState): void {
	const currentString = state.currentString;
	state.currentString = undefined;
	const container = state.stack.at(-1);
	if (
		currentString?.kind !== "key" ||
		currentString.truncated ||
		container?.kind !== "object"
	) {
		return;
	}
	container.pendingKey = currentString.text;
}

/** Stores a completed scalar value when it is part of the RPC control projection. */
function finishJsonProjectionStringValue(
	state: ChildRpcLineProjectionState,
): void {
	const currentString = state.currentString;
	state.currentString = undefined;
	if (currentString?.kind !== "value" || currentString.truncated) {
		return;
	}
	recordJsonProjectionStringValue(
		state,
		currentString.path,
		currentString.text,
	);
}

/** Applies one completed string value to the projected RPC event metadata. */
function recordJsonProjectionStringValue(
	state: ChildRpcLineProjectionState,
	path: readonly string[],
	value: string,
): void {
	if (isJsonProjectionPath(path, "type")) {
		state.eventType = value;
		return;
	}
	if (isJsonProjectionPath(path, "message", "role")) {
		state.role = value;
		return;
	}
	if (isJsonProjectionPath(path, "message", "stopReason")) {
		state.stopReason = value;
		return;
	}
	if (isJsonProjectionPath(path, "assistantMessageEvent", "type")) {
		state.assistantMessageEventType = value;
		return;
	}
	if (isJsonProjectionPath(path, "message", "content", "*", "type")) {
		const contentPart = getCurrentJsonProjectionContentPart(state);
		if (contentPart !== undefined) {
			contentPart.type = value;
		}
	}
}

/** Resolves the current value path and clears consumed object keys. */
function consumeJsonProjectionValuePath(
	state: ChildRpcLineProjectionState,
): readonly string[] {
	const parent = state.stack.at(-1);
	if (parent === undefined) {
		return [];
	}
	if (parent.kind === "array") {
		return [...parent.path, "*"];
	}
	const key = parent.pendingKey;
	parent.pendingKey = undefined;
	return key === undefined ? parent.path : [...parent.path, key];
}

/** Returns metadata for the innermost message content part currently being parsed. */
function getCurrentJsonProjectionContentPart(
	state: ChildRpcLineProjectionState,
): JsonProjectionContentPart | undefined {
	for (let index = state.stack.length - 1; index >= 0; index -= 1) {
		const contentPart = state.stack[index]?.contentPart;
		if (contentPart !== undefined) {
			return contentPart;
		}
	}
	return undefined;
}

/** Builds the projected RPC event shape consumed by existing run-subagent logic. */
function buildProjectedChildRpcEvent(
	state: ChildRpcLineProjectionState,
): unknown | undefined {
	switch (state.eventType) {
		case "agent_end":
			return { type: "agent_end", messages: [] };
		case "message_start":
			return buildProjectedMessageStartEvent(state);
		case "message_update":
			return buildProjectedMessageUpdateEvent(state);
		case "message_end":
			return buildProjectedMessageEndEvent(state);
		default:
			return undefined;
	}
}

/** Builds a minimal message_start event that preserves assistant-turn reset behavior. */
function buildProjectedMessageStartEvent(
	state: ChildRpcLineProjectionState,
): Record<string, unknown> {
	return {
		type: "message_start",
		...(state.role === undefined ? {} : { message: { role: state.role } }),
	};
}

/** Builds a minimal message_update event that preserves usable streamed text deltas. */
function buildProjectedMessageUpdateEvent(
	state: ChildRpcLineProjectionState,
): Record<string, unknown> {
	if (state.assistantMessageEventType !== "text_delta") {
		return { type: "message_update" };
	}
	return {
		type: "message_update",
		assistantMessageEvent: {
			type: "text_delta",
			delta: state.assistantMessageEventDelta ?? "",
			...(state.assistantMessageEventDeltaExceededLimit
				? { deltaExceededLimit: true }
				: {}),
		},
	};
}

/** Builds a minimal message_end event that preserves final-answer validation metadata. */
function buildProjectedMessageEndEvent(
	state: ChildRpcLineProjectionState,
): Record<string, unknown> {
	const content = [
		...(state.role === "assistant" && state.hasSkippedText
			? [{ type: SKIPPED_TEXT_PART_TYPE }]
			: []),
		...(state.hasToolCall ? [{ type: "toolCall" }] : []),
	];
	return {
		type: "message_end",
		message: {
			...(state.role === undefined ? {} : { role: state.role }),
			content,
			...(state.stopReason === undefined
				? {}
				: { stopReason: state.stopReason }),
		},
	};
}

/** Compares a JSON projection path with a finite path pattern. */
function isJsonProjectionPath(
	path: readonly string[],
	...expectedPath: readonly string[]
): boolean {
	return (
		path.length === expectedPath.length &&
		path.every((part, index) => part === expectedPath[index])
	);
}

/** Parses one RPC JSONL output record. */
function parseJsonLine(line: string): unknown | undefined {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

/** Returns true when a projected text_delta exceeded the streamed-answer memory limit. */
function isProjectedTextDeltaExceeded(event: unknown): boolean {
	if (!isRecord(event) || event["type"] !== "message_update") {
		return false;
	}
	const { assistantMessageEvent } = event;
	return (
		isRecord(assistantMessageEvent) &&
		assistantMessageEvent["type"] === "text_delta" &&
		assistantMessageEvent["deltaExceededLimit"] === true
	);
}

/** Extracts one streamed assistant text delta from a child message_update event. */
function extractAssistantTextDelta(event: unknown): string | undefined {
	if (!isRecord(event)) {
		return undefined;
	}
	const { type, assistantMessageEvent } = event;
	if (type !== "message_update" || !isRecord(assistantMessageEvent)) {
		return undefined;
	}
	if (assistantMessageEvent["type"] !== "text_delta") {
		return undefined;
	}
	const delta = assistantMessageEvent["delta"];
	return typeof delta === "string" ? delta : undefined;
}

/** Extracts assistant text from a child message_end event. */
function extractAssistantText(
	state: ChildStreamState,
	event: unknown,
): string | undefined {
	if (!isRecord(event)) {
		return undefined;
	}
	const { type, message } = event;
	if (type !== "message_end" || !isRecord(message)) {
		return undefined;
	}
	const { role, content } = message;
	if (role !== "assistant") {
		return undefined;
	}
	if (
		message["stopReason"] === "error" ||
		message["stopReason"] === "aborted"
	) {
		return undefined;
	}
	if (!Array.isArray(content) || content.some(isToolCallPart)) {
		return undefined;
	}

	const textParts = content
		.filter(isTextPart)
		.map((part) => part.text)
		.join("\n");
	if (textParts.length > 0) {
		return textParts;
	}
	if (content.some(isSkippedTextPart) && state.streamedText.length > 0) {
		return state.streamedText;
	}
	return undefined;
}

/** Creates a standard error result for failed tool execution. */
function errorResult(
	message: string,
	details?: SubagentRunDetails,
): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: message }], details };
}

/** Reports an issue scoped only to run-subagent. */
function reportIssue(ctx: RunSubagentContext, issue: string): void {
	if (ctx.hasUI === false) {
		return;
	}

	ctx.ui.notify(`${ISSUE_PREFIX} ${issue}`, "warning");
}

/** Reads the current subagent nesting depth from the process environment. */
function readCurrentDepth(): DepthResult {
	const raw = readSubagentDepth();
	if (raw === undefined) {
		return { value: 0 };
	}

	if (!DEPTH_PATTERN.test(raw)) {
		return {
			issue: "PI_SUBAGENT_DEPTH must be a canonical non-negative integer",
		};
	}

	const depth = Number(raw);
	if (!Number.isSafeInteger(depth)) {
		return { issue: "PI_SUBAGENT_DEPTH must be a safe integer" };
	}

	return { value: depth };
}

/** Spawns the real child pi process with sanitized parent environment plus explicit subagent env. */
function defaultSpawnPi(
	command: string,
	args: string[],
	options: SpawnOptions,
): SpawnedProcess {
	return spawn(command, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
		signal: options.signal,
	}) as SpawnedProcess;
}

/** Returns true when an object contains only keys from a finite set. */
function hasOnlyKeys(
	value: Record<string, unknown>,
	allowedKeys: readonly string[],
): boolean {
	return Object.keys(value).every((key) => allowedKeys.includes(key));
}

/** Returns true when a runtime value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns true when a value follows the Promise contract enough to await it safely. */
function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
	return isRecord(value) && typeof value["then"] === "function";
}

/** Returns true when a child event starts a new assistant message stream. */
function isAssistantMessageStart(event: unknown): boolean {
	if (!isRecord(event) || event["type"] !== "message_start") {
		return false;
	}
	const { message } = event;
	return isRecord(message) && message["role"] === "assistant";
}

/** Returns true when a child event completes the current assistant message stream. */
function isAssistantMessageEnd(event: unknown): boolean {
	if (!isRecord(event) || event["type"] !== "message_end") {
		return false;
	}
	const { message } = event;
	return isRecord(message) && message["role"] === "assistant";
}

/** Returns true when a runtime value is a text content part. */
function isTextPart(value: unknown): value is { readonly text: string } {
	if (!isRecord(value)) {
		return false;
	}

	const { type, text } = value;
	return type === "text" && typeof text === "string";
}

/** Returns true when a projected content part marks text skipped by bounded parsing. */
function isSkippedTextPart(value: unknown): boolean {
	return isRecord(value) && value["type"] === SKIPPED_TEXT_PART_TYPE;
}

/** Returns true when a runtime value is a tool-call content part. */
function isToolCallPart(value: unknown): boolean {
	return isRecord(value) && value["type"] === "toolCall";
}

/** Converts unknown failures into safe diagnostics. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Returns true when a filesystem error represents a missing config file. */
function isFileNotFoundError(error: unknown): boolean {
	if (!isRecord(error)) {
		return false;
	}

	const { code } = error;
	return code === "ENOENT";
}
