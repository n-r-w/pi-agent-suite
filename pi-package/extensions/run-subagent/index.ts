import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
import { truncateToolTextOutput } from "../../shared/tool-output-truncation";
import { resolveToolPolicy } from "../../shared/tool-policy";
import {
	createChildEnvironment,
	readSubagentAgentId,
	readSubagentDepth,
	SUBAGENT_AGENT_ID_ENV,
	SUBAGENT_DEPTH_ENV,
	SUBAGENT_TOOLS_ENV,
} from "./environment";
import {
	appendSubagentStderr,
	createSubagentProgressState,
	finalizeSubagentProgressState,
	recordSubagentJsonEvent,
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

const TOOL_NAME = "run_subagent";
const ISSUE_PREFIX = "[run-subagent]";
const CONFIG_PATH = join("config", "run-subagent.json");
const ENABLED_CONFIG_KEY = "enabled";
const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_WIDGET_LINE_BUDGET = 7;
const WIDGET_UPDATE_THROTTLE_MS = 120;
const SECOND_MS = 1000;
const ELAPSED_SECONDS_FRACTION_DIGITS = 1;
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
	readonly stdout: {
		on(event: "data", handler: (data: unknown) => void): void;
	};
	readonly stderr: {
		on(event: "data", handler: (data: unknown) => void): void;
	};
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

interface ChildRunResult {
	readonly exitCode: number;
	readonly stdoutText: string;
	readonly stderrText: string;
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
	if (
		!(options.ctx.hasUI ?? true) ||
		(!forceWidgetUpdate &&
			lastWidgetUpdateAt !== 0 &&
			now - lastWidgetUpdateAt < WIDGET_UPDATE_THROTTLE_MS)
	) {
		return lastWidgetUpdateAt;
	}

	recordSubagentWidgetRun(options.subagentWidgetState, details, now);
	options.ctx.ui.setWidget(
		SUBAGENT_WIDGET_KEY,
		createSubagentWidgetFactory(
			options.subagentWidgetState,
			plan.config.widgetLineBudget,
		),
	);
	return now;
}

/** Runs the child process and records JSON-mode progress events. */
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
			prompt: options.params.prompt,
		}),
		cwd: options.ctx.cwd,
		env: createChildEnvironment({
			[SUBAGENT_AGENT_ID_ENV]: plan.agent.id,
			[SUBAGENT_DEPTH_ENV]: String(plan.depth + 1),
			...plan.childTools.env,
		}),
		signal: options.signal,
		onJsonEvent(event) {
			if (recordSubagentJsonEvent(progress.state, event, Date.now())) {
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
	if (run.exitCode !== 0) {
		const details = progress.emit("failed", run.exitCode, true);
		return errorResult(
			run.stderrText || `child pi exited with code ${run.exitCode}`,
			details,
		);
	}

	const details = progress.emit("succeeded", run.exitCode, true);
	const output = await truncateToolTextOutput(
		run.stdoutText || "Subagent completed.",
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
	readonly prompt: string;
}): string[] {
	return [
		"--mode",
		"json",
		"--no-session",
		"--model",
		options.modelId,
		"--thinking",
		options.thinking,
		...options.toolPolicy.args,
		options.prompt,
	];
}

/** Runs the child pi process and extracts final assistant text from JSON-mode events. */
async function runChildPi(
	spawnPi: NonNullable<RunSubagentDependencies["spawnPi"]>,
	options: {
		readonly args: string[];
		readonly cwd: string;
		readonly env: Record<string, string>;
		readonly signal: AbortSignal | undefined;
		readonly onJsonEvent: (event: unknown) => void;
	},
): Promise<ChildRunResult> {
	return new Promise((resolve) => {
		const child = spawnPi("pi", options.args, {
			cwd: options.cwd,
			env: options.env,
			signal: options.signal,
		});
		let stdoutBuffer = "";
		let stderrText = "";
		let finalText = "";

		const processLine = (line: string): void => {
			if (line.trim().length === 0) {
				return;
			}

			const event = parseJsonLine(line);
			if (event === undefined) {
				return;
			}

			options.onJsonEvent(event);
			const text = extractAssistantText(event);
			if (text !== undefined) {
				finalText = text;
			}
		};

		child.stdout.on("data", (data) => {
			stdoutBuffer += String(data);
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				processLine(line);
			}
		});
		child.stderr.on("data", (data) => {
			stderrText += String(data);
		});
		child.on("close", (code) => {
			processLine(stdoutBuffer);
			resolve({ exitCode: code ?? 0, stdoutText: finalText, stderrText });
		});
		child.on("error", (error) => {
			resolve({
				exitCode: 1,
				stdoutText: finalText,
				stderrText: error.message,
			});
		});
	});
}

/** Parses one JSON-mode output line without failing the whole tool on unrelated output. */
function parseJsonLine(line: string): unknown | undefined {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

/** Extracts assistant text from a pi JSON-mode message_end event. */
function extractAssistantText(event: unknown): string | undefined {
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
	if (!Array.isArray(content)) {
		return undefined;
	}

	const textParts = content
		.filter(isTextPart)
		.map((part) => part.text)
		.join("\n");
	return textParts.length > 0 ? textParts : undefined;
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
		stdio: ["ignore", "pipe", "pipe"],
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

/** Returns true when a runtime value is a text content part. */
function isTextPart(value: unknown): value is { readonly text: string } {
	if (!isRecord(value)) {
		return false;
	}

	const { type, text } = value;
	return type === "text" && typeof text === "string";
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
