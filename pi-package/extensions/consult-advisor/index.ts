import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Context,
	completeSimple as defaultCompleteSimple,
	type Message,
	type Model,
	type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { getAgentRuntimeComposition } from "../../shared/agent-runtime-composition";
import {
	collectLoadedSkillRoots,
	replayContextProjection,
} from "../../shared/context-projection";
import { estimateSerializedInputTokens } from "../../shared/context-size";
import { truncateToolTextOutput } from "../../shared/tool-output-truncation";
import {
	renderConsultAdvisorCall,
	renderConsultAdvisorResult,
} from "./rendering";

const TOOL_NAME = "consult_advisor";
const ISSUE_PREFIX = "[consult-advisor]";
const CONFIG_PATH = join("config", "consult-advisor.json");
const ENABLED_CONFIG_KEY = "enabled";
const ADVISOR_VISIBLE_RESPONSE_INSTRUCTION =
	"Return the advice as visible text. If you cannot answer a request, explain the limit in visible text.";
const ADVISOR_CONTEXT_TOO_LARGE_ERROR = "context is too large";

/** Extension-local prompt used when config does not provide a custom advisor prompt file. */
const DEFAULT_ADVISOR_PROMPT_FILE = join(
	dirname(fileURLToPath(import.meta.url)),
	"prompts",
	"advisor.md",
);

const THINKING_VALUES = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

const ConsultAdvisorParameters = Type.Object({
	question: Type.String({ description: "Question to ask the advisor" }),
});

type Thinking = (typeof THINKING_VALUES)[number];

interface ConsultAdvisorDependencies {
	readonly completeSimple?: (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
}

interface ConsultAdvisorParams {
	readonly question: string;
}

interface ConsultAdvisorConfig {
	readonly model?: { readonly id?: string; readonly thinking?: Thinking };
	readonly promptFile: string;
	readonly debugPayloadFile?: string;
}

interface AdvisorRuntime {
	readonly model: Model<Api>;
	readonly apiKey?: string;
	readonly headers?: Record<string, string>;
}

interface AdvisorContextBuildOptions {
	readonly ctx: AdvisorContext;
	readonly advisorPrompt: string;
	readonly question: string;
	readonly toolCallId: string;
	readonly loadedSkillRoots: readonly string[];
}

interface AdvisorContext extends ExtensionContext {
	readonly model: Model<Api> | undefined;
}

interface ExecuteConsultAdvisorOptions {
	readonly completeSimple: NonNullable<
		ConsultAdvisorDependencies["completeSimple"]
	>;
	readonly toolCallId: string;
	readonly params: ConsultAdvisorParams;
	readonly signal: AbortSignal | undefined;
	readonly ctx: AdvisorContext;
	readonly currentThinkingLevel: unknown;
	readonly loadedSkillRoots: readonly string[];
}

/** Extension entry point for advisor consultation behavior. */
export default function consultAdvisor(
	pi: ExtensionAPI,
	dependencies: ConsultAdvisorDependencies = {
		completeSimple: defaultCompleteSimple,
	},
): void {
	if (isConsultAdvisorDisabled()) {
		return;
	}

	const completeSimple = dependencies.completeSimple ?? defaultCompleteSimple;
	let loadedSkillRoots: readonly string[] = [];

	pi.on("before_agent_start", (event) => {
		loadedSkillRoots = collectLoadedSkillRoots(event);
	});

	getAgentRuntimeComposition(pi).setConsultAdvisorContribution({
		requiredToolName: TOOL_NAME,
		prompt:
			"Use consult_advisor for independent advice when the user or task requires a second opinion.",
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Consult advisor",
		description: "Ask an independent advisor model a focused question.",
		parameters: ConsultAdvisorParameters,
		renderCall: renderConsultAdvisorCall,
		renderResult: renderConsultAdvisorResult,
		async execute(...[toolCallId, params, signal, _onUpdate, ctx]) {
			return executeConsultAdvisor({
				completeSimple,
				toolCallId,
				params: params as ConsultAdvisorParams,
				signal,
				ctx: ctx as AdvisorContext,
				currentThinkingLevel: pi.getThinkingLevel(),
				loadedSkillRoots,
			});
		},
	});
}

/** Executes one advisor model call after strict config, prompt, and model validation. */
async function executeConsultAdvisor({
	completeSimple,
	toolCallId,
	params,
	signal,
	ctx,
	currentThinkingLevel,
	loadedSkillRoots,
}: ExecuteConsultAdvisorOptions): Promise<AgentToolResult<unknown>> {
	const configResult = await readAdvisorConfig();
	if ("disabled" in configResult) {
		return errorResult("consult-advisor is disabled.");
	}
	if ("issue" in configResult) {
		reportIssue(ctx, configResult.issue);
		return errorResult(configResult.issue);
	}

	const promptResult = await readAdvisorPrompt(configResult.config.promptFile);
	if ("issue" in promptResult) {
		reportIssue(ctx, promptResult.issue);
		return errorResult(promptResult.issue);
	}

	const runtimeResult = await resolveAdvisorRuntime(
		ctx,
		configResult.config.model?.id,
	);
	if ("issue" in runtimeResult) {
		reportIssue(ctx, runtimeResult.issue);
		return errorResult(runtimeResult.issue);
	}

	const context = await buildAdvisorContext({
		ctx,
		advisorPrompt: promptResult.prompt,
		question: params.question,
		toolCallId,
		loadedSkillRoots,
	});
	if (!doesAdvisorInputFitContextWindow(context, runtimeResult.runtime.model)) {
		return errorResult(ADVISOR_CONTEXT_TOO_LARGE_ERROR);
	}

	const options = buildAdvisorOptions(
		configResult.config.model?.thinking ?? parseThinking(currentThinkingLevel),
		signal,
		runtimeResult.runtime,
	);
	if (configResult.config.debugPayloadFile !== undefined) {
		await writeDebugPayload(configResult.config.debugPayloadFile, {
			context,
			options,
		});
	}

	const answer = await completeSimple(
		runtimeResult.runtime.model,
		context,
		options,
	);
	const responseText = getAdvisorResponseText(answer);
	if (responseText.length === 0) {
		return errorResult("Advisor returned an empty response.");
	}

	const output = await truncateToolTextOutput(
		responseText,
		"pi-consult-advisor-",
	);
	return {
		content: [{ type: "text", text: output.content }],
		details: output.details,
	};
}

/** Returns true only for a present valid config that explicitly disables consult-advisor. */
function isConsultAdvisorDisabled(): boolean {
	try {
		const config: unknown = JSON.parse(
			readFileSync(join(getAgentDir(), CONFIG_PATH), "utf8"),
		);
		return isRecord(config) && config[ENABLED_CONFIG_KEY] === false;
	} catch {
		return false;
	}
}

/** Reads and validates advisor config from the isolated pi agent directory. */
async function readAdvisorConfig(): Promise<
	| { readonly disabled: true }
	| { readonly config: ConsultAdvisorConfig }
	| { readonly issue: string }
> {
	const configFile = join(getAgentDir(), CONFIG_PATH);
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(configFile, "utf8"));
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return { config: buildAdvisorConfig({}, dirname(configFile)) };
		}

		return { issue: `failed to read config: ${formatError(error)}` };
	}

	const config = parseAdvisorConfig(parsed, dirname(configFile));
	if ("issue" in config || "disabled" in config) {
		return config;
	}

	return { config };
}

/** Parses strict advisor config and resolves config-relative paths. */
function parseAdvisorConfig(
	value: unknown,
	configDir: string,
):
	| ConsultAdvisorConfig
	| { readonly disabled: true }
	| { readonly issue: string } {
	const validationResult = validateAdvisorConfig(value);
	if ("issue" in validationResult) {
		return validationResult;
	}
	if (validationResult.config[ENABLED_CONFIG_KEY] === false) {
		return { disabled: true };
	}

	return buildAdvisorConfig(validationResult.config, configDir);
}

/** Validates raw advisor config before config-relative path resolution. */
function validateAdvisorConfig(
	value: unknown,
): { readonly config: Record<string, unknown> } | { readonly issue: string } {
	if (!isRecord(value)) {
		return { issue: "config must be an object" };
	}
	if (
		!hasOnlyKeys(value, [
			ENABLED_CONFIG_KEY,
			"model",
			"promptFile",
			"debugPayloadFile",
		])
	) {
		return { issue: "config contains unsupported keys" };
	}

	const enabled = value[ENABLED_CONFIG_KEY];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return { issue: `${ENABLED_CONFIG_KEY} must be a boolean` };
	}
	if (enabled !== false) {
		const modelResult = validateAdvisorModelConfig(value["model"]);
		if ("issue" in modelResult) {
			return modelResult;
		}
	}

	const pathIssue = validateOptionalPathConfig(value);
	return pathIssue === undefined ? { config: value } : { issue: pathIssue };
}

/** Validates the required advisor model config object. */
function validateAdvisorModelConfig(
	model: unknown,
): { readonly model: Record<string, unknown> } | { readonly issue: string } {
	if (model === undefined) {
		return { model: {} };
	}
	if (!isRecord(model)) {
		return { issue: "model must be an object" };
	}
	if (!hasOnlyKeys(model, ["id", "thinking"])) {
		return { issue: "model contains unsupported keys" };
	}

	const { id, thinking } = model;
	if (id !== undefined && (typeof id !== "string" || id.length === 0)) {
		return { issue: "model.id must be a non-empty string" };
	}
	if (typeof id === "string" && !hasProviderModelShape(id)) {
		return { issue: "model.id must use provider/model" };
	}
	if (thinking !== undefined && !isThinking(thinking)) {
		return {
			issue: `model.thinking must be one of ${THINKING_VALUES.join(", ")}`,
		};
	}

	return { model };
}

/** Validates optional advisor path config fields. */
function validateOptionalPathConfig(
	config: Record<string, unknown>,
): string | undefined {
	const { promptFile, debugPayloadFile } = config;
	if (
		promptFile !== undefined &&
		(typeof promptFile !== "string" || promptFile.length === 0)
	) {
		return "promptFile must be a non-empty string";
	}
	if (
		debugPayloadFile !== undefined &&
		(typeof debugPayloadFile !== "string" || debugPayloadFile.length === 0)
	) {
		return "debugPayloadFile must be a non-empty string";
	}

	return undefined;
}

/** Builds typed advisor config after raw validation succeeds. */
function buildAdvisorConfig(
	config: Record<string, unknown>,
	configDir: string,
): ConsultAdvisorConfig {
	const rawModel = config["model"];
	const model = isRecord(rawModel)
		? {
				...(typeof rawModel["id"] === "string" ? { id: rawModel["id"] } : {}),
				...(isThinking(rawModel["thinking"])
					? { thinking: rawModel["thinking"] }
					: {}),
			}
		: undefined;
	const { promptFile, debugPayloadFile } = config;
	return {
		...(model !== undefined ? { model } : {}),
		promptFile:
			typeof promptFile === "string"
				? resolveConfigPath(configDir, promptFile)
				: DEFAULT_ADVISOR_PROMPT_FILE,
		...(typeof debugPayloadFile === "string"
			? { debugPayloadFile: resolveConfigPath(configDir, debugPayloadFile) }
			: {}),
	};
}

/** Resolves absolute paths and config-relative paths without adding home expansion. */
function resolveConfigPath(configDir: string, path: string): string {
	return isAbsolute(path) ? path : join(configDir, path);
}

/** Reads the advisor system prompt and rejects empty files. */
async function readAdvisorPrompt(
	promptFile: string,
): Promise<{ readonly prompt: string } | { readonly issue: string }> {
	try {
		const prompt = await readFile(promptFile, "utf8");
		if (prompt.trim().length === 0) {
			return { issue: "advisor prompt must not be empty" };
		}
		return { prompt: prompt.trim() };
	} catch (error) {
		return { issue: `failed to read advisor prompt: ${formatError(error)}` };
	}
}

/** Builds advisor context from current branch while replaying recorded context projection state. */
async function buildAdvisorContext({
	ctx,
	advisorPrompt,
	question,
	toolCallId,
	loadedSkillRoots,
}: AdvisorContextBuildOptions): Promise<Context> {
	const projectedMessages = await replayContextProjection({
		branchEntries: ctx.sessionManager.getBranch(),
		cwd: ctx.cwd,
		loadedSkillRoots,
	});
	const messages = removePendingAdvisorCall(
		convertToLlm(projectedMessages),
		toolCallId,
	);
	messages.push({ role: "user", content: question, timestamp: Date.now() });
	return {
		systemPrompt: formatAdvisorSystemPrompt(advisorPrompt),
		messages,
		tools: [],
	};
}

/** Returns true when the estimated advisor input fits the resolved advisor model window. */
function doesAdvisorInputFitContextWindow(
	context: Context,
	model: Model<Api>,
): boolean {
	return estimateAdvisorInputTokens(context, model) <= model.contextWindow;
}

/** Estimates advisor input with tokenizer-based counting before provider execution. */
function estimateAdvisorInputTokens(
	context: Context,
	model: Model<Api>,
): number {
	return estimateSerializedInputTokens(context, model.id, model.provider);
}

/** Removes consult_advisor tool calls and matching tool results from the advisor transcript. */
function removePendingAdvisorCall(
	messages: Message[],
	toolCallId: string,
): Message[] {
	const result: Message[] = [];
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolCallId === toolCallId) {
			continue;
		}
		if (message.role !== "assistant") {
			result.push(message);
			continue;
		}

		const content = message.content.filter(
			(part) => part.type !== "toolCall" || part.id !== toolCallId,
		);
		if (content.length > 0) {
			result.push({ ...message, content });
		}
	}

	return result;
}

/** Returns true when model ID contains provider and model parts separated by the first slash. */
function hasProviderModelShape(modelId: string): boolean {
	const separatorIndex = modelId.indexOf("/");
	return separatorIndex > 0 && separatorIndex < modelId.length - 1;
}

/** Resolves the advisor model and request auth through the pi model registry. */
async function resolveAdvisorRuntime(
	ctx: AdvisorContext,
	modelId: string | undefined,
): Promise<{ readonly runtime: AdvisorRuntime } | { readonly issue: string }> {
	const model =
		modelId === undefined
			? ctx.model
			: resolveConfiguredAdvisorModel(ctx, modelId);
	if (model === undefined) {
		return {
			issue:
				modelId === undefined
					? "current model is unavailable"
					: `model ${modelId} was not found`,
		};
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { issue: `advisor model auth unavailable: ${auth.error}` };
	}

	return {
		runtime: {
			model,
			...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
			...(auth.headers !== undefined ? { headers: auth.headers } : {}),
		},
	};
}

/** Resolves a configured advisor model ID through the model registry. */
function resolveConfiguredAdvisorModel(
	ctx: AdvisorContext,
	modelId: string,
): Model<Api> | undefined {
	const separatorIndex = modelId.indexOf("/");
	if (separatorIndex <= 0 || separatorIndex === modelId.length - 1) {
		return undefined;
	}

	return ctx.modelRegistry.find(
		modelId.slice(0, separatorIndex),
		modelId.slice(separatorIndex + 1),
	);
}

/** Builds completion options while treating `off` as no reasoning option. */
function buildAdvisorOptions(
	thinking: Thinking | undefined,
	signal: AbortSignal | undefined,
	runtime: AdvisorRuntime,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = {};
	if (signal !== undefined) {
		options.signal = signal;
	}
	if (runtime.apiKey !== undefined) {
		options.apiKey = runtime.apiKey;
	}
	if (runtime.headers !== undefined) {
		options.headers = runtime.headers;
	}
	if (thinking !== undefined && thinking !== "off") {
		options.reasoning = thinking;
	}
	return options;
}

/** Writes the advisor debug payload after creating the target directory. */
async function writeDebugPayload(
	path: string,
	payload: unknown,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(payload, null, 2));
}

/** Adds a visible-answer rule to avoid provider-specific reasoning-only responses. */
function formatAdvisorSystemPrompt(advisorPrompt: string): string {
	return `${advisorPrompt}\n\n${ADVISOR_VISIBLE_RESPONSE_INSTRUCTION}`.trim();
}

/** Extracts visible text content from the advisor answer. */
function getAdvisorResponseText(message: AssistantMessage): string {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/** Creates a standard tool result for advisor execution failures. */
function errorResult(message: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: message }], details: undefined };
}

/** Reports an issue scoped only to consult-advisor. */
function reportIssue(ctx: AdvisorContext, issue: string): void {
	if (ctx.hasUI === false) {
		return;
	}

	ctx.ui.notify(`${ISSUE_PREFIX} ${issue}`, "warning");
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

/** Returns true when a runtime value is an accepted thinking value. */
function isThinking(value: unknown): value is Thinking {
	return (
		typeof value === "string" &&
		(THINKING_VALUES as readonly string[]).includes(value)
	);
}

/** Parses an unknown active thinking level into an advisor reasoning value. */
function parseThinking(value: unknown): Thinking | undefined {
	return isThinking(value) ? value : undefined;
}

/** Returns true when a filesystem error represents a missing config file. */
function isFileNotFoundError(error: unknown): boolean {
	return isRecord(error) && error["code"] === "ENOENT";
}

/** Converts unknown failures into safe diagnostics. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
