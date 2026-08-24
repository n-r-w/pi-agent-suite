import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Check } from "typebox/value";
import {
	getAgentRuntimeComposition,
	MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT,
} from "../../shared/agent-runtime-composition";
import { CHILD_AGENT_PROCESS_ENV } from "../../shared/child-agent-environment";
import { SUBAGENT_WORKFLOW_IDS_ENV } from "../../shared/subagent-environment";
import {
	registerWorkflowTriggerRunner,
	type WorkflowTrigger,
	type WorkflowTriggerRunResult,
} from "../../shared/workflow-trigger-runtime";
import workflowExtension from "./index";
import {
	activateWorkflow,
	validateWorkflowDefinition,
	WORKFLOW_STATE_JOURNAL_VERSION,
} from "./workflow";

type WidgetFactory = (tui: TUI, theme: Theme) => Component;
type WidgetContent = string[] | WidgetFactory | undefined;

interface FakeTool {
	readonly name: string;
	readonly description: string;
	readonly promptGuidelines?: readonly string[];
	readonly executionMode?: string;
	readonly parameters: unknown;
	readonly execute: (...args: unknown[]) => Promise<unknown>;
}

interface FakePi {
	readonly handlers: Map<string, (...args: unknown[]) => unknown>;
	readonly listeners: Map<string, Set<(...args: unknown[]) => void>>;
	readonly tools: FakeTool[];
	readonly appended: Array<{ customType: string; data: unknown }>;
	readonly messages: Array<{
		readonly customType: string;
		readonly content: string;
		readonly display: boolean;
		readonly details: unknown;
		readonly options: unknown;
	}>;
	readonly notifications: Array<{ message: string; type: string | undefined }>;
	readonly modelSetCalls: Model<Api>[];
	readonly modelRegistry: ExtensionContext["modelRegistry"];
	activeTools: string[];
	appendError: Error | undefined;
	api: ExtensionAPI | undefined;
	model: Model<Api> | undefined;
	thinkingLevel: string;
	readonly ui: ExtensionContext["ui"];
	readonly widgetUpdates: Array<{ key: string; content: WidgetContent }>;
	flagValues: Map<string, boolean | string>;
	shutdownCalls: number;
}

const temporaryDirectories: string[] = [];
const originalSuiteDirectory = process.env["PI_AGENT_SUITE_DIR"];
const originalChildMarker = process.env[CHILD_AGENT_PROCESS_ENV];
const originalChildWorkflowIds = process.env[SUBAGENT_WORKFLOW_IDS_ENV];

/** Creates a complete suite fixture without reading real user configuration. */
async function createSuite(yaml?: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-workflow-index-"));
	temporaryDirectories.push(root);
	const extensionDirectory = join(root, "workflow");
	await mkdir(join(extensionDirectory, "workflows"), { recursive: true });
	if (yaml !== undefined) {
		await writeFile(
			join(extensionDirectory, "workflows", "delivery.yaml"),
			yaml,
		);
	}
	process.env["PI_AGENT_SUITE_DIR"] = root;
	delete process.env[CHILD_AGENT_PROCESS_ENV];
	delete process.env[SUBAGENT_WORKFLOW_IDS_ENV];
	return root;
}

/** Returns one workflow that supports an advance followed by route-based rework. */
function validYaml(): string {
	return "description: Delivery\nstages:\n  - id: start\n    description: Start\n    prompt: Start work\n    initial: true\n  - id: done\n    description: Done\n    prompt: Finish work\n    final: true\ntransitions:\n  - from: start\n    to: done\n    type: advance\n  - from: done\n    to: start\n    type: rework\n";
}

/** Returns a catalog workflow with root and initial-stage model settings. */
function modelYaml(): string {
	return "description: Delivery\nmodel:\n  id: openai/workflow-model\n  thinking: high\nstages:\n  - id: start\n    description: Start\n    prompt: Start work\n    initial: true\n    model:\n      thinking: xhigh\n  - id: done\n    description: Done\n    prompt: Finish work\n    final: true\ntransitions:\n  - from: start\n    to: done\n    type: advance\n  - from: done\n    to: start\n    type: rework\n";
}

/** Returns a workflow whose second stage must fall back to the selected agent model. */
function agentFallbackYaml(): string {
	return "description: Delivery\nstages:\n  - id: configured\n    description: Configured\n    prompt: Use the workflow model\n    initial: true\n    model:\n      id: openai/workflow-model\n      thinking: xhigh\n  - id: fallback\n    description: Fallback\n    prompt: Use the agent model\n    final: true\ntransitions:\n  - from: configured\n    to: fallback\n    type: advance\n  - from: fallback\n    to: configured\n    type: rework\n";
}

/** Returns a workflow whose initial stage uses an alias model and whose final stage has no settings. */
function aliasStageYaml(): string {
	return "description: Delivery\nstages:\n  - id: collect\n    description: Collect\n    prompt: Collect state\n    initial: true\n    model:\n      id: codex_extractor\n  - id: implement\n    description: Implement\n    prompt: Implement change\n    final: true\ntransitions:\n  - from: collect\n    to: implement\n    type: advance\n  - from: implement\n    to: collect\n    type: rework\n";
}

/** Creates one model fixture with optional support for model-specific thinking levels. */
function createModel(
	provider: string,
	id: string,
	extendedThinking = false,
): Model<Api> {
	return {
		provider,
		id,
		api: "fake-api",
		baseUrl: "https://example.test",
		reasoning: true,
		...(extendedThinking
			? { thinkingLevelMap: { xhigh: "xhigh", max: "max" } }
			: {}),
		name: `${provider}/${id}`,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_192,
	};
}

/** Creates one complete workflow_create argument object with a caller-owned identity. */
function createArguments(id = "dynamic-delivery"): Record<string, unknown> {
	return {
		id,
		description: "Dynamic delivery",
		prompt: "Follow the dynamic workflow.",
		stages: [
			{
				id: "start",
				description: "Start",
				prompt: "Start dynamic work",
				model: { thinking: "medium" },
				initial: true,
			},
			{
				id: "done",
				description: "Done",
				prompt: "Finish dynamic work",
				model: { thinking: "medium" },
				final: true,
			},
		],
		transitions: [
			{ from: "start", to: "done", type: "advance" },
			{ from: "done", to: "start", type: "rework" },
		],
	};
}

/** Adds ordered duplicate triggers to both stages of one dynamic workflow fixture. */
function triggeredCreateArguments(): Record<string, unknown> {
	const args = createArguments();
	const stages = args["stages"] as Record<string, unknown>[];
	stages[0] = {
		...stages[0],
		triggers: [
			{ type: "local_knowledge_accumulation" },
			{ type: "global_knowledge_accumulation" },
			{ type: "local_knowledge_accumulation" },
		],
	};
	stages[1] = {
		...stages[1],
		triggers: [{ type: "global_knowledge_accumulation" }],
	};
	return args;
}

/** Registers one fake runner and records persistence visible at each trigger attempt. */
function captureTriggers(
	fake: FakePi,
	result: WorkflowTriggerRunResult | Error = { ok: true },
	onRun?: (ctx: ExtensionContext, signal: AbortSignal | undefined) => void,
): Array<{ trigger: WorkflowTrigger; persistedKinds: readonly string[] }> {
	if (fake.api === undefined) {
		throw new Error("extension API missing");
	}
	const calls: Array<{
		trigger: WorkflowTrigger;
		persistedKinds: readonly string[];
	}> = [];
	registerWorkflowTriggerRunner(fake.api, {
		async run(trigger, ctx, signal) {
			onRun?.(ctx, signal);
			calls.push({
				trigger,
				persistedKinds: fake.appended.map(
					({ data }) => (data as { kind: string }).kind,
				),
			});
			if (result instanceof Error) {
				throw result;
			}
			return result;
		},
	});
	return calls;
}

/** Returns a registered workflow tool or fails the fixture with its missing identity. */
function requireTool(fake: FakePi, name: string): FakeTool {
	const tool = fake.tools.find((candidate) => candidate.name === name);
	if (tool === undefined) {
		throw new Error(`${name} tool missing`);
	}
	return tool;
}

/** Creates one validated saved state entry independent of the current catalog. */
function activatedEntry(): unknown {
	const workflow = validateWorkflowDefinition(
		"delivery",
		{
			description: "Delivery",
			stages: [
				{
					id: "start",
					description: "Start",
					prompt: "Start work",
					initial: true,
					triggers: [{ type: "local_knowledge_accumulation" }],
				},
				{
					id: "done",
					description: "Done",
					prompt: "Finish work",
					final: true,
				},
			],
			transitions: [{ from: "start", to: "done", type: "advance" }],
		},
		"fixture.yaml",
	);
	const state = activateWorkflow(workflow);
	return {
		type: "custom",
		customType: "workflow-state",
		data: {
			kind: "activated",
			workflow,
			route: state.route,
			restoration: { modelId: "openai/current-model", thinking: "medium" },
			journalVersion: WORKFLOW_STATE_JOURNAL_VERSION,
		},
	};
}

/** Captures only Pi APIs owned by the workflow entry point. */
async function createFakePi(): Promise<FakePi> {
	const widgetUpdates: Array<{ key: string; content: WidgetContent }> = [];
	const notifications: Array<{ message: string; type: string | undefined }> =
		[];
	const ui = {
		notify(message: string, type?: string): void {
			notifications.push({ message, type });
		},
		setWidget(key: string, content: WidgetContent): void {
			widgetUpdates.push({ key, content });
		},
	} as unknown as ExtensionContext["ui"];
	const currentModel = createModel("openai", "current-model");
	const workflowModel = createModel("openai", "workflow-model", true);
	const agentModel = createModel("openai-codex", "gpt-5.6-luna");
	const models = [currentModel, workflowModel, agentModel];
	const fake: FakePi = {
		handlers: new Map(),
		listeners: new Map(),
		tools: [],
		appended: [],
		messages: [],
		notifications,
		modelSetCalls: [],
		modelRegistry: {
			find(provider: string, id: string) {
				return models.find(
					(model) => model.provider === provider && model.id === id,
				);
			},
		} as ExtensionContext["modelRegistry"],
		activeTools: ["read"],
		appendError: undefined,
		api: undefined,
		model: currentModel,
		thinkingLevel: "medium",
		ui,
		widgetUpdates,
		flagValues: new Map(),
		shutdownCalls: 0,
	};
	const api = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			fake.handlers.set(event, handler);
		},
		registerTool(tool: FakeTool) {
			fake.tools.push(tool);
			fake.activeTools.push(tool.name);
		},
		getActiveTools() {
			return [...fake.activeTools];
		},
		setActiveTools(names: string[]) {
			fake.activeTools = [...names];
		},
		async setModel(model: Model<Api>) {
			fake.modelSetCalls.push(model);
			fake.model = model;
			return true;
		},
		getThinkingLevel() {
			return fake.thinkingLevel;
		},
		setThinkingLevel(level: string) {
			fake.thinkingLevel = level;
		},
		appendEntry(customType: string, data: unknown) {
			if (fake.appendError !== undefined) {
				throw fake.appendError;
			}
			fake.appended.push({ customType, data });
		},
		sendMessage(
			message: {
				customType: string;
				content: unknown;
				display: boolean;
				details?: unknown;
			},
			options?: unknown,
		) {
			fake.messages.push({
				customType: message.customType,
				content: String(message.content),
				display: message.display,
				details: message.details,
				options,
			});
		},
		registerFlag(
			name: string,
			options: {
				type: "boolean" | "string";
				default?: boolean | string;
			},
		) {
			if (options.default !== undefined && !fake.flagValues.has(name)) {
				fake.flagValues.set(name, options.default);
			}
		},
		getFlag(name: string) {
			return fake.flagValues.get(name);
		},
		events: {
			emit(event: string, ...args: unknown[]) {
				for (const listener of fake.listeners.get(event) ?? []) {
					listener(...args);
				}
			},
			on(event: string, listener: (...args: unknown[]) => void) {
				const listeners = fake.listeners.get(event) ?? new Set();
				listeners.add(listener);
				fake.listeners.set(event, listeners);
				return () => listeners.delete(listener);
			},
		},
	};
	const extensionApi = api as unknown as ExtensionAPI;
	fake.api = extensionApi;
	await workflowExtension(extensionApi);
	return fake;
}

/** Publishes one canonical main-agent workflow policy through runtime metadata. */
function setMainWorkflowPolicy(
	fake: FakePi,
	workflows: readonly string[] | undefined,
	tools?: readonly string[],
): void {
	if (fake.api === undefined) {
		throw new Error("extension API missing");
	}
	getAgentRuntimeComposition(fake.api).setMainAgentContribution({
		prompt: "main",
		...(tools === undefined ? {} : { tools }),
		agent: {
			id: "Main",
			...(workflows === undefined ? {} : { workflows }),
		},
	});
}

/** Invokes one captured lifecycle handler with an isolated branch. */
async function runLifecycle(
	fake: FakePi,
	event: "session_start" | "session_tree" | "session_shutdown",
	branch: readonly unknown[] = [],
	mode: ExtensionContext["mode"] = "tui",
): Promise<void> {
	const handler = fake.handlers.get(event);
	if (handler === undefined) {
		throw new Error(`missing ${event} handler`);
	}
	await handler(
		{ type: event },
		{
			mode,
			hasUI: mode === "tui" || mode === "rpc",
			ui: fake.ui,
			model: fake.model,
			modelRegistry: fake.modelRegistry,
			sessionManager: { getBranch: () => branch },
			shutdown: () => {
				fake.shutdownCalls++;
			},
		},
	);
}

/** Invokes one complete model turn with caller-owned finalized tool results. */
async function runTurn(
	fake: FakePi,
	toolCallCount: number,
	terminateResults?: readonly boolean[],
	message: unknown = {},
): Promise<void> {
	const start = fake.handlers.get("turn_start");
	const end = fake.handlers.get("turn_end");
	if (start === undefined || end === undefined) {
		throw new Error("missing workflow reminder turn handlers");
	}
	await start({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
	if (terminateResults !== undefined) {
		const toolEnd = fake.handlers.get("tool_execution_end");
		if (toolEnd === undefined) {
			throw new Error("missing workflow reminder tool execution handler");
		}
		for (const [index, terminate] of terminateResults.entries()) {
			await toolEnd({
				type: "tool_execution_end",
				toolCallId: `tool-${index}`,
				toolName: "fixture",
				result: { terminate },
				isError: false,
			});
		}
	}
	await end({
		type: "turn_end",
		turnIndex: 0,
		message,
		toolResults: Array.from({ length: toolCallCount }, () => ({})),
	});
}

/** Invokes the post-compaction lifecycle handler. */
async function runSessionCompact(fake: FakePi): Promise<void> {
	const handler = fake.handlers.get("session_compact");
	if (handler === undefined) {
		throw new Error("missing session_compact handler");
	}
	await handler({ type: "session_compact" });
}

/** Invokes the session-level settlement handler without providing a UI context. */
async function runAgentSettled(fake: FakePi): Promise<void> {
	const handler = fake.handlers.get("agent_settled");
	if (handler === undefined) {
		throw new Error("missing agent_settled handler");
	}
	await handler({ type: "agent_settled" });
}

/** Renders the latest shared status widget or fails with its missing state. */
function renderLatestStatus(fake: FakePi, width: number): string[] {
	const factory = fake.widgetUpdates.at(-1)?.content;
	if (typeof factory !== "function") {
		throw new Error("workflow status widget factory is missing");
	}
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
	return factory({} as TUI, theme)
		.render(width)
		.map((row) => stripVTControlCharacters(row));
}

/** Returns content from the latest persisted workflow lifecycle record. */
function latestWorkflowContent(fake: FakePi): string | undefined {
	return (
		[...fake.messages]
			.reverse()
			.find(({ details }) => isWorkflowLifecycleDetails(details)) ??
		fake.messages.at(-1)
	)?.content;
}

function isWorkflowLifecycleDetails(details: unknown): boolean {
	return (
		typeof details === "object" &&
		details !== null &&
		Reflect.get(details, "kind") !== "activation_options"
	);
}

afterEach(async () => {
	if (originalSuiteDirectory === undefined) {
		delete process.env["PI_AGENT_SUITE_DIR"];
	} else {
		process.env["PI_AGENT_SUITE_DIR"] = originalSuiteDirectory;
	}
	if (originalChildMarker === undefined) {
		delete process.env[CHILD_AGENT_PROCESS_ENV];
	} else {
		process.env[CHILD_AGENT_PROCESS_ENV] = originalChildMarker;
	}
	if (originalChildWorkflowIds === undefined) {
		delete process.env[SUBAGENT_WORKFLOW_IDS_ENV];
	} else {
		process.env[SUBAGENT_WORKFLOW_IDS_ENV] = originalChildWorkflowIds;
	}
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("workflow extension lifecycle", () => {
	/** Proves configured definitions exist before lifecycle policy resolution. */
	test("registers the five sequential workflow tools during initialization", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		expect(fake.tools.map(({ name }) => name)).toEqual([
			"workflow_activate",
			"workflow_get_stage",
			"workflow_edit_stage",
			"workflow_transition",
			"workflow_create",
		]);
		expect(
			fake.tools.every(({ executionMode }) => executionMode === "sequential"),
		).toBe(true);
		const workflowGuideline = fake.tools[0]?.promptGuidelines?.[0];
		expect(workflowGuideline?.length).toBeGreaterThan(0);
		expect(
			fake.tools.every(
				({ promptGuidelines }) =>
					promptGuidelines?.length === 1 &&
					promptGuidelines[0] === workflowGuideline,
			),
		).toBe(true);
		await runLifecycle(fake, "session_start");
		await runLifecycle(fake, "session_tree");
		expect(fake.tools).toHaveLength(5);
	});

	/**
	 * Proves both stage tools have closed schemas without a workflow identifier or immutable stage fields.
	 * Input and expected output: get accepts only stageId; edit requires stageId, description, prompt, and thinking.
	 * Edge cases: extended thinking is valid, while partial edits, workflowId, id, initial, final, triggers, and model.id are rejected.
	 * Dependencies: registered TypeBox schemas only.
	 */
	test("exposes closed stage get and edit schemas", async () => {
		await createSuite();
		const fake = await createFakePi();
		const get = requireTool(fake, "workflow_get_stage");
		const edit = requireTool(fake, "workflow_edit_stage");
		const getSchema = get.parameters as Parameters<typeof Check>[0];
		const editSchema = edit.parameters as Parameters<typeof Check>[0];
		const validEdit = {
			stageId: "start",
			description: "Revised start",
			prompt: "Use the revised requirements.",
			model: { thinking: "xhigh" },
		};

		expect(Check(getSchema, { stageId: "start" })).toBe(true);
		expect(Check(getSchema, { stageId: "start", workflowId: "other" })).toBe(
			false,
		);
		expect(Check(editSchema, validEdit)).toBe(true);
		for (const invalid of [
			{ ...validEdit, workflowId: "other" },
			{ ...validEdit, id: "replacement" },
			{ ...validEdit, initial: true },
			{ ...validEdit, final: true },
			{ ...validEdit, triggers: [] },
			{ ...validEdit, model: { thinking: "high", id: "openai/model" } },
			{ stageId: "start", description: "Partial" },
		] as const) {
			expect(Check(editSchema, invalid)).toBe(false);
		}
	});

	/**
	 * Proves the dynamic TypeBox boundary accepts only closed trigger objects with supported discriminators.
	 * Inputs and expected outputs: ordered supported trigger objects pass; unknown types, fields, and shapes fail.
	 * Edge case: omitting triggers remains valid.
	 * Dependencies: the registered workflow_create TypeBox schema.
	 */
	test("exposes the closed workflow trigger schema", async () => {
		await createSuite();
		const fake = await createFakePi();
		const create = requireTool(fake, "workflow_create");
		const schema = create.parameters as Parameters<typeof Check>[0];
		const valid = triggeredCreateArguments();

		expect(Check(schema, valid)).toBe(true);
		expect(Check(schema, createArguments())).toBe(true);
		for (const triggers of [
			[{ type: "unknown" }],
			[{ type: "local_knowledge_accumulation", extra: true }],
			[{}],
			["local_knowledge_accumulation"],
			null,
		] as const) {
			const invalid = triggeredCreateArguments();
			const stages = invalid["stages"] as Record<string, unknown>[];
			stages[0] = { ...stages[0], triggers };
			expect(Check(schema, invalid)).toBe(false);
		}
	});

	/**
	 * Proves the dynamic TypeBox boundary requires thinking-only model settings on every stage.
	 * Inputs and expected outputs: low, medium, and high pass on every stage; other levels and model IDs fail.
	 * Edge cases: root model settings and stages without model settings are rejected.
	 * Dependencies: the registered workflow_create TypeBox schema.
	 */
	test("requires thinking-only model settings on every stage", async () => {
		await createSuite();
		const fake = await createFakePi();
		const create = requireTool(fake, "workflow_create");
		const schema = create.parameters as Parameters<typeof Check>[0];

		const rootModel = createArguments();
		rootModel["model"] = { thinking: "medium" };
		expect(Check(schema, rootModel)).toBe(false);

		for (const stageIndex of [0, 1] as const) {
			const missingModel = createArguments();
			const stages = missingModel["stages"] as Record<string, unknown>[];
			delete stages[stageIndex]?.["model"];
			expect(Check(schema, missingModel)).toBe(false);
		}

		for (const thinking of ["low", "medium", "high"] as const) {
			const valid = createArguments();
			const stages = valid["stages"] as Record<string, unknown>[];
			for (const stage of stages) {
				stage["model"] = { thinking };
			}
			expect(Check(schema, valid)).toBe(true);
		}

		for (const model of [
			{ thinking: "off" },
			{ thinking: "minimal" },
			{ thinking: "xhigh" },
			{ thinking: "max" },
			{ thinking: "unknown" },
			{ id: "openai/gpt-test" },
			{ thinking: "high", id: "openai/gpt-test" },
			{ thinking: "high", extra: true },
			{},
		] as const) {
			const invalidStage = createArguments();
			const stages = invalidStage["stages"] as Record<string, unknown>[];
			stages[0] = { ...stages[0], model };
			expect(Check(schema, invalidStage)).toBe(false);
		}
	});

	/**
	 * Proves a valid empty catalog keeps workflow_create and universal guidance without activation options.
	 * Input and expected output: no YAML and no saved state leave only workflow_create active and project guidelines only.
	 * Edge case: workflow_activate and workflow_transition are system-suppressed independently.
	 * Dependencies: lifecycle reconciliation, prompt loading, and activation-options journaling.
	 */
	test("keeps creation active for an empty catalog", async () => {
		await createSuite();
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");

		expect(fake.activeTools).toEqual(["read", "workflow_create"]);
		const content = latestWorkflowContent(fake);
		expect(content).toBe("<workflow_activation_options />");
		expect(fake.handlers.has("context")).toBe(false);
	});

	/**
	 * Proves invalid catalog workflows cannot fail startup or suppress valid siblings.
	 * Inputs and expected output: one valid and two invalid YAML files keep activation available and produce one warning naming both invalid files.
	 * Edge case: session-tree reconciliation does not repeat the startup warning.
	 * Dependencies: isolated catalog files, real lifecycle synchronization, and the captured Pi notification API.
	 */
	test("skips invalid catalog workflows and reports one startup warning", async () => {
		const root = await createSuite(validYaml());
		const workflowDirectory = join(root, "workflow", "workflows");
		const malformedPath = join(workflowDirectory, "malformed.yaml");
		const invalidGraphPath = join(workflowDirectory, "invalid-graph.yaml");
		await Promise.all([
			writeFile(malformedPath, "stages: ["),
			writeFile(
				invalidGraphPath,
				"description: Invalid\nstages: []\ntransitions: []\n",
			),
		]);
		const fake = await createFakePi();

		await runLifecycle(fake, "session_start");
		await runLifecycle(fake, "session_tree");

		expect(fake.activeTools).toContain("workflow_activate");
		expect(fake.notifications).toHaveLength(1);
		const notification = fake.notifications[0];
		if (notification === undefined) {
			throw new Error("workflow warning missing");
		}
		expect(notification.type).toBe("warning");
		expect(notification.message).toContain(malformedPath);
		expect(notification.message).toContain(invalidGraphPath);
		expect(notification.message).toContain(
			"workflow must have exactly one initial stage",
		);
		const activate = requireTool(fake, "workflow_activate");
		await activate.execute("activate-valid", { workflowId: "delivery" });
		expect(fake.appended).toHaveLength(1);
	});

	/**
	 * Proves legacy workflow entries do not block startup and produce one warning.
	 * Inputs and expected output: an old activation followed by a transition is ignored and catalog capabilities remain available.
	 * Edge case: ignoring only the activation would make the dependent transition fail during replay.
	 * Dependencies: workflow replay, lifecycle warning delivery, and catalog reconciliation.
	 */
	test("warns and ignores legacy workflow state", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		const activated = activatedEntry() as {
			readonly type: "custom";
			readonly customType: "workflow-state";
			readonly data: Record<string, unknown>;
		};
		const activatedData = activated.data;
		const { journalVersion: _journalVersion, ...legacyData } = activatedData;
		const legacyBranch = [
			{ ...activated, data: legacyData },
			{
				type: "custom",
				customType: "workflow-state",
				data: { kind: "transitioned", route: ["start", "done"] },
			},
		];

		await runLifecycle(fake, "session_start");
		await runLifecycle(fake, "session_tree", legacyBranch);
		await runLifecycle(fake, "session_tree", legacyBranch);

		expect(fake.notifications).toEqual([
			{
				message:
					"[workflow] ignored workflow state from an older format; start a new workflow to continue",
				type: "warning",
			},
		]);
		expect(
			fake.messages.some(
				({ details }) =>
					isWorkflowLifecycleDetails(details) &&
					(details as Record<string, unknown>)["kind"] === "checkpoint",
			),
		).toBe(false);
		expect(fake.activeTools).toContain("workflow_activate");
		expect(fake.activeTools).toContain("workflow_transition");
	});

	/**
	 * Proves dynamic creation and transition remain independent from the catalog workflows allowlist.
	 * Input and expected output: workflows: [] permits create, restores policy-enabled transition, and advances dynamic state.
	 * Edge case: no activation options are projected before or after creation.
	 * Dependencies: per-tool reconciliation, dynamic snapshots, and source-aware policy checks.
	 */
	test("creates and transitions a dynamic workflow under an empty allowlist", async () => {
		await createSuite();
		const fake = await createFakePi();
		setMainWorkflowPolicy(fake, []);
		await runLifecycle(fake, "session_start");
		const create = requireTool(fake, "workflow_create");
		const transition = requireTool(fake, "workflow_transition");
		const triggerCalls = captureTriggers(fake);

		expect(await create.execute("create", createArguments())).toMatchObject({
			content: [{ type: "text", text: '{"success":true}' }],
		});
		expect(fake.activeTools).toEqual([
			"read",
			"workflow_get_stage",
			"workflow_edit_stage",
			"workflow_transition",
			"workflow_create",
		]);
		expect(
			await transition.execute("transition", { stageId: "done" }),
		).toMatchObject({
			content: [{ type: "text", text: '{"success":true}' }],
		});
		expect(
			fake.appended.map(({ data }) => (data as { kind: string }).kind),
		).toEqual(["created", "transitioned"]);
		expect(triggerCalls).toEqual([]);
		const content = latestWorkflowContent(fake);
		expect(content).toContain(
			'<workflow_stage_activated workflow_id="dynamic-delivery" stage_id="done"',
		);
		expect(content).not.toContain("<workflow_activation_options");
	});

	/**
	 * Proves registered stage tools reject direct calls until a workflow is active.
	 * Input and expected output: no saved state hides both tools and both executions fail with the same active-workflow error.
	 * Edge case: registered definitions remain callable in the test despite availability filtering.
	 * Dependencies: lifecycle reconciliation and execution-time state checks.
	 */
	test("requires an active workflow for stage tools", async () => {
		await createSuite();
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const get = requireTool(fake, "workflow_get_stage");
		const edit = requireTool(fake, "workflow_edit_stage");

		expect(fake.activeTools).not.toContain("workflow_get_stage");
		expect(fake.activeTools).not.toContain("workflow_edit_stage");
		await expect(get.execute("get", { stageId: "start" })).rejects.toThrow(
			"no workflow is active",
		);
		await expect(
			edit.execute("edit", {
				stageId: "start",
				description: "Start",
				prompt: "Start only after activation.",
				model: { thinking: "medium" },
			}),
		).rejects.toThrow("no workflow is active");
	});

	/**
	 * Proves catalog workflows never expose or execute stage inspection and editing.
	 * Input and expected output: activating one catalog workflow keeps both tools hidden and direct calls reject it.
	 * Edge case: workflow_transition remains available for the same active catalog workflow.
	 * Dependencies: workflow source tracking, availability filtering, and execution-time source checks.
	 */
	test("rejects stage tools for catalog workflows", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("activate", {
			workflowId: "delivery",
		});
		const get = requireTool(fake, "workflow_get_stage");
		const edit = requireTool(fake, "workflow_edit_stage");

		expect(fake.activeTools).not.toContain("workflow_get_stage");
		expect(fake.activeTools).not.toContain("workflow_edit_stage");
		expect(fake.activeTools).toContain("workflow_transition");
		await expect(get.execute("get", { stageId: "start" })).rejects.toThrow(
			"workflow_create",
		);
		await expect(
			edit.execute("edit", {
				stageId: "start",
				description: "Catalog stage",
				prompt: "Catalog stages cannot be edited.",
				model: { thinking: "medium" },
			}),
		).rejects.toThrow("workflow_create");
	});

	/**
	 * Proves stage tools read and change active and non-active stages in only the current active workflow.
	 * Input and expected output: dynamic creation exposes both tools; edits persist in the workflow journal.
	 * Edge cases: editing a non-active stage does not change current thinking, while editing the active stage applies thinking immediately.
	 * Dependencies: workflow availability, session persistence, workflow journaling, and model runtime application.
	 */
	test("gets and edits stages in the current active workflow", async () => {
		await createSuite();
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const create = requireTool(fake, "workflow_create");
		await create.execute("create", createArguments());
		const get = requireTool(fake, "workflow_get_stage");
		const edit = requireTool(fake, "workflow_edit_stage");
		const transition = requireTool(fake, "workflow_transition");

		expect(fake.activeTools).toEqual(
			expect.arrayContaining(["workflow_get_stage", "workflow_edit_stage"]),
		);
		const initial = (await get.execute("get-start", {
			stageId: "start",
		})) as { content: Array<{ type: string; text: string }> };
		expect(JSON.parse(initial.content[0]?.text ?? "null")).toEqual({
			id: "start",
			description: "Start",
			prompt: "Start dynamic work",
			model: { thinking: "medium" },
			initial: true,
			final: false,
		});

		await edit.execute("edit-done", {
			stageId: "done",
			description: "Revised done",
			prompt: "Use the revised final-stage requirements.",
			model: { thinking: "high" },
		});
		expect(fake.thinkingLevel).toBe("medium");
		const revisedDone = (await get.execute("get-done", {
			stageId: "done",
		})) as { content: Array<{ type: string; text: string }> };
		expect(JSON.parse(revisedDone.content[0]?.text ?? "null")).toMatchObject({
			id: "done",
			description: "Revised done",
			prompt: "Use the revised final-stage requirements.",
			model: { thinking: "high" },
			initial: false,
			final: true,
		});

		await transition.execute("transition", { stageId: "done" });
		expect(fake.thinkingLevel).toBe("high");
		await edit.execute("edit-active", {
			stageId: "done",
			description: "Correct final stage",
			prompt: "Follow the corrected requirements now.",
			model: { thinking: "low" },
		});
		expect(fake.thinkingLevel).toBe("low");
		expect(
			fake.appended.map(({ data }) => (data as { kind: string }).kind),
		).toEqual(["created", "stage_edited", "transitioned", "stage_edited"]);
		const content = latestWorkflowContent(fake);
		expect(content).toContain("Correct final stage");
		expect(content).toContain("Follow the corrected requirements now.");
	});

	/**
	 * Proves stage edits survive session replay and are unavailable once the workflow is completed.
	 * Input and expected output: replaying created and stage_edited entries returns revised stage content; settlement hides both tools.
	 * Edge case: direct calls against a completed saved snapshot fail instead of reading or changing it.
	 * Dependencies: session entry replay, agent settlement, and active-tool reconciliation.
	 */
	test("replays stage edits and hides stage tools after completion", async () => {
		await createSuite();
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_create").execute(
			"create",
			createArguments(),
		);
		const get = requireTool(fake, "workflow_get_stage");
		const edit = requireTool(fake, "workflow_edit_stage");
		await edit.execute("edit", {
			stageId: "done",
			description: "Saved revision",
			prompt: "Replay these corrected requirements.",
			model: { thinking: "high" },
		});
		const branch = fake.appended.map(({ customType, data }) => ({
			type: "custom",
			customType,
			data,
		}));
		await runLifecycle(fake, "session_tree", branch);
		const replayed = (await get.execute("get-replayed", {
			stageId: "done",
		})) as { content: Array<{ text: string }> };
		expect(JSON.parse(replayed.content[0]?.text ?? "null")).toMatchObject({
			description: "Saved revision",
			prompt: "Replay these corrected requirements.",
			model: { thinking: "high" },
		});

		await requireTool(fake, "workflow_transition").execute("done", {
			stageId: "done",
		});
		await runAgentSettled(fake);
		expect(fake.activeTools).not.toContain("workflow_get_stage");
		expect(fake.activeTools).not.toContain("workflow_edit_stage");
		await expect(
			get.execute("completed-get", { stageId: "done" }),
		).rejects.toThrow("no workflow is active");
		await expect(
			edit.execute("completed-edit", {
				stageId: "done",
				description: "Disallowed",
				prompt: "Do not edit a completed workflow.",
				model: { thinking: "medium" },
			}),
		).rejects.toThrow("no workflow is active");
	});

	/**
	 * Proves invalid or unpersisted edits leave the active snapshot and runtime settings unchanged.
	 * Input and expected output: unknown stages reject without append; append failure rolls back active-stage thinking.
	 * Edge case: get and edit share the same unknown-stage diagnostic.
	 * Dependencies: exact tool validation and atomic workflow model persistence.
	 */
	test("preserves active state when stage editing fails", async () => {
		await createSuite();
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_create").execute(
			"create",
			createArguments(),
		);
		const get = requireTool(fake, "workflow_get_stage");
		const edit = requireTool(fake, "workflow_edit_stage");
		const appendedBeforeFailure = fake.appended.length;
		await expect(
			get.execute("missing-get", { stageId: "missing" }),
		).rejects.toThrow("stage missing");
		await expect(
			edit.execute("missing-edit", {
				stageId: "missing",
				description: "Missing",
				prompt: "This stage does not exist.",
				model: { thinking: "high" },
			}),
		).rejects.toThrow("stage missing");
		expect(fake.appended).toHaveLength(appendedBeforeFailure);

		fake.appendError = new Error("append failed");
		await expect(
			edit.execute("failed-edit", {
				stageId: "start",
				description: "Unpersisted revision",
				prompt: "This change must roll back.",
				model: { thinking: "high" },
			}),
		).rejects.toThrow("append failed");
		expect(fake.thinkingLevel).toBe("medium");
		const current = (await get.execute("get-current", {
			stageId: "start",
		})) as { content: Array<{ text: string }> };
		expect(JSON.parse(current.content[0]?.text ?? "null")).toMatchObject({
			description: "Start",
			prompt: "Start dynamic work",
			model: { thinking: "medium" },
		});
	});

	/**
	 * Proves dynamic creation, advance, and rework run the entered stage triggers after each saved state entry.
	 * Inputs and expected outputs: duplicate initial triggers and one final trigger run in listed order on every entry.
	 * Edge case: rework re-enters the initial stage and repeats its full trigger list exactly once.
	 * Dependencies: the registered cross-extension runner and append-before-trigger ordering.
	 */
	test("runs dynamic stage triggers after persisted stage entry", async () => {
		await createSuite();
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const calls = captureTriggers(fake);
		const create = requireTool(fake, "workflow_create");
		const transition = requireTool(fake, "workflow_transition");

		await create.execute("create", triggeredCreateArguments());
		await transition.execute("advance", { stageId: "done" });
		await transition.execute("rework", { stageId: "start" });

		expect(calls.map(({ trigger }) => trigger.type)).toEqual([
			"local_knowledge_accumulation",
			"global_knowledge_accumulation",
			"local_knowledge_accumulation",
			"global_knowledge_accumulation",
			"local_knowledge_accumulation",
			"global_knowledge_accumulation",
			"local_knowledge_accumulation",
		]);
		expect(calls.map(({ persistedKinds }) => persistedKinds)).toEqual([
			["created"],
			["created"],
			["created"],
			["created", "transitioned"],
			["created", "transitioned", "transitioned"],
			["created", "transitioned", "transitioned"],
			["created", "transitioned", "transitioned"],
		]);
	});

	/** Proves trigger model and session resolution use the tool invocation that entered the stage. */
	test("passes the initiating context and cancellation signal after persistence", async () => {
		// Purpose: trigger model and session resolution must use the tool invocation that entered the stage.
		// Input and expected output: one triggered create forwards the exact context and signal after appending state.
		// Edge case: no copied or lifecycle context may replace either invocation-owned value.
		// Dependencies: the shared runner boundary and workflow create tool execution contract.
		await createSuite();
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const invocations: Array<{
			ctx: ExtensionContext;
			signal: AbortSignal | undefined;
		}> = [];
		captureTriggers(fake, { ok: true }, (ctx, signal) => {
			invocations.push({ ctx, signal });
		});
		const create = requireTool(fake, "workflow_create");
		const signal = new AbortController().signal;
		const ctx = { marker: "initiating-context" } as unknown as ExtensionContext;

		await create.execute(
			"create",
			triggeredCreateArguments(),
			signal,
			undefined,
			ctx,
		);

		expect(invocations).toEqual([
			{ ctx, signal },
			{ ctx, signal },
			{ ctx, signal },
		]);
		expect(
			fake.appended.map(({ data }) => (data as { kind: string }).kind),
		).toEqual(["created"]);
	});

	/**
	 * Proves catalog activation runs initial-stage triggers only after the activated snapshot is saved.
	 * Input and expected output: one triggered catalog workflow invokes local then global once.
	 * Edge case: duplicate-free catalog input uses the same runner contract as dynamic creation.
	 * Dependencies: catalog parsing, activation persistence, and the shared runner registry.
	 */
	test("runs catalog activation triggers after persistence", async () => {
		await createSuite(
			validYaml().replace(
				"    initial: true\n",
				"    initial: true\n    triggers:\n      - type: local_knowledge_accumulation\n      - type: global_knowledge_accumulation\n",
			),
		);
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const calls = captureTriggers(fake);
		const activate = requireTool(fake, "workflow_activate");

		await activate.execute("activate", { workflowId: "delivery" });

		expect(calls).toEqual([
			{
				trigger: { type: "local_knowledge_accumulation" },
				persistedKinds: ["activated"],
			},
			{
				trigger: { type: "global_knowledge_accumulation" },
				persistedKinds: ["activated"],
			},
		]);
	});

	/**
	 * Proves session and branch restoration reconstruct triggered workflow state without entering the restored stage.
	 * Input and expected output: a saved initial stage containing a trigger produces zero runner calls on both lifecycle events.
	 * Edge case: repeated branch restoration remains side-effect free.
	 * Dependencies: saved workflow replay and lifecycle synchronization.
	 */
	test("does not run triggers during workflow restoration", async () => {
		await createSuite();
		const fake = await createFakePi();
		const calls = captureTriggers(fake);

		await runLifecycle(fake, "session_start", [activatedEntry()]);
		await runLifecycle(fake, "session_tree", [activatedEntry()]);

		expect(calls).toEqual([]);
	});

	/**
	 * Proves runner failures remain non-blocking and stop the remaining triggers for that stage entry.
	 * Inputs and expected outputs: a reported failure and a thrown failure each preserve the exact workflow success result.
	 * Edge case: only the first of three listed triggers is attempted after either failure form.
	 * Dependencies: sequential trigger dispatch and workflow success-result stability.
	 */
	test.each([
		["reported", { ok: false } as const],
		["thrown", new Error("runner failed")],
	])("keeps workflow success after a %s runner failure", async (_case, failure) => {
		await createSuite();
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const calls = captureTriggers(fake, failure);
		const create = requireTool(fake, "workflow_create");

		const result = await create.execute("create", triggeredCreateArguments());

		expect(result).toEqual({
			content: [{ type: "text", text: '{"success":true}' }],
			details: {},
		});
		expect(calls.map(({ trigger }) => trigger.type)).toEqual([
			"local_knowledge_accumulation",
		]);
	});

	/**
	 * Proves workflow IDs use exact NFC identity and rejected creates are atomic.
	 * Input and expected output: a catalog case variant remains distinct, an exact active ID rejects, and a different ID replaces state.
	 * Edge case: append failure retains the prior catalog route before a later successful replacement.
	 * Dependencies: catalog normalization, dynamic state identity, and append-before-memory ordering.
	 */
	test("uses exact workflow IDs and atomically replaces a different workflow", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const create = requireTool(fake, "workflow_create");
		const activate = requireTool(fake, "workflow_activate");
		const transition = requireTool(fake, "workflow_transition");

		await create.execute("create", createArguments("DELIVERY"));
		await activate.execute("activate", { workflowId: "delivery" });
		await transition.execute("transition", { stageId: "done" });
		fake.appendError = new Error("append failed");
		await expect(
			create.execute("create", createArguments("new-delivery")),
		).rejects.toThrow("append failed");
		fake.appendError = undefined;
		const retained = latestWorkflowContent(fake);
		expect(retained).toContain(
			'<workflow_stage_activated workflow_id="delivery" stage_id="done"',
		);

		await create.execute("create", createArguments("new-delivery"));
		const entriesBeforeDuplicate = [...fake.appended];
		await expect(
			create.execute("create", createArguments("new-delivery")),
		).rejects.toThrow("already active");
		expect(fake.appended).toEqual(entriesBeforeDuplicate);
		const replaced = latestWorkflowContent(fake);
		expect(replaced).toContain(
			'<workflow_stage_activated workflow_id="new-delivery" stage_id="start"',
		);
	});

	/**
	 * Proves replacement never makes a dynamic workflow reactivatable.
	 * Input and expected output: dynamic A followed by catalog activation or dynamic B rejects activation of A.
	 * Edge case: recreating A after its first replacement starts a new snapshot that a later B still replaces.
	 * Dependencies: create replacement, catalog-only activation options, and direct activation validation.
	 */
	test("does not reactivate replaced dynamic workflows", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const create = requireTool(fake, "workflow_create");
		const activate = requireTool(fake, "workflow_activate");

		await create.execute("create-a", createArguments("dynamic-a"));
		await activate.execute("activate-catalog", { workflowId: "delivery" });
		await expect(
			activate.execute("reactivate-a", { workflowId: "dynamic-a" }),
		).rejects.toThrow("not available for activation");

		await create.execute("recreate-a", createArguments("dynamic-a"));
		await create.execute("create-b", createArguments("dynamic-b"));
		await expect(
			activate.execute("reactivate-replaced-a", { workflowId: "dynamic-a" }),
		).rejects.toThrow("not available for activation");
	});

	/** Proves an invalid configured override prevents temporary or fallback registration. */
	test("retains prompt initialization errors without registering tools", async () => {
		const root = await createSuite(validYaml());
		const configPath = join(root, "workflow", "config.json");
		await writeFile(
			configPath,
			JSON.stringify({
				activateDescriptionPromptFile: join(root, "missing-prompt.md"),
			}),
		);
		const fake = await createFakePi();
		expect(fake.tools).toEqual([]);
		await expect(runLifecycle(fake, "session_start")).rejects.toThrow(
			configPath,
		);
	});

	/** Proves a readable whitespace-only override also prevents registration. */
	test("does not fall back from an empty configured prompt", async () => {
		const root = await createSuite(validYaml());
		const promptPath = join(root, "empty-prompt.md");
		const configPath = join(root, "workflow", "config.json");
		await writeFile(promptPath, " \n");
		await writeFile(
			configPath,
			JSON.stringify({ activateDescriptionPromptFile: promptPath }),
		);
		const fake = await createFakePi();
		expect(fake.tools).toEqual([]);
		await expect(runLifecycle(fake, "session_start")).rejects.toThrow(
			"non-empty",
		);
	});

	/** Proves catalog activation applies stage-over-workflow model settings before persistence. */
	test("applies catalog model settings during activation", async () => {
		await createSuite(modelYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");

		await activate.execute("call", { workflowId: "delivery" });

		expect(
			fake.modelSetCalls.map(({ provider, id }) => `${provider}/${id}`),
		).toEqual(["openai/workflow-model"]);
		expect(fake.thinkingLevel).toBe("xhigh");
		expect(fake.appended[0]?.data).toMatchObject({
			kind: "activated",
			journalVersion: WORKFLOW_STATE_JOURNAL_VERSION,
			workflow: {
				model: { id: "openai/workflow-model", thinking: "high" },
			},
			restoration: { modelId: "openai/current-model", thinking: "medium" },
		});

		const transition = requireTool(fake, "workflow_transition");
		await transition.execute("call", { stageId: "done" });
		expect(
			fake.modelSetCalls.map(({ provider, id }) => `${provider}/${id}`),
		).toEqual(["openai/workflow-model"]);
		expect(fake.thinkingLevel).toBe("high");
	});

	/** Proves a stage without workflow settings applies the selected agent model. */
	test("applies agent model when returning to a stage without model settings", async () => {
		await createSuite(agentFallbackYaml());
		const fake = await createFakePi();
		if (fake.api === undefined) {
			throw new Error("extension API missing");
		}
		getAgentRuntimeComposition(fake.api).setMainAgentContribution({
			prompt: "main",
			model: {
				id: "openai-codex/gpt-5.6-luna",
				thinking: "medium",
			},
			agent: { id: "Main" },
		});
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");
		await activate.execute("call", { workflowId: "delivery" });
		expect(fake.model?.id).toBe("workflow-model");
		expect(fake.thinkingLevel).toBe("xhigh");

		const transition = requireTool(fake, "workflow_transition");
		await transition.execute("call", { stageId: "fallback" });

		expect(
			fake.modelSetCalls.map(({ provider, id }) => `${provider}/${id}`),
		).toEqual(["openai/workflow-model", "openai-codex/gpt-5.6-luna"]);
		expect(fake.model?.provider).toBe("openai-codex");
		expect(fake.model?.id).toBe("gpt-5.6-luna");
		expect(fake.thinkingLevel).toBe("medium");
	});

	/**
	 * Proves a stage without settings restores the pre-workflow model when no agent is available.
	 * Inputs and expected outputs: a process without an agent contribution returns to the pre-workflow model on the first model-less stage.
	 * Edge case: the pre-workflow restoration snapshot carries both the model and the thinking level.
	 * Dependencies: activation restoration capture and stage-transition model application.
	 */
	test("restores pre-workflow model on a stage without model settings", async () => {
		await createSuite(agentFallbackYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");
		await activate.execute("call", { workflowId: "delivery" });
		expect(fake.model?.id).toBe("workflow-model");
		expect(fake.thinkingLevel).toBe("xhigh");

		const transition = requireTool(fake, "workflow_transition");
		await transition.execute("call", { stageId: "fallback" });

		expect(
			fake.modelSetCalls.map(({ provider, id }) => `${provider}/${id}`),
		).toEqual(["openai/workflow-model", "openai/current-model"]);
		expect(fake.model?.provider).toBe("openai");
		expect(fake.model?.id).toBe("current-model");
		expect(fake.thinkingLevel).toBe("medium");
	});

	/**
	 * Proves a stage with an alias model keeps the alias default thinking over the restoration snapshot.
	 * Inputs and expected outputs: a process without an agent contribution applies the alias thinking on the initial stage and restores the pre-workflow values on the next model-less stage.
	 * Edge case: the alias carries both the model and the default thinking level.
	 * Dependencies: isolated model-alias config and stage-transition model application.
	 */
	test("applies alias default thinking on stages with an alias model", async () => {
		const suite = await createSuite(aliasStageYaml());
		await mkdir(join(suite, "model-aliases"), { recursive: true });
		await writeFile(
			join(suite, "model-aliases", "config.json"),
			JSON.stringify({
				codex_extractor: {
					id: "openai-codex/gpt-5.6-luna",
					thinking: "low",
				},
			}),
		);
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");
		await activate.execute("call", { workflowId: "delivery" });
		expect(
			fake.modelSetCalls.map(({ provider, id }) => `${provider}/${id}`),
		).toEqual(["openai-codex/gpt-5.6-luna"]);
		expect(fake.thinkingLevel).toBe("low");

		const transition = requireTool(fake, "workflow_transition");
		await transition.execute("call", { stageId: "implement" });

		expect(
			fake.modelSetCalls.map(({ provider, id }) => `${provider}/${id}`),
		).toEqual(["openai-codex/gpt-5.6-luna", "openai/current-model"]);
		expect(fake.thinkingLevel).toBe("medium");
	});

	/** Rejects unknown workflow models before runtime or session state mutation. */
	test("rejects unknown model before activation persistence", async () => {
		await createSuite(
			modelYaml().replace("openai/workflow-model", "openai/missing"),
		);
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");

		await expect(
			activate.execute("call", { workflowId: "delivery" }),
		).rejects.toThrow("model openai/missing was not found");
		expect(fake.modelSetCalls).toEqual([]);
		expect(fake.appended).toEqual([]);
	});

	/** Resolves unsupported thinking before applying and persisting the target model. */
	test("resolves unsupported thinking before activation persistence", async () => {
		// Purpose: workflow activation must use a level supported by the selected model.
		// Input and expected output: xhigh resolves to high for openai/current-model and activation succeeds.
		// Edge case: the model changes while the workflow's configured thinking level is unavailable.
		// Dependencies: workflow model runtime applies the shared thinking-level resolver.
		await createSuite(
			modelYaml().replace("openai/workflow-model", "openai/current-model"),
		);
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");

		await activate.execute("call", { workflowId: "delivery" });
		expect(fake.thinkingLevel).toBe("high");
		expect(fake.appended).toHaveLength(1);
	});

	/** Restores runtime model and thinking when workflow persistence fails. */
	test("rolls back runtime settings when activation persistence fails", async () => {
		await createSuite(modelYaml());
		const fake = await createFakePi();
		fake.appendError = new Error("append failed");
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");

		await expect(
			activate.execute("call", { workflowId: "delivery" }),
		).rejects.toThrow("append failed");
		expect(fake.model?.id).toBe("current-model");
		expect(fake.thinkingLevel).toBe("medium");
		expect(fake.appended).toEqual([]);
	});

	/**
	 * Proves a settled final-stage run restores the runtime values captured before activation.
	 * Inputs and expected outputs: activation and final transition apply workflow settings; settlement restores the original model and thinking level and persists completion.
	 * Edge cases: the final stage omits model settings, so the final runtime values remain those from the preceding stage.
	 * Dependencies: workflow model application, persisted state entries, and the agent_settled lifecycle event.
	 */
	test("restores runtime settings after a final stage settles", async () => {
		await createSuite(modelYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");
		await activate.execute("activate", { workflowId: "delivery" });
		const transition = requireTool(fake, "workflow_transition");
		await transition.execute("transition", { stageId: "done" });

		expect(fake.model?.id).toBe("workflow-model");
		expect(fake.thinkingLevel).toBe("high");

		await runAgentSettled(fake);

		expect(fake.model?.id).toBe("current-model");
		expect(fake.thinkingLevel).toBe("medium");
		expect(
			fake.appended.map(({ data }) => (data as { kind: string }).kind),
		).toEqual(["activated", "transitioned", "completed"]);
	});

	test("restores branch settings when leaving an active workflow branch", async () => {
		// Purpose: session-tree navigation must restore the target branch runtime instead of leaking workflow settings.
		// Inputs and expected output: a high-thinking branch activates an xhigh stage, then navigation before activation restores high.
		// Edge case: the target branch contains no workflow-state entry.
		// Dependencies: Pi session model/thinking entries, workflow activation, and lifecycle replay.
		await createSuite(modelYaml());
		const fake = await createFakePi();
		fake.thinkingLevel = "high";
		const branchBeforeActivation = [
			{
				type: "model_change",
				provider: "openai",
				modelId: "current-model",
			},
			{ type: "thinking_level_change", thinkingLevel: "high" },
		];

		await runLifecycle(fake, "session_start", branchBeforeActivation);
		await requireTool(fake, "workflow_activate").execute("activate", {
			workflowId: "delivery",
		});
		expect(fake.thinkingLevel).toBe("xhigh");

		await runLifecycle(fake, "session_tree", branchBeforeActivation);

		expect(fake.model?.id).toBe("current-model");
		expect(fake.thinkingLevel).toBe("high");
	});

	test("merges partial branch settings with the workflow restoration snapshot", async () => {
		// Purpose: branch navigation must preserve an explicit target thinking level even when that branch has no model entry.
		// Inputs and expected output: activation captures current-model/high, while the target branch overrides only thinking to low.
		// Edge case: model and thinking session entries are independently optional.
		// Dependencies: workflow activation snapshot and lifecycle branch reconciliation.
		await createSuite(modelYaml());
		const fake = await createFakePi();
		fake.thinkingLevel = "high";
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("activate", {
			workflowId: "delivery",
		});

		await runLifecycle(fake, "session_tree", [
			{ type: "thinking_level_change", thinkingLevel: "low" },
		]);

		expect(fake.model?.id).toBe("current-model");
		expect(fake.thinkingLevel).toBe("low");
	});

	/**
	 * Proves replay of completed state does not reapply final-stage runtime settings.
	 * Inputs and expected outputs: a completed branch is replayed into a fresh runtime and keeps the main model selected.
	 * Edge cases: the branch contains activation, transition, and completion entries in chronological order.
	 * Dependencies: workflow replay, completed-state synchronization, and model runtime setup.
	 */
	test("does not reapply workflow settings when replaying completion", async () => {
		await createSuite(modelYaml());
		const source = await createFakePi();
		await runLifecycle(source, "session_start");
		await requireTool(source, "workflow_activate").execute("activate", {
			workflowId: "delivery",
		});
		await requireTool(source, "workflow_transition").execute("transition", {
			stageId: "done",
		});
		await runAgentSettled(source);

		const replayed = await createFakePi();
		const branch = source.appended.map(({ data }) => ({
			type: "custom",
			customType: "workflow-state",
			data,
		}));
		await runLifecycle(replayed, "session_start", branch);

		expect(replayed.model?.id).toBe("current-model");
		expect(replayed.thinkingLevel).toBe("medium");
	});

	/** Proves non-final settlement does not complete the active workflow. */
	test("keeps runtime settings while a non-final stage settles", async () => {
		await createSuite(modelYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");
		await activate.execute("activate", { workflowId: "delivery" });

		await runAgentSettled(fake);

		expect(fake.model?.id).toBe("workflow-model");
		expect(fake.thinkingLevel).toBe("xhigh");
		expect(
			fake.appended.map(({ data }) => (data as { kind: string }).kind),
		).toEqual(["activated"]);
	});

	/**
	 * Proves completion removes active-stage instructions while retaining the rework route.
	 * Inputs and expected outputs: a settled final stage projects completed state without active-stage guidance; rework restores active settings and context.
	 * Edge cases: the completed state must remain available even though the final-stage model has been restored.
	 * Dependencies: completion persistence, workflow journaling, and route transition application.
	 */
	test("projects completion and supports rework", async () => {
		await createSuite(modelYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");
		await activate.execute("activate", { workflowId: "delivery" });
		const transition = requireTool(fake, "workflow_transition");
		await transition.execute("transition", { stageId: "done" });
		await runAgentSettled(fake);

		const completedContext = latestWorkflowContent(fake);
		expect(completedContext).toContain("<workflow_completed");
		expect(completedContext).not.toContain("<stage_guidelines>");

		await transition.execute("rework", { stageId: "start" });

		expect(fake.model?.id).toBe("workflow-model");
		expect(fake.thinkingLevel).toBe("xhigh");
		const activeContext = latestWorkflowContent(fake);
		expect(activeContext).toContain("<workflow_stage_activated");
		expect(activeContext).toContain('guidelines="reuse"');
	});

	/**
	 * Proves completion persistence failure restores final-stage runtime values and keeps the workflow active.
	 * Inputs and expected outputs: an append failure during settlement leaves the final model, thinking level, and active context unchanged.
	 * Edge cases: runtime restoration succeeds before the persistence failure and therefore requires an explicit rollback.
	 * Dependencies: completion transaction and workflow model rollback.
	 */
	test("rolls back final-stage restoration when completion persistence fails", async () => {
		await createSuite(modelYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");
		await activate.execute("activate", { workflowId: "delivery" });
		const transition = requireTool(fake, "workflow_transition");
		await transition.execute("transition", { stageId: "done" });
		fake.appendError = new Error("completion append failed");

		await expect(runAgentSettled(fake)).rejects.toThrow(
			"completion append failed",
		);

		expect(fake.model?.id).toBe("workflow-model");
		expect(fake.thinkingLevel).toBe("high");
		expect(
			fake.appended.map(({ data }) => (data as { kind: string }).kind),
		).toEqual(["activated", "transitioned"]);
	});

	/** Proves manual model changes are not overwritten by main-agent policy events. */
	test("does not reapply workflow settings after manual model selection", async () => {
		await createSuite(modelYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");
		await activate.execute("call", { workflowId: "delivery" });
		fake.modelSetCalls.length = 0;
		const manualModel = createModel("openai", "manual-model", true);
		fake.model = manualModel;
		fake.thinkingLevel = "low";
		for (const listener of fake.listeners.get("model_select") ?? []) {
			listener({ model: manualModel });
		}
		setMainWorkflowPolicy(fake, ["delivery"]);

		expect(fake.modelSetCalls).toEqual([]);
		expect(fake.model?.id).toBe("manual-model");
		expect(fake.thinkingLevel).toBe("low");
	});

	/** Proves successful tools keep model content stable while persisting state. */
	test("persists activation and transition with stable success content", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");
		const transition = requireTool(fake, "workflow_transition");
		expect(
			await activate.execute("call", { workflowId: "delivery" }),
		).toMatchObject({
			content: [{ type: "text", text: '{"success":true}' }],
		});
		expect(await transition.execute("call", { stageId: "done" })).toMatchObject(
			{
				content: [{ type: "text", text: '{"success":true}' }],
			},
		);
		expect(
			fake.appended.map(({ data }) => (data as { kind: string }).kind),
		).toEqual(["activated", "transitioned"]);
	});

	/** Proves the active workflow cannot be reactivated outside current activation options. */
	test("rejects reactivation without appending or resetting progress", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");
		const transition = requireTool(fake, "workflow_transition");
		await activate.execute("call", { workflowId: "delivery" });
		await transition.execute("call", { stageId: "done" });
		const entriesBeforeReactivation = [...fake.appended];

		await expect(
			activate.execute("call", { workflowId: "delivery" }),
		).rejects.toThrow("not available for activation");

		expect(fake.appended).toEqual(entriesBeforeReactivation);
		const transitionedEntry = entriesBeforeReactivation[1];
		if (transitionedEntry === undefined) {
			throw new Error("transitioned entry missing");
		}
		expect(
			(transitionedEntry.data as { route: readonly string[] }).route,
		).toEqual(["start", "done"]);
		const content = latestWorkflowContent(fake);
		expect(content).toContain('stage_id="done"');
		expect(content).toContain('<transition to="start" type="rework" />');
	});

	/**
	 * Proves system suppression does not erase active workflow guidance granted by agent policy.
	 * Input and expected output: an activate-only agent activates its sole option, loses the unusable tool, and retains active context.
	 * Edge case: activation options remain absent after the sole workflow becomes active.
	 * Dependencies: extension-owned suppression, provider-context gating, and catalog activation.
	 */
	test("keeps active context after suppressing the sole activation tool", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		setMainWorkflowPolicy(fake, ["delivery"], ["read", "workflow_activate"]);
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");

		await activate.execute("activate", { workflowId: "delivery" });
		expect(fake.activeTools).toEqual(["read"]);
		const content = latestWorkflowContent(fake);
		expect(content).toContain(
			'<workflow_stage_activated workflow_id="delivery" stage_id="start"',
		);
		expect(content).toContain("<stage_guidelines>\nStart work");
		expect(content).not.toContain("<workflow_activation_options");
	});

	/** Proves invalid arguments and append failures preserve prior state. */
	test("validates tool boundaries and preserves state on append failure", async () => {
		await createSuite(
			validYaml().replace(
				"    initial: true\n",
				"    initial: true\n    triggers:\n      - type: local_knowledge_accumulation\n",
			),
		);
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const activate = fake.tools[0];
		if (activate === undefined) {
			throw new Error("activation tool missing");
		}
		await expect(
			activate.execute("call", { workflowId: "missing" }),
		).rejects.toThrow();
		await expect(
			activate.execute("call", { workflowId: "delivery", extra: true }),
		).rejects.toThrow();
		const triggerCalls = captureTriggers(fake);
		const messageCount = fake.messages.length;
		fake.appendError = new Error("append failed");
		await expect(
			activate.execute("call", { workflowId: "delivery" }),
		).rejects.toThrow("append failed");
		expect(triggerCalls).toEqual([]);
		expect(fake.messages).toHaveLength(messageCount);
		fake.appendError = undefined;
	});

	/**
	 * Proves completed calls across turn-end events publish one persistent steered reminder.
	 * Input and expected output: batches of two and one at interval three emit the active workflow marker.
	 * Edge case: the threshold is reached across separate provider turns.
	 * Dependencies: workflow activation, Pi turn handlers, scheduler, and journal publication.
	 */
	test("publishes periodic reminders from completed turn tool calls", async () => {
		const suite = await createSuite(validYaml());
		await writeFile(
			join(suite, "workflow", "config.json"),
			JSON.stringify({ reminderToolCallInterval: 3 }),
		);
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("activate", {
			workflowId: "delivery",
		});
		fake.messages.length = 0;

		await runTurn(fake, 2);
		expect(fake.messages).toEqual([]);
		await runTurn(fake, 1);

		expect(fake.messages).toHaveLength(1);
		expect(fake.messages[0]).toMatchObject({
			customType: "workflow",
			content: '<workflow_reminder id="delivery" active_stage_id="start" />',
			display: false,
			details: { kind: "reminder" },
			options: { deliverAs: "steer" },
		});
	});

	/**
	 * Proves completed reasoning contributes one retained activity unit per turn.
	 * Input and expected output: plain and encrypted reasoning plus two tool calls reach interval four.
	 * Edge cases: multiple blocks count once, an empty unsigned block counts zero, and below-threshold reasoning-only turns remain silent.
	 * Dependencies: final assistant messages, turn-end scheduling, and journal publication.
	 */
	test("counts one final reasoning unit per completed turn", async () => {
		const suite = await createSuite(validYaml());
		await writeFile(
			join(suite, "workflow", "config.json"),
			JSON.stringify({ reminderToolCallInterval: 4 }),
		);
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("activate", {
			workflowId: "delivery",
		});
		fake.messages.length = 0;

		await runTurn(fake, 0, undefined, {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "First" },
				{ type: "thinking", thinking: "Second" },
			],
		});
		await runTurn(fake, 0, undefined, {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "",
					thinkingSignature: '{"encrypted_content":"opaque"}',
				},
			],
		});
		await runTurn(fake, 0, undefined, {
			role: "assistant",
			content: [{ type: "thinking", thinking: "" }],
		});
		await runTurn(fake, 1);
		expect(fake.messages).toEqual([]);

		await runTurn(fake, 1);
		expect(fake.messages).toHaveLength(1);
		expect(fake.messages[0]?.details).toMatchObject({ kind: "reminder" });
	});

	/**
	 * Proves a reasoning-only interval queues a reminder for the next user turn.
	 * Input and expected output: two reasoning-only turns at interval two publish one `nextTurn` reminder.
	 * Edge case: publication occurs without any tool result or immediate follow-up request.
	 * Dependencies: final assistant messages, turn-end scheduling, and journal publication.
	 */
	test("queues reasoning-only reminders for the next user turn", async () => {
		const suite = await createSuite(validYaml());
		await writeFile(
			join(suite, "workflow", "config.json"),
			JSON.stringify({ reminderToolCallInterval: 2 }),
		);
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("activate", {
			workflowId: "delivery",
		});
		fake.messages.length = 0;
		const reasoningMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "Reasoning" }],
		};

		await runTurn(fake, 0, undefined, reasoningMessage);
		expect(fake.messages).toEqual([]);
		await runTurn(fake, 0, undefined, reasoningMessage);

		expect(fake.messages).toHaveLength(1);
		expect(fake.messages[0]).toMatchObject({
			details: { kind: "reminder" },
			options: { deliverAs: "nextTurn" },
		});
	});

	/**
	 * Proves an all-terminating batch cannot queue a reminder while a mixed batch still counts.
	 * Input and expected output: two terminating results emit nothing, then one terminating and one ordinary result emit a reminder.
	 * Edge case: both batches independently reach the configured interval.
	 * Dependencies: finalized tool execution events, turn-end scheduling, and journal publication.
	 */
	test("suppresses reminders only when every tool result terminates", async () => {
		const suite = await createSuite(validYaml());
		await writeFile(
			join(suite, "workflow", "config.json"),
			JSON.stringify({ reminderToolCallInterval: 2 }),
		);
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("activate", {
			workflowId: "delivery",
		});
		fake.messages.length = 0;

		await runTurn(fake, 2, [true, true]);
		expect(fake.messages).toEqual([]);

		await runTurn(fake, 2, [true, false]);
		expect(
			fake.messages.filter(({ content }) =>
				content.includes("workflow_reminder"),
			),
		).toHaveLength(1);
	});

	/**
	 * Proves fresh workflow state suppresses the same turn's batch and session lifecycle resets progress.
	 * Input and expected output: a transition in a threshold batch emits only stage state, and session_tree drops prior calls.
	 * Edge case: one parallel batch exceeds the interval but still emits at most one later reminder.
	 * Dependencies: workflow transition, session_tree, Pi turn handlers, scheduler, and journal publication.
	 */
	test("resets periodic reminder progress on state publication and session lifecycle", async () => {
		const suite = await createSuite(validYaml());
		await writeFile(
			join(suite, "workflow", "config.json"),
			JSON.stringify({ reminderToolCallInterval: 2 }),
		);
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("activate", {
			workflowId: "delivery",
		});
		fake.messages.length = 0;
		const start = fake.handlers.get("turn_start");
		const end = fake.handlers.get("turn_end");
		if (start === undefined || end === undefined) {
			throw new Error("missing workflow reminder turn handlers");
		}
		await start({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await requireTool(fake, "workflow_transition").execute("transition", {
			stageId: "done",
		});
		await end({
			type: "turn_end",
			turnIndex: 0,
			message: {},
			toolResults: [{}, {}, {}, {}, {}],
		});
		expect(
			fake.messages.filter(({ details }) =>
				isWorkflowLifecycleDetails(details),
			),
		).toHaveLength(1);
		expect(
			fake.messages.some(({ content }) =>
				content.includes("workflow_reminder"),
			),
		).toBe(false);

		fake.messages.length = 0;
		await runTurn(fake, 1);
		await runLifecycle(fake, "session_tree", [activatedEntry()]);
		await runTurn(fake, 1);
		expect(
			fake.messages.some(({ content }) =>
				content.includes("workflow_reminder"),
			),
		).toBe(false);
		await runTurn(fake, 5);
		expect(
			fake.messages.filter(({ content }) =>
				content.includes("workflow_reminder"),
			),
		).toHaveLength(1);
	});

	/** Proves workflow records enter the active tool loop through Pi's steering queue. */
	test("delivers workflow records to the next provider request", async () => {
		// Purpose: a journal record published during tool execution must join the active loop context.
		// Input and expected output: activation uses steer delivery without forcing a separate agent turn.
		// Edge case: triggerTurn false would persist the message but omit it from the active loop snapshot.
		// Dependencies: workflow activation and the public sendMessage delivery contract.
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("activate", {
			workflowId: "delivery",
		});
		const activation = fake.messages.find(({ details }) =>
			isWorkflowLifecycleDetails(details),
		);

		expect(activation?.options).toEqual({ deliverAs: "steer" });
	});

	/** Proves compaction starts a new activation-options segment without an active workflow. */
	test("re-publishes activation options after inactive compaction", async () => {
		// Purpose: every compaction must establish workflow availability in the new provider-visible segment.
		// Input and expected output: delivery availability is published once at startup and once after inactive compaction.
		// Edge case: no active or completed workflow exists to produce a checkpoint.
		// Dependencies: session_compact wiring and activation-options deduplication reset.
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const initialOptions = fake.messages.at(-1)?.content;

		await runSessionCompact(fake);

		expect(fake.messages).toHaveLength(2);
		expect(fake.messages.at(-1)?.content).toBe(initialOptions);
	});

	/** Proves compaction creates one checkpoint and forgets definitions outside that checkpoint. */
	test("checkpoints after compaction and inlines the first later stage entry", async () => {
		// Purpose: post-compaction history must restore exact active instructions without trusting the summary.
		// Input and expected output: review compaction emits one checkpoint, then rework inlines implementation guidance again.
		// Edge case: unchanged activation options are re-published because compaction removed the prior record from provider context.
		// Dependencies: session_compact wiring, checkpoint rendering, and known-stage reset.
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("activate", {
			workflowId: "delivery",
		});
		const transition = requireTool(fake, "workflow_transition");
		await transition.execute("advance", { stageId: "done" });
		const beforeCompaction = fake.messages.length;

		await runSessionCompact(fake);
		expect(fake.messages).toHaveLength(beforeCompaction + 2);
		expect(fake.messages.at(-2)?.content).toContain(
			'<workflow_checkpoint id="delivery" status="active" active_stage_id="done"',
		);
		expect(fake.messages.at(-1)?.content).toBe(
			"<workflow_activation_options />",
		);

		await transition.execute("rework", { stageId: "start" });
		expect(fake.messages.at(-1)?.content).toContain('guidelines="inline"');
		expect(fake.messages.at(-1)?.content).toContain("Start work");
	});

	/** Proves restored journal records prevent duplicate legacy-repair checkpoints. */
	test("deduplicates compatible restore checkpoints", async () => {
		// Purpose: repeated session restoration must not append the same checkpoint and options again.
		// Input and expected output: state-only history is repaired once, then the repaired branch produces no new message.
		// Edge case: the availability record follows the checkpoint in the repaired branch.
		// Dependencies: workflow-state replay and journal detail restoration.
		await createSuite(validYaml());
		const fake = await createFakePi();
		const stateEntry = activatedEntry();
		await runLifecycle(fake, "session_start", [stateEntry]);
		const repairedMessages = fake.messages.map((message) => ({
			type: "custom_message",
			...message,
		}));
		const messageCount = fake.messages.length;

		await runLifecycle(fake, "session_tree", [stateEntry, ...repairedMessages]);

		expect(fake.messages).toHaveLength(messageCount);
	});

	/**
	 * Proves main-agent policy changes filter new activation without hiding active state.
	 * Input and expected output: active delivery continues after policy changes to review, which remains activatable.
	 * Edge case: review is rejected before the policy change and allowed afterward.
	 * Dependencies: runtime composition events, active-state projection, activation filtering, and transition authorization.
	 */
	test("keeps active workflow available across main-agent policy changes", async () => {
		const root = await createSuite(validYaml());
		await writeFile(
			join(root, "workflow", "workflows", "review.yaml"),
			validYaml().replace("description: Delivery", "description: Review"),
		);
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		setMainWorkflowPolicy(fake, ["delivery"]);
		const activate = requireTool(fake, "workflow_activate");
		const transition = requireTool(fake, "workflow_transition");

		await expect(
			activate.execute("reject-review", { workflowId: "review" }),
		).rejects.toThrow("not allowed");
		await activate.execute("activate-delivery", { workflowId: "delivery" });
		await transition.execute("finish-delivery", { stageId: "done" });

		setMainWorkflowPolicy(fake, ["review"]);
		const switchedContent = latestWorkflowContent(fake);
		expect(switchedContent).toContain(
			'<workflow_stage_activated workflow_id="delivery" stage_id="done"',
		);
		expect(fake.messages.at(-1)?.content).toContain(
			"<workflow_activation_options>",
		);
		expect(fake.messages.at(-1)?.content).toContain('id="review"');

		await transition.execute("reopen-delivery", { stageId: "start" });
		await activate.execute("activate-review", { workflowId: "review" });
		const replacedContent = latestWorkflowContent(fake);
		expect(replacedContent).toContain(
			'<workflow_stage_activated workflow_id="review" stage_id="start"',
		);
	});

	/**
	 * Proves child policy filters new activation without hiding saved active state.
	 * Input and expected output: child policy review preserves and advances saved delivery while exposing review.
	 * Edge case: immutable child transport uses the same continuation semantics as main-agent policy.
	 * Dependencies: child environment parsing, saved-state replay, activation filtering, and transition authorization.
	 */
	test("keeps saved workflow available under child policy", async () => {
		const root = await createSuite(validYaml());
		await writeFile(
			join(root, "workflow", "workflows", "review.yaml"),
			validYaml().replace("description: Delivery", "description: Review"),
		);
		process.env[CHILD_AGENT_PROCESS_ENV] = "1";
		process.env[SUBAGENT_WORKFLOW_IDS_ENV] = '["review"]';
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start", [activatedEntry()]);
		const transition = requireTool(fake, "workflow_transition");
		const activate = requireTool(fake, "workflow_activate");

		const initialContent = latestWorkflowContent(fake);
		expect(initialContent).toContain(
			'<workflow_checkpoint id="delivery" status="active" active_stage_id="start"',
		);
		expect(fake.messages.at(-1)?.content).toContain('id="review"');

		await transition.execute("finish-delivery", { stageId: "done" });
		await activate.execute("activate-review", { workflowId: "review" });
		const replacedContent = latestWorkflowContent(fake);
		expect(replacedContent).toContain(
			'<workflow_stage_activated workflow_id="review" stage_id="start"',
		);
	});

	/** Proves invalid child policy disables provider behavior without deleting replayed state. */
	test.each([
		["malformed", "{", "valid JSON"],
		["unknown", '["missing"]', "missing"],
	] as const)("fails closed for %s child workflow policy", async (_case, rawPolicy, expectedIssue) => {
		// Purpose: policy rejection must remove all workflow tool names and suppress every provider-facing path.
		// Input and expected output: malformed or unknown transport throws, hides context, appends nothing, and disables all workflow tools.
		// Edge case: transition still reaches the retained replayed snapshot before returning the cached policy error.
		// Dependencies: production child environment parsing, lifecycle replay, tool reconciliation, context gating, and transition authorization.
		await createSuite(validYaml());
		process.env[CHILD_AGENT_PROCESS_ENV] = "1";
		process.env[SUBAGENT_WORKFLOW_IDS_ENV] = rawPolicy;
		const fake = await createFakePi();

		await expect(
			runLifecycle(fake, "session_start", [activatedEntry()]),
		).rejects.toThrow(expectedIssue);

		expect(fake.activeTools).toEqual(["read"]);
		expect(latestWorkflowContent(fake)).toBeUndefined();
		expect(fake.appended).toEqual([]);
		const transition = fake.tools.find(
			({ name }) => name === "workflow_transition",
		);
		if (transition === undefined) {
			throw new Error("transition tool missing");
		}
		await expect(
			transition.execute("call", { stageId: "done" }),
		).rejects.toThrow(expectedIssue);
		expect(fake.appended).toEqual([]);
	});

	/** Proves usable lifecycle reconciliation never overrides agent policy. */
	test("leaves active names unchanged while the subsystem is usable", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		setMainWorkflowPolicy(fake, ["delivery"], ["read"]);
		await runLifecycle(fake, "session_start");
		expect(fake.activeTools).toEqual(["read"]);
	});

	/** Proves ordinary suppression is retained and restored exactly once. */
	test("restores only names suppressed by unusable lifecycle reconciliation", async () => {
		await createSuite();
		const fake = await createFakePi();
		fake.activeTools = ["read", "workflow_activate", "workflow_transition"];
		if (fake.api === undefined) {
			throw new Error("extension API missing");
		}
		const composition = getAgentRuntimeComposition(fake.api);
		composition.setMainAgentContribution({
			prompt: "main",
			tools: ["read", "workflow_activate", "workflow_transition"],
		});
		await runLifecycle(fake, "session_start");
		expect(fake.activeTools).toEqual(["read"]);

		await runLifecycle(fake, "session_tree");
		expect(fake.activeTools).toEqual(["read"]);

		composition.setRestrictiveToolNames("upstream", ["read"]);
		composition.addBaselineToolNames(["workflow_transition"]);

		await runLifecycle(fake, "session_tree", [activatedEntry()]);
		expect(fake.activeTools).toEqual(["read"]);
		await runLifecycle(fake, "session_tree", [activatedEntry()]);
		expect(fake.activeTools).toEqual(["read"]);
	});

	/** Proves a main-agent policy reset replaces stale suppression ownership. */
	test("reconciles inactive state after main-agent contribution changes", async () => {
		await createSuite();
		const fake = await createFakePi();
		setMainWorkflowPolicy(fake, undefined, [
			"read",
			"workflow_activate",
			"workflow_transition",
		]);
		await runLifecycle(fake, "session_start");

		setMainWorkflowPolicy(fake, undefined, ["read", "workflow_transition"]);
		expect(fake.activeTools).toEqual(["read"]);
		await runLifecycle(fake, "session_tree", [activatedEntry()]);
		expect(fake.activeTools).toEqual(["read", "workflow_transition"]);
	});

	/** Proves usable policy resets clear stale ownership without changing active names. */
	test("clears stale suppression after a usable main-agent policy change", async () => {
		await createSuite();
		const fake = await createFakePi();
		setMainWorkflowPolicy(fake, undefined, ["read", "workflow_transition"]);
		await runLifecycle(fake, "session_start");
		await runLifecycle(fake, "session_tree", [activatedEntry()]);
		expect(fake.activeTools).toEqual(["read", "workflow_transition"]);

		setMainWorkflowPolicy(fake, undefined, ["read"]);
		expect(fake.activeTools).toEqual(["read"]);
		await runLifecycle(fake, "session_tree");
		await runLifecycle(fake, "session_tree", [activatedEntry()]);
		expect(fake.activeTools).toEqual(["read"]);
	});

	/** Proves shutdown releases the main-agent contribution listener. */
	test("unsubscribes from main-agent changes on shutdown", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		expect(fake.listeners.get(MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT)?.size).toBe(
			1,
		);
		await runLifecycle(fake, "session_shutdown");
		expect(fake.listeners.get(MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT)?.size).toBe(
			0,
		);
	});

	/** Proves resolved policies preserve saved snapshots across removed and invalid catalogs. */
	test.each([
		["removed", "unrestricted", undefined],
		["removed", "empty", []],
		["removed", "matching explicit", ["delivery"]],
		["removed", "non-matching explicit", ["review"]],
		["invalid", "unrestricted", undefined],
		["invalid", "empty", []],
		["invalid", "matching explicit", ["delivery"]],
		["invalid", "non-matching explicit", ["review"]],
	] as const)("keeps a saved snapshot with %s catalog and %s policy", async (catalogKind, _policyName, policy) => {
		// Purpose: a complete saved snapshot remains continuable independently from catalog and activation policy.
		// Input and expected output: every resolved policy exposes and advances saved Delivery without new activation options.
		// Edge case: invalid and removed catalogs still cannot provide new activation definitions.
		// Dependencies: production lifecycle replay, active-state projection, transition enforcement, and isolated catalog fixtures.
		await createSuite(
			catalogKind === "invalid" ? "invalid: true\n" : undefined,
		);
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start", [activatedEntry()]);
		setMainWorkflowPolicy(fake, policy);
		const transition = requireTool(fake, "workflow_transition");

		const initialContent = latestWorkflowContent(fake);
		expect(initialContent).toBeDefined();
		expect(initialContent).not.toContain("<workflow_activation_options");
		expect(initialContent).toContain(
			'<workflow_checkpoint id="delivery" status="active" active_stage_id="start"',
		);

		await transition.execute("finish-delivery", { stageId: "done" });
		expect(fake.appended).toHaveLength(1);
		const transitionedContent = latestWorkflowContent(fake);
		expect(transitionedContent).toContain('stage_id="done"');
	});

	test("does not publish workflow status outside TUI mode", async () => {
		// Purpose: print and RPC sessions must not create the interactive shared status panel.
		// Inputs and expected output: an RPC session restores an active workflow without any setWidget call.
		// Edge case: provider context and workflow tools remain independent from TUI presentation.
		// Dependencies: Pi lifecycle mode and saved workflow replay.
		await createSuite(validYaml());
		const fake = await createFakePi();

		await runLifecycle(fake, "session_start", [activatedEntry()], "rpc");
		await runLifecycle(fake, "session_shutdown", [], "rpc");

		expect(fake.widgetUpdates).toEqual([]);
	});

	test("keeps saved workflow status when agent policy stops allowing it", async () => {
		// Purpose: changing the selected agent must not hide workflow state persisted in the session branch.
		// Inputs and expected output: delivery is restored while allowed, then remains visible after policy changes to another workflow.
		// Edge case: tool and provider-context availability may change without deleting the saved active workflow.
		// Dependencies: saved workflow replay, main-agent contribution changes, and independent status presentation.
		await createSuite(validYaml());
		const fake = await createFakePi();
		setMainWorkflowPolicy(fake, ["delivery"]);
		await runLifecycle(fake, "session_start", [activatedEntry()]);

		setMainWorkflowPolicy(fake, ["another-workflow"]);
		const rows = renderLatestStatus(fake, 120);
		await runLifecycle(fake, "session_shutdown");

		expect(rows[1]).toBe("Workflow: delivery · Start");
	});

	test("publishes workflow status across branch and tool lifecycle", async () => {
		// Purpose: the shared compact row must track effective state restored from a branch and changed by workflow tools.
		// Inputs and expected output: session_tree restores start, workflow_transition replaces it with done, and shutdown clears the row.
		// Edge case: session_start without active state must not leave a visible Workflow row.
		// Dependencies: validated session replay, the common tool setState path, and shared panel cleanup.
		await createSuite(validYaml());
		const fake = await createFakePi();
		const transition = requireTool(fake, "workflow_transition");

		await runLifecycle(fake, "session_start");
		await runLifecycle(fake, "session_tree", [activatedEntry()]);
		const resumedRows = renderLatestStatus(fake, 120);
		await transition.execute("call", { stageId: "done" });
		const transitionedRows = renderLatestStatus(fake, 120);
		await runLifecycle(fake, "session_shutdown");
		const cleared = fake.widgetUpdates.at(-1)?.content;

		expect(resumedRows[1]).toBe("Workflow: delivery · Start");
		expect(transitionedRows[1]).toBe("Workflow: delivery · Done");
		expect(cleared).toBeUndefined();
	});

	/** Proves malformed matching entries fail closed and remove only workflow names. */
	test("deactivates cleanly and rejects malformed saved entries", async () => {
		await createSuite();
		const fake = await createFakePi();
		setMainWorkflowPolicy(fake, undefined, [
			"read",
			"workflow_activate",
			"workflow_transition",
		]);
		await runLifecycle(fake, "session_start");
		expect(fake.activeTools).toEqual(["read"]);
		await expect(
			runLifecycle(fake, "session_tree", [
				{
					type: "custom",
					customType: "workflow-state",
					data: { kind: "transitioned", route: [] },
				},
			]),
		).rejects.toThrow("workflow-state");
		expect(fake.activeTools).toEqual(["read"]);
	});
});
