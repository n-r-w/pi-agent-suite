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
import { type ExitTarget, LaunchGate } from "./launch-gate";
import {
	applyLaunchedSubagent,
	failLaunchWhenDisabled,
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

/** Fake session context that records notifications and shutdown requests. */
interface ContextFake extends ExtensionContext {
	/** Notifications that the code under test showed. */
	readonly notifications: Array<{ message: string; type: string | undefined }>;
	/** One entry per shutdown request. */
	readonly shutdowns: number[];
}

/** How the fake model registry answers the lookup of provider credentials. */
type ProviderAuthMode = "resolved" | "missing" | "failing";

/** Process stand-in, so that a test never changes the exit code of the test run. */
function createExitTarget(): ExitTarget {
	return { exitCode: undefined, once: () => undefined };
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

/** Creates the session context with observable notifications and shutdown requests. */
function createContext(
	cwd: string,
	providerAuth: ProviderAuthMode = "resolved",
): ContextFake {
	const notifications: ContextFake["notifications"] = [];
	const shutdowns: number[] = [];
	return {
		cwd,
		hasUI: true,
		model: SESSION_MODEL,
		sessionManager: { getSessionId: () => "launched-session" },
		notifications,
		shutdowns,
		shutdown: () => {
			shutdowns.push(shutdowns.length);
		},
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
			getProviderAuth: async () => {
				if (providerAuth === "failing") {
					throw new Error(
						"Failed to resolve API key from shell command: false",
					);
				}
				return providerAuth === "missing"
					? undefined
					: { auth: { apiKey: "key" } };
			},
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

	/** Creates the gate of one process with a process stand-in for the exit code. */
	function createGate(): LaunchGate {
		return new LaunchGate(createExitTarget());
	}

	/** Runs the application of a launched agent and returns the text that reached stderr. */
	async function applyWithStderr(
		pi: PiFake,
		ctx: ContextFake,
		gate: LaunchGate,
	): Promise<string> {
		const stderr = spyOn(process.stderr, "write").mockImplementation(
			() => true,
		);
		try {
			await applyLaunchedSubagent(pi, ctx, gate);
			return stderr.mock.calls.flat().join("");
		} finally {
			stderr.mockRestore();
		}
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

		const ctx = createContext(directory.path);
		const gate = createGate();

		await applyLaunchedSubagent(pi, ctx, gate);

		expect(
			getAgentRuntimeComposition(pi).getSelectedAgentContribution(),
		).toBeUndefined();
		expect(pi.setModelCalls).toEqual([]);
		expect(pi.thinkingCalls).toEqual([]);
		expect(gate.failed).toBe(false);
		expect(ctx.shutdowns).toEqual([]);
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

		const ctx = createContext(directory.path);
		const gate = createGate();

		await applyLaunchedSubagent(pi, ctx, gate);

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
		expect(gate.failed).toBe(false);
		expect(ctx.shutdowns).toEqual([]);
	});

	test("resolves the thinking level of a child when the definition names none", async () => {
		// Purpose: a launched subagent resolves model and thinking by the rules that run-subagent uses for a child.
		// Input and expected output: current thinking medium is resolved against a model without reasoning and applied as off.
		// Edge case: configured thinking is absent, so the current session level is the source.
		// Dependencies: shared thinking resolution and public thinking API.
		writeAgent("Worker", ["type: subagent", "model:", "  id: provider/plain"]);
		const pi = createLaunchedPi("Worker");

		const ctx = createContext(directory.path);
		const gate = createGate();

		await applyLaunchedSubagent(pi, ctx, gate);

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

		const ctx = createContext(directory.path);
		const gate = createGate();

		await applyLaunchedSubagent(pi, ctx, gate);

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
			issue: "type main",
		},
		{
			name: "the definition is invalid",
			files: () => writeAgent("Worker", ["type: subagent", "unknown: 1"]),
			issue: "unsupported frontmatter fields: unknown",
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
	])("fails the launch and applies nothing when $name", async ({
		files,
		issue,
	}) => {
		// Purpose: an agent that cannot be applied must end the launch with its reason, and leave no partial slot or session change.
		// Input and expected output: stderr names the cause, the gate reports a failure, one shutdown is requested, no slot, and no model or thinking call.
		// Edge case: Pi mode rpc has a UI, and the reason still reaches stderr, not only a notification.
		// Dependencies: isolated registry, the gate, and process stderr.
		files();
		const pi = createLaunchedPi("Worker");
		const ctx = createContext(directory.path);
		const gate = createGate();

		const stderr = await applyWithStderr(pi, ctx, gate);

		expect(stderr).toContain(issue);
		expect(gate.failed).toBe(true);
		expect(ctx.shutdowns).toHaveLength(1);
		expect(
			getAgentRuntimeComposition(pi).getSelectedAgentContribution(),
		).toBeUndefined();
		expect(pi.setModelCalls).toEqual([]);
		expect(pi.thinkingCalls).toEqual([]);
	});

	test("fails the launch when Pi rejects the model", async () => {
		// Purpose: a model that Pi cannot use, for example without credentials, ends the launch and leaves no slot.
		// Input and expected output: setModel returns false, stderr names the model, and the slot stays empty.
		// Edge case: the thinking level is not applied after the model failed.
		// Dependencies: public model API, the gate, and process stderr.
		writeAgent("Worker", [
			"type: subagent",
			"model:",
			"  id: provider/reasoner",
		]);
		const pi = createLaunchedPi("Worker", { setModelResult: false });
		const ctx = createContext(directory.path);
		const gate = createGate();

		const stderr = await applyWithStderr(pi, ctx, gate);

		expect(stderr).toContain("provider/reasoner");
		expect(gate.failed).toBe(true);
		expect(ctx.shutdowns).toHaveLength(1);
		expect(
			getAgentRuntimeComposition(pi).getSelectedAgentContribution(),
		).toBeUndefined();
		expect(pi.thinkingCalls).toEqual([]);
	});

	test.each([
		{
			name: "the model of the definition matches the session model and has no credentials",
			frontmatter: ["model:", "  id: session/default"],
			providerAuth: "missing" as const,
			issue: "session/default",
		},
		{
			name: "the definition names no model and the session model has no credentials",
			frontmatter: [],
			providerAuth: "missing" as const,
			issue: "session/default",
		},
		{
			name: "the credential command of the provider fails",
			frontmatter: ["model:", "  id: provider/reasoner"],
			providerAuth: "failing" as const,
			issue: "shell command: false",
		},
	])("fails the launch before the agent starts when $name", async ({
		frontmatter,
		providerAuth,
		issue,
	}) => {
		// Purpose: Pi accepts a model without usable credentials until the first prompt, so the launch must check them before it publishes the agent.
		// Input and expected output: stderr names the cause, the gate reports a failure, one shutdown is requested, and the slot stays empty.
		// Edge case: setModel is skipped when the model matches the session model, and a failing credential command is not an absent credential.
		// Dependencies: isolated registry, fake model registry, the gate, and process stderr.
		writeAgent("Worker", ["type: subagent", ...frontmatter]);
		const pi = createLaunchedPi("Worker");
		const ctx = createContext(directory.path, providerAuth);
		const gate = createGate();

		const stderr = await applyWithStderr(pi, ctx, gate);

		expect(stderr).toContain(issue);
		expect(gate.failed).toBe(true);
		expect(ctx.shutdowns).toHaveLength(1);
		expect(
			getAgentRuntimeComposition(pi).getSelectedAgentContribution(),
		).toBeUndefined();
		expect(pi.thinkingCalls).toEqual([]);
	});

	test("fails the launch when applying the definition throws", async () => {
		// Purpose: an unexpected error while applying the definition must end the launch like any other reason, not only reject the session start.
		// Input and expected output: stderr names the error, the gate reports a failure, one shutdown is requested, and the slot stays empty.
		// Edge case: the error comes from the Pi API after the definition was found and validated.
		// Dependencies: isolated registry, the gate, and process stderr.
		writeAgent("Worker", ["type: subagent", "tools:", "  - read"]);
		const pi = createLaunchedPi("Worker");
		pi.getAllTools = () => {
			throw new Error("tool registry is unavailable");
		};
		const ctx = createContext(directory.path);
		const gate = createGate();

		const stderr = await applyWithStderr(pi, ctx, gate);

		expect(stderr).toContain("tool registry is unavailable");
		expect(gate.failed).toBe(true);
		expect(ctx.shutdowns).toHaveLength(1);
		expect(
			getAgentRuntimeComposition(pi).getSelectedAgentContribution(),
		).toBeUndefined();
	});

	test("fails the launch when --agent is set in the same process", async () => {
		// Purpose: the two flags name two different agents, so the process runs neither.
		// Input and expected output: stderr names both flag values, the gate reports a failure, and the slot stays empty.
		// Edge case: the subagent definition is valid.
		// Dependencies: isolated registry, the composition resolver of flag --agent, and process stderr.
		writeAgent("Worker", ["type: subagent"]);
		const pi = createLaunchedPi("Worker");
		getAgentRuntimeComposition(pi).setAgentFlagResolver(() => "Lead");
		const ctx = createContext(directory.path);
		const gate = createGate();

		const stderr = await applyWithStderr(pi, ctx, gate);

		expect(stderr).toContain("--agent Lead");
		expect(stderr).toContain("--subagent Worker");
		expect(gate.failed).toBe(true);
		expect(ctx.shutdowns).toHaveLength(1);
		expect(
			getAgentRuntimeComposition(pi).getSelectedAgentContribution(),
		).toBeUndefined();
		expect(pi.setModelCalls).toEqual([]);
	});

	test("fails the launch when run-subagent is disabled", () => {
		// Purpose: a disabled run-subagent cannot apply the definition, and the launcher must learn it.
		// Input and expected output: stderr names the agent and the configuration issue, and the gate reports a failure.
		// Edge case: the configuration has no issue text, and a process without the flag fails nothing.
		// Dependencies: the composition resolver of the launch flag, the gate, and process stderr.
		const ctx = createContext(directory.path);
		const gate = createGate();
		const stderr = spyOn(process.stderr, "write").mockImplementation(
			() => true,
		);
		try {
			failLaunchWhenDisabled(createPi(), ctx, gate, undefined);
			expect(gate.failed).toBe(false);

			failLaunchWhenDisabled(
				createLaunchedPi("Worker"),
				ctx,
				gate,
				"bad config",
			);

			const text = stderr.mock.calls.flat().join("");
			expect(text).toContain("--subagent Worker");
			expect(text).toContain("bad config");
		} finally {
			stderr.mockRestore();
		}
		expect(gate.failed).toBe(true);
		expect(ctx.shutdowns).toHaveLength(1);
	});
});
