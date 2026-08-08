import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	getTriggerAlgorithm,
	getTriggerAlgorithms,
} from "../../shared/algorithm-registry";
import { readKnowledgeBlock } from "../../shared/knowledge-runtime";
import { getWorkflowTriggerRunner } from "../../shared/workflow-trigger-runtime";
import type { KnowledgeConfig } from "./config";
import type { GitProjectResolution } from "./git-context";
import knowledgeExtension from "./index";
import { createBranchPaths, createProjectPaths } from "./paths";

const MODEL = {
	provider: "test-provider",
	id: "test-model",
	name: "Test model",
	api: "test-api",
	baseUrl: "https://invalid.example",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_000,
} as Model<Api>;
const temporaryDirectories: string[] = [];

/** Removes only isolated system-temporary fixtures created by this test file. */
afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

/** Creates one auxiliary response with explicit stop reason and optional provider error text. */
function response(
	text: string,
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: MODEL.provider,
		model: MODEL.id,
		api: MODEL.api,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
		timestamp: 1,
	};
}

/** Creates enabled configuration rooted in one system-temporary catalog. */
function config(dataDir: string): KnowledgeConfig {
	return {
		enabled: true,
		dataDir,
		globalTokenLimit: 5_000,
		localTokenLimit: 5_000,
		primaryBranches: ["main", "master"],
		preferredRemotes: ["origin"],
		extraction: {
			model: undefined,
			thinking: undefined,
			systemPrompt: "extract system",
			taskPrompt: "summarize projected session",
			maxFractionDenominator: 8,
			initialFraction: 2 / 3,
			reductionCoefficient: 3 / 4,
		},
		mergeLocal: {
			model: undefined,
			thinking: undefined,
			systemPrompt: "merge local system",
			taskPrompt: "merge local task prompt",
			maxFractionDenominator: 8,
			initialFraction: 2 / 3,
			reductionCoefficient: 3 / 4,
		},
		mergeGlobal: {
			model: undefined,
			thinking: undefined,
			systemPrompt: "merge global system",
			taskPrompt: "merge global task prompt",
			maxFractionDenominator: 8,
			initialFraction: 2 / 3,
			reductionCoefficient: 3 / 4,
		},
	};
}

/** Creates one resolved read-write project with stable generated paths. */
function readWriteResolution(): Extract<
	GitProjectResolution,
	{ readonly project: unknown }
> {
	const digest = "a".repeat(64);
	return {
		kind: "resolved-read-write",
		project: {
			profile: "github-v1",
			canonicalIdentity: "github.com/example/project",
			displayName: "project",
			key: digest,
			directoryName: `project-${digest}`,
		},
		identityMetadata: {
			schema: "knowledge-project-identity/v1",
			key: digest,
			profile: "github-v1",
			displayName: "project",
			canonicalIdentity: "github.com/example/project",
			remoteNames: ["origin"],
			redactedFetchUrls: ["https://github.com/example/project.git"],
		},
		branch: { name: "feature/a", directoryName: `feature-a-${"b".repeat(64)}` },
	};
}

/** Builds the narrow extension API and captures lifecycle handlers and notifications. */
function createPi() {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const notifications: string[] = [];
	const notificationLevels: string[] = [];
	const sendMessageCalls: Array<{
		customType: string;
		content: string;
		display: boolean;
		details: unknown;
	}> = [];
	const pi = {
		events: new EventEmitter(),
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		getThinkingLevel: () => "high",
		registerMessageRenderer: () => {},
		sendMessage: (message: {
			customType: string;
			content: string;
			display: boolean;
			details: unknown;
		}) => {
			sendMessageCalls.push(message);
		},
	} as unknown as ExtensionAPI & { sendMessageCalls: typeof sendMessageCalls };
	Object.assign(pi, { sendMessageCalls });
	return {
		pi,
		handlers,
		notifications,
		notificationLevels,
	};
}

/** Creates one initiating context with isolated session and TUI state. */
function createContext(
	notifications: string[],
	hasUI = true,
	notificationLevels?: string[],
): ExtensionContext {
	return {
		cwd: "/project",
		model: MODEL,
		modelRegistry: {
			find: () => MODEL,
			getApiKeyAndHeaders: async () => ({ ok: true }),
		},
		hasUI,
		mode: hasUI ? "tui" : "rpc",
		sessionManager: {
			getSessionId: () => "root-session",
			getBranch: () => [],
		},
		ui: {
			notify: (message: string, level: string) => {
				notifications.push(message);
				notificationLevels?.push(level);
			},
		},
	} as unknown as ExtensionContext;
}

describe("knowledge extension lifecycle", () => {
	/**
	 * Proves normal turns and explicit context readers receive current applicable storage through one root coordinator.
	 * Inputs and expected outputs: global and active-local files append one knowledge block after the incoming system prompt.
	 * Edge case: deleting both files between reads yields no block because idle reads never cache storage.
	 * Dependencies: real KnowledgeOwner reads isolated temporary files; Git and model boundaries are injected.
	 */
	test("delivers applicable current knowledge to normal agent turns", async () => {
		// Arrange: create one project and branch knowledge pair in a temporary catalog.
		const dataDir = await mkdtemp(join(tmpdir(), "pi-knowledge-runtime-"));
		temporaryDirectories.push(dataDir);
		const resolution = readWriteResolution();
		if (resolution.branch === null) {
			throw new Error("read-write fixture branch missing");
		}
		const projectPaths = createProjectPaths(
			dataDir,
			resolution.project.directoryName,
		);
		const branchPaths = createBranchPaths(projectPaths, resolution.branch.name);
		await mkdir(join(projectPaths.projectDirectory, "global"), {
			recursive: true,
		});
		await mkdir(branchPaths.branchDirectory, { recursive: true });
		await writeFile(
			projectPaths.globalKnowledgeFile,
			"global knowledge",
			"utf8",
		);
		await writeFile(branchPaths.knowledgeFile, "local knowledge", "utf8");
		const fake = createPi();
		knowledgeExtension(fake.pi, {
			readConfig: () => ({ kind: "valid", config: config(dataDir) }),
			resolveProject: () => resolution,
			completeSimple: async () => response("NOT_FOUND"),
			runtimeEnv: {},
		});
		const ctx = createContext(fake.notifications);
		const handler = fake.handlers.get("before_agent_start")?.[0];
		if (handler === undefined) {
			throw new Error("before_agent_start handler missing");
		}

		// Act: assemble a normal agent turn and read the same explicit context source.
		const result = await handler(
			{ systemPrompt: "Base", systemPromptOptions: { cwd: "/project" } },
			ctx,
		);
		const explicitBlock = await readKnowledgeBlock(fake.pi, ctx);

		// Assert: both entry paths use one rendered block and preserve the existing prompt.
		expect(result).toEqual({ systemPrompt: `Base\n\n${explicitBlock}` });
		expect(explicitBlock).toContain("global knowledge");
		expect(explicitBlock).toContain("local knowledge");
		expect(explicitBlock?.match(/<knowledge>/gu)).toHaveLength(1);
	});

	/**
	 * Proves trigger failures notify TUI safely, remain silent headlessly, and return failure for workflow sequencing.
	 * Inputs and expected outputs: empty extraction exhausts one retry in both TUI and headless contexts.
	 * Edge case: notification includes the raw model output for debugging.
	 * Dependencies: workflow runner receives the exact initiating context and signal from the workflow extension.
	 */
	test("reports trigger failure safely without throwing into workflow", async () => {
		// Arrange: every extraction response is empty, failing the response contract.
		const dataDir = await mkdtemp(join(tmpdir(), "pi-knowledge-trigger-"));
		temporaryDirectories.push(dataDir);
		const fake = createPi();
		const resolution = readWriteResolution();
		knowledgeExtension(fake.pi, {
			readConfig: () => ({ kind: "valid", config: config(dataDir) }),
			resolveProject: () => resolution,
			completeSimple: async () => response(""),
			runtimeEnv: {},
		});
		const runner = getWorkflowTriggerRunner(fake.pi);
		if (runner === undefined) {
			throw new Error("workflow trigger runner missing");
		}
		const tuiContext = createContext(fake.notifications, true);
		const headlessContext = createContext(fake.notifications, false);

		// Act: both initiating modes run the same failing trigger contract.
		const tuiResult = await runner.run(
			{ type: "local_knowledge_accumulation" },
			tuiContext,
			undefined,
		);
		const headlessResult = await runner.run(
			{ type: "local_knowledge_accumulation" },
			headlessContext,
			undefined,
		);

		// Assert: workflow receives failure, TUI receives step progress and one detailed failure message, and headless adds none.
		expect(tuiResult).toEqual({ ok: false });
		expect(headlessResult).toEqual({ ok: false });
		expect(fake.notifications).toEqual([
			"[knowledge] preparing local knowledge summary...",
			"[knowledge] accumulation failed (knowledge extraction response contract was not satisfied:)",
		]);
	});

	/**
	 * Proves provider-facing failure details are preserved in the user-visible accumulation warning.
	 * Inputs and expected outputs: one model error response with explicit errorMessage propagates that message to the warning.
	 * Edge case: extraction failure still returns workflow-safe { ok: false } without throwing.
	 * Dependencies: knowledge trigger runner catches algorithm errors and formats one warning.
	 */
	test("reports original provider error text in accumulation warning", async () => {
		// Arrange: completeSimple returns one explicit provider error response.
		const dataDir = await mkdtemp(
			join(tmpdir(), "pi-knowledge-provider-error-"),
		);
		temporaryDirectories.push(dataDir);
		const fake = createPi();
		knowledgeExtension(fake.pi, {
			readConfig: () => ({ kind: "valid", config: config(dataDir) }),
			resolveProject: () => readWriteResolution(),
			completeSimple: async () =>
				response("", "error", "No API key found for github-copilot."),
			runtimeEnv: {},
		});
		const runner = getWorkflowTriggerRunner(fake.pi);
		if (runner === undefined) {
			throw new Error("workflow trigger runner missing");
		}

		// Act.
		const result = await runner.run(
			{ type: "local_knowledge_accumulation" },
			createContext(fake.notifications, true),
			undefined,
		);

		// Assert.
		expect(result).toEqual({ ok: false });
		expect(fake.notifications).toEqual([
			"[knowledge] preparing local knowledge summary...",
			"[knowledge] accumulation failed (No API key found for github-copilot.)",
		]);
	});

	/**
	 * Proves unresolved project identity is a failed trigger rather than a successful accumulation no-op.
	 * Inputs and expected outputs: unsupported remote evidence returns failure and one fixed TUI warning.
	 * Edge case: no model or storage work starts before exact scope resolution.
	 * Dependencies: Git identity outcome is injected independently from algorithm behavior.
	 */
	test("fails a trigger when exact project scope cannot be resolved", async () => {
		// Arrange: configuration is valid while Git identity evidence is unsupported.
		const dataDir = await mkdtemp(join(tmpdir(), "pi-knowledge-identity-"));
		temporaryDirectories.push(dataDir);
		const fake = createPi();
		knowledgeExtension(fake.pi, {
			readConfig: () => ({ kind: "valid", config: config(dataDir) }),
			resolveProject: () => ({ kind: "unsupported" }),
			completeSimple: async () => response("NOT_FOUND"),
			runtimeEnv: {},
		});
		const runner = getWorkflowTriggerRunner(fake.pi);
		if (runner === undefined) {
			throw new Error("workflow trigger runner missing");
		}

		// Act: enter one accumulation trigger with unavailable exact scope.
		const result = await runner.run(
			{ type: "local_knowledge_accumulation" },
			createContext(fake.notifications, true),
			undefined,
		);

		// Assert: the stage trigger fails safely before model or catalog activity and reports the failure reason.
		expect(result).toEqual({ ok: false });
		expect(fake.notifications).toEqual([
			"[knowledge] accumulation failed (knowledge project scope unavailable)",
		]);
	});

	/**
	 * Proves local accumulation reports summary preparation and merge as separate progress events in TUI mode.
	 * Inputs and expected outputs: one successful extraction and one successful merge yield two ordered info notifications.
	 * Edge case: workflow success keeps progress messages without any warning notification.
	 * Dependencies: trigger progress is emitted through the workflow runner boundary.
	 */
	test("reports separate local preparation and merge progress", async () => {
		// ARRANGE
		const dataDir = await mkdtemp(join(tmpdir(), "pi-knowledge-progress-"));
		temporaryDirectories.push(dataDir);
		const fake = createPi();
		knowledgeExtension(fake.pi, {
			readConfig: () => ({ kind: "valid", config: config(dataDir) }),
			resolveProject: () => readWriteResolution(),
			completeSimple: async (_model, context) => {
				const serialized = String(context.messages[0]?.content);
				if (serialized.includes("<summary_source>")) {
					return response("## Strategic knowledge\n- Stable rule.");
				}
				return response(
					"## Strategic knowledge\n- Stable rule.\n\n## Tactical knowledge\n- Active debt.",
				);
			},
			runtimeEnv: {},
		});
		const runner = getWorkflowTriggerRunner(fake.pi);
		if (runner === undefined) {
			throw new Error("workflow trigger runner missing");
		}

		// ACT
		const result = await runner.run(
			{ type: "local_knowledge_accumulation" },
			createContext(fake.notifications, true),
			undefined,
		);

		// ASSERT
		expect(result).toEqual({ ok: true });
		expect(fake.notifications).toEqual([
			"[knowledge] preparing local knowledge summary...",
			"[knowledge] merging local knowledge...",
		]);
	});

	/**
	 * Proves a reduced-target extraction retry announces its new A4-page size in TUI mode.
	 * Inputs and expected outputs: one truncated extraction is retried at 1/2, then extraction and merge fit.
	 * Edge case: the retry progress message appears between preparation and merge progress.
	 * Dependencies: trigger progress is emitted through the workflow runner boundary.
	 */
	test("reports reduced-target extraction retry with its new size", async () => {
		// ARRANGE
		const dataDir = await mkdtemp(join(tmpdir(), "pi-knowledge-retry-notify-"));
		temporaryDirectories.push(dataDir);
		const fake = createPi();
		knowledgeExtension(fake.pi, {
			readConfig: () => ({ kind: "valid", config: config(dataDir) }),
			resolveProject: () => readWriteResolution(),
			completeSimple: async (_model, context) => {
				const serialized = String(context.messages[0]?.content);
				if (serialized.includes("<summary_source>")) {
					if (serialized.includes("1/2 of an A4 page")) {
						return response("## Strategic knowledge\n- Stable rule.");
					}
					return response("", "length");
				}
				return response(
					"## Strategic knowledge\n- Stable rule.\n\n## Tactical knowledge\n- Active debt.",
				);
			},
			runtimeEnv: {},
		});
		const runner = getWorkflowTriggerRunner(fake.pi);
		if (runner === undefined) {
			throw new Error("workflow trigger runner missing");
		}

		// ACT
		const result = await runner.run(
			{ type: "local_knowledge_accumulation" },
			createContext(fake.notifications, true),
			undefined,
		);

		// ASSERT
		expect(result).toEqual({ ok: true });
		expect(fake.notifications).toEqual([
			"[knowledge] preparing local knowledge summary...",
			"[knowledge] extraction output too large, retrying with a reduced target (1/2 of an A4 page)...",
			"[knowledge] merging local knowledge...",
		]);
	});

	/**
	 * Proves a successful knowledge trigger writes one TUI-only outcome entry to the session journal.
	 * Inputs and expected outputs: one successful local accumulation produces one knowledge-outcome entry with kind success.
	 * Edge case: the outcome entry is presentation-only and does not enter the LLM context.
	 * Dependencies: trigger success path and the extension's appendEntry boundary.
	 */
	test("persists knowledge outcome entry on successful trigger", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "pi-knowledge-outcome-"));
		temporaryDirectories.push(dataDir);
		const fake = createPi();
		knowledgeExtension(fake.pi, {
			readConfig: () => ({ kind: "valid", config: config(dataDir) }),
			resolveProject: () => readWriteResolution(),
			completeSimple: async (_model, context) => {
				const serialized = String(context.messages[0]?.content);
				if (serialized.includes("<summary_source>")) {
					return response("## Strategic knowledge\n- Stable rule.");
				}
				return response(
					"## Strategic knowledge\n- Stable rule.\n\n## Tactical knowledge\n- Active debt.",
				);
			},
			runtimeEnv: {},
		});
		const runner = getWorkflowTriggerRunner(fake.pi);
		if (runner === undefined) {
			throw new Error("workflow trigger runner missing");
		}

		const ctx = createContext(fake.notifications, true);
		const result = await runner.run(
			{ type: "local_knowledge_accumulation" },
			ctx,
			undefined,
		);

		expect(result).toEqual({ ok: true });
		expect(fake.pi.sendMessageCalls).toContainEqual({
			customType: "knowledge-outcome",
			content: "[knowledge] local knowledge merge completed",
			display: true,
			details: {
				kind: "success",
				triggerType: "local_knowledge_accumulation",
			},
		});
	});

	/**
	 * Proves loaded skill roots are retained for the next workflow-trigger projection replay.
	 * Inputs and expected outputs: one skill base directory is forwarded to the injected replay boundary.
	 * Edge case: context delivery before the trigger must not discard the captured skill set.
	 * Dependencies: before_agent_start supplies Pi's current skill metadata.
	 */
	test("replays trigger context with the loaded skill roots", async () => {
		// ARRANGE
		const dataDir = await mkdtemp(join(tmpdir(), "pi-knowledge-skills-"));
		temporaryDirectories.push(dataDir);
		const fake = createPi();
		let replayedSkillRoots: readonly string[] | undefined;
		knowledgeExtension(fake.pi, {
			readConfig: () => ({ kind: "valid", config: config(dataDir) }),
			resolveProject: () => readWriteResolution(),
			completeSimple: async () => response("NOT_FOUND"),
			replay: async (options) => {
				replayedSkillRoots = options.loadedSkillRoots;
				return [];
			},
			runtimeEnv: {},
		});
		const ctx = createContext(fake.notifications);
		const handler = fake.handlers.get("before_agent_start")?.[0];
		const runner = getWorkflowTriggerRunner(fake.pi);
		if (handler === undefined || runner === undefined) {
			throw new Error("knowledge lifecycle handler missing");
		}
		await handler(
			{
				systemPrompt: "Base",
				systemPromptOptions: {
					cwd: "/project",
					skills: [{ baseDir: "/skills/knowledge" }],
				},
			},
			ctx,
		);

		// ACT
		const result = await runner.run(
			{ type: "local_knowledge_accumulation" },
			ctx,
			undefined,
		);

		// ASSERT
		expect(result).toEqual({ ok: true });
		expect(replayedSkillRoots).toEqual([resolve("/skills/knowledge")]);
		expect(fake.notifications).toEqual([
			"[knowledge] preparing local knowledge summary...",
		]);
	});

	/**
	 * Proves a present invalid configuration disables every knowledge runtime role without default fallback.
	 * Inputs and expected outputs: invalid config registers no trigger or context source, reports one safe startup warning only with TUI,
	 * and echoes the parser reason to stderr in every mode.
	 * Edge case: reading the shared context registry after startup still returns null.
	 * Dependencies: configuration validation itself is covered by config.test.ts.
	 */
	test("keeps runtime disabled for invalid present configuration", async () => {
		// Arrange: extension initialization receives one invalid config result.
		const fake = createPi();
		knowledgeExtension(fake.pi, {
			readConfig: () => ({ kind: "invalid", issue: "invalid private path" }),
		});
		const ctx = createContext(
			fake.notifications,
			true,
			fake.notificationLevels,
		);
		const stderrLines: string[] = [];
		const originalStderrWrite = process.stderr.write;
		process.stderr.write = (chunk: string) => {
			stderrLines.push(chunk);
			return true;
		};
		try {
			// Act: emit the startup warning handler if registration created one.
			for (const handler of fake.handlers.get("session_start") ?? []) {
				await handler({ type: "session_start" }, ctx);
			}
		} finally {
			process.stderr.write = originalStderrWrite;
		}

		// Assert: no fallback runtime exists, the TUI warning echoes the parser reason, and stderr does too.
		expect(getWorkflowTriggerRunner(fake.pi)).toBeUndefined();
		expect(await readKnowledgeBlock(fake.pi, ctx)).toBeNull();
		expect(fake.notifications).toEqual([
			"[knowledge] invalid configuration: invalid private path",
		]);
		expect(fake.notificationLevels).toEqual(["error"]);
		expect(stderrLines).toEqual([
			"[knowledge] invalid configuration: invalid private path\n",
		]);
	});

	/**
	 * Proves the knowledge extension registers its two accumulation algorithms in the shared registry.
	 * Inputs and expected outputs: both trigger types resolve after extension load.
	 * Edge case: registration is scoped to the same pi instance that loaded the extension.
	 * Dependencies: the shared algorithm registry is the single manual-launch source.
	 */
	test("registers its accumulation algorithms in the algorithm registry", async () => {
		// Arrange: one enabled extension with a no-op extraction outcome.
		const dataDir = await mkdtemp(join(tmpdir(), "pi-knowledge-registry-"));
		temporaryDirectories.push(dataDir);
		const fake = createPi();
		knowledgeExtension(fake.pi, {
			readConfig: () => ({ kind: "valid", config: config(dataDir) }),
			resolveProject: () => readWriteResolution(),
			completeSimple: async () => response("NOT_FOUND"),
			runtimeEnv: {},
		});

		// Act: read the shared registry entries.
		const types = getTriggerAlgorithms(fake.pi)
			.map(({ type }) => type)
			.sort();

		// Assert: both knowledge algorithms are available for manual launch.
		expect(types).toEqual([
			"global_knowledge_accumulation",
			"local_knowledge_accumulation",
		]);
		expect(
			getTriggerAlgorithm(fake.pi, "local_knowledge_accumulation"),
		).toBeDefined();
		expect(
			getTriggerAlgorithm(fake.pi, "global_knowledge_accumulation"),
		).toBeDefined();
	});
});
