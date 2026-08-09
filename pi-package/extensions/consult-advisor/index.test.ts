import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import consultAdvisor from "./index";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";

const temporaryDirectories: string[] = [];
const originalAgentDir = process.env[AGENT_DIR_ENV];
const originalAgentSuiteDir = process.env[AGENT_SUITE_DIR_ENV];

interface AdvisorCompletionCall {
	readonly model: Model<Api>;
	readonly context: Context;
	readonly options: SimpleStreamOptions | undefined;
}

/** Creates a model fixture that can be resolved by provider and model ID. */
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

/** Creates fake advisor completion and records every request sent by consult-advisor. */
function createCompletionFake(text = "Advisor answer"): {
	readonly calls: AdvisorCompletionCall[];
	readonly completeSimple: <TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
} {
	const calls: AdvisorCompletionCall[] = [];
	return {
		calls,
		async completeSimple<TApi extends Api>(
			model: Model<TApi>,
			context: Context,
			options?: SimpleStreamOptions,
		): Promise<AssistantMessage> {
			calls.push({
				model: model as Model<Api>,
				context,
				options,
			});
			return {
				role: "assistant",
				content: [{ type: "text", text }],
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
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
				},
				stopReason: "stop",
				timestamp: 1,
			};
		},
	};
}

/** Creates the smallest ExtensionAPI fake that registers and executes the advisor tool. */
function createExtensionApiFake(): ExtensionAPI & {
	readonly tools: ToolDefinition[];
} {
	const tools: ToolDefinition[] = [];
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	return {
		tools,
		on(eventName: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(eventName, handler);
		},
		registerTool(definition: ToolDefinition) {
			tools.push(definition);
		},
		registerFlag(): void {},
		getFlag(): undefined {
			return undefined;
		},
		getActiveTools(): string[] {
			return [];
		},
		setActiveTools(): void {},
		getThinkingLevel(): string {
			return "medium";
		},
		setThinkingLevel(): void {},
		appendEntry(): void {},
		events: {
			emit(): void {},
			on(): () => void {
				return () => {};
			},
		},
	} as unknown as ExtensionAPI & { readonly tools: ToolDefinition[] };
}

/** Creates the smallest tool context with an isolated model registry and empty session. */
function createToolContext(models: readonly Model<Api>[]): ExtensionContext {
	return {
		cwd: "/tmp/project",
		hasUI: false,
		model: models[0],
		modelRegistry: {
			find(provider: string, modelId: string): Model<Api> | undefined {
				return models.find(
					(model) => model.provider === provider && model.id === modelId,
				);
			},
			async getApiKeyAndHeaders() {
				return { ok: true, apiKey: "advisor-api-key" };
			},
		},
		sessionManager: {
			getBranch(): unknown[] {
				return [];
			},
		},
	} as unknown as ExtensionContext;
}

/** Returns the single registered advisor tool. */
function getAdvisorTool(
	pi: ExtensionAPI & { readonly tools: ToolDefinition[] },
): ToolDefinition {
	const tool = pi.tools.find(
		(candidate) => candidate.name === "consult_advisor",
	);
	if (tool === undefined) {
		throw new Error("expected consult_advisor tool");
	}
	return tool;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
	if (originalAgentDir === undefined) {
		delete process.env[AGENT_DIR_ENV];
	} else {
		process.env[AGENT_DIR_ENV] = originalAgentDir;
	}
	if (originalAgentSuiteDir === undefined) {
		delete process.env[AGENT_SUITE_DIR_ENV];
	} else {
		process.env[AGENT_SUITE_DIR_ENV] = originalAgentSuiteDir;
	}
});

/** Creates an isolated agent directory with an optional suite config file. */
async function withIsolatedAgentDir<T>(
	action: (agentDir: string) => Promise<T>,
): Promise<T> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-consult-advisor-"));
	temporaryDirectories.push(agentDir);
	process.env[AGENT_DIR_ENV] = agentDir;
	delete process.env[AGENT_SUITE_DIR_ENV];
	return action(agentDir);
}

/** Writes a suite-owned config file under the isolated agent directory. */
async function writeSuiteConfig(
	agentDir: string,
	extensionDir: string,
	config: unknown,
): Promise<void> {
	const configDir = join(agentDir, "agent-suite", extensionDir);
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "config.json"), JSON.stringify(config));
}

test("applies alias default thinking when config model has no explicit thinking", async () => {
	// Purpose: consult_advisor must use the alias default thinking instead of the current session thinking level.
	// Input and expected output: config model alias without thinking resolves to the alias default reasoning.
	// Edge case: the alias carries both the model and the default thinking level.
	// Dependencies: isolated model-alias config, fake model layer, and fake ExtensionAPI tool registration.
	await withIsolatedAgentDir(async (agentDir) => {
		const model = createModel("openai-codex", "gpt-5.6-luna");
		await writeSuiteConfig(agentDir, "model-aliases", {
			codex_extractor: {
				id: "openai-codex/gpt-5.6-luna",
				thinking: "low",
			},
		});
		await writeSuiteConfig(agentDir, "consult-advisor", {
			model: { id: "codex_extractor" },
		});
		const completion = createCompletionFake();
		const pi = createExtensionApiFake();
		consultAdvisor(pi, { completeSimple: completion.completeSimple });

		const result = await getAdvisorTool(pi).execute(
			"call-1",
			{ question: "Check the fix" },
			undefined,
			undefined,
			createToolContext([model]),
		);

		expect(completion.calls).toHaveLength(1);
		expect(completion.calls[0]?.model).toBe(model);
		expect(completion.calls[0]?.options?.reasoning).toBe("low");
		expect(result).toMatchObject({
			content: [{ type: "text", text: "Advisor answer" }],
		});
	});
});
