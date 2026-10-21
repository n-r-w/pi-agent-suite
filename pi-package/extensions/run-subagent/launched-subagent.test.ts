import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	createEventBus,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createTempDir } from "../../../test/support/temp-dir";
import { getAgentRuntimeComposition } from "../../shared/agent-runtime-composition";
import { AGENT_SUITE_DIR_ENV } from "../../shared/agent-suite-storage";
import { publishWorkflowCatalogPolicy } from "../../shared/workflow-policy";
import {
	applyLaunchedSubagent,
	LAUNCHED_SUBAGENT_FLAG,
	registerLaunchedSubagentFlag,
} from "./launched-subagent";

/** Model that supports thinking levels. */
const REASONING_MODEL = createModel("provider", "reasoner", true);
/** Model without reasoning, which supports only the off level. */
const PLAIN_MODEL = createModel("provider", "plain", false);
/** Model that the session uses before a definition is applied. */
const SESSION_MODEL = createModel("session", "default", true);

/** Fake extension API that records flag, model, and thinking calls. */
interface PiFake extends ExtensionAPI {
	readonly flags: Map<string, boolean | string>;
	readonly registeredFlags: string[];
	readonly setModelCalls: Model<Api>[];
	readonly thinkingCalls: string[];
}

/** Controls the answers of the fake extension API. */
interface PiFakeOptions {
	readonly flags?: ReadonlyMap<string, boolean | string>;
	readonly setModelResult?: boolean;
	readonly allTools?: readonly string[];
}

/** Fake session context that records notifications. */
interface ContextFake extends ExtensionContext {
	readonly notifications: Array<{ message: string; type: string | undefined }>;
}

/** Creates a fake model with the given reasoning support. */
function createModel(
	provider: string,
	id: string,
	reasoning: boolean,
): Model<Api> {
	return {
		provider,
		id,
		api: "fake-api",
		baseUrl: "https://example.test",
		reasoning,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		name: `${provider}/${id}`,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_192,
	};
}

/** Creates the narrow public API surface that applying a launched subagent uses. */
function createPi(options: PiFakeOptions = {}): PiFake {
	const flags = new Map<string, boolean | string>(options.flags ?? []);
	const registeredFlags: string[] = [];
	const setModelCalls: Model<Api>[] = [];
	const thinkingCalls: string[] = [];
	const allTools = options.allTools ?? ["read", "bash", "subagent_start"];
	let activeTools = [...allTools];
	let thinking = "medium";
	return {
		flags,
		registeredFlags,
		setModelCalls,
		thinkingCalls,
		events: createEventBus(),
		on: () => undefined,
		registerFlag: (name: string) => {
			registeredFlags.push(name);
		},
		getFlag: (name: string) => flags.get(name),
		getAllTools: () => allTools.map((name) => ({ name })),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
		setModel: async (model: Model<Api>) => {
			setModelCalls.push(model);
			return options.setModelResult ?? true;
		},
		getThinkingLevel: () => thinking,
		setThinkingLevel: (level: string) => {
			thinkingCalls.push(level);
			thinking = level;
		},
	} as unknown as PiFake;
}

/** Creates the session context with an observable issue channel. */
function createContext(cwd: string, hasUI = true): ContextFake {
	const notifications: ContextFake["notifications"] = [];
	return {
		cwd,
		hasUI,
		model: SESSION_MODEL,
		sessionManager: { getSessionId: () => "launched-session" },
		notifications,
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
		},
		modelRegistry: {
			find: (provider: string, id: string) =>
				[REASONING_MODEL, PLAIN_MODEL, SESSION_MODEL].find(
					(model) => model.provider === provider && model.id === id,
				),
		},
	} as unknown as ContextFake;
}

describe("launched subagent", () => {
	let directory: ReturnType<typeof createTempDir>;
	let suite: ReturnType<typeof createTempDir>;
	let previousSuiteDir: string | undefined;

	beforeEach(() => {
		directory = createTempDir("run-subagent-launched-");
		suite = createTempDir("run-subagent-launched-suite-");
		previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
		process.env[AGENT_SUITE_DIR_ENV] = suite.path;
		mkdirSync(join(suite.path, "agent-selection", "agents"), {
			recursive: true,
		});
		publishWorkflowCatalogPolicy({ ids: ["Review"] });
	});

	afterEach(() => {
		directory.remove();
		suite.remove();
		if (previousSuiteDir === undefined) {
			delete process.env[AGENT_SUITE_DIR_ENV];
		} else {
			process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
		}
	});

	/** Writes one agent definition into the isolated suite registry. */
	function writeAgent(
		id: string,
		frontmatter: string[],
		body = "Prompt",
	): void {
		writeFileSync(
			join(suite.path, "agent-selection", "agents", `${id}.md`),
			["---", `description: ${id}`, ...frontmatter, "---", body].join("\n"),
		);
	}

	/** Creates a process that was launched for one agent ID. */
	function createLaunchedPi(id: string, options: PiFakeOptions = {}): PiFake {
		const pi = createPi({
			...options,
			flags: new Map([[LAUNCHED_SUBAGENT_FLAG, id], ...(options.flags ?? [])]),
		});
		registerLaunchedSubagentFlag(pi);
		return pi;
	}

	test("registers flag subagent and shares its value through the composition", () => {
		// Purpose: only run-subagent owns the flag, and other extensions read its value through the composition.
		// Input and expected output: an absent flag reports no launch; a string value reports its ID.
		// Edge case: a boolean value reports no launch.
		// Dependencies: public flag API and the composition resolver.
		const pi = createPi();
		registerLaunchedSubagentFlag(pi);
		const composition = getAgentRuntimeComposition(pi);

		expect(pi.registeredFlags).toEqual([LAUNCHED_SUBAGENT_FLAG]);
		expect(composition.getLaunchedSubagentId()).toBeUndefined();
		pi.flags.set(LAUNCHED_SUBAGENT_FLAG, true);
		expect(composition.getLaunchedSubagentId()).toBeUndefined();
		pi.flags.set(LAUNCHED_SUBAGENT_FLAG, "Worker");
		expect(composition.getLaunchedSubagentId()).toBe("Worker");
	});

	test("changes nothing without the flag", async () => {
		// Purpose: processes without --subagent keep their behavior.
		// Input and expected output: no selected agent, no model, and no thinking call.
		// Edge case: a definition with the same ID as a later launch exists in the registry.
		// Dependencies: isolated registry.
		writeAgent("Worker", ["type: subagent"]);
		const pi = createPi();
		registerLaunchedSubagentFlag(pi);

		await applyLaunchedSubagent(pi, createContext(directory.path));

		expect(
			getAgentRuntimeComposition(pi).getSelectedAgentContribution(),
		).toBeUndefined();
		expect(pi.setModelCalls).toEqual([]);
		expect(pi.thinkingCalls).toEqual([]);
	});

	test.each([
		"subagent",
		"both",
	])("fills the selected-agent slot from a definition of type %s", async (type) => {
		// Purpose: the launched agent gets the prompt, tools, workflows, callable subagents, and model of its definition.
		// Input and expected output: the slot holds the resolved policies and the session gets the model and thinking of the definition.
		// Edge case: one tool pattern is a wildcard that matches a tool by prefix.
		// Dependencies: isolated registry, published workflow catalog, and public model and thinking APIs.
		writeAgent("Helper", ["type: subagent"]);
		writeAgent(
			"Worker",
			[
				`type: ${type}`,
				"model:",
				"  id: provider/reasoner",
				"  thinking: high",
				"tools:",
				'  - "subagent_*"',
				"  - read",
				"workflows:",
				"  - Review",
				"agents:",
				"  - Helper",
			],
			"Worker prompt",
		);
		const pi = createLaunchedPi("Worker");

		await applyLaunchedSubagent(pi, createContext(directory.path));

		expect(
			getAgentRuntimeComposition(pi).getSelectedAgentContribution(),
		).toEqual({
			prompt: "Worker prompt",
			agent: {
				id: "Worker",
				tools: ["subagent_start", "read"],
				workflows: ["Review"],
				agents: ["Helper"],
			},
			model: { id: "provider/reasoner", thinking: "high" },
			tools: ["subagent_start", "read"],
		});
		expect(pi.setModelCalls).toEqual([REASONING_MODEL]);
		expect(pi.thinkingCalls).toEqual(["high"]);
	});

	test("resolves the thinking level of a child when the definition names none", async () => {
		// Purpose: a launched subagent resolves model and thinking by the rules that run-subagent uses for a child.
		// Input and expected output: current thinking medium is resolved against a model without reasoning and applied as off.
		// Edge case: configured thinking is absent, so the current session level is the source.
		// Dependencies: shared thinking resolution and public thinking API.
		writeAgent("Worker", ["type: subagent", "model:", "  id: provider/plain"]);
		const pi = createLaunchedPi("Worker");

		await applyLaunchedSubagent(pi, createContext(directory.path));

		expect(pi.setModelCalls).toEqual([PLAIN_MODEL]);
		expect(pi.thinkingCalls).toEqual(["off"]);
	});

	test("keeps the session model and thinking when the definition names no model", async () => {
		// Purpose: nothing needs applying when the definition leaves model and thinking to the session.
		// Input and expected output: no setModel call and no thinking call.
		// Edge case: the session model supports the current thinking level.
		// Dependencies: public model and thinking APIs.
		writeAgent("Worker", ["type: subagent"]);
		const pi = createLaunchedPi("Worker");

		await applyLaunchedSubagent(pi, createContext(directory.path));

		expect(pi.setModelCalls).toEqual([]);
		expect(pi.thinkingCalls).toEqual([]);
		expect(
			getAgentRuntimeComposition(pi).getSelectedAgentContribution()?.agent?.id,
		).toBe("Worker");
	});

	test.each([
		{
			name: "no definition has the ID",
			files: () => undefined,
			issue: "Worker",
		},
		{
			name: "the definition has type main",
			files: () => writeAgent("Worker", ["type: main"]),
			issue: "Worker",
		},
		{
			name: "the model of the definition is unavailable",
			files: () =>
				writeAgent("Worker", [
					"type: subagent",
					"model:",
					"  id: provider/missing",
				]),
			issue: "provider/missing",
		},
		{
			name: "a tool pattern matches no tool",
			files: () =>
				writeAgent("Worker", ["type: subagent", "tools:", "  - nope"]),
			issue: "nope",
		},
		{
			name: "a workflow name is unknown",
			files: () =>
				writeAgent("Worker", ["type: subagent", "workflows:", "  - Missing"]),
			issue: "Missing",
		},
	])("reports an issue and applies nothing when $name", async ({
		files,
		issue,
	}) => {
		// Purpose: an agent that cannot be applied must not leave a partial slot or session change.
		// Input and expected output: one visible issue that names the cause, no slot, and no model or thinking call.
		// Edge case: the process continues without the agent after the issue.
		// Dependencies: isolated registry and the issue channel.
		files();
		const pi = createLaunchedPi("Worker");
		const ctx = createContext(directory.path);

		await applyLaunchedSubagent(pi, ctx);

		expect(ctx.notifications).toHaveLength(1);
		expect(ctx.notifications[0]?.type).toBe("warning");
		expect(ctx.notifications[0]?.message).toContain(issue);
		expect(
			getAgentRuntimeComposition(pi).getSelectedAgentContribution(),
		).toBeUndefined();
		expect(pi.setModelCalls).toEqual([]);
		expect(pi.thinkingCalls).toEqual([]);
	});

	test("reports the issue to stderr without a UI and applies nothing when Pi rejects the model", async () => {
		// Purpose: an issue must reach a launcher that has no UI, and a rejected model leaves no slot.
		// Input and expected output: setModel returns false, stderr names the model, and the slot stays empty.
		// Edge case: the thinking level is not applied after the model failed.
		// Dependencies: public model API and process stderr.
		writeAgent("Worker", [
			"type: subagent",
			"model:",
			"  id: provider/reasoner",
		]);
		const pi = createLaunchedPi("Worker", { setModelResult: false });
		const stderr = spyOn(process.stderr, "write").mockImplementation(
			() => true,
		);
		try {
			await applyLaunchedSubagent(pi, createContext(directory.path, false));

			expect(stderr.mock.calls.flat().join("")).toContain("provider/reasoner");
		} finally {
			stderr.mockRestore();
		}
		expect(
			getAgentRuntimeComposition(pi).getSelectedAgentContribution(),
		).toBeUndefined();
		expect(pi.thinkingCalls).toEqual([]);
	});
});
