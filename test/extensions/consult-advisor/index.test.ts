import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	createEventBus,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type SessionEntry,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Text, visibleWidth } from "@earendil-works/pi-tui";
import consultAdvisor from "../../../pi-package/extensions/consult-advisor/index";
import { COLLAPSED_ADVICE_PREVIEW_LINES } from "../../../pi-package/extensions/consult-advisor/rendering";
import contextProjection from "../../../pi-package/extensions/context-projection/index";
import mainAgentSelection from "../../../pi-package/extensions/main-agent-selection/index";
import { AVAILABLE_SUBAGENTS_PROMPT_OPENING_TAG } from "../../../pi-package/extensions/run-subagent/contracts";
import subagents from "../../../pi-package/extensions/run-subagent/index";
import { HELPER_API_COST_CUSTOM_TYPE } from "../../../pi-package/shared/helper-api-cost";
import { registerKnowledgeContextRuntime } from "../../../pi-package/shared/knowledge-runtime";
import {
	SUBAGENT_AGENT_ID_ENV,
	SUBAGENT_DEPTH_ENV,
	SUBAGENT_TOOL_PATTERNS_ENV,
} from "../../../pi-package/shared/subagent-environment";
import { getPackageToolPresentation } from "../../../pi-package/shared/tool-presentation/registry";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";
/** Matches Pi-compatible UUIDv7 provider session identifiers. */
const AUXILIARY_SESSION_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUBAGENT_ENV_KEYS = [
	SUBAGENT_DEPTH_ENV,
	SUBAGENT_AGENT_ID_ENV,
	SUBAGENT_TOOL_PATTERNS_ENV,
] as const;

/** SGR reset sequence that would break parent panel styling when embedded in truncated text. */
const SGR_RESET = `${String.fromCharCode(27)}[0m`;

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: unknown;
}

interface RegisteredCommandFake {
	readonly name: string;
	readonly handler: (args: string, ctx: unknown) => Promise<void>;
}

interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
	readonly tools: ToolDefinition[];
	readonly commands: RegisteredCommandFake[];
	readonly activeToolCalls: string[][];
	readonly appendEntryCalls: Array<{ customType: string; data: unknown }>;
}

interface CompletionCall {
	readonly model: Model<Api>;
	readonly context: Context;
	readonly options: SimpleStreamOptions | undefined;
}

interface CompletionResponseOutcome {
	readonly kind: "response";
	readonly content: AssistantMessage["content"];
	readonly stopReason?: AssistantMessage["stopReason"];
	readonly errorMessage?: string;
	readonly cost?: number;
}

interface CompletionThrowOutcome {
	readonly kind: "throw";
	readonly error: Error;
}

type CompletionOutcome = CompletionResponseOutcome | CompletionThrowOutcome;

interface ContextFake {
	readonly cwd: string;
	readonly hasUI?: boolean;
	readonly model: Model<Api> | undefined;
	readonly modelRegistry: {
		find(provider: string, modelId: string): Model<Api> | undefined;
		getApiKeyAndHeaders(model: Model<Api>): Promise<
			| {
					readonly ok: true;
					readonly apiKey?: string;
					readonly headers?: Record<string, string>;
			  }
			| { readonly ok: false; readonly error: string }
		>;
	};
	readonly sessionManager: {
		getSessionId(): string;
		getSessionFile(): string;
		getEntries(): unknown[];
		getBranch(): SessionEntry[];
		getLeafId(): string | null;
	};
	readonly ui: {
		readonly theme: { fg(color: string, value: string): string };
		notify(message: string, type?: string): void;
		setStatus(key: string, text: string | undefined): void;
		select(title: string, options: string[]): Promise<string | undefined>;
	};
	getContextUsage():
		| { tokens: number | null; contextWindow: number }
		| undefined;
}

/** Runs a test with isolated pi agent and subagent environment state. */
async function withIsolatedAgentDir<T>(
	action: (agentDir: string) => Promise<T>,
): Promise<T> {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const previousAgentSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
	const previousSubagentEnv = new Map(
		SUBAGENT_ENV_KEYS.map((key) => [key, process.env[key]]),
	);
	const agentDir = await mkdtemp(join(tmpdir(), "pi-consult-advisor-"));
	process.env[AGENT_DIR_ENV] = agentDir;
	delete process.env[AGENT_SUITE_DIR_ENV];
	for (const key of SUBAGENT_ENV_KEYS) {
		delete process.env[key];
	}
	try {
		return await action(agentDir);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env[AGENT_DIR_ENV];
		} else {
			process.env[AGENT_DIR_ENV] = previousAgentDir;
		}
		if (previousAgentSuiteDir === undefined) {
			delete process.env[AGENT_SUITE_DIR_ENV];
		} else {
			process.env[AGENT_SUITE_DIR_ENV] = previousAgentSuiteDir;
		}
		for (const key of SUBAGENT_ENV_KEYS) {
			const previousValue = previousSubagentEnv.get(key);
			if (previousValue === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = previousValue;
			}
		}
		await rm(agentDir, { recursive: true, force: true });
	}
}

/** Creates the ExtensionAPI fake shared by consult-advisor and cross-extension composition tests. */
function createExtensionApiFake(
	allToolNames: readonly string[] = [],
): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];
	const tools: ToolDefinition[] = [];
	const commands: RegisteredCommandFake[] = [];
	const activeToolCalls: string[][] = [];
	const appendEntryCalls: Array<{ customType: string; data: unknown }> = [];
	let activeTools: string[] = [];

	return {
		handlers,
		tools,
		commands,
		activeToolCalls,
		appendEntryCalls,
		events: createEventBus(),
		on(eventName: string, handler: unknown): void {
			handlers.push({ eventName, handler });
		},
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
		registerMessageRenderer(): void {},
		registerCommand(
			name: string,
			options: { handler: RegisteredCommandFake["handler"] },
		): void {
			commands.push({ name, handler: options.handler });
		},
		registerShortcut(): void {},
		appendEntry(customType: string, data: unknown): void {
			appendEntryCalls.push({ customType, data });
		},
		getAllTools() {
			return allToolNames.map((name) => ({
				name,
				description: name,
				parameters: {},
				sourceInfo: { path: "fake" },
			}));
		},
		getActiveTools(): string[] {
			return [...activeTools];
		},
		setActiveTools(toolNames: string[]): void {
			activeTools = [...toolNames];
			activeToolCalls.push(toolNames);
		},
		getCommands(): never[] {
			return [];
		},
		getThinkingLevel(): string {
			return "medium";
		},
		setThinkingLevel(): void {},
		async setModel(): Promise<boolean> {
			return true;
		},
		setLabel(): void {},
		modelRegistry: undefined,
	} as unknown as ExtensionApiFake;
}

/** Creates a fake extension context with model registry, session entries, and observable notifications. */
function createContext(
	models: readonly Model<Api>[],
	entries: unknown[] = [],
	authResult:
		| {
				readonly ok: true;
				readonly apiKey?: string;
				readonly headers?: Record<string, string>;
		  }
		| { readonly ok: false; readonly error: string } = {
		ok: true,
		apiKey: "advisor-api-key",
		headers: { "x-advisor": "enabled" },
	},
	hasUI?: boolean,
): ContextFake & {
	readonly notifications: Array<{
		readonly message: string;
		readonly type: string | undefined;
	}>;
} {
	const notifications: Array<{
		readonly message: string;
		readonly type: string | undefined;
	}> = [];
	return {
		cwd: "/tmp/project",
		notifications,
		model: models[0],
		...(hasUI !== undefined ? { hasUI } : {}),
		modelRegistry: {
			find(provider: string, modelId: string): Model<Api> | undefined {
				return models.find(
					(model) => model.provider === provider && model.id === modelId,
				);
			},
			async getApiKeyAndHeaders(): Promise<typeof authResult> {
				return authResult;
			},
		},
		sessionManager: {
			getSessionId(): string {
				return "consult-advisor-test-session";
			},
			getSessionFile(): string {
				return "/tmp/consult-advisor-test-session.jsonl";
			},
			getEntries(): unknown[] {
				return entries;
			},
			getBranch(): SessionEntry[] {
				return entries as SessionEntry[];
			},
			getLeafId(): string | null {
				const lastEntry = entries.at(-1);
				if (!isRecord(lastEntry)) {
					return null;
				}
				const { id } = lastEntry;
				return typeof id === "string" ? id : null;
			},
		},
		ui: {
			theme: {
				fg(color: string, value: string): string {
					return `<${color}>${value}</${color}>`;
				},
			},
			notify(message: string, type?: string): void {
				notifications.push({ message, type });
			},
			setStatus(): void {},
			async select(): Promise<string | undefined> {
				return undefined;
			},
		},
		getContextUsage(): { tokens: number; contextWindow: number } {
			return { tokens: 950, contextWindow: 1_000 };
		},
	};
}

/** Creates a model fixture for model-registry resolution. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows before_agent_start handler output to a prompt result. */
function isPromptResult(
	value: unknown,
): value is { readonly systemPrompt: string } {
	return (
		isRecord(value) &&
		"systemPrompt" in value &&
		typeof value["systemPrompt"] === "string"
	);
}

function createModel(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		api: "fake-api",
		baseUrl: "https://example.test",
		reasoning: true,
		name: `${provider}/${id}`,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_192,
	};
}

/** Writes consult-advisor config under the isolated pi agent directory. */
async function writeConfig(agentDir: string, config: unknown): Promise<void> {
	await mkdir(join(agentDir, "config"), { recursive: true });
	await writeFile(
		join(agentDir, "config", "consult-advisor.json"),
		JSON.stringify(config),
	);
}

/** Writes context-projection config under the isolated pi agent directory. */
async function writeProjectionConfig(
	agentDir: string,
	config: unknown,
): Promise<void> {
	await mkdir(join(agentDir, "config"), { recursive: true });
	await writeFile(
		join(agentDir, "config", "context-projection.json"),
		JSON.stringify(config),
	);
}

/** Writes one agent definition for cross-extension composition tests. */
async function writeAgent(
	agentDir: string,
	id: string,
	type: "main" | "subagent",
	body: string,
	tools?: readonly string[],
): Promise<void> {
	await mkdir(join(agentDir, "agents"), { recursive: true });
	const lines = [
		"---",
		`description: ${JSON.stringify(id)}`,
		`type: ${JSON.stringify(type)}`,
	];
	if (tools !== undefined) {
		lines.push("tools:", ...tools.map((tool) => `  - ${JSON.stringify(tool)}`));
	}
	lines.push("---", body);
	await writeFile(join(agentDir, "agents", `${id}.md`), lines.join("\n"));
}

/** Returns the registered consult_advisor tool. */
function getConsultTool(pi: ExtensionApiFake): ToolDefinition {
	const tool = pi.tools.find(
		(candidate) => candidate.name === "consult_advisor",
	);
	if (tool === undefined) {
		throw new Error("expected consult_advisor tool");
	}
	return tool;
}

/** Emits before-agent-start handlers in registration order and returns the latest non-empty result. */
/** Initializes every registered extension before prompt composition. */
async function emitSessionStartHandlers(
	pi: ExtensionApiFake,
	ctx: unknown,
): Promise<void> {
	const handlers = pi.handlers
		.filter((item) => item.eventName === "session_start")
		.map((item) => item.handler)
		.filter(
			(handler): handler is (event: unknown, ctx: unknown) => unknown =>
				typeof handler === "function",
		);
	if (handlers.length === 0) {
		throw new Error("expected session_start handler");
	}
	for (const handler of handlers) {
		await handler({ type: "session_start", reason: "startup" }, ctx);
	}
}

async function emitBeforeAgentStartHandlers(
	pi: ExtensionApiFake,
	event: unknown,
	ctx: unknown,
): Promise<unknown> {
	const handlers = pi.handlers
		.filter((item) => item.eventName === "before_agent_start")
		.map((item) => item.handler)
		.filter(
			(handler): handler is (event: unknown, ctx: unknown) => unknown =>
				typeof handler === "function",
		);
	if (handlers.length === 0) {
		throw new Error("expected before_agent_start handler");
	}

	let result: unknown;
	for (const handler of handlers) {
		const nextResult = await handler(event, ctx);
		if (nextResult !== undefined) {
			result = nextResult;
		}
	}

	return result;
}

/** Executes the registered consult_advisor tool. */
async function executeConsult(
	pi: ExtensionApiFake,
	ctx: ContextFake,
	question: string,
	signal?: AbortSignal,
): Promise<unknown> {
	return getConsultTool(pi).execute(
		"call-1",
		{ question },
		signal,
		undefined,
		ctx as never,
	);
}

/** Creates an assistant message that calls consult_advisor. */
function createAdvisorToolCallMessage(
	toolCallId: string,
	question: string,
	timestamp: number,
): AssistantMessage {
	return createToolCallMessage(
		toolCallId,
		"consult_advisor",
		{ question },
		timestamp,
	);
}

/** Creates an assistant message that calls a tool. */
function createToolCallMessage(
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown>,
	timestamp: number,
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: toolCallId,
				name: toolName,
				arguments: args,
			},
		],
		api: "fake-api",
		provider: "openai",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	};
}

/** Creates an extension-owned projection state entry. */
function createProjectionStateEntry(
	id: string,
	projectedEntryId: string,
	replacementText: string,
	parentId: string | null,
): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: "t",
		customType: "context-projection",
		data: {
			projectedEntries: [{ entryId: projectedEntryId, replacementText }],
		},
	} as SessionEntry;
}

/** Creates fake completeSimple and its observable call list. */
function createCompletionFake(
	responseContent: AssistantMessage["content"] = [
		{ type: "text", text: "advisor answer" },
	],
): {
	readonly calls: CompletionCall[];
	readonly completeSimple: <TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
} {
	return createCompletionSequenceFake([
		{ kind: "response", content: responseContent },
	]);
}

/** Creates fake completeSimple that returns or throws one configured outcome per call. */
function createCompletionSequenceFake(outcomes: readonly CompletionOutcome[]): {
	readonly calls: CompletionCall[];
	readonly completeSimple: <TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
} {
	const calls: CompletionCall[] = [];
	return {
		calls,
		async completeSimple<TApi extends Api>(
			model: Model<TApi>,
			context: Context,
			options?: SimpleStreamOptions,
		): Promise<AssistantMessage> {
			calls.push({ model: model as Model<Api>, context, options });
			const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
			if (outcome === undefined) {
				throw new Error("expected completion outcome");
			}
			if (outcome.kind === "throw") {
				throw outcome.error;
			}

			return createAssistantResponse(model, outcome);
		},
	};
}

/** Creates one advisor assistant response with standard fake usage metadata. */
function createAssistantResponse<TApi extends Api>(
	model: Model<TApi>,
	outcome: CompletionResponseOutcome,
): AssistantMessage {
	return {
		role: "assistant",
		content: outcome.content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: outcome.cost ?? 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: outcome.cost ?? 0,
			},
		},
		stopReason: outcome.stopReason ?? "stop",
		...(outcome.errorMessage !== undefined
			? { errorMessage: outcome.errorMessage }
			: {}),
		timestamp: 1,
	};
}

describe("consult-advisor", () => {
	test("does not register consult_advisor when explicitly disabled", async () => {
		// Purpose: disabled consult-advisor config must remove the advisor tool and prompt contribution.
		// Input and expected output: enabled false registers no consult_advisor tool.
		// Edge case: dependencies are available, so config is the only disablement source.
		// Dependencies: this test uses an isolated agent directory and in-memory ExtensionAPI fake.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { enabled: false });
			const pi = createExtensionApiFake();

			consultAdvisor(pi);

			expect(pi.tools.map((tool) => tool.name)).not.toContain(
				"consult_advisor",
			);
		});
	});

	test("registers the unchanged public consult_advisor schema", () => {
		// Purpose: the public tool contract must stay limited to question.
		// Input and expected output: extension load registers one question parameter and publishes the exact call and result renderers.
		// Edge case: no config file is needed for registration.
		// Dependencies: this test uses an in-memory ExtensionAPI fake with Pi's event bus.
		const pi = createExtensionApiFake();
		consultAdvisor(pi);
		const tool = getConsultTool(pi);
		const parameters = tool.parameters as unknown as {
			readonly properties: Record<string, unknown>;
		};
		const presentation = getPackageToolPresentation(
			pi.events,
			"consult_advisor",
		);
		expect({
			parameterNames: Object.keys(parameters.properties),
			renderCall: presentation?.renderCall === tool.renderCall,
			renderResult: presentation?.renderResult === tool.renderResult,
		}).toEqual({
			parameterNames: ["question"],
			renderCall: true,
			renderResult: true,
		});
	});

	test("renders advisor question and collapsed answer within terminal width", () => {
		// Purpose: consult_advisor must show the asked question and keep long answers collapsed under Pi tool expansion.
		// Input and expected output: long question and answer render as Pi Text visual-line previews, while expanded mode exposes full advice.
		// Edge case: long text must be wrapped by Pi Text rendering instead of custom plain slicing.
		// Dependencies: this test uses the registered tool renderers and a plain in-memory theme.
		const pi = createExtensionApiFake();
		consultAdvisor(pi);
		const tool = getConsultTool(pi);
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as never;
		const longQuestion =
			"Which implementation risk should we check before changing the runtime policy?";
		const longAdvice = "Check the active tool policy before editing. ".repeat(
			60,
		);
		const wordWrapAdvice =
			"alpha beta supercalifragilisticexpialidocious omega";

		const callComponent = tool.renderCall?.(
			{ question: longQuestion },
			theme,
			{} as never,
		);
		const collapsedResult = tool.renderResult?.(
			{
				content: [{ type: "text", text: longAdvice }],
				details: undefined,
			},
			{ expanded: false, isPartial: false },
			theme,
			{ isError: false } as never,
		);
		const wordWrapCollapsedResult = tool.renderResult?.(
			{
				content: [{ type: "text", text: wordWrapAdvice }],
				details: undefined,
			},
			{ expanded: false, isPartial: false },
			theme,
			{ isError: false } as never,
		);
		const expandedResult = tool.renderResult?.(
			{
				content: [{ type: "text", text: longAdvice }],
				details: undefined,
			},
			{ expanded: true, isPartial: false },
			theme,
			{ isError: false } as never,
		);

		expect(callComponent).toBeDefined();
		expect(collapsedResult).toBeDefined();
		expect(expandedResult).toBeDefined();
		const renderWidth = 80;
		const callLines = callComponent?.render(renderWidth) ?? [];
		const collapsedLines = collapsedResult?.render(renderWidth) ?? [];
		const wordWrapCollapsedLines = wordWrapCollapsedResult?.render(24) ?? [];
		const expandedText = expandedResult?.render(80).join("\n") ?? "";

		expect(callLines.length).toBeGreaterThan(1);
		expect(callLines[0]).toStartWith(
			"consult_advisor: Which implementation risk",
		);
		expect(callLines.join("")).toContain("runtime policy");
		expect(collapsedLines).toHaveLength(COLLAPSED_ADVICE_PREVIEW_LINES + 1);
		expect(collapsedLines[0]).toStartWith(
			"Advice: Check the active tool policy",
		);
		expect(wordWrapCollapsedLines).toEqual(
			new Text(`Advice: ${wordWrapAdvice}`, 0, 0).render(24),
		);
		expect(collapsedLines.at(-1)).toContain("... (");
		expect(collapsedLines.at(-1)).toContain("more lines");
		expect(collapsedLines.at(-1)).toContain("total");
		expect(collapsedLines.at(-1)).toContain("to expand");
		expect(expandedText).toContain("Check the active tool policy before");
		expect(expandedText).toContain("editing.");
		for (const line of [...callLines, ...collapsedLines]) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(renderWidth);
		}
	});

	test("wraps advisor question preview within bounded header rows", () => {
		// Purpose: consult_advisor must keep the full tool-call question visible when the prompt is long.
		// Input and expected output: a long Unicode question renders as width-bounded wrapped header rows without ellipsis clipping.
		// Edge case: the question contains mixed-direction Unicode text and emoji variation sequences.
		// Dependencies: this test uses the registered consult_advisor call renderer and pi-tui visible-width measurement.
		const pi = createExtensionApiFake();
		consultAdvisor(pi);
		const tool = getConsultTool(pi);
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as never;
		const question =
			"Task Return one complex Unicode string for subsystem testing. Scope Only produce the requested string. Do not analyze it. Advisor-Unicode-test: Русский текст; Український текст; 日本語; 한국어; हिन्दी; שלום עברית; عربي مرحبا; accents: café naïve façade coöperate São Tomé; emoji: 🌍🚀✨ 👨‍👩‍👧‍👦 🏳️‍🌈";
		const width = 100;

		const lines =
			tool.renderCall?.({ question }, theme, {} as never).render(width) ?? [];

		expect(lines.length).toBeGreaterThan(1);
		expect(lines[0]).toStartWith("consult_advisor: Task Return");
		expect(lines).toHaveLength(4);
		expect(lines.join("\n")).toContain("... (1 more line, 4 total, ");
		expect(lines.join("\n")).toContain("to expand)");
		expect(lines.join("\n")).not.toContain("…");
		for (const line of lines) {
			expect(line).not.toContain(SGR_RESET);
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("renders collapsed advisor preview through the standard Pi tool box", () => {
		// Purpose: consult_advisor collapsed output must follow the same Box-contained width contract as built-in Pi tools.
		// Input and expected output: a long word is wrapped by Pi Text at the Box content width, not by custom slicing.
		// Edge case: Box padding reduces child width by two columns before the result component renders.
		// Dependencies: this test uses the public Pi TUI Box and Text components plus the registered consult_advisor renderer.
		const pi = createExtensionApiFake();
		consultAdvisor(pi);
		const tool = getConsultTool(pi);
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as never;
		const advice = "alpha beta supercalifragilisticexpialidocious omega";
		const contentWidth = 24;
		const boxWidth = contentWidth + 2;
		const resultComponent = tool.renderResult?.(
			{
				content: [{ type: "text", text: advice }],
				details: undefined,
			},
			{ expanded: false, isPartial: false },
			theme,
			{ isError: false } as never,
		);
		const box = new Box(1, 1, (text: string) => text);
		if (resultComponent !== undefined) {
			box.addChild(resultComponent);
		}

		const renderedLines = box.render(boxWidth);
		const expectedContentLines = new Text(`Advice: ${advice}`, 0, 0).render(
			contentWidth,
		);
		const expectedLines = [
			" ".repeat(boxWidth),
			...expectedContentLines.map((line) => ` ${line} `),
			" ".repeat(boxWidth),
		];

		expect(renderedLines).toEqual(expectedLines);
		for (const line of renderedLines) {
			expect(visibleWidth(line)).toBe(boxWidth);
		}
	});

	test("keeps call and collapsed result rows within visible terminal width for emoji variation sequences", () => {
		// Purpose: consult_advisor custom renderers must satisfy pi TUI width checks when question or advice contains grapheme clusters.
		// Input and expected output: call and collapsed result text containing `⚠️` render at or below 60 visible columns.
		// Edge case: truncation happens near `⚠️`, which exposes code-point-based width undercounting.
		// Dependencies: this test uses the registered tool renderers and a plain in-memory theme.
		const pi = createExtensionApiFake();
		consultAdvisor(pi);
		const tool = getConsultTool(pi);
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as never;
		const text =
			"Question before **⚠️ FND-01 — Major** location pi-package/extensions/run-subagent/widget.ts";

		const callLines =
			tool.renderCall?.({ question: text }, theme, {} as never).render(60) ??
			[];
		const collapsedLines =
			tool
				.renderResult?.(
					{
						content: [{ type: "text", text }],
						details: undefined,
					},
					{ expanded: false, isPartial: false },
					theme,
					{ isError: false } as never,
				)
				.render(60) ?? [];

		expect(callLines).not.toHaveLength(0);
		expect(collapsedLines).not.toHaveLength(0);
		for (const line of [...callLines, ...collapsedLines]) {
			expect(line).not.toContain(SGR_RESET);
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}
	});

	test("uses current model and thinking when config file is missing", async () => {
		// Purpose: consult-advisor is enabled by default and must have a usable default runtime.
		// Input and expected output: no consult-advisor.json uses the active model, active thinking level, and bundled prompt.
		// Edge case: the config directory is absent, so no model.id or model.thinking is configured.
		// Dependencies: this test uses an isolated agent directory and a fake completion function.
		await withIsolatedAgentDir(async () => {
			const currentModel = createModel("openai", "current");
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContext([currentModel]);
			const ctxWithCurrentModel = { ...ctx, model: currentModel };
			consultAdvisor(pi, { completeSimple: completion.completeSimple });

			const result = await executeConsult(pi, ctxWithCurrentModel, "Question");

			expect(result).toMatchObject({
				content: [{ type: "text", text: "advisor answer" }],
			});
			expect(completion.calls).toHaveLength(1);
			expect(completion.calls[0]?.model).toBe(currentModel);
			expect(completion.calls[0]?.options).toMatchObject({
				reasoning: "medium",
			});
			expect(ctx.notifications).toEqual([]);
		});
	});

	test("fails startup when advisor promptFile is not absolute", async () => {
		// Purpose: configured advisor prompt files must use absolute paths so startup cannot depend on config-relative or home expansion.
		// Input and expected output: non-absolute promptFile values cause extension loading to throw.
		// Edge case: model settings are valid, so the prompt path is the only invalid field.
		// Dependencies: isolated config file and in-memory ExtensionAPI fake.
		for (const promptFile of ["advisor.md", "~/advisor.md"]) {
			await withIsolatedAgentDir(async (agentDir) => {
				await writeConfig(agentDir, {
					enabled: true,
					model: { id: "openai/advisor", thinking: "high" },
					promptFile,
				});
				const pi = createExtensionApiFake();

				expect(() => consultAdvisor(pi)).toThrow(
					"[consult-advisor] promptFile must be an absolute path",
				);
			});
		}
	});

	test("uses bundled default advisor prompt when config omits promptFile", async () => {
		// Purpose: consult-advisor must work without a custom prompt path when the extension bundles a default prompt.
		// Input and expected output: config with only model settings calls completeSimple with the extension-local advisor prompt.
		// Edge case: promptFile is omitted while model settings stay valid.
		// Dependencies: extension-local prompt file, fake model registry, fake completion function, and fake session entries.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				model: { id: "openai/advisor", thinking: "high" },
			});
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContext([createModel("openai", "advisor")]);
			consultAdvisor(pi, { completeSimple: completion.completeSimple });

			const result = await executeConsult(pi, ctx, "Question");

			expect(result).toMatchObject({
				content: [{ type: "text", text: "advisor answer" }],
			});
			expect(
				(result as AgentToolResult<unknown>).details as
					| { readonly fullOutputPath?: string }
					| undefined,
			).toBeUndefined();
			expect(ctx.notifications).toEqual([]);
			expect(completion.calls).toHaveLength(1);
			expect(completion.calls[0]?.context.systemPrompt).toContain(
				"You are an advisor: a highly skilled",
			);
		});
	});

	test("includes loaded project context files in advisor system prompt", async () => {
		// Purpose: consult-advisor must preserve Pi-loaded project rules for the advisor model.
		// Input and expected output: contextFiles with AGENTS.md and CLAUDE.md are appended to the advisor system prompt.
		// Edge case: project context comes from before_agent_start state, not from the conversation branch.
		// Dependencies: fake before_agent_start event, fake model registry, and fake completion function.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "advisor");
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContext([model]);
			consultAdvisor(pi, { completeSimple: completion.completeSimple });
			await emitBeforeAgentStartHandlers(
				pi,
				{
					systemPrompt: "Base",
					systemPromptOptions: {
						contextFiles: [
							{
								path: "/tmp/project/AGENTS.md",
								content: "Project rule: use the project validation scripts.",
							},
							{
								path: "/tmp/project/CLAUDE.md",
								content: "Project rule: keep docs current.",
							},
						],
					},
				},
				ctx,
			);

			const result = await executeConsult(pi, ctx, "Question");

			expect(result).toMatchObject({
				content: [{ type: "text", text: "advisor answer" }],
			});
			expect(completion.calls).toHaveLength(1);
			expect(completion.calls[0]?.context.systemPrompt).toContain(
				"# Project Context",
			);
			expect(completion.calls[0]?.context.systemPrompt).toContain(
				"## /tmp/project/AGENTS.md",
			);
			expect(completion.calls[0]?.context.systemPrompt).toContain(
				"Project rule: use the project validation scripts.",
			);
			expect(completion.calls[0]?.context.systemPrompt).toContain(
				"## /tmp/project/CLAUDE.md",
			);
			expect(completion.calls[0]?.context.systemPrompt).toContain(
				"Project rule: keep docs current.",
			);
		});
	});

	test("includes applicable knowledge in the advisor system context", async () => {
		// Purpose: explicit advisor requests must receive the same applicable knowledge as normal agent turns.
		// Input and expected output: one registered source appends its block to the advisor system prompt.
		// Edge case: knowledge is read when the explicit request is assembled.
		// Dependencies: shared knowledge registry and completion recorder.
		await withIsolatedAgentDir(async () => {
			const pi = createExtensionApiFake();
			const ctx = createContext([createModel("openai", "advisor")]);
			const completion = createCompletionFake();
			registerKnowledgeContextRuntime(pi, {
				readBlock: async () => "<knowledge>advisor knowledge</knowledge>",
			});
			consultAdvisor(pi, { completeSimple: completion.completeSimple });

			await executeConsult(pi, ctx, "Use knowledge");

			expect(completion.calls[0]?.context.systemPrompt).toContain(
				"<knowledge>advisor knowledge</knowledge>",
			);
		});
	});

	test("truncates large advisor output and saves full output to a temp file", async () => {
		// Purpose: model-facing consult_advisor content must be bounded while complete advisor answers remain available from a temp file.
		// Input and expected output: an advisor answer over the Pi line limit returns tail-truncated content plus a full-output path.
		// Edge case: tail truncation preserves the latest advisor lines and omits the earliest line.
		// Dependencies: this test uses temp config, Pi truncation constants, fake model registry, and fake completion function.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				model: { id: "openai/advisor", thinking: "high" },
			});
			const totalLines = DEFAULT_MAX_LINES + 5;
			const advisorOutput = Array.from(
				{ length: totalLines },
				(_, index) => `advisor line ${index + 1}`,
			).join("\n");
			const completion = createCompletionFake([
				{ type: "text", text: advisorOutput },
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext([createModel("openai", "advisor")]);
			consultAdvisor(pi, { completeSimple: completion.completeSimple });

			const result = (await executeConsult(
				pi,
				ctx,
				"Question",
			)) as AgentToolResult<unknown>;
			const content =
				result.content[0]?.type === "text" ? result.content[0].text : "";
			const details = result.details as {
				readonly fullOutputPath?: string;
				readonly truncation?: {
					readonly truncated: boolean;
					readonly outputLines: number;
					readonly totalLines: number;
				};
			};

			expect(content).not.toBe(advisorOutput);
			expect(content).not.toContain("advisor line 1\n");
			expect(content).toContain("advisor line 6\n");
			expect(content).toContain(`advisor line ${totalLines}`);
			expect(content).toContain(
				`[Showing lines 6-${totalLines} of ${totalLines}. Full output: `,
			);
			expect(details.truncation).toMatchObject({
				truncated: true,
				outputLines: DEFAULT_MAX_LINES,
				totalLines,
			});
			const fullOutputPath = details.fullOutputPath ?? "";
			expect(fullOutputPath).toStartWith(join(tmpdir(), "pi-consult-advisor-"));
			expect(fullOutputPath).toEndWith(".log");
			expect(await readFile(fullOutputPath, "utf8")).toBe(advisorOutput);
			await rm(fullOutputPath, { force: true });
		});
	});

	test("calls advisor model with prompt, sanitized transcript, tools disabled, and debug payload", async () => {
		// Purpose: valid config must call completeSimple with an isolated session, advisor prompt, transcript, and no tools.
		// Input and expected output: the request has a Pi-compatible UUIDv7 and excludes the pending advisor call.
		// Edge case: debug payload path is resolved relative to consult-advisor.json directory.
		// Dependencies: temp config, temp prompt, fake model registry, fake completion function, fake session entries.
		await withIsolatedAgentDir(async (agentDir) => {
			const promptFile = join(agentDir, "config", "advisor.md");
			await mkdir(join(agentDir, "config"), { recursive: true });
			await writeFile(promptFile, "Advisor prompt");
			await writeConfig(agentDir, {
				enabled: true,
				model: { id: "openai/advisor", thinking: "high" },
				promptFile,
				debugPayloadFile: "payload.json",
			});
			const model = createModel("openai", "advisor");
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const entries = [
				{
					type: "message",
					id: "1",
					parentId: null,
					timestamp: "t",
					message: { role: "user", content: "hello", timestamp: 1 },
				},
				{
					type: "message",
					id: "2",
					parentId: "1",
					timestamp: "t",
					message: createAdvisorToolCallMessage("old-call", "old question", 2),
				},
				{
					type: "message",
					id: "3",
					parentId: "2",
					timestamp: "t",
					message: {
						role: "toolResult",
						toolCallId: "old-call",
						toolName: "consult_advisor",
						content: [{ type: "text", text: "old advisor result" }],
						isError: false,
						timestamp: 3,
					},
				},
				{
					type: "message",
					id: "4",
					parentId: "3",
					timestamp: "t",
					message: createAdvisorToolCallMessage(
						"call-1",
						"current question",
						4,
					),
				},
				{
					type: "message",
					id: "5",
					parentId: "4",
					timestamp: "t",
					message: {
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "consult_advisor",
						content: [{ type: "text", text: "current pending result" }],
						isError: false,
						timestamp: 5,
					},
				},
			];
			const ctx = createContext([model], entries);
			consultAdvisor(pi, { completeSimple: completion.completeSimple });

			const result = await executeConsult(pi, ctx, "Should we proceed?");

			expect(result).toMatchObject({
				content: [{ type: "text", text: "advisor answer" }],
			});
			expect(completion.calls).toHaveLength(1);
			expect(completion.calls[0]?.model).toBe(model);
			expect(completion.calls[0]?.options).toMatchObject({
				reasoning: "high",
				apiKey: "advisor-api-key",
				headers: { "x-advisor": "enabled" },
			});
			expect(completion.calls[0]?.options?.sessionId).toMatch(
				AUXILIARY_SESSION_ID_PATTERN,
			);
			expect(completion.calls[0]?.options?.sessionId).not.toBe(
				"consult-advisor-test-session",
			);
			expect(completion.calls[0]?.context.systemPrompt).toBe("Advisor prompt");
			expect(completion.calls[0]?.context.tools).toEqual([]);
			const advisorMessages = JSON.stringify(
				completion.calls[0]?.context.messages,
			);
			expect(advisorMessages).toContain("old advisor result");
			expect(advisorMessages).toContain("old-call");
			expect(advisorMessages).not.toContain("current pending result");
			expect(advisorMessages).not.toContain("call-1");
			expect(advisorMessages).toContain("Should we proceed?");
			const debugPayload = JSON.parse(
				await readFile(join(agentDir, "config", "payload.json"), "utf8"),
			);
			expect(debugPayload.context.tools).toEqual([]);
		});
	});

	test("retries retryable advisor provider failures before returning the answer", async () => {
		// Purpose: consult_advisor must retry transient provider failures inside one isolated provider session.
		// Input and expected output: first provider call throws, second returns advisor text, and both use one session ID.
		// Edge case: zero retry delay keeps the test deterministic while preserving request identity across retries.
		// Dependencies: temp config, fake model registry, and fake completeSimple sequence.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
			});
			const completion = createCompletionSequenceFake([
				{ kind: "throw", error: new Error("network error: fetch failed") },
				{
					kind: "response",
					content: [{ type: "text", text: "advisor answer after retry" }],
				},
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext([createModel("openai", "advisor")]);
			consultAdvisor(pi, { completeSimple: completion.completeSimple });

			const result = await executeConsult(pi, ctx, "Question");

			expect(result).toMatchObject({
				content: [{ type: "text", text: "advisor answer after retry" }],
			});
			expect(completion.calls).toHaveLength(2);
			const retrySessionIds = completion.calls.map(
				(call) => call.options?.sessionId,
			);
			expect(retrySessionIds[0]).toMatch(AUXILIARY_SESSION_ID_PATTERN);
			expect(retrySessionIds[1]).toBe(retrySessionIds[0]);
		});
	});

	test("retries retryable advisor error responses before returning the answer", async () => {
		// Purpose: provider responses with stopReason error must use the same retry path as thrown transient errors.
		// Input and expected output: first response has retryable error metadata, second response returns visible text, and both response costs are recorded.
		// Edge case: completeSimple resolves successfully but the assistant response marks the provider call as failed.
		// Dependencies: temp config, fake model registry, fake completeSimple sequence, and in-memory helper cost entries.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
			});
			const completion = createCompletionSequenceFake([
				{
					kind: "response",
					content: [],
					stopReason: "error",
					errorMessage: "provider returned error 503",
					cost: 0.2,
				},
				{
					kind: "response",
					content: [{ type: "text", text: "advisor recovered" }],
					cost: 0.3,
				},
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext([createModel("openai", "advisor")]);
			consultAdvisor(pi, { completeSimple: completion.completeSimple });

			const result = await executeConsult(pi, ctx, "Question");

			expect(result).toMatchObject({
				content: [{ type: "text", text: "advisor recovered" }],
			});
			expect(completion.calls).toHaveLength(2);
			expect(pi.appendEntryCalls).toEqual([
				{
					customType: HELPER_API_COST_CUSTOM_TYPE,
					data: { source: "consult-advisor", cost: 0.2 },
				},
				{
					customType: HELPER_API_COST_CUSTOM_TYPE,
					data: { source: "consult-advisor", cost: 0.3 },
				},
			]);
		});
	});

	test("does not retry aborted advisor requests", async () => {
		// Purpose: cancellation must stop advisor retry instead of starting another provider call.
		// Input and expected output: completeSimple throws AbortError and consult_advisor returns one safe error result.
		// Edge case: retry config allows retries, so the abort classification is the only reason no retry happens.
		// Dependencies: temp config, fake model registry, and fake completeSimple sequence.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
			});
			const abortError = new Error("user aborted advisor request");
			abortError.name = "AbortError";
			const completion = createCompletionSequenceFake([
				{ kind: "throw", error: abortError },
			]);
			const pi = createExtensionApiFake();
			const ctx = createContext([createModel("openai", "advisor")]);
			consultAdvisor(pi, { completeSimple: completion.completeSimple });

			const result = await executeConsult(pi, ctx, "Question");

			expect(result).toMatchObject({
				content: [
					{
						type: "text",
						text: "Advisor request failed: user aborted advisor request",
					},
				],
			});
			expect(completion.calls).toHaveLength(1);
		});
	});

	test("rejects invalid advisor retry config", async () => {
		// Purpose: retry config is external JSON and must fail closed when numeric limits are invalid.
		// Input and expected output: negative maxRetries produces a consult-advisor config error before provider calls.
		// Edge case: the config object uses only supported keys except the invalid retry field value.
		// Dependencies: temp config, fake model registry, fake completion function, and in-memory UI notifications.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				retry: { enabled: true, maxRetries: -1, baseDelayMs: 0 },
			});
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContext([createModel("openai", "advisor")]);
			consultAdvisor(pi, { completeSimple: completion.completeSimple });

			const result = await executeConsult(pi, ctx, "Question");

			expect(result).toMatchObject({
				content: [
					{
						type: "text",
						text: "retry.maxRetries must be a non-negative integer",
					},
				],
			});
			expect(completion.calls).toHaveLength(0);
			expect(ctx.notifications).toEqual([
				{
					message:
						"[consult-advisor] retry.maxRetries must be a non-negative integer",
					type: "warning",
				},
			]);
		});
	});

	test("replays persisted context projection state before calling the advisor", async () => {
		// Purpose: advisor input must match the projected task state when context-projection has recorded omitted tool results.
		// Input and expected output: valid projection config plus persisted state replaces old tool output with the recorded replacement text.
		// Edge case: the current pending consult_advisor call is still removed after projection replay.
		// Dependencies: temp context-projection config, fake model registry, fake completion function, and fake session entries.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeProjectionConfig(agentDir, { enabled: true });
			const replacementText = "[projected old output]";
			const model = createModel("openai", "advisor");
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const entries = [
				{
					type: "message",
					id: "1",
					parentId: null,
					timestamp: "t",
					message: { role: "user", content: "hello", timestamp: 1 },
				},
				{
					type: "message",
					id: "2",
					parentId: "1",
					timestamp: "t",
					message: createToolCallMessage("old-tool", "bash", {}, 2),
				},
				{
					type: "message",
					id: "3",
					parentId: "2",
					timestamp: "t",
					message: {
						role: "toolResult",
						toolCallId: "old-tool",
						toolName: "bash",
						content: [{ type: "text", text: "old full tool output" }],
						isError: false,
						timestamp: 3,
					},
				},
				createProjectionStateEntry("4", "3", replacementText, "3"),
				{
					type: "message",
					id: "5",
					parentId: "4",
					timestamp: "t",
					message: createAdvisorToolCallMessage(
						"call-1",
						"current question",
						5,
					),
				},
			];
			const ctx = createContext([model], entries);
			consultAdvisor(pi, { completeSimple: completion.completeSimple });

			await executeConsult(pi, ctx, "Should we proceed?");

			expect(completion.calls).toHaveLength(1);
			const advisorMessages = JSON.stringify(
				completion.calls[0]?.context.messages,
			);
			expect(advisorMessages).toContain(replacementText);
			expect(advisorMessages).not.toContain("old full tool output");
			expect(advisorMessages).not.toContain("current question");
			expect(advisorMessages).not.toContain("call-1");
		});
	});

	test("matches main projection view for the same persisted projection state", async () => {
		// Purpose: advisor projection replay must produce the same projected tool-result view as the main context-projection hook.
		// Input and expected output: one persisted projection state replaces the same old tool result in both main and advisor contexts.
		// Edge case: advisor uses a separate execution path and must still share projection semantics with the main model path.
		// Dependencies: context-projection and consult-advisor factories, fake completion function, and in-memory session entries.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeProjectionConfig(agentDir, { enabled: true });
			const replacementText = "[projected shared output]";
			const model = createModel("openai", "advisor");
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const branchEntries = [
				{
					type: "message",
					id: "1",
					parentId: null,
					timestamp: "t",
					message: { role: "user", content: "hello", timestamp: 1 },
				},
				{
					type: "message",
					id: "2",
					parentId: "1",
					timestamp: "t",
					message: createToolCallMessage("old-tool", "bash", {}, 2),
				},
				{
					type: "message",
					id: "3",
					parentId: "2",
					timestamp: "t",
					message: {
						role: "toolResult",
						toolCallId: "old-tool",
						toolName: "bash",
						content: [{ type: "text", text: "old full tool output" }],
						isError: false,
						timestamp: 3,
					},
				},
				createProjectionStateEntry("4", "3", replacementText, "3"),
			] satisfies SessionEntry[];
			const ctx = createContext([model], branchEntries);
			contextProjection(pi);
			consultAdvisor(pi, { completeSimple: completion.completeSimple });
			const sessionStartHandler = pi.handlers.find(
				(handler) => handler.eventName === "session_start",
			)?.handler;
			const contextHandler = pi.handlers.find(
				(handler) => handler.eventName === "context",
			)?.handler;
			if (typeof sessionStartHandler !== "function") {
				throw new Error("expected session_start handler");
			}
			if (typeof contextHandler !== "function") {
				throw new Error("expected context handler");
			}

			await sessionStartHandler({ type: "session_start" }, ctx);
			const mainResult = (await contextHandler(
				{
					type: "context",
					messages: branchEntries
						.filter((entry) => entry.type === "message")
						.map((entry) => entry.message),
				},
				ctx,
			)) as { messages: unknown[] };
			await executeConsult(pi, ctx, "Should we proceed?");

			const mainProjectedToolResult = JSON.stringify(mainResult.messages[2]);
			const advisorProjectedToolResult = JSON.stringify(
				completion.calls[0]?.context.messages[2],
			);
			expect(mainProjectedToolResult).toContain(replacementText);
			expect(advisorProjectedToolResult).toBe(mainProjectedToolResult);
			expect(advisorProjectedToolResult).not.toContain("old full tool output");
		});
	});

	test("uses live projection state before the persisted custom entry appears in the active branch", async () => {
		// Purpose: advisor replay must use context-projection's runtime state from the same process, not only persisted branch entries.
		// Input and expected output: context-projection records an omission in memory, and consult_advisor receives the replacement text without the custom state entry in branch.
		// Edge case: projection state has been appended by the context hook but is not part of the active branch snapshot used by the advisor tool call.
		// Dependencies: context-projection and consult-advisor factories share the same imported projection state module.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeProjectionConfig(agentDir, {
				enabled: true,
				projectionRemainingTokensL1: 100_000,
				minToolResultTokensL1: 1,
				projectionRemainingTokensL2: 50_000,
				minToolResultTokensL2: 1,
				projectionRemainingTokensL3: 30_000,
				minToolResultTokensL3: 1,
				keepRecentTurns: 0,
				keepRecentTurnsPercent: 0,
			});
			const model = createModel("openai", "advisor");
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const branchEntries = [
				{
					type: "message",
					id: "1",
					parentId: null,
					timestamp: "t",
					message: createToolCallMessage("old-tool", "bash", {}, 1),
				},
				{
					type: "message",
					id: "2",
					parentId: "1",
					timestamp: "t",
					message: {
						role: "toolResult",
						toolCallId: "old-tool",
						toolName: "bash",
						content: [{ type: "text", text: "old output ".repeat(400) }],
						isError: false,
						timestamp: 2,
					},
				},
			];
			const ctx = createContext([model], branchEntries);
			contextProjection(pi);
			consultAdvisor(pi, { completeSimple: completion.completeSimple });
			const contextHandler = pi.handlers.find(
				(handler) => handler.eventName === "context",
			)?.handler;
			if (typeof contextHandler !== "function") {
				throw new Error("expected context handler");
			}

			await contextHandler(
				{
					type: "context",
					messages: branchEntries.map((entry) => entry.message),
				},
				ctx,
			);
			await executeConsult(pi, ctx, "Should we proceed?");

			const advisorMessages = JSON.stringify(
				completion.calls[0]?.context.messages,
			);
			expect(advisorMessages).toContain(
				"Result omitted. Run tool again for full result.",
			);
			expect(advisorMessages).not.toContain("old output old output");
		});
	});

	test("replays live generated projection summaries to the advisor before state persistence reaches the branch", async () => {
		// Purpose: advisor replay must use summary replacement text from context-projection runtime state in the same process.
		// Input and expected output: summary-enabled projection records a generated summary, and advisor input contains that summary instead of old output.
		// Edge case: the active branch does not contain the custom projection state entry yet.
		// Dependencies: context-projection summary fake, consult-advisor fake, and shared runtime projection state.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeProjectionConfig(agentDir, {
				enabled: true,
				projectionRemainingTokensL1: 100_000,
				minToolResultTokensL1: 1,
				projectionRemainingTokensL2: 50_000,
				minToolResultTokensL2: 1,
				projectionRemainingTokensL3: 30_000,
				minToolResultTokensL3: 1,
				keepRecentTurns: 0,
				keepRecentTurnsPercent: 0,
				summary: {
					enabled: true,
					maxConcurrency: 1,
				},
			});
			const model = createModel("openai", "advisor");
			const summaryCompletion = createCompletionFake([
				{ type: "text", text: "Generated projection summary" },
			]);
			const advisorCompletion = createCompletionFake();
			const pi = createExtensionApiFake();
			const branchEntries = [
				{
					type: "message",
					id: "1",
					parentId: null,
					timestamp: "t",
					message: createToolCallMessage("old-tool", "bash", {}, 1),
				},
				{
					type: "message",
					id: "2",
					parentId: "1",
					timestamp: "t",
					message: {
						role: "toolResult",
						toolCallId: "old-tool",
						toolName: "bash",
						content: [{ type: "text", text: "old output ".repeat(400) }],
						isError: false,
						timestamp: 2,
					},
				},
			] satisfies SessionEntry[];
			const ctx = createContext([model], branchEntries);
			contextProjection(pi, {
				completeSimple: summaryCompletion.completeSimple,
			});
			consultAdvisor(pi, { completeSimple: advisorCompletion.completeSimple });
			const contextHandler = pi.handlers.find(
				(handler) => handler.eventName === "context",
			)?.handler;
			if (typeof contextHandler !== "function") {
				throw new Error("expected context handler");
			}

			await contextHandler(
				{
					type: "context",
					messages: branchEntries.map((entry) => entry.message),
				},
				ctx,
			);
			await executeConsult(pi, ctx, "Should we proceed?");

			const advisorToolResult = advisorCompletion.calls[0]?.context.messages[1];
			if (advisorToolResult?.role !== "toolResult") {
				throw new Error("expected advisor tool result");
			}
			const advisorReplacement = advisorToolResult.content[0];
			if (advisorReplacement?.type !== "text") {
				throw new Error("expected advisor text replacement");
			}
			expect(summaryCompletion.calls).toHaveLength(1);
			expect(advisorReplacement.text).toContain(
				'<tool_result full_result="omitted" content="summary">',
			);
			expect(advisorReplacement.text).toContain("Generated projection summary");
			expect(advisorReplacement.text).not.toContain("old output old output");
			expect(pi.appendEntryCalls[0]?.data).toEqual({
				projectedEntries: [
					{
						entryId: "2",
						replacementText: advisorReplacement.text,
					},
				],
			});
		});
	});

	test("does not let stored projection state hide loaded skill read results from the advisor", async () => {
		// Purpose: advisor projection replay must preserve skill instructions even when stale projection state references a skill read result.
		// Input and expected output: loaded skill root plus stored projection state keeps the read output visible and omits the replacement text.
		// Edge case: stale projection state exists for the same read result entry.
		// Dependencies: before_agent_start hook, temp context-projection config, fake completion function, and in-memory session entries.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeProjectionConfig(agentDir, { enabled: true });
			const replacementText = "[projected skill output]";
			const model = createModel("openai", "advisor");
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContext(
				[model],
				[
					{
						type: "message",
						id: "1",
						parentId: null,
						timestamp: "t",
						message: createToolCallMessage(
							"read-skill",
							"read",
							{ path: "/tmp/project/skills/SKILL.md" },
							1,
						),
					},
					{
						type: "message",
						id: "2",
						parentId: "1",
						timestamp: "t",
						message: {
							role: "toolResult",
							toolCallId: "read-skill",
							toolName: "read",
							content: [{ type: "text", text: "skill instruction text" }],
							isError: false,
							timestamp: 2,
						},
					},
					createProjectionStateEntry("3", "2", replacementText, "2"),
				],
			);
			consultAdvisor(pi, { completeSimple: completion.completeSimple });
			await emitBeforeAgentStartHandlers(
				pi,
				{
					systemPrompt: "Base",
					systemPromptOptions: { skills: [{ baseDir: "/tmp/project/skills" }] },
				},
				ctx,
			);

			await executeConsult(pi, ctx, "Should we proceed?");

			const advisorMessages = JSON.stringify(
				completion.calls[0]?.context.messages,
			);
			expect(advisorMessages).toContain("skill instruction text");
			expect(advisorMessages).not.toContain(replacementText);
		});
	});

	test("returns an explicit error when advisor input exceeds the advisor model context window", async () => {
		// Purpose: consult_advisor must fail before provider execution when projected-or-full advisor input is too large.
		// Input and expected output: a tiny advisor context window rejects a large stored user message and completeSimple is not called.
		// Edge case: projection config is absent, so the full context path still needs the same guard.
		// Dependencies: fake model registry, fake completion function, and in-memory session entries.
		await withIsolatedAgentDir(async () => {
			const model = { ...createModel("openai", "advisor"), contextWindow: 8 };
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContext(
				[model],
				[
					{
						type: "message",
						id: "1",
						parentId: null,
						timestamp: "t",
						message: {
							role: "user",
							content: "large advisor context ".repeat(20),
							timestamp: 1,
						},
					},
				],
			);
			consultAdvisor(pi, { completeSimple: completion.completeSimple });

			const result = (await executeConsult(
				pi,
				ctx,
				"Question",
			)) as AgentToolResult<unknown>;

			expect(completion.calls).toEqual([]);
			expect(result.content).toEqual([
				{
					type: "text",
					text: "context is too large",
				},
			]);
		});
	});

	test("rejects advisor input when approximate character counting would undercount dense text", async () => {
		// Purpose: context-window protection must fail closed when a chars-per-token estimate cannot prove advisor input fit.
		// Input and expected output: dense multibyte text fits chars-per-token counting but is rejected before completeSimple.
		// Edge case: provider-independent guard must not rely on optimistic tokenizer behavior.
		// Dependencies: fake model registry, fake completion function, and in-memory session entries.
		await withIsolatedAgentDir(async () => {
			const model = { ...createModel("openai", "advisor"), contextWindow: 80 };
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContext(
				[model],
				[
					{
						type: "message",
						id: "1",
						parentId: null,
						timestamp: "t",
						message: {
							role: "user",
							content: "界".repeat(80),
							timestamp: 1,
						},
					},
				],
			);
			consultAdvisor(pi, { completeSimple: completion.completeSimple });

			const result = (await executeConsult(
				pi,
				ctx,
				"Question",
			)) as AgentToolResult<unknown>;

			expect(completion.calls).toEqual([]);
			expect(result.content).toEqual([
				{
					type: "text",
					text: "context is too large",
				},
			]);
		});
	});

	test("fails closed when advisor model auth is unavailable", async () => {
		// Purpose: advisor execution must use pi model-registry auth and stop before provider calls when auth is unavailable.
		// Input and expected output: getApiKeyAndHeaders returns an error, so completeSimple is not called and a warning is returned.
		// Edge case: the model itself exists, but request auth cannot be resolved.
		// Dependencies: temp config, fake model registry auth result, and fake completion function.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				model: { id: "openai/advisor", thinking: "high" },
			});
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContext([createModel("openai", "advisor")], [], {
				ok: false,
				error: "missing OpenAI credentials",
			});
			consultAdvisor(pi, { completeSimple: completion.completeSimple });

			const result = await executeConsult(pi, ctx, "Question");

			expect(result).toMatchObject({
				content: [
					{
						type: "text",
						text: "advisor model auth unavailable: missing OpenAI credentials",
					},
				],
			});
			expect(completion.calls).toEqual([]);
			expect(ctx.notifications).toEqual([
				{
					message:
						"[consult-advisor] advisor model auth unavailable: missing OpenAI credentials",
					type: "warning",
				},
			]);
		});
	});

	test("reports empty advisor responses instead of returning blank output", async () => {
		// Purpose: empty provider responses must be visible failures instead of blank tool output.
		// Input and expected output: completeSimple returns no text parts, so the tool returns an explicit empty-response message.
		// Edge case: the provider call succeeds structurally but has no visible text content.
		// Dependencies: temp config, fake model registry, and fake completion function with empty content.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				model: { id: "openai/advisor", thinking: "high" },
			});
			const completion = createCompletionFake([]);
			const pi = createExtensionApiFake();
			const ctx = createContext([createModel("openai", "advisor")]);
			consultAdvisor(pi, { completeSimple: completion.completeSimple });

			const result = await executeConsult(pi, ctx, "Question");

			expect(result).toMatchObject({
				content: [
					{ type: "text", text: "Advisor returned an empty response." },
				],
			});
			expect(completion.calls).toHaveLength(1);
		});
	});

	test("composes all agent-related extensions consistently across all load orders", async () => {
		// Purpose: Agent Runtime Composition must keep prompt and active tools load-order invariant.
		// Input and expected output: all six factory orders produce the same composed prompt and active tools.
		// Edge case: main agent enables both subagent_start and consult_advisor tools.
		// Dependencies: this test intentionally loads all three agent-related extension factories.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeAgent(agentDir, "main", "main", "Main prompt", [
				"subagent_start",
				"consult_advisor",
			]);
			await writeAgent(agentDir, "helper", "subagent", "Helper prompt");
			const orders: Array<readonly ("main" | "subagents" | "consult")[]> = [
				["main", "subagents", "consult"],
				["main", "consult", "subagents"],
				["subagents", "main", "consult"],
				["subagents", "consult", "main"],
				["consult", "main", "subagents"],
				["consult", "subagents", "main"],
			];

			const results = [];
			for (const order of orders) {
				results.push(await loadAgentRelatedOrder(order));
			}

			expect(
				new Set(results.map((result) => JSON.stringify(result))).size,
			).toBe(1);
		});
	});

	test("keeps cross-extension composition isolated from parent subagent environment", async () => {
		// Purpose: cross-extension prompt composition tests must not inherit subagent depth filtering from the runner process.
		// Input and expected output: selecting the main agent clears inherited child depth and keeps its permitted subagent marker.
		// Edge case: this test can run inside a pi subagent process.
		// Dependencies: temp agent files plus main-agent selection, Subagents, and consult-advisor factories.
		const previousEnv = new Map(
			SUBAGENT_ENV_KEYS.map((key) => [key, process.env[key]]),
		);
		process.env[SUBAGENT_DEPTH_ENV] = "1";
		process.env[SUBAGENT_AGENT_ID_ENV] = "SubAgentSage";
		process.env[SUBAGENT_TOOL_PATTERNS_ENV] = JSON.stringify(["read", "bash"]);
		try {
			await withIsolatedAgentDir(async (agentDir) => {
				await writeAgent(agentDir, "main", "main", "Main prompt", [
					"subagent_start",
				]);
				await writeAgent(agentDir, "helper", "subagent", "Helper prompt");
				const pi = createExtensionApiFake([
					"subagent_start",
					"subagent_steer",
					"subagent_wait",
					"consult_advisor",
				]);
				const ctx = createContext([]);
				mainAgentSelection(pi);
				await subagents(pi);
				consultAdvisor(pi);
				await emitSessionStartHandlers(pi, ctx);

				const command = pi.commands.find(
					(registeredCommand) => registeredCommand.name === "agent",
				);
				if (command === undefined) {
					throw new Error("agent command was not captured");
				}
				await command.handler("main", ctx);
				const result = await emitBeforeAgentStartHandlers(
					pi,
					{ systemPrompt: "Base" },
					ctx,
				);

				if (!isPromptResult(result)) {
					throw new Error("before_agent_start did not return a system prompt");
				}
				expect(result.systemPrompt).toContain("Base");
				expect(result.systemPrompt).toContain("Main prompt");
				expect(result.systemPrompt).toContain(
					AVAILABLE_SUBAGENTS_PROMPT_OPENING_TAG,
				);
				expect(pi.activeToolCalls.at(-1)).toEqual(["subagent_start"]);
			});
		} finally {
			for (const key of SUBAGENT_ENV_KEYS) {
				const previousValue = previousEnv.get(key);
				if (previousValue === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = previousValue;
				}
			}
		}
	});

	test("omits advisor guidance when effective agent lacks consult_advisor", async () => {
		// Purpose: advisor guidance must appear only when the current effective agent can call consult_advisor.
		// Input and expected output: selected main agent has only subagent_start, so composed prompt omits consult_advisor guidance.
		// Edge case: consult-advisor extension is loaded and registered, but the selected agent policy disables its tool.
		// Dependencies: this test loads main-agent selection, Subagents, and consult-advisor against temp agent files.
		const previousDepth = process.env[SUBAGENT_DEPTH_ENV];
		process.env[SUBAGENT_DEPTH_ENV] = "0";
		try {
			await withIsolatedAgentDir(async (agentDir) => {
				await writeAgent(agentDir, "main", "main", "Main prompt", [
					"subagent_start",
				]);
				await writeAgent(agentDir, "helper", "subagent", "Helper prompt");
				const pi = createExtensionApiFake([
					"subagent_start",
					"subagent_steer",
					"subagent_wait",
					"consult_advisor",
				]);
				const ctx = createContext([]);
				mainAgentSelection(pi);
				await subagents(pi);
				consultAdvisor(pi);
				await emitSessionStartHandlers(pi, ctx);

				const command = pi.commands.find(
					(registeredCommand) => registeredCommand.name === "agent",
				);
				if (command === undefined) {
					throw new Error("agent command was not captured");
				}
				await command.handler("main", ctx);
				const result = await emitBeforeAgentStartHandlers(
					pi,
					{ systemPrompt: "Base" },
					ctx,
				);

				if (!isPromptResult(result)) {
					throw new Error("before_agent_start did not return a system prompt");
				}
				expect(result.systemPrompt).toContain("Base");
				expect(result.systemPrompt).toContain("Main prompt");
				expect(result.systemPrompt).toContain(
					AVAILABLE_SUBAGENTS_PROMPT_OPENING_TAG,
				);
				expect(result.systemPrompt).toContain('<agent id="helper">');
				expect(result.systemPrompt).not.toContain("consult_advisor");
			});
		} finally {
			if (previousDepth === undefined) {
				delete process.env[SUBAGENT_DEPTH_ENV];
			} else {
				process.env[SUBAGENT_DEPTH_ENV] = previousDepth;
			}
		}
	});

	test("rejects malformed model id during config validation", async () => {
		// Purpose: malformed model.id values must be classified as config errors.
		// Input and expected output: malformed provider/model strings report model.id format warning and skip completeSimple.
		// Edge case: model IDs are split at first slash, but provider and model parts must both exist.
		// Dependencies: temp config and fake completion function.
		for (const modelId of ["advisor", "/advisor", "openai/"]) {
			await withIsolatedAgentDir(async (agentDir) => {
				await writeConfig(agentDir, {
					enabled: true,
					model: { id: modelId, thinking: "high" },
					promptFile: join(agentDir, "config", "advisor.md"),
				});
				const completion = createCompletionFake();
				const pi = createExtensionApiFake();
				const ctx = createContext([createModel("openai", "advisor")]);
				consultAdvisor(pi, { completeSimple: completion.completeSimple });

				await executeConsult(pi, ctx, "Question");

				expect(completion.calls).toEqual([]);
				expect(ctx.notifications).toEqual([
					{
						message: "[consult-advisor] model.id must use provider/model",
						type: "warning",
					},
				]);
			});
		}
	});

	test("fails closed on unreadable and empty prompt files", async () => {
		// Purpose: advisor prompt must be readable and non-empty before any model call.
		// Input and expected output: missing and empty prompt files report consult-advisor warnings and skip completeSimple.
		// Edge case: config itself is otherwise valid.
		// Dependencies: temp config, temp prompt file, and fake completion function.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				model: { id: "openai/advisor", thinking: "high" },
				promptFile: join(agentDir, "config", "missing.md"),
			});
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContext([createModel("openai", "advisor")]);
			consultAdvisor(pi, { completeSimple: completion.completeSimple });

			await executeConsult(pi, ctx, "Question");

			expect(completion.calls).toEqual([]);
			expect(ctx.notifications[0]?.message).toStartWith(
				"[consult-advisor] failed to read advisor prompt",
			);
		});

		await withIsolatedAgentDir(async (agentDir) => {
			await mkdir(join(agentDir, "config"), { recursive: true });
			await writeFile(join(agentDir, "config", "empty.md"), "   ");
			await writeConfig(agentDir, {
				enabled: true,
				model: { id: "openai/advisor", thinking: "high" },
				promptFile: join(agentDir, "config", "empty.md"),
			});
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContext([createModel("openai", "advisor")]);
			consultAdvisor(pi, { completeSimple: completion.completeSimple });

			await executeConsult(pi, ctx, "Question");

			expect(completion.calls).toEqual([]);
			expect(ctx.notifications).toEqual([
				{
					message: "[consult-advisor] advisor prompt must not be empty",
					type: "warning",
				},
			]);
		});
	});

	test("does not notify invalid config when UI is unavailable", async () => {
		// Purpose: non-interactive pi modes must not receive consult-advisor warning notifications.
		// Input and expected output: invalid config with hasUI false returns an error result without notification or model call.
		// Edge case: the UI object still has notify, but hasUI is the authoritative mode signal.
		// Dependencies: this test uses temp config, fake completion function, and fake model registry.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				model: { id: "openai/advisor", thinking: "extreme" },
				promptFile: join(agentDir, "config", "advisor.md"),
			});
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContext(
				[createModel("openai", "advisor")],
				[],
				{
					ok: true,
					apiKey: "advisor-api-key",
					headers: { "x-advisor": "enabled" },
				},
				false,
			);
			consultAdvisor(pi, { completeSimple: completion.completeSimple });

			const result = await executeConsult(pi, ctx, "Question");

			expect(result).toMatchObject({ content: [{ type: "text" }] });
			expect(completion.calls).toEqual([]);
			expect(ctx.notifications).toEqual([]);
		});
	});

	test("omits reasoning when configured thinking is off", async () => {
		// Purpose: thinking off must omit reasoning while preserving the isolated provider session.
		// Input and expected output: completeSimple receives auth and a session ID but no reasoning option.
		// Edge case: `off` is accepted by config but not by pi-ai reasoning options.
		// Dependencies: temp config, temp prompt, fake completion function, and fake model registry.
		await withIsolatedAgentDir(async (agentDir) => {
			await mkdir(join(agentDir, "config"), { recursive: true });
			await writeFile(join(agentDir, "config", "advisor.md"), "Advisor prompt");
			await writeConfig(agentDir, {
				enabled: true,
				model: { id: "openai/advisor", thinking: "off" },
				promptFile: join(agentDir, "config", "advisor.md"),
			});
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContext([createModel("openai", "advisor")]);
			consultAdvisor(pi, { completeSimple: completion.completeSimple });

			await executeConsult(pi, ctx, "Question");

			expect(completion.calls[0]?.options).toMatchObject({
				apiKey: "advisor-api-key",
				headers: { "x-advisor": "enabled" },
			});
			expect(completion.calls[0]?.options?.reasoning).toBeUndefined();
			expect(completion.calls[0]?.options?.sessionId).toMatch(
				AUXILIARY_SESSION_ID_PATTERN,
			);
		});
	});

	test("fails closed with only consult-advisor warning on invalid config", async () => {
		// Purpose: invalid config must disable advisor call and isolate the issue to consult-advisor.
		// Input and expected output: invalid model.thinking reports one warning and does not call completeSimple.
		// Edge case: model.id is valid but an unsupported thinking value fails config validation.
		// Dependencies: temp config and fake completion function.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				model: { id: "openai/advisor", thinking: "extreme" },
				promptFile: join(agentDir, "config", "advisor.md"),
			});
			const completion = createCompletionFake();
			const pi = createExtensionApiFake();
			const ctx = createContext([createModel("openai", "advisor")]);
			consultAdvisor(pi, { completeSimple: completion.completeSimple });

			const result = await executeConsult(pi, ctx, "Question");

			expect(result).toMatchObject({ content: [{ type: "text" }] });
			expect(completion.calls).toEqual([]);
			expect(ctx.notifications).toEqual([
				{
					message:
						"[consult-advisor] model.thinking must be one of off, minimal, low, medium, high, xhigh, max",
					type: "warning",
				},
			]);
		});
	});
});

/** Loads agent-related extensions in a specific order, selects the main agent, and returns composed runtime state. */
async function loadAgentRelatedOrder(
	order: readonly ("main" | "subagents" | "consult")[],
): Promise<{
	readonly promptResult: unknown;
	readonly activeToolCalls: string[][];
}> {
	const pi = createExtensionApiFake([
		"subagent_start",
		"subagent_steer",
		"subagent_wait",
		"consult_advisor",
	]);
	const ctx = createContext([]);
	for (const extension of order) {
		if (extension === "main") {
			mainAgentSelection(pi);
		} else if (extension === "subagents") {
			await subagents(pi);
		} else {
			consultAdvisor(pi);
		}
	}

	const command = pi.commands.find(
		(registeredCommand) => registeredCommand.name === "agent",
	);
	if (command === undefined) {
		throw new Error("agent command was not captured");
	}
	await command.handler("main", ctx);

	return {
		promptResult: await emitBeforeAgentStartHandlers(
			pi,
			{ systemPrompt: "Base" },
			ctx,
		),
		activeToolCalls: pi.activeToolCalls,
	};
}
