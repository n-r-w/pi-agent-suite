import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
	createEventBus,
	discoverAndLoadExtensions,
	ExtensionRunner,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { SUBAGENT_AGENT_ID_ENV } from "../../pi-package/shared/subagent-environment";
import { createTempDir } from "../support/temp-dir";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";
const STARTUP_DELAY_KEY = "__piMainAgentStartupDelay";
const RUNTIME_OBSERVATION_KEY = "__piMainAgentRuntimeObservation";
const BEFORE_AGENT_START_COUNT_KEY = "__piMainAgentBeforeStartCount";

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
}

interface StartupEnvironment {
	readonly root: string;
	readonly cwd: string;
	readonly agentDir: string;
	readonly suiteDir: string;
	readonly selectionDir: string;
	readonly sharedGlobal: Record<string, unknown>;
}

interface RunnerBindings {
	readonly activeTools: string[];
	readonly allTools: readonly string[];
	readonly getModel: () => Model<Api> | undefined;
	readonly setModel: (model: Model<Api>) => Promise<boolean>;
	readonly getThinkingLevel: () => string;
	readonly setThinkingLevel: (level: string) => void;
}

interface ExtensionErrorRecord {
	readonly event: string;
	readonly error: string;
}

interface StartupRunner {
	readonly runner: ExtensionRunner;
	readonly startupDelay: Deferred<void>;
	readonly extensionErrors: ExtensionErrorRecord[];
}

function createDeferred<T>(): Deferred<T> {
	let resolve: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	if (resolve === undefined) {
		throw new Error("failed to create deferred promise");
	}
	return { promise, resolve };
}

async function withIsolatedStartupEnvironment<T>(
	prefix: string,
	action: (environment: StartupEnvironment) => Promise<T>,
): Promise<T> {
	const temporaryDirectory = createTempDir(prefix);
	const cwd = join(temporaryDirectory.path, "project");
	const agentDir = join(temporaryDirectory.path, "agent");
	const suiteDir = join(agentDir, "agent-suite");
	const selectionDir = join(suiteDir, "agent-selection");
	const stateDir = join(selectionDir, "state");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	const stateFileName = createHash("sha256").update(cwd).digest("hex");
	writeFileSync(
		join(stateDir, `${stateFileName}.json`),
		JSON.stringify({ cwd, activeAgentId: "selected" }),
	);

	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
	const previousSubagentId = process.env[SUBAGENT_AGENT_ID_ENV];
	process.env[AGENT_DIR_ENV] = agentDir;
	process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
	delete process.env[SUBAGENT_AGENT_ID_ENV];
	const sharedGlobal = globalThis as Record<string, unknown>;

	try {
		return await action({
			root: temporaryDirectory.path,
			cwd,
			agentDir,
			suiteDir,
			selectionDir,
			sharedGlobal,
		});
	} finally {
		delete sharedGlobal[STARTUP_DELAY_KEY];
		delete sharedGlobal[RUNTIME_OBSERVATION_KEY];
		delete sharedGlobal[BEFORE_AGENT_START_COUNT_KEY];
		if (previousAgentDir === undefined) {
			delete process.env[AGENT_DIR_ENV];
		} else {
			process.env[AGENT_DIR_ENV] = previousAgentDir;
		}
		if (previousSuiteDir === undefined) {
			delete process.env[AGENT_SUITE_DIR_ENV];
		} else {
			process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
		}
		if (previousSubagentId === undefined) {
			delete process.env[SUBAGENT_AGENT_ID_ENV];
		} else {
			process.env[SUBAGENT_AGENT_ID_ENV] = previousSubagentId;
		}
		temporaryDirectory.remove();
	}
}

async function buildStartupRunner(
	environment: StartupEnvironment,
	observerExtensionPath: string,
	bindings: RunnerBindings,
	modelRegistry: ModelRegistry,
): Promise<StartupRunner> {
	const startupDelay = createDeferred<void>();
	environment.sharedGlobal[STARTUP_DELAY_KEY] = startupDelay.promise;
	const delayExtensionPath = join(environment.root, "startup-delay.ts");
	writeFileSync(
		delayExtensionPath,
		`export default function startupDelay(pi) {\n  pi.on("session_start", async () => { await globalThis.${STARTUP_DELAY_KEY}; });\n}\n`,
	);
	const extensionsResult = await discoverAndLoadExtensions(
		[
			delayExtensionPath,
			join(
				process.cwd(),
				"pi-package",
				"extensions",
				"main-agent-selection",
				"index.ts",
			),
			observerExtensionPath,
		],
		environment.cwd,
		environment.agentDir,
		createEventBus(),
	);
	if (extensionsResult.errors.length > 0) {
		throw new Error(
			`failed to load startup integration extensions: ${JSON.stringify(extensionsResult.errors)}`,
		);
	}

	const runner = new ExtensionRunner(
		extensionsResult.extensions,
		extensionsResult.runtime,
		environment.cwd,
		SessionManager.inMemory(environment.cwd),
		modelRegistry,
	);
	const extensionErrors: ExtensionErrorRecord[] = [];
	runner.onError((error) => extensionErrors.push(error));
	runner.bindCore(
		{
			sendMessage(): void {},
			sendUserMessage(): void {},
			appendEntry(): void {},
			setSessionName(): void {},
			getSessionName: () => undefined,
			setLabel(): void {},
			getActiveTools: () => [...bindings.activeTools],
			getAllTools: () =>
				bindings.allTools.map((name) => ({
					name,
					description: name,
					parameters: {},
					promptGuidelines: undefined,
					sourceInfo: { path: "integration" },
				})),
			setActiveTools(toolNames: string[]): void {
				bindings.activeTools.splice(
					0,
					bindings.activeTools.length,
					...toolNames,
				);
			},
			refreshTools(): void {},
			getCommands: () => [],
			setModel: bindings.setModel,
			getThinkingLevel: bindings.getThinkingLevel,
			setThinkingLevel: bindings.setThinkingLevel,
		} as unknown as ExtensionActions,
		{
			getModel: bindings.getModel,
			getScopedModels: () => [],
			isIdle: () => true,
			isProjectTrusted: () => true,
			getSignal: () => undefined,
			abort(): void {},
			hasPendingMessages: () => false,
			shutdown(): void {},
			getContextUsage: () => undefined,
			compact(): void {},
			getSystemPrompt: () => "Base prompt",
		} satisfies ExtensionContextActions,
	);
	return { runner, startupDelay, extensionErrors };
}

test("real extension runner blocks first input before main-agent startup dispatch", async () => {
	await withIsolatedStartupEnvironment(
		"pi-main-agent-startup-barrier-",
		async (environment) => {
			const agentsDir = join(environment.selectionDir, "agents");
			mkdirSync(agentsDir);
			writeFileSync(
				join(agentsDir, "selected.md"),
				[
					"---",
					'description: "Selected agent"',
					'type: "main"',
					"model:",
					'  id: "selection-test/selected"',
					'  thinking: "xhigh"',
					"tools:",
					'  - "read"',
					"workflows: []",
					"agents:",
					'  - "reviewer"',
					"---",
					"Selected integration prompt",
				].join("\n"),
			);
			const observerExtensionPath = join(
				environment.root,
				"runtime-observer.ts",
			);
			writeFileSync(
				observerExtensionPath,
				[
					`import { getAgentRuntimeComposition } from ${JSON.stringify(join(process.cwd(), "pi-package", "shared", "agent-runtime-composition.ts"))};`,
					"export default function runtimeObserver(pi) {",
					'  pi.on("before_agent_start", () => {',
					"    const contribution = getAgentRuntimeComposition(pi).getMainAgentContribution();",
					`    globalThis.${RUNTIME_OBSERVATION_KEY} = {`,
					"      promptApplied: contribution?.prompt.length > 0,",
					"      tools: pi.getActiveTools(),",
					"      thinking: pi.getThinkingLevel(),",
					"      workflows: contribution?.agent?.workflows,",
					"      agents: contribution?.agent?.agents,",
					"    };",
					"  });",
					"}",
				].join("\n"),
			);

			const model = createModel("selection-test", "selected");
			let currentModel: Model<Api> | undefined;
			let thinking = "medium";
			const bindings: RunnerBindings = {
				activeTools: ["read", "bash", "workflow_activate", "subagent_start"],
				allTools: ["read", "bash", "workflow_activate", "subagent_start"],
				getModel: () => currentModel,
				setModel: async (selectedModel) => {
					currentModel = selectedModel;
					return true;
				},
				getThinkingLevel: () => thinking,
				setThinkingLevel: (level) => {
					thinking = level;
				},
			};
			const modelRegistry = {
				find(provider: string, modelId: string): Model<Api> | undefined {
					return provider === model.provider && modelId === model.id
						? model
						: undefined;
				},
			} as ModelRegistry;
			const { runner, startupDelay, extensionErrors } =
				await buildStartupRunner(
					environment,
					observerExtensionPath,
					bindings,
					modelRegistry,
				);

			const startup = runner.emit({
				type: "session_start",
				reason: "startup",
			});
			let inputContinued = false;
			const input = runner
				.emitInput("first input", undefined, "interactive")
				.then((result) => {
					inputContinued = true;
					return result;
				});
			await Promise.resolve();
			await Promise.resolve();
			expect(inputContinued).toBe(false);

			startupDelay.resolve();
			await startup;
			expect(extensionErrors).toEqual([]);
			expect(await input).toMatchObject({ action: "continue" });
			const beforeAgentStart = await runner.emitBeforeAgentStart(
				"first input",
				undefined,
				{ cwd: environment.cwd },
			);

			expect(extensionErrors).toEqual([]);
			expect(
				beforeAgentStart.systemPromptOptions.forceSystemPrompt,
			).toBeDefined();
			expect(currentModel).toBe(model);
			expect(environment.sharedGlobal[RUNTIME_OBSERVATION_KEY]).toEqual({
				promptApplied: true,
				tools: ["read"],
				thinking: "xhigh",
				workflows: [],
				agents: ["reviewer"],
			});
		},
	);
});

test("real extension runner handles input after selected-agent startup restoration throws", async () => {
	await withIsolatedStartupEnvironment(
		"pi-main-agent-startup-failure-",
		async (environment) => {
			const agentsPath = join(environment.selectionDir, "agents");
			writeFileSync(agentsPath, "not a directory");
			environment.sharedGlobal[BEFORE_AGENT_START_COUNT_KEY] = 0;
			const observerExtensionPath = join(
				environment.root,
				"request-observer.ts",
			);
			writeFileSync(
				observerExtensionPath,
				[
					`import { getAgentRuntimeComposition } from ${JSON.stringify(join(process.cwd(), "pi-package", "shared", "agent-runtime-composition.ts"))};`,
					"export default function requestObserver(pi) {",
					'  pi.on("before_agent_start", () => {',
					`    globalThis.${BEFORE_AGENT_START_COUNT_KEY} += 1;`,
					"    const contribution = getAgentRuntimeComposition(pi).getMainAgentContribution();",
					`    globalThis.${RUNTIME_OBSERVATION_KEY} = {`,
					"      tools: pi.getActiveTools(),",
					"      workflows: contribution?.agent?.workflows,",
					"      agents: contribution?.agent?.agents,",
					"    };",
					"  });",
					"}",
				].join("\n"),
			);
			const bindings: RunnerBindings = {
				activeTools: ["read", "workflow_activate"],
				allTools: ["read", "workflow_activate"],
				getModel: () => undefined,
				setModel: async () => true,
				getThinkingLevel: () => "medium",
				setThinkingLevel: () => {},
			};
			const { runner, startupDelay, extensionErrors } =
				await buildStartupRunner(environment, observerExtensionPath, bindings, {
					find: () => undefined,
				} as unknown as ModelRegistry);

			const startup = runner.emit({
				type: "session_start",
				reason: "startup",
			});
			const input = runner.emitInput("first input", undefined, "interactive");
			startupDelay.resolve();
			await startup;
			const inputResult = await input;
			if (inputResult.action !== "handled") {
				await runner.emitBeforeAgentStart("first input", undefined, {
					cwd: environment.cwd,
				});
			}

			expect(inputResult).toEqual({ action: "handled" });
			expect(extensionErrors).toHaveLength(1);
			expect(extensionErrors[0]).toMatchObject({
				event: "session_start",
			});
			expect(extensionErrors[0]?.error).toContain(
				"failed to read suite agents directory",
			);
			expect(environment.sharedGlobal[BEFORE_AGENT_START_COUNT_KEY]).toBe(0);

			rmSync(agentsPath);
			mkdirSync(agentsPath);
			writeFileSync(
				join(agentsPath, "selected.md"),
				[
					"---",
					'description: "Recovered selected agent"',
					'type: "main"',
					"tools:",
					'  - "read"',
					"workflows: []",
					"agents:",
					'  - "reviewer"',
					"---",
					"Recovered selected prompt",
				].join("\n"),
			);
			await runner.emit({ type: "session_start", reason: "reload" });
			expect(extensionErrors).toHaveLength(1);
			expect(
				await runner.emitInput("later input", undefined, "interactive"),
			).toMatchObject({ action: "continue" });
			await runner.emitBeforeAgentStart("later input", undefined, {
				cwd: environment.cwd,
			});
			expect(environment.sharedGlobal[BEFORE_AGENT_START_COUNT_KEY]).toBe(1);
			expect(environment.sharedGlobal[RUNTIME_OBSERVATION_KEY]).toEqual({
				tools: ["read"],
				workflows: [],
				agents: ["reviewer"],
			});
		},
	);
});

function createModel(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		api: "fake-api",
		baseUrl: "https://example.test",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		name: `${provider}/${id}`,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_192,
	};
}
