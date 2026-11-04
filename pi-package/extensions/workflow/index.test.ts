import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ProjectedSessionEntry,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Check } from "typebox/value";
import { stringify } from "yaml";
import { projectBranch } from "../../../test/support/session-projection";
import {
	getAgentRuntimeComposition,
	SELECTED_AGENT_CONTRIBUTION_CHANGE_EVENT,
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
	getTopWorkflow,
	replayWorkflowChain,
	validateWorkflowDefinition,
	WORKFLOW_STATE_JOURNAL_VERSION,
} from "./workflow";

/** Reads the top of a replayed chain for tool result assertions. */
function replayWorkflowState(entries: readonly unknown[]) {
	return getTopWorkflow(replayWorkflowChain(entries).chain);
}

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

/** Returns a format-2 catalog workflow with grounded advance and rework. */
function groundedYaml(): string {
	return `version: 2
description: Delivery
stages:
  - id: start
    description: Start
    goal: Ready <&> approved
    prompt: Perform work
    initial: true
  - id: done
    description: Done
    goal: Delivery ready
    prompt: Finish work
    model:
      id: openai/workflow-model
      thinking: high
    final: true
transitions:
  - from: start
    to: done
    type: advance
    grounds:
      - id: ready
        when: Evidence <&> approved
  - from: done
    to: start
    type: rework
    grounds:
      - id: retry
        when: Revision needed
`;
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
				goal: "Initial evidence is ready",
				prompt: "Start dynamic work",
				model: { thinking: "medium" },
				initial: true,
			},
			{
				id: "done",
				description: "Done",
				goal: "Delivery is approved",
				prompt: "Finish dynamic work",
				model: { thinking: "medium" },
				final: true,
			},
		],
		transitions: [
			{ from: "start", to: "done", type: "advance" },
			{
				from: "done",
				to: "start",
				type: "rework",
				grounds: [{ id: "revise", when: "The review requires changes" }],
			},
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
	getAgentRuntimeComposition(fake.api).setSelectedAgentContribution({
		prompt: "main",
		...(tools === undefined ? {} : { tools }),
		agent: {
			id: "Main",
			...(workflows === undefined ? {} : { workflows }),
		},
	});
}

/** Models Pi storing a returned before_agent_start message before the provider request. */
async function runBeforeAgentStart(
	fake: FakePi,
	branch: readonly unknown[] = fake.messages.map((message) => ({
		type: "custom_message",
		...message,
	})),
): Promise<void> {
	const handler = fake.handlers.get("before_agent_start");
	if (handler === undefined) {
		throw new Error("missing before_agent_start handler");
	}
	const result = (await handler(
		{ type: "before_agent_start" },
		{
			sessionManager: {
				buildSessionProjection: () => ({ entries: projectBranch(branch) }),
			},
		},
	)) as
		| {
				message?: {
					customType: string;
					content: string;
					display: boolean;
					details: unknown;
				};
		  }
		| undefined;
	if (result?.message !== undefined) {
		fake.messages.push({ ...result.message, options: undefined });
	}
}

/** Invokes one captured lifecycle handler with an isolated branch. */
async function runLifecycle(
	fake: FakePi,
	event: "session_start" | "session_tree" | "session_shutdown",
	branch: readonly unknown[] = [],
	mode: ExtensionContext["mode"] = "tui",
	projectedEntries = branch.map((sourceEntry) => ({
		sourceEntry,
		messages: [{}],
	})) as ProjectedSessionEntry[],
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
			sessionManager: {
				getBranch: () => branch,
				buildSessionProjection: () => ({ entries: projectedEntries }),
			},
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
async function runSessionCompact(
	fake: FakePi,
	idle = true,
	projectedEntries: readonly ProjectedSessionEntry[] = [],
): Promise<void> {
	const handler = fake.handlers.get("session_compact");
	if (handler === undefined) {
		throw new Error("missing session_compact handler");
	}
	await handler(
		{ type: "session_compact" },
		{
			isIdle: () => idle,
			sessionManager: {
				buildSessionProjection: () => ({ entries: projectedEntries }),
			},
		},
	);
}

/** Invokes the session-level settlement handler without providing a UI context. */
async function runAgentSettled(fake: FakePi): Promise<void> {
	const handler = fake.handlers.get("agent_settled");
	await handler?.({ type: "agent_settled" });
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

describe("nested workflow execution", () => {
	for (const role of ["main", "child"] as const) {
		test(`${role} nested catalog authorization rejects atomically and allows a compatible policy`, async () => {
			const suite = await createSuite(modelYaml());
			await writeFile(
				join(suite, "workflow/workflows/check.yaml"),
				groundedYaml()
					.replace(
						"version: 2",
						"version: 3\nnested: true\nmodel:\n  id: openai/current-model\n  thinking: low",
					)
					.replace(
						"    initial: true",
						"    initial: true\n    triggers:\n      - type: local_knowledge_accumulation",
					),
			);
			if (role === "child") {
				process.env[CHILD_AGENT_PROCESS_ENV] = "1";
				process.env[SUBAGENT_WORKFLOW_IDS_ENV] = '["delivery"]';
			}
			const denied = await createFakePi();
			if (role === "main") {
				setMainWorkflowPolicy(denied, ["delivery"]);
			}
			await runLifecycle(denied, "session_start");
			const triggers = captureTriggers(denied);
			const activate = requireTool(denied, "workflow_activate");
			await activate.execute("parent", { workflowId: "delivery" });
			const branch = savedBranch(denied);
			const parentChain = replayWorkflowChain(branch).chain;
			expect(parentChain).toHaveLength(1);
			expect(parentChain[0]?.route).toEqual(["start"]);
			expect(denied.activeTools).toContain("workflow_activate");
			const before = {
				entries: [...denied.appended],
				messages: [...denied.messages],
				modelCalls: [...denied.modelSetCalls],
				model: denied.model,
				thinking: denied.thinkingLevel,
				tools: [...denied.activeTools],
				widgets: [...denied.widgetUpdates],
				notifications: [...denied.notifications],
				triggers: [...triggers],
			};
			await expect(
				activate.execute("denied-nested", { workflowId: "check" }),
			).rejects.toThrow("not allowed");
			expect(denied.appended).toEqual(before.entries);
			expect(replayWorkflowChain(savedBranch(denied)).chain).toEqual(
				parentChain,
			);
			expect(denied.messages).toEqual(before.messages);
			expect(denied.modelSetCalls).toEqual(before.modelCalls);
			expect(denied.model).toBe(before.model);
			expect(denied.thinkingLevel).toBe(before.thinking);
			expect(denied.activeTools).toEqual(before.tools);
			expect(denied.widgetUpdates).toEqual(before.widgets);
			expect(denied.notifications).toEqual(before.notifications);
			expect(triggers).toEqual(before.triggers);

			if (role === "child") {
				process.env[SUBAGENT_WORKFLOW_IDS_ENV] = '["delivery","check"]';
			}
			const allowed = await createFakePi();
			if (role === "main") {
				setMainWorkflowPolicy(allowed, ["delivery", "check"]);
			}
			await runLifecycle(allowed, "session_start", branch);
			await requireTool(allowed, "workflow_activate").execute(
				"allowed-nested",
				{ workflowId: "check" },
			);
			const chain = replayWorkflowChain([
				...branch,
				...savedBranch(allowed),
			]).chain;
			expect(chain).toHaveLength(2);
			expect(chain[0]).toEqual(parentChain[0]);
			expect(chain[1]?.workflow.id).toBe("check");
			expect(chain[1]?.route).toEqual(["start"]);
		});
	}

	test("nested catalog starts preserve parents, restore effective models, and resume without triggers", async () => {
		const suite = await createSuite(modelYaml());
		await writeFile(
			join(suite, "workflow/workflows/check.yaml"),
			groundedYaml().replace(
				"version: 2",
				"version: 3\nnested: true\nmodel:\n  id: openai/current-model\n  thinking: low",
			),
		);
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const triggers = captureTriggers(fake);
		const activate = requireTool(fake, "workflow_activate");
		await activate.execute("root", { workflowId: "delivery" });
		const parent = replayWorkflowChain(savedBranch(fake)).chain[0];
		if (!parent) {
			throw new Error("missing parent");
		}
		fake.appendError = new Error("persistence failed");
		await expect(
			activate.execute("fail-child", { workflowId: "check" }),
		).rejects.toThrow("persistence failed");
		expect(fake.model?.id).toBe("workflow-model");
		expect(fake.thinkingLevel).toBe("xhigh");
		fake.appendError = undefined;
		await activate.execute("child", { workflowId: "check" });
		expect(renderLatestStatus(fake, 120)[1]).toBe(
			"Workflow: delivery➡check · Start",
		);
		const chain = replayWorkflowChain(savedBranch(fake)).chain;
		expect(chain).toHaveLength(2);
		expect(chain[0]).toEqual(parent);
		expect(chain[1]?.restoration).toEqual({
			modelId: "openai/workflow-model",
			thinking: "xhigh",
		});
		expect(fake.model?.id).toBe("current-model");
		expect(fake.thinkingLevel).toBe("low");
		const before = {
			entries: [...fake.appended],
			messages: [...fake.messages],
			modelCalls: [...fake.modelSetCalls],
		};
		await expect(
			activate.execute("duplicate", { workflowId: "delivery" }),
		).rejects.toThrow();
		expect(fake.appended).toEqual(before.entries);
		expect(fake.messages).toEqual(before.messages);
		expect(fake.modelSetCalls).toEqual(before.modelCalls);
		await expect(
			requireTool(fake, "workflow_transition").execute("parent-move", {
				stageId: "done",
				ground: "missing",
				basis: "Parent work complete",
			}),
		).rejects.toThrow("ground");
		const count = triggers.length;
		fake.appendError = new Error("persistence failed");
		await expect(
			requireTool(fake, "workflow_exit").execute("fail-return", {
				basis: "Check complete",
			}),
		).rejects.toThrow("persistence failed");
		expect(fake.model?.id).toBe("current-model");
		expect(fake.thinkingLevel).toBe("low");
		expect(replayWorkflowChain(savedBranch(fake)).chain).toEqual(chain);
		fake.appendError = undefined;
		await requireTool(fake, "workflow_exit").execute("return", {
			basis: "Check complete",
		});
		expect(replayWorkflowChain(savedBranch(fake)).chain).toEqual([parent]);
		expect(triggers).toHaveLength(count);
		expect(fake.model?.id).toBe("workflow-model");
		expect(fake.thinkingLevel).toBe("xhigh");
		await requireTool(fake, "workflow_exit").execute("exit", {
			basis: "Task complete",
		});
		expect(fake.model?.id).toBe("current-model");
		expect(fake.thinkingLevel).toBe("medium");
	});

	test("dynamic kind validation is atomic and saved kinds survive catalog removal", async () => {
		const suite = await createSuite(modelYaml());
		await writeFile(
			join(suite, "workflow/kinds.yaml"),
			"- id: review\n  description: Review work\n",
		);
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("parent", {
			workflowId: "delivery",
		});
		const create = requireTool(fake, "workflow_create");
		const args = {
			...triggeredCreateArguments(),
			nested: true,
			kind: "review",
		};
		expect(Check(create.parameters as never, args)).toBe(true);
		const before = {
			entries: [...fake.appended],
			messages: [...fake.messages],
			calls: [...fake.modelSetCalls],
			tools: [...fake.activeTools],
			thinking: fake.thinkingLevel,
		};
		await expect(
			create.execute("unknown", { ...args, kind: "missing" }),
		).rejects.toThrow("unknown workflow kind");
		expect(fake.appended).toEqual(before.entries);
		expect(fake.messages).toEqual(before.messages);
		expect(fake.modelSetCalls).toEqual(before.calls);
		expect(fake.activeTools).toEqual(before.tools);
		expect(fake.thinkingLevel).toBe(before.thinking);
		await create.execute("known", args);
		const branch = savedBranch(fake);
		expect(replayWorkflowChain(branch).chain.at(-1)?.workflow.kind).toBe(
			"review",
		);
		await rm(join(suite, "workflow/kinds.yaml"));
		const restored = await createFakePi();
		await runLifecycle(restored, "session_start", branch);
		expect(replayWorkflowChain(branch).chain.at(-1)?.workflow.kind).toBe(
			"review",
		);
		await expect(
			requireTool(restored, "workflow_create").execute("removed", {
				...args,
				id: "other-kind",
			}),
		).rejects.toThrow("unknown workflow kind");
		await requireTool(restored, "workflow_exit").execute("return", {
			basis: "Done",
		});
	});

	test("nested dynamic creation accepts schema, isolates same stage IDs, and rejects waiting IDs atomically", async () => {
		await createSuite();
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const create = requireTool(fake, "workflow_create");
		const args = { ...triggeredCreateArguments(), nested: true };
		expect(Check(create.parameters as never, args)).toBe(true);
		const triggers = captureTriggers(fake);
		await create.execute("root", args);
		const parent = replayWorkflowChain(savedBranch(fake)).chain[0];
		if (!parent) {
			throw new Error("missing parent");
		}
		await create.execute("child", {
			...createArguments("dynamic-child"),
			nested: true,
		});
		await requireTool(fake, "workflow_edit_stage").execute("edit", {
			stageId: "start",
			description: "Child changed",
			goal: "Child ready",
			prompt: "Child work",
			model: { thinking: "low" },
		});
		const result = (await requireTool(fake, "workflow_get_stage").execute(
			"read",
			{ stageId: "start" },
		)) as { content: { text: string }[] };
		const content = result.content[0];
		if (!content) {
			throw new Error("missing stage result");
		}
		expect(JSON.parse(content.text).description).toBe("Child changed");
		expect(replayWorkflowChain(savedBranch(fake)).chain[0]).toEqual(parent);
		const entries = [...fake.appended];
		await expect(
			create.execute("duplicate", createArguments()),
		).rejects.toThrow("already");
		expect(fake.appended).toEqual(entries);
		const count = triggers.length;
		await requireTool(fake, "workflow_exit").execute("return", {
			basis: "Child complete",
		});
		expect(triggers).toHaveLength(count);
		expect(replayWorkflowChain(savedBranch(fake)).chain).toEqual([parent]);
	});

	test("nested catalog workflows run alone and leave an empty chain from their final stage", async () => {
		const suite = await createSuite();
		await writeFile(
			join(suite, "workflow/workflows/check.yaml"),
			groundedYaml().replace("version: 2", "version: 3\nnested: true"),
		);
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("standalone", {
			workflowId: "check",
		});
		await requireTool(fake, "workflow_transition").execute("finish", {
			stageId: "done",
			ground: "ready",
			basis: "Ready to deliver",
		});
		expect(replayWorkflowChain(savedBranch(fake)).chain[0]?.route).toEqual([
			"start",
			"done",
		]);
		await requireTool(fake, "workflow_exit").execute("exit", {
			basis: "Delivered",
		});
		expect(replayWorkflowChain(savedBranch(fake)).chain).toEqual([]);
		expect(fake.messages.at(-1)?.details).toMatchObject({ kind: "exit" });
		expect(fake.model?.id).toBe("current-model");
		expect(fake.thinkingLevel).toBe("medium");
	});

	test("reload branch navigation and compaction preserve edited waiting definitions routes and snapshots", async () => {
		await createSuite();
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const create = requireTool(fake, "workflow_create");
		await create.execute("parent", triggeredCreateArguments());
		await requireTool(fake, "workflow_edit_stage").execute("edit-parent", {
			stageId: "start",
			description: "Edited parent",
			goal: "Parent ready",
			prompt: "Parent instructions",
			model: { thinking: "high" },
		});
		const parentBranch = savedBranch(fake);
		await create.execute("child", {
			...createArguments("dynamic-child"),
			nested: true,
		});
		await requireTool(fake, "workflow_transition").execute("advance-child", {
			stageId: "done",
			basis: "Child work ready",
		});
		await requireTool(fake, "workflow_edit_stage").execute("edit-child", {
			stageId: "done",
			description: "Edited child",
			goal: "Child ready",
			prompt: "Child instructions",
			model: { thinking: "low" },
		});
		const branch = savedBranch(fake);
		const saved = replayWorkflowChain(branch).chain;
		await runLifecycle(fake, "session_start", branch);
		expect(fake.messages.at(-1)?.details).toMatchObject({
			kind: "checkpoint",
			workflowId: "dynamic-child",
			currentStageId: "done",
			graphWorkflowIds: ["dynamic-delivery", "dynamic-child"],
		});
		expect(fake.thinkingLevel).toBe("low");
		await runLifecycle(fake, "session_tree", parentBranch);
		expect(fake.thinkingLevel).toBe("high");
		await runLifecycle(fake, "session_tree", []);
		expect(fake.thinkingLevel).toBe("medium");
		await runLifecycle(fake, "session_tree", branch);
		expect(fake.thinkingLevel).toBe("low");
		await runSessionCompact(fake);
		expect(fake.messages.at(-1)?.details).toMatchObject({
			kind: "checkpoint",
			graphWorkflowIds: ["dynamic-delivery", "dynamic-child"],
		});
		expect(replayWorkflowChain(savedBranch(fake)).chain).toEqual(saved);
		await requireTool(fake, "workflow_exit").execute("return", {
			basis: "Child done",
		});
		expect(fake.thinkingLevel).toBe("high");
		expect(replayWorkflowChain(savedBranch(fake)).chain).toEqual(
			saved.slice(0, 1),
		);
		await requireTool(fake, "workflow_exit").execute("exit", {
			basis: "Parent done",
		});
		expect(fake.thinkingLevel).toBe("medium");
	});

	test("nested start and return persistence failures roll back settings and replacement uses root baseline", async () => {
		const suite = await createSuite(modelYaml());
		await writeFile(
			join(suite, "workflow/workflows/check.yaml"),
			groundedYaml().replace("version: 2", "version: 3\nnested: true"),
		);
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("root", {
			workflowId: "delivery",
		});
		const create = requireTool(fake, "workflow_create");
		fake.appendError = new Error("persistence failed");
		await expect(
			create.execute("fail-start", {
				...createArguments("child-failed"),
				nested: true,
			}),
		).rejects.toThrow("persistence failed");
		expect(fake.model?.id).toBe("workflow-model");
		expect(fake.thinkingLevel).toBe("xhigh");
		fake.appendError = undefined;
		await create.execute("child", {
			...createArguments("child-success"),
			nested: true,
		});
		expect(replayWorkflowChain(savedBranch(fake)).chain).toHaveLength(2);
		fake.appendError = new Error("persistence failed");
		await expect(
			requireTool(fake, "workflow_exit").execute("fail-return", {
				basis: "Done",
			}),
		).rejects.toThrow("persistence failed");
		expect(fake.thinkingLevel).toBe("medium");
		expect(replayWorkflowChain(savedBranch(fake)).chain).toHaveLength(2);
		await expect(
			create.execute("fail-replace", createArguments("replace-failed")),
		).rejects.toThrow("persistence failed");
		expect(fake.model?.id).toBe("workflow-model");
		expect(fake.thinkingLevel).toBe("medium");
		fake.appendError = undefined;
		await create.execute("replace", createArguments("replacement"));
		const chain = replayWorkflowChain(savedBranch(fake)).chain;
		expect(chain).toHaveLength(1);
		expect(chain[0]?.restoration).toEqual({
			modelId: "openai/current-model",
			thinking: "medium",
		});
		expect(fake.model?.id).toBe("current-model");
		await requireTool(fake, "workflow_exit").execute("exit", { basis: "Done" });
		expect(fake.thinkingLevel).toBe("medium");
	});
});

describe("workflow extension lifecycle", () => {
	test("validates exit basis before any side effect and rejects stale calls", async () => {
		await createSuite(modelYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("start", {
			workflowId: "delivery",
		});
		const exit = requireTool(fake, "workflow_exit");
		expect(exit.executionMode).toBe("sequential");
		const saved = JSON.stringify(fake.appended);
		const messages = JSON.stringify(fake.messages);
		const calls = fake.modelSetCalls.length;
		for (const basis of [undefined, null, 12, false, [], {}, "", " \n\t"]) {
			const args = basis === undefined ? {} : { basis };
			expect(Check(exit.parameters as never, args)).toBe(false);
			await expect(exit.execute("bad", args)).rejects.toThrow("basis");
			expect(JSON.stringify(fake.appended)).toBe(saved);
			expect(JSON.stringify(fake.messages)).toBe(messages);
			expect(fake.modelSetCalls).toHaveLength(calls);
			expect(fake.thinkingLevel).toBe("xhigh");
		}
		await exit.execute("exit", {
			basis: " \nTask no longer needs this process.\n ",
		});
		expect(fake.model?.id).toBe("current-model");
		expect(fake.thinkingLevel).toBe("medium");
		expect(fake.appended.at(-1)?.data).toEqual({
			kind: "exited",
			journalVersion: 2,
		});
		expect((fake.messages.at(-1)?.details as { kind: string }).kind).toBe(
			"exit",
		);
		expect(fake.widgetUpdates.at(-1)?.content).toBeUndefined();
		expect(fake.activeTools).toContain("workflow_exit");
		await expect(
			exit.execute("stale", { basis: "Already left." }),
		).rejects.toThrow("no workflow is active");
		await expect(
			requireTool(fake, "workflow_transition").execute("stale", {
				stageId: "done",
				basis: "Already left.",
			}),
		).rejects.toThrow("no workflow is active");
	});

	test.each([
		false,
		true,
	])("restores version1 completion settings with historical rework %s", async (rework) => {
		await createSuite(modelYaml());
		const source = await createFakePi();
		await runLifecycle(source, "session_start");
		await requireTool(source, "workflow_activate").execute("start", {
			workflowId: "delivery",
		});
		const { mode: _mode, ...saved } = source.appended[0]?.data as Record<
			string,
			unknown
		>;
		const branch = [
			{
				type: "custom",
				customType: "workflow-state",
				data: { ...saved, journalVersion: 1 },
			},
			{
				type: "custom",
				customType: "workflow-state",
				data: { kind: "transitioned", route: ["start", "done"] },
			},
			{ type: "model_change", provider: "openai", modelId: "workflow-model" },
			{ type: "thinking_level_change", thinkingLevel: "high" },
			{
				type: "custom",
				customType: "workflow-state",
				data: { kind: "completed", route: ["start", "done"] },
			},
			...(rework
				? [
						{
							type: "custom",
							customType: "workflow-state",
							data: { kind: "transitioned", route: ["start"] },
						},
					]
				: []),
		];
		const restored = await createFakePi();
		await runLifecycle(restored, "session_start", branch);
		expect(restored.model?.id).toBe(
			rework ? "workflow-model" : "current-model",
		);
		expect(restored.thinkingLevel).toBe(rework ? "xhigh" : "medium");
		expect(replayWorkflowState(branch)?.route).toEqual(
			rework ? ["start"] : undefined,
		);
		if (!rework) {
			expect(restored.widgetUpdates.at(-1)?.content).toBeUndefined();
		}
	});

	test("publishes no-workflow state again only when no visible record shows it", async () => {
		// Purpose: a restart or a compaction that keeps the exit record must not repeat it.
		// Input and expected output: an exited workflow, then a restart and a compaction that keep the exit record: no new record; a compaction that summarizes it: one exit record.
		// Dependencies: replay of saved state, session projection, and journal restoration.
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("activate", {
			workflowId: "delivery",
		});
		await requireTool(fake, "workflow_exit").execute("exit", {
			basis: "No more work.",
		});
		const history = [
			...fake.appended.map(({ data }) => ({
				type: "custom",
				customType: "workflow-state",
				data,
			})),
			...fake.messages.map((message) => ({
				type: "custom_message",
				...message,
			})),
		];
		const count = fake.messages.length;
		await runLifecycle(fake, "session_start", history);
		await runSessionCompact(fake, true, projectBranch(history));
		expect(fake.messages).toHaveLength(count);
		await runSessionCompact(fake);
		expect(fake.messages).toHaveLength(count + 1);
		expect((fake.messages.at(-1)?.details as { kind: string }).kind).toBe(
			"exit",
		);
	});

	test("publishes no-workflow state after compaction of an exited workflow", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("activate", {
			workflowId: "delivery",
		});
		await requireTool(fake, "workflow_exit").execute("exit", {
			basis: "No more work.",
		});
		const count = fake.messages.length;
		await runSessionCompact(fake);
		expect(fake.messages).toHaveLength(count + 1);
		expect((fake.messages.at(-1)?.details as { kind: string }).kind).toBe(
			"exit",
		);
		expect(fake.widgetUpdates.at(-1)?.content).toBeUndefined();
	});

	test("reuses stages of a workflow that runs again until a compaction", async () => {
		// Purpose: a second run reuses the stages that the context holds, and a compaction makes them unknown.
		// Input and expected output: run, exit, run gives reuse; exit, compaction, run gives inline.
		// Dependencies: session_compact wiring and journal-local known-stage tracking.
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const run = async () => {
			await requireTool(fake, "workflow_activate").execute("activate", {
				workflowId: "delivery",
			});
			const activation = fake.messages
				.filter(
					({ details }) => (details as { kind?: string }).kind === "activation",
				)
				.at(-1);
			await requireTool(fake, "workflow_exit").execute("exit", {
				basis: "No more work.",
			});
			return (activation?.details as { guidelines?: string }).guidelines;
		};
		expect(await run()).toBe("inline");
		expect(await run()).toBe("reuse");
		await runSessionCompact(fake);
		expect(await run()).toBe("inline");
	});

	test("synchronizes empty branches after exit and respects later manual settings", async () => {
		await createSuite(modelYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("start", {
			workflowId: "delivery",
		});
		await requireTool(fake, "workflow_exit").execute("exit", {
			basis: "Done.",
		});
		const ended = fake.appended.map(({ data }) => ({
			type: "custom",
			customType: "workflow-state",
			data,
		}));
		await runLifecycle(fake, "session_tree", [
			...ended,
			{ type: "model_change", provider: "openai", modelId: "workflow-model" },
			{ type: "thinking_level_change", thinkingLevel: "low" },
		]);
		expect(fake.model?.id).toBe("workflow-model");
		expect(fake.thinkingLevel).toBe("low");
		await runLifecycle(fake, "session_tree", ended);
		expect(fake.model?.id).toBe("current-model");
		expect(fake.thinkingLevel).toBe("medium");
		await runLifecycle(fake, "session_tree", [
			{ type: "thinking_level_change", thinkingLevel: "high" },
		]);
		await runLifecycle(fake, "session_tree", [
			{ type: "model_change", provider: "openai", modelId: "workflow-model" },
		]);
		expect(fake.model?.id).toBe("workflow-model");
		expect(fake.thinkingLevel).toBe("medium");
		await runLifecycle(fake, "session_tree", []);
		expect(fake.model?.id).toBe("current-model");
		expect(fake.thinkingLevel).toBe("medium");
	});

	test("replacement snapshots the original root settings and rolls back failed persistence", async () => {
		await createSuite(modelYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("start", {
			workflowId: "delivery",
		});
		const create = requireTool(fake, "workflow_create");
		fake.appendError = new Error("replacement failed");
		await expect(create.execute("replace", createArguments())).rejects.toThrow(
			"replacement failed",
		);
		expect(fake.model?.id).toBe("workflow-model");
		expect(fake.thinkingLevel).toBe("xhigh");
		expect(fake.appended).toHaveLength(1);
		fake.appendError = undefined;
		await create.execute("replace", createArguments());
		expect(fake.model?.id).toBe("current-model");
		expect(
			(fake.appended.at(-1)?.data as { restoration: unknown }).restoration,
		).toEqual({ modelId: "openai/current-model", thinking: "medium" });
		await requireTool(fake, "workflow_exit").execute("exit", {
			basis: "Done.",
		});
		expect(fake.model?.id).toBe("current-model");
		expect(fake.activeTools).toContain("workflow_get_stage");
		await expect(
			requireTool(fake, "workflow_get_stage").execute("stale", {
				stageId: "start",
			}),
		).rejects.toThrow("no workflow is active");
	});
	test("publishes only the final idle policy when work starts", async () => {
		// Purpose: agent selection changes tools immediately but journals only the options used by work.
		// Input/output: start and policy toggles publish nothing; before_agent_start publishes one options record.
		// Edge cases: unchanged starts and A -> B -> A keep the original record and history prefix.
		// Dependencies: isolated catalog, real journal, fake lifecycle and persisted branch messages.
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		setMainWorkflowPolicy(fake, []);
		setMainWorkflowPolicy(fake, ["delivery"]);
		expect(fake.messages).toHaveLength(0);
		await runBeforeAgentStart(fake);
		expect(fake.messages.map(({ details }) => details)).toMatchObject([
			{ version: 1, kind: "activation_options" },
		]);
		const prefix = structuredClone(fake.messages);
		setMainWorkflowPolicy(fake, []);
		setMainWorkflowPolicy(fake, ["delivery"]);
		await runBeforeAgentStart(fake);
		expect(fake.messages).toEqual(prefix);
		setMainWorkflowPolicy(fake, []);
		expect(fake.messages).toEqual(prefix);
		await runBeforeAgentStart(fake);
		expect(fake.messages).toHaveLength(2);
		expect(fake.messages.slice(0, 1)).toEqual(prefix);
		await runBeforeAgentStart(fake);
		expect(fake.messages).toHaveLength(2);
	});

	test("rebuilds activation availability from the selected context segment at work start", async () => {
		// Purpose: navigation and manual compaction must not create premature availability records.
		// Input/output: navigating empty history and compacting defer publication until work starts.
		// Edge cases: a compacted segment needs fresh options; initial empty options need no replacement.
		// Dependencies: fake session history, compaction, and production journal deduplication.
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await runLifecycle(fake, "session_tree");
		expect(fake.messages).toHaveLength(0);
		await runBeforeAgentStart(fake);
		expect(fake.messages).toHaveLength(1);
		await runSessionCompact(fake);
		expect(fake.messages).toHaveLength(1);
		await runBeforeAgentStart(fake, [{ type: "compaction" }]);
		expect(fake.messages).toHaveLength(2);
		setMainWorkflowPolicy(fake, []);
		await runLifecycle(fake, "session_tree");
		await runBeforeAgentStart(fake, []);
		expect(fake.messages).toHaveLength(2);
	});

	/** Proves configured definitions exist before lifecycle policy resolution. */
	test("registers the six sequential workflow tools during initialization", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		expect(fake.tools.map(({ name }) => name)).toEqual([
			"workflow_activate",
			"workflow_get_stage",
			"workflow_edit_stage",
			"workflow_transition",
			"workflow_exit",
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
		expect(fake.tools).toHaveLength(6);
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
		expect(Check(editSchema, { ...validEdit, goal: "Outcome ready" })).toBe(
			true,
		);
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

	/** Checks required goals and transition ground shapes in the public creation schema. */
	test("exposes required goals and closed optional transition grounds", async () => {
		await createSuite();
		const fake = await createFakePi();
		const schema = requireTool(fake, "workflow_create")
			.parameters as Parameters<typeof Check>[0];
		expect(Check(schema, createArguments())).toBe(true);
		const missingGoal = createArguments();
		delete (missingGoal["stages"] as Record<string, unknown>[])[0]?.["goal"];
		expect(Check(schema, missingGoal)).toBe(false);
		for (const grounds of [
			[{}],
			[{ id: "revise" }],
			[{ id: "revise", when: "Condition", extra: true }],
			"condition",
		]) {
			const args = createArguments();
			(args["transitions"] as Record<string, unknown>[])[1] = {
				from: "done",
				to: "start",
				type: "rework",
				grounds,
			};
			expect(Check(schema, args)).toBe(false);
		}
		const versioned = { ...createArguments(), version: 2 };
		expect(Check(schema, versioned)).toBe(false);
	});

	/** Checks format-3 creation and restoration through the registered tool. */
	test("creates and restores format-3 goals grounds and routes", async () => {
		await createSuite();
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_create").execute(
			"create",
			createArguments(),
		);
		const created = fake.appended[0]?.data;
		expect(created).toMatchObject({
			kind: "created",
			route: ["start"],
			workflow: {
				version: 3,
				stages: [
					{ goal: "Initial evidence is ready" },
					{ goal: "Delivery is approved" },
				],
			},
		});
		const initial = latestWorkflowContent(fake) ?? "";
		expect(initial).toContain("<stage_goal>");
		expect(initial.indexOf("<stage_goal>")).toBeLessThan(
			initial.indexOf("<stage_guidelines>"),
		);
		await requireTool(fake, "workflow_transition").execute("done", {
			basis: "Stage checks passed.",
			stageId: "done",
		});
		const branch = JSON.parse(
			JSON.stringify(
				fake.appended.map(({ customType, data }) => ({
					type: "custom",
					customType,
					data,
				})),
			),
		);
		const restored = replayWorkflowState(branch);
		expect(restored?.route).toEqual(["start", "done"]);
		expect(restored?.workflow.version).toBe(3);
		expect(
			restored?.workflow.stages.map(({ id, goal }) => ({ id, goal })),
		).toEqual([
			{ id: "start", goal: "Initial evidence is ready" },
			{ id: "done", goal: "Delivery is approved" },
		]);
		expect(restored?.workflow.transitions[1]?.grounds).toEqual([
			{ id: "revise", when: "The review requires changes" },
		]);
		await runLifecycle(fake, "session_tree", branch);
		await expect(
			requireTool(fake, "workflow_transition").execute("invalid", {
				basis: "Stage checks passed.",
				stageId: "start",
				ground: "missing",
			}),
		).rejects.toThrow("revise");
		await requireTool(fake, "workflow_transition").execute("rework", {
			basis: "Stage checks passed.",
			stageId: "start",
			ground: "revise",
		});
	});

	/**
	 * Proves the provider-facing create schema delegates exact string checks to workflow execution.
	 * Inputs and expected outputs: structurally valid strings pass TypeBox, then execution rejects invalid workflow text.
	 * Edge cases: root text, stage text and IDs, and transition endpoints cover every constrained create string.
	 * Dependencies: the registered workflow_create schema and validateCreatedWorkflowDefinition.
	 */
	test("delegates exact create string checks to workflow execution", async () => {
		await createSuite();
		const fake = await createFakePi();
		const create = requireTool(fake, "workflow_create");
		const schema = create.parameters as Parameters<typeof Check>[0];
		const cases = [
			(args: Record<string, unknown>) => {
				args["id"] = " dynamic-delivery";
			},
			(args: Record<string, unknown>) => {
				args["description"] = "Dynamic\ndelivery";
			},
			(args: Record<string, unknown>) => {
				const stages = args["stages"] as Record<string, unknown>[];
				stages[0] = { ...stages[0], id: "start stage" };
			},
			(args: Record<string, unknown>) => {
				const stages = args["stages"] as Record<string, unknown>[];
				stages[0] = { ...stages[0], description: "Start\nwork" };
			},
			(args: Record<string, unknown>) => {
				const transitions = args["transitions"] as Record<string, unknown>[];
				transitions[0] = { ...transitions[0], from: "start stage" };
			},
			(args: Record<string, unknown>) => {
				const transitions = args["transitions"] as Record<string, unknown>[];
				transitions[0] = { ...transitions[0], to: "done stage" };
			},
		] as const;

		for (const mutate of cases) {
			const args = createArguments();
			mutate(args);
			expect(Check(schema, args)).toBe(true);
			await expect(create.execute("create", args)).rejects.toThrow(
				"workflow_create",
			);
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
		await runLifecycle(fake, "session_tree");
		await runSessionCompact(fake);

		expect(fake.activeTools).toEqual(["read", "workflow_create"]);
		expect(
			fake.messages.filter(
				({ details }) =>
					typeof details === "object" &&
					details !== null &&
					Reflect.get(details, "kind") === "activation_options",
			),
		).toHaveLength(0);
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
			"workflow_exit",
			"workflow_create",
		]);
		expect(
			await transition.execute("transition", {
				basis: "Stage checks passed.",
				stageId: "done",
			}),
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

	/** Proves saved format-1 dynamic stages remain goal-free and inspection is read-only. */
	test("inspects a restored unversioned dynamic snapshot without a goal", async () => {
		await createSuite();
		const fake = await createFakePi();
		const saved = activatedEntry() as { data: { kind: string } };
		saved.data.kind = "created";
		await runLifecycle(fake, "session_start", [saved]);
		const before = fake.appended.length;
		const get = requireTool(fake, "workflow_get_stage");
		const result = (await get.execute("legacy-get", { stageId: "start" })) as {
			content: Array<{ text: string }>;
		};
		const stage = JSON.parse(result.content[0]?.text ?? "null");
		expect(stage).toMatchObject({
			id: "start",
			description: "Start",
			model: {},
			initial: true,
			final: false,
		});
		expect(stage).not.toHaveProperty("goal");
		expect(fake.appended).toHaveLength(before);
	});

	/** Proves goal validation and persistence failures preserve both state and journal evidence. */
	test.each([
		"start",
		"done",
	])("edits goals atomically for %s and replays saved evidence", async (stageId) => {
		await createSuite();
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const calls = captureTriggers(fake);
		await requireTool(fake, "workflow_create").execute(
			"create",
			triggeredCreateArguments(),
		);
		const edit = requireTool(fake, "workflow_edit_stage");
		const get = requireTool(fake, "workflow_get_stage");
		const replacement = {
			stageId,
			description: "Revised",
			prompt: "Replacement instructions.",
			model: { thinking: "high" },
		};
		const before = structuredClone(fake.appended);
		const messages = structuredClone(fake.messages);
		const triggerCount = calls.length;
		const original = await get.execute("before", { stageId });
		for (const goal of [undefined, null, "", "  ", 42]) {
			await expect(
				edit.execute("invalid", {
					...replacement,
					...(goal === undefined ? {} : { goal }),
				}),
			).rejects.toThrow("goal");
			expect(fake.appended).toEqual(before);
			expect(fake.messages).toEqual(messages);
			expect(await get.execute("unchanged", { stageId })).toEqual(original);
		}
		fake.appendError = new Error("append failed");
		await expect(
			edit.execute("unpersisted", { ...replacement, goal: "Revised outcome" }),
		).rejects.toThrow("append failed");
		expect(fake.appended).toEqual(before);
		expect(fake.messages).toEqual(messages);
		expect(await get.execute("unchanged", { stageId })).toEqual(original);
		expect(fake.thinkingLevel).toBe("medium");
		fake.appendError = undefined;
		await edit.execute("edit", {
			...replacement,
			goal: "  Revised <&> outcome  ",
		});
		expect(fake.appended.at(-1)?.data).toMatchObject({
			kind: "stage_edited",
			goal: "Revised <&> outcome",
		});
		expect(fake.thinkingLevel).toBe(stageId === "start" ? "high" : "medium");
		expect(calls).toHaveLength(triggerCount);
		const record = fake.messages.at(-1);
		expect(record?.details).toMatchObject({
			kind: "stage_update",
			stageId,
			active: stageId === "start",
		});
		const content = record?.content ?? "";
		expect(content).toContain("<stage_goal>");
		expect(content.indexOf("<stage_goal>")).toBeLessThan(
			content.indexOf("<stage_guidelines>"),
		);
		expect(content).not.toContain("<workflow_stage_activated");
		const branch = fake.appended.map(({ customType, data }) => ({
			type: "custom",
			customType,
			data,
		}));
		const restored = replayWorkflowState(JSON.parse(JSON.stringify(branch)));
		expect(restored?.route).toEqual(["start"]);
		expect(
			restored?.workflow.stages.find(({ id }) => id === stageId)?.goal,
		).toBe("Revised <&> outcome");
		await runLifecycle(fake, "session_tree", branch);
		const result = (await get.execute("after", { stageId })) as {
			content: Array<{ text: string }>;
		};
		expect(JSON.parse(result.content[0]?.text ?? "null")).toMatchObject({
			goal: "Revised <&> outcome",
		});
	});

	/** Proves restored format1 edits omit the goal key in persisted entries. */
	test("edits restored format1 state without introducing a goal", async () => {
		await createSuite();
		const fake = await createFakePi();
		const saved = activatedEntry() as { data: { kind: string } };
		saved.data.kind = "created";
		await runLifecycle(fake, "session_start", [saved]);
		const edit = requireTool(fake, "workflow_edit_stage");
		const replacement = {
			stageId: "start",
			description: "Revised",
			prompt: "Replacement instructions.",
			model: { thinking: "high" },
		};
		const before = structuredClone(fake.messages);
		await expect(
			edit.execute("invalid", { ...replacement, goal: "Outcome ready" }),
		).rejects.toThrow("format version 2");
		expect(fake.messages).toEqual(before);
		await edit.execute("legacy", replacement);
		expect(fake.appended.at(-1)?.data).toEqual({
			journalVersion: 2,
			kind: "stage_edited",
			...replacement,
		});
		expect(
			replayWorkflowState([
				saved,
				...fake.appended.map(({ customType, data }) => ({
					type: "custom",
					customType,
					data,
				})),
			])?.workflow.stages[0],
		).not.toHaveProperty("goal");
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
		expect(JSON.parse(initial.content[0]?.text ?? "null")).toMatchObject({
			id: "start",
			description: "Start",
			goal: "Initial evidence is ready",
			model: { thinking: "medium" },
			initial: true,
			final: false,
		});

		await edit.execute("edit-done", {
			stageId: "done",
			goal: "Replacement outcome",
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

		await transition.execute("transition", {
			basis: "Stage checks passed.",
			stageId: "done",
		});
		expect(fake.thinkingLevel).toBe("high");
		await edit.execute("edit-active", {
			stageId: "done",
			goal: "Replacement outcome",
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

	/** Verifies replayed stage edits remain readable until exit and stale offered calls fail afterward. */
	test("replays stage edits and rejects stale stage calls after exit", async () => {
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
			goal: "Replacement outcome",
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
			basis: "Stage checks passed.",
			stageId: "done",
		});
		await runAgentSettled(fake);
		await requireTool(fake, "workflow_exit").execute("exit", {
			basis: "Stage work is complete.",
		});
		expect(fake.activeTools).toContain("workflow_get_stage");
		expect(fake.activeTools).toContain("workflow_edit_stage");
		await expect(
			get.execute("exited-get", { stageId: "done" }),
		).rejects.toThrow("no workflow is active");
		await expect(
			edit.execute("exited-edit", {
				stageId: "done",
				goal: "Replacement outcome",
				description: "Disallowed",
				prompt: "Do not edit an exited workflow.",
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
				goal: "Replacement outcome",
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
				goal: "Replacement outcome",
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
		await transition.execute("advance", {
			basis: "Stage checks passed.",
			stageId: "done",
		});
		await transition.execute("rework", {
			basis: "Stage checks passed.",
			stageId: "start",
			ground: "revise",
		});

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
		await transition.execute("transition", {
			basis: "Stage checks passed.",
			stageId: "done",
		});
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
		).rejects.toThrow("already runs in the chain");
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
		await transition.execute("call", {
			basis: "Stage checks passed.",
			stageId: "done",
		});
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
		getAgentRuntimeComposition(fake.api).setSelectedAgentContribution({
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
		await transition.execute("call", {
			basis: "Stage checks passed.",
			stageId: "fallback",
		});

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
		await transition.execute("call", {
			basis: "Stage checks passed.",
			stageId: "fallback",
		});

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
		await transition.execute("call", {
			basis: "Stage checks passed.",
			stageId: "implement",
		});

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

	/** Verifies final-stage settlement retains settings and reminders until explicit exit restores the snapshot. */
	test("retains final-stage settings until explicit exit", async () => {
		await createSuite(modelYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");
		await activate.execute("activate", { workflowId: "delivery" });
		const transition = requireTool(fake, "workflow_transition");
		await transition.execute("transition", {
			basis: "Stage checks passed.",
			stageId: "done",
		});

		expect(fake.model?.id).toBe("workflow-model");
		expect(fake.thinkingLevel).toBe("high");

		await runAgentSettled(fake);
		expect(fake.model?.id).toBe("workflow-model");
		expect(fake.thinkingLevel).toBe("high");
		expect(fake.appended).toHaveLength(2);
		await runTurn(fake, 50);
		expect((fake.messages.at(-1)?.details as { kind: string }).kind).toBe(
			"reminder",
		);
		await requireTool(fake, "workflow_exit").execute("exit", {
			basis: "Work is delivered.",
		});

		expect(fake.model?.id).toBe("current-model");
		expect(fake.thinkingLevel).toBe("medium");
		expect(
			fake.appended.map(({ data }) => (data as { kind: string }).kind),
		).toEqual(["activated", "transitioned", "exited"]);
	});

	/** Verifies aborted and failed runs retain the active final stage and its model settings. */
	test.each([
		"aborted",
		"error",
	] as const)("keeps the final stage active after an %s run settles", async (stopReason) => {
		await createSuite(modelYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("activate", {
			workflowId: "delivery",
		});
		await requireTool(fake, "workflow_transition").execute("transition", {
			basis: "Stage checks passed.",
			stageId: "done",
		});

		await runTurn(fake, 0, undefined, {
			role: "assistant",
			content: [],
			stopReason,
		});
		await runAgentSettled(fake);

		expect(fake.model?.id).toBe("workflow-model");
		expect(fake.thinkingLevel).toBe("high");
		expect(
			fake.appended.map(({ data }) => (data as { kind: string }).kind),
		).toEqual(["activated", "transitioned"]);
		expect(latestWorkflowContent(fake)).toContain(
			'<workflow_stage_activated workflow_id="delivery" stage_id="done"',
		);
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

	/** Verifies replay of an exit restores the root snapshot without reapplying final-stage settings. */
	test("does not reapply workflow settings when replaying exit", async () => {
		await createSuite(modelYaml());
		const source = await createFakePi();
		await runLifecycle(source, "session_start");
		await requireTool(source, "workflow_activate").execute("activate", {
			workflowId: "delivery",
		});
		await requireTool(source, "workflow_transition").execute("transition", {
			basis: "Stage checks passed.",
			stageId: "done",
		});
		await requireTool(source, "workflow_exit").execute("exit", {
			basis: "Stage work is complete.",
		});

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

	/** Verifies a settled final stage stays active and supports route-dependent rework before exit. */
	test("retains final-stage context and supports rework before exit", async () => {
		await createSuite(modelYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");
		await activate.execute("activate", { workflowId: "delivery" });
		const transition = requireTool(fake, "workflow_transition");
		await transition.execute("transition", {
			basis: "Stage checks passed.",
			stageId: "done",
		});
		await runAgentSettled(fake);

		expect((fake.messages.at(-1)?.details as { kind: string }).kind).toBe(
			"stage_activation",
		);
		expect(fake.model?.id).toBe("workflow-model");
		expect(fake.thinkingLevel).toBe("high");

		await transition.execute("rework", {
			basis: "Stage checks passed.",
			stageId: "start",
		});

		expect(fake.model?.id).toBe("workflow-model");
		expect(fake.thinkingLevel).toBe("xhigh");
		expect(
			replayWorkflowState(
				fake.appended.map(({ data }) => ({
					type: "custom",
					customType: "workflow-state",
					data,
				})),
			)?.route,
		).toEqual(["start"]);
	});

	/** Verifies an exit persistence failure rolls model restoration back and preserves the active route. */
	test("rolls back final-stage restoration when exit persistence fails", async () => {
		await createSuite(modelYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");
		await activate.execute("activate", { workflowId: "delivery" });
		const transition = requireTool(fake, "workflow_transition");
		await transition.execute("transition", {
			basis: "Stage checks passed.",
			stageId: "done",
		});
		fake.appendError = new Error("exit append failed");

		await expect(
			requireTool(fake, "workflow_exit").execute("exit", {
				basis: "Stage work is complete.",
			}),
		).rejects.toThrow("exit append failed");

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
		expect(
			await transition.execute("call", {
				basis: "Stage checks passed.",
				stageId: "done",
			}),
		).toMatchObject({
			content: [{ type: "text", text: '{"success":true}' }],
		});
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
		await transition.execute("call", {
			basis: "Stage checks passed.",
			stageId: "done",
		});
		const entriesBeforeReactivation = [...fake.appended];

		await expect(
			activate.execute("call", { workflowId: "delivery" }),
		).rejects.toThrow("already runs in the chain");

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

	/** Verifies activation and active context stay offered when the sole catalog option becomes active. */
	test("keeps active context and the previously offered sole activation tool", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		setMainWorkflowPolicy(fake, ["delivery"], ["read", "workflow_activate"]);
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");

		await activate.execute("activate", { workflowId: "delivery" });
		expect(fake.activeTools).toEqual(["read", "workflow_activate"]);
		const content = latestWorkflowContent(fake);
		expect(content).toContain(
			'<workflow_stage_activated workflow_id="delivery" stage_id="start"',
		);
		expect(content).toContain("<stage_guidelines>\nStart work");
		expect(content).not.toContain("<workflow_activation_options");
	});

	/** Checks basis validation before any transition side effects for both catalog formats. */
	test.each([
		1, 2,
	])("requires a nonempty runtime transition basis for format %s", async (version) => {
		await createSuite(version === 1 ? validYaml() : groundedYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("activate", {
			workflowId: "delivery",
		});
		const transition = requireTool(fake, "workflow_transition");
		const ground = version === 2 ? { ground: "ready" } : {};
		const schema = transition.parameters as Parameters<typeof Check>[0];
		const entries = [...fake.appended];
		const messages = [...fake.messages];
		const model = fake.model;
		const thinking = fake.thinkingLevel;
		for (const invalid of [
			{},
			{ basis: undefined },
			{ basis: null },
			{ basis: 7 },
			{ basis: false },
			{ basis: [] },
			{ basis: {} },
			{ basis: "" },
			{ basis: " \t\n" },
		]) {
			const params = { stageId: "done", ...ground, ...invalid };
			expect(Check(schema, params)).toBe(false);
			await expect(transition.execute("invalid", params)).rejects.toThrow(
				"basis",
			);
			expect(fake.appended).toEqual(entries);
			expect(fake.messages).toEqual(messages);
			expect(fake.model).toBe(model);
			expect(fake.thinkingLevel).toBe(thinking);
		}
		await transition.execute("valid", {
			stageId: "done",
			...ground,
			basis: "  Checks passed.\nThe result is ready.  ",
		});
		expect(fake.appended.at(-1)?.data).toEqual({
			journalVersion: 2,
			kind: "transitioned",
			route: ["start", "done"],
		});
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
			content: expect.any(String),
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
			basis: "Stage checks passed.",
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
		// Edge case: passive activation-options updates must not change lifecycle delivery.
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

	test("does not publish activation options again at an activation", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await runBeforeAgentStart(fake);
		fake.messages.length = 0;

		await requireTool(fake, "workflow_activate").execute("activate", {
			workflowId: "delivery",
		});

		expect(
			fake.messages.some(({ details }) => !isWorkflowLifecycleDetails(details)),
		).toBe(false);
	});

	/** Proves automatic compaction restores availability for the continuing run. */
	test("re-publishes activation options during automatic compaction", async () => {
		// Purpose: a continuing run needs options after compaction without another before_agent_start.
		// Input/output: run startup and automatic compaction each publish one options record.
		// Edge case: no workflow state exists to produce a checkpoint.
		// Dependencies: session_compact wiring and journal publication.
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await runBeforeAgentStart(fake);

		await runSessionCompact(fake, false);

		expect(fake.messages).toHaveLength(2);
		expect(fake.messages.at(-1)?.details).toMatchObject({
			version: 1,
			kind: "activation_options",
		});
		expect(fake.messages.at(-1)?.options).toEqual({
			deliverAs: "steer",
			triggerTurn: false,
		});
	});

	/** Proves compaction creates one checkpoint and forgets definitions outside that checkpoint. */
	test("checkpoints after compaction and inlines the first later stage entry", async () => {
		// Purpose: post-compaction history must restore exact active instructions without trusting the summary.
		// Input and expected output: review compaction emits one checkpoint, then rework inlines implementation guidance again.
		// Edge case: idle compaction leaves the activation options to the next tool call, which publishes them without another provider turn.
		// Dependencies: session_compact wiring, checkpoint rendering, and known-stage reset.
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("activate", {
			workflowId: "delivery",
		});
		const transition = requireTool(fake, "workflow_transition");
		await transition.execute("advance", {
			basis: "Stage checks passed.",
			stageId: "done",
		});
		const beforeCompaction = fake.messages.length;

		await runSessionCompact(fake);
		expect(fake.messages).toHaveLength(beforeCompaction + 1);
		expect(fake.messages.at(-1)?.details).toMatchObject({
			kind: "checkpoint",
			workflowId: "delivery",
			currentStageId: "done",
		});
		expect(fake.messages.at(-1)?.options).toEqual({
			deliverAs: "steer",
			triggerTurn: false,
		});

		await transition.execute("rework", {
			basis: "Stage checks passed.",
			stageId: "start",
		});
		const afterRework = fake.messages.slice(beforeCompaction + 1);
		expect(
			afterRework.find(({ details }) => isWorkflowLifecycleDetails(details))
				?.details,
		).toMatchObject({
			kind: "stage_activation",
			workflowId: "delivery",
			stageId: "start",
		});
		expect(
			afterRework.find(({ details }) => !isWorkflowLifecycleDetails(details))
				?.options,
		).toEqual({
			deliverAs: "steer",
			triggerTurn: false,
		});
	});

	/** Verifies graph restoration decisions through the extension lifecycle. */
	test("restores a missing graph once and preserves visible graphs across compactions", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("activate", {
			workflowId: "delivery",
		});
		const activation = fake.messages.find(({ details }) =>
			isWorkflowLifecycleDetails(details),
		);
		const visible = (message: unknown) =>
			[
				{
					sourceEntry: { type: "custom_message", ...(message as object) },
					messages: [{}],
				},
			] as ProjectedSessionEntry[];

		await runSessionCompact(fake, true, visible(activation));
		expect(fake.messages.at(-1)?.details).toMatchObject({
			kind: "checkpoint",
			includesGraph: false,
		});
		await runSessionCompact(fake);
		const restored = fake.messages.at(-1);
		expect(restored?.details).toMatchObject({
			kind: "checkpoint",
			includesGraph: true,
		});
		await runSessionCompact(fake, true, visible(restored));
		expect(fake.messages.at(-1)?.details).toMatchObject({
			includesGraph: false,
		});

		const oldCheckpoint = {
			type: "custom_message",
			...restored,
			details: {
				...(restored?.details as object),
				includesGraph: undefined,
				graphWorkflowIds: undefined,
			},
		};
		const branch = [activatedEntry(), { type: "compaction" }, oldCheckpoint];
		const beforeRepair = fake.messages.length;
		await runLifecycle(fake, "session_tree", branch);
		expect(fake.messages).toHaveLength(beforeRepair + 1);
		expect(fake.messages.at(-1)?.details).toMatchObject({
			includesGraph: true,
		});
		const repairedBranch = [
			...branch,
			{ type: "custom_message", ...fake.messages.at(-1) },
		];
		await runLifecycle(fake, "session_start", repairedBranch);
		expect(fake.messages).toHaveLength(beforeRepair + 1);
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
	 * Proves saved workflow state continues after an agent temporarily hides workflow tools.
	 * Input and expected output: activation state remains saved while only read is active, then transition resumes after its tool returns.
	 * Edge case: selected-agent tool policy removes every workflow tool without removing the saved route.
	 * Dependencies: runtime composition reconciliation, persisted workflow entries, and transition execution.
	 */
	test("continues saved workflow after compatible tools return", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("activate", {
			workflowId: "delivery",
		});

		setMainWorkflowPolicy(fake, ["delivery"], ["read"]);
		expect(fake.activeTools).toEqual(["read"]);
		expect(fake.appended.at(-1)?.data).toMatchObject({
			kind: "activated",
			route: ["start"],
		});

		setMainWorkflowPolicy(fake, ["delivery"], ["read", "workflow_transition"]);
		expect(fake.activeTools).toEqual(["read", "workflow_transition"]);
		await requireTool(fake, "workflow_transition").execute("continue", {
			basis: "Stage checks passed.",
			stageId: "done",
		});
		expect(fake.appended.at(-1)?.data).toMatchObject({
			kind: "transitioned",
			route: ["start", "done"],
		});
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
		await transition.execute("finish-delivery", {
			basis: "Stage checks passed.",
			stageId: "done",
		});

		setMainWorkflowPolicy(fake, ["review"]);
		expect(fake.messages.at(-1)?.details).toMatchObject({
			kind: "stage_activation",
			workflowId: "delivery",
			stageId: "done",
		});
		await runBeforeAgentStart(fake);
		expect(fake.messages.at(-1)?.details).toEqual({
			version: 1,
			kind: "activation_options",
		});

		await transition.execute("reopen-delivery", {
			basis: "Stage checks passed.",
			stageId: "start",
		});
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

		expect(fake.messages.at(-1)?.details).toMatchObject({
			kind: "checkpoint",
			workflowId: "delivery",
			stageId: "start",
		});
		await runBeforeAgentStart(fake);
		expect(fake.messages.at(-1)?.details).toEqual({
			version: 1,
			kind: "activation_options",
		});

		await transition.execute("finish-delivery", {
			basis: "Stage checks passed.",
			stageId: "done",
		});
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
			transition.execute("call", {
				basis: "Stage checks passed.",
				stageId: "done",
			}),
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

	/** Verifies upstream policy exclusions survive later workflow applicability. */
	test("preserves upstream exclusions when workflow tools become applicable", async () => {
		await createSuite();
		const fake = await createFakePi();
		fake.activeTools = ["read", "workflow_activate", "workflow_transition"];
		if (fake.api === undefined) {
			throw new Error("extension API missing");
		}
		const composition = getAgentRuntimeComposition(fake.api);
		composition.setSelectedAgentContribution({
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

	/** Verifies selected-agent policy changes still gate newly applicable workflow tools. */
	test("reconciles inactive state after selected-agent contribution changes", async () => {
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

	/** Verifies workflow replay cannot reoffer a tool excluded by the selected agent. */
	test("preserves selected-agent exclusions across workflow branch changes", async () => {
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

	/** Proves shutdown releases the selected-agent contribution listener. */
	test("unsubscribes from main-agent changes on shutdown", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		expect(
			fake.listeners.get(SELECTED_AGENT_CONTRIBUTION_CHANGE_EVENT)?.size,
		).toBe(1);
		await runLifecycle(fake, "session_shutdown");
		expect(
			fake.listeners.get(SELECTED_AGENT_CONTRIBUTION_CHANGE_EVENT)?.size,
		).toBe(0);
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

		await transition.execute("finish-delivery", {
			basis: "Stage checks passed.",
			stageId: "done",
		});
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
		// Dependencies: saved workflow replay, selected-agent contribution changes, and independent status presentation.
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
		await transition.execute("call", {
			basis: "Stage checks passed.",
			stageId: "done",
		});
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

/** Exercises catalog activation, persisted definition replay, and record structure together. */
test("activates and restores a format-2 catalog workflow", async () => {
	await createSuite(groundedYaml());
	const fake = await createFakePi();
	await runLifecycle(fake, "session_start");
	await requireTool(fake, "workflow_activate").execute("activate", {
		workflowId: "delivery",
	});
	const activation = fake.messages.find(
		({ details }) =>
			(details as Record<string, unknown>)?.["kind"] === "activation",
	);
	expect(activation).toBeDefined();
	if (activation === undefined) {
		throw new Error("missing activation record");
	}
	const content = activation.content;
	const [graph, entry] = content.split("</workflow_activated>");
	expect(graph).not.toContain("<ground");
	expect(entry).toContain("<stage_goal>");
	expect(entry).toContain("Ready &lt;&amp;&gt; approved");
	expect(entry?.indexOf("<stage_goal>")).toBeLessThan(
		entry?.indexOf("<stage_guidelines>") ?? -1,
	);
	expect(entry).toContain('<ground id="ready">');
	expect(entry).toContain("Evidence &lt;&amp;&gt; approved");
	const snapshot = fake.appended[0];
	if (snapshot === undefined) {
		throw new Error("missing activation snapshot");
	}
	expect(snapshot.data).toMatchObject({
		journalVersion: 2,
		workflow: {
			version: 2,
			stages: [{ goal: "Ready <&> approved" }, { goal: "Delivery ready" }],
		},
		route: ["start"],
	});
	const restored = await createFakePi();
	await runLifecycle(restored, "session_start", [
		{ type: "custom", ...snapshot },
	]);
	await runBeforeAgentStart(restored);
	expect(latestWorkflowContent(restored)).toContain("<stage_goal>");
	expect(latestWorkflowContent(restored)).toContain('<ground id="ready">');
});

/** Checks the registered schema and executor together with the real domain and journal. */
test.each([
	"catalog",
	"dynamic",
])("transitions %s state with declared grounds and preserves it on failure", async (source) => {
	await createSuite(
		source === "catalog"
			? groundedYaml()
			: groundedYaml().replace("      id: openai/workflow-model\n", ""),
	);
	let fake = await createFakePi();
	await runLifecycle(fake, "session_start");
	await requireTool(fake, "workflow_activate").execute("activate", {
		workflowId: "delivery",
	});
	if (source === "dynamic") {
		const snapshot = fake.appended[0];
		if (snapshot === undefined) {
			throw new Error("missing workflow snapshot");
		}
		fake = await createFakePi();
		await runLifecycle(fake, "session_start", [
			{
				type: "custom",
				customType: "workflow-state",
				data: { ...(snapshot.data as object), kind: "created" },
			},
		]);
		await runBeforeAgentStart(fake);
	}
	const tool = requireTool(fake, "workflow_transition");
	const schema = tool.parameters as Parameters<typeof Check>[0];
	expect(
		Check(schema, {
			basis: "Stage checks passed.",
			stageId: "done",
			ground: "ready",
		}),
	).toBe(true);
	expect(
		Check(schema, { basis: "Stage checks passed.", stageId: "done" }),
	).toBe(true);
	expect(
		Check(schema, {
			basis: "Stage checks passed.",
			stageId: "done",
			ground: 42,
		}),
	).toBe(false);
	expect(
		Check(schema, {
			basis: "Stage checks passed.",
			stageId: "done",
			ground: "ready",
			extra: true,
		}),
	).toBe(false);
	const entries = structuredClone(fake.appended);
	const messages = structuredClone(fake.messages);
	const model = fake.model;
	const thinking = fake.thinkingLevel;
	for (const params of [
		{ basis: "Stage checks passed.", stageId: "done", ground: "missing" },
		{ basis: "Stage checks passed.", stageId: "done", ground: "retry" },
	]) {
		await expect(tool.execute("invalid", params)).rejects.toThrow("ready");
		expect(fake.appended).toEqual(entries);
		expect(fake.messages).toEqual(messages);
	}
	for (const params of [
		{ basis: "Stage checks passed.", stageId: "done", ground: 42 },
		{ basis: "Stage checks passed.", stageId: "done", ground: null },
		{
			basis: "Stage checks passed.",
			stageId: "done",
			ground: "ready",
			extra: true,
		},
	]) {
		await expect(tool.execute("invalid", params)).rejects.toThrow();
		expect(fake.appended).toEqual(entries);
		expect(fake.messages).toEqual(messages);
	}
	fake.appendError = new Error("append failed");
	await expect(
		tool.execute("failed", {
			basis: "Stage checks passed.",
			stageId: "done",
			ground: "ready",
		}),
	).rejects.toThrow("append failed");
	expect(fake.appended).toEqual(entries);
	expect(fake.messages).toEqual(messages);
	expect(fake.model).toBe(model);
	expect(fake.thinkingLevel).toBe(thinking);
	fake.appendError = undefined;
	expect(
		await tool.execute("advance", {
			basis: "Stage checks passed.",
			stageId: "done",
			ground: "ready",
		}),
	).toMatchObject({ content: [{ type: "text", text: '{"success":true}' }] });
	expect(fake.appended.at(-1)?.data).toEqual({
		kind: "transitioned",
		journalVersion: 2,
		route: ["start", "done"],
	});
	expect(latestWorkflowContent(fake)).toContain('stage_id="done"');
	expect(latestWorkflowContent(fake)).toContain("<stage_goal>");
	expect(latestWorkflowContent(fake)).toContain('guidelines="inline"');
	expect(latestWorkflowContent(fake)).toContain('<ground id="retry">');
	await runTurn(fake, 0);
	await runAgentSettled(fake);
	expect((fake.messages.at(-1)?.details as { kind: string }).kind).toBe(
		"stage_activation",
	);
	expect(latestWorkflowContent(fake)).toContain('<ground id="retry">');
	await tool.execute("rework", {
		basis: "Stage checks passed.",
		stageId: "start",
		ground: "retry",
	});
	expect(fake.appended.at(-1)?.data).toEqual({
		kind: "transitioned",
		journalVersion: 2,
		route: ["start"],
	});
	const reuse = latestWorkflowContent(fake);
	expect(reuse).toContain('stage_id="start"');
	expect(reuse).toContain('guidelines="reuse"');
	expect(reuse).toContain("<stage_goal>");
	expect(reuse).not.toContain("<stage_guidelines>");
	expect(reuse).toContain('<ground id="ready">');
});

/** Keeps format-1 and unconditional format-2 tool transitions free of grounds. */
test.each([
	"legacy",
	"unconditional",
])("rejects supplied grounds on %s tool transitions", async (mode) => {
	await createSuite(
		mode === "legacy"
			? validYaml()
			: groundedYaml().replace(
					"    grounds:\n      - id: ready\n        when: Evidence <&> approved\n",
					"",
				),
	);
	const fake = await createFakePi();
	await runLifecycle(fake, "session_start");
	await requireTool(fake, "workflow_activate").execute("activate", {
		workflowId: "delivery",
	});
	const tool = requireTool(fake, "workflow_transition");
	const entries = structuredClone(fake.appended);
	const messages = structuredClone(fake.messages);
	await expect(
		tool.execute("invalid", {
			basis: "Stage checks passed.",
			stageId: "done",
			ground: "ready",
		}),
	).rejects.toThrow("ground");
	expect(fake.appended).toEqual(entries);
	expect(fake.messages).toEqual(messages);
	await tool.execute("advance", {
		basis: "Stage checks passed.",
		stageId: "done",
	});
	expect(fake.appended.at(-1)?.data).toEqual({
		kind: "transitioned",
		journalVersion: 2,
		route: ["start", "done"],
	});
});

/** Projects fake journal writes into isolated session entries. */
function savedBranch(fake: FakePi) {
	return fake.appended.map((entry) => ({ type: "custom", ...entry }));
}

/** Captures publication metadata without inspecting model-facing text. */
function captureMessageMetadata(fake: FakePi) {
	return fake.messages.map(({ details, options }) => ({ details, options }));
}

/** Installs bound catalog graphs and returns matching dynamic-parent arguments. */
async function createBoundSuite() {
	const args = triggeredCreateArguments();
	const transitions = args["transitions"] as Record<string, unknown>[];
	args["transitions"] = transitions.map((edge) => ({
		...edge,
		workflow: "check",
	}));
	const suite = await createSuite();
	await writeFile(
		join(suite, "workflow/workflows/delivery.yaml"),
		stringify({ ...args, id: undefined, version: 3 }),
	);
	await writeFile(
		join(suite, "workflow/workflows/check.yaml"),
		stringify({
			...createArguments(),
			id: undefined,
			version: 3,
			nested: true,
			stages: [
				...(createArguments()["stages"] as Record<string, unknown>[]),
				{
					id: "middle",
					description: "Middle",
					goal: "Reviewed",
					prompt: "Review",
					model: { thinking: "low" },
				},
			],
			transitions: [
				{ from: "start", to: "middle", type: "advance" },
				{ from: "middle", to: "done", type: "advance" },
				{
					from: "done",
					to: "start",
					type: "rework",
					grounds: [{ id: "retry", when: "Revision" }],
				},
			],
		}),
	);
	return { suite, args };
}

for (const role of ["main", "child"] as const) {
	for (const source of ["catalog", "created"] as const) {
		test(`bound transitions ${role} ${source} allow, refuse, repeat and rework at any check stage`, async () => {
			const { args } = await createBoundSuite();
			if (role === "child") {
				process.env[CHILD_AGENT_PROCESS_ENV] = "1";
				process.env[SUBAGENT_WORKFLOW_IDS_ENV] = '["delivery","check"]';
			}
			const fake = await createFakePi();
			if (role === "main") {
				setMainWorkflowPolicy(fake, ["delivery", "check"]);
			}
			await runLifecycle(fake, "session_start");
			const triggers = captureTriggers(fake);
			expect(
				Check(requireTool(fake, "workflow_create").parameters as never, args),
			).toBe(true);
			expect(
				Check(requireTool(fake, "workflow_exit").parameters as never, {
					basis: "Ready",
					allow: true,
				}),
			).toBe(true);
			await requireTool(
				fake,
				source === "catalog" ? "workflow_activate" : "workflow_create",
			).execute(
				"start",
				source === "catalog" ? { workflowId: "delivery" } : args,
			);
			const parent = replayWorkflowChain(savedBranch(fake)).chain[0];
			if (parent === undefined) {
				throw new Error("missing parent fixture");
			}
			const move = requireTool(fake, "workflow_transition");
			const exit = requireTool(fake, "workflow_exit");
			const request = { stageId: "done", basis: "Ready for checking" };
			await move.execute("request", request);
			const pending = replayWorkflowChain(savedBranch(fake)).chain;
			expect(pending[0]).toEqual(parent);
			expect(pending[1]?.workflow.id).toBe("check");
			expect(pending[1]?.pendingTransition).toEqual({ stageId: "done" });
			const before = {
				entries: [...fake.appended],
				messages: captureMessageMetadata(fake),
				calls: [...fake.modelSetCalls],
				thinking: fake.thinkingLevel,
			};
			for (const allow of [undefined, null, "true", 1, {}]) {
				await expect(
					exit.execute("bad", {
						basis: "Check decision",
						...(allow === undefined ? {} : { allow }),
					}),
				).rejects.toThrow("allow");
			}
			expect(fake.appended).toEqual(before.entries);
			expect(captureMessageMetadata(fake)).toEqual(before.messages);
			expect(fake.modelSetCalls).toEqual(before.calls);
			expect(fake.thinkingLevel).toBe(before.thinking);
			await move.execute("middle-check", {
				stageId: "middle",
				basis: "Initial check finished",
			});
			const triggerCount = triggers.length;
			await exit.execute("refuse", { basis: "More work needed", allow: false });
			expect(replayWorkflowChain(savedBranch(fake)).chain).toEqual([parent]);
			expect(triggers).toHaveLength(triggerCount);
			expect(
				(fake.messages.at(-1)?.details as Record<string, unknown>)[
					"refusedTransition"
				],
			).toEqual({ stageId: "done" });
			await move.execute("repeat", request);
			await move.execute("middle-again", {
				stageId: "middle",
				basis: "Initial check finished",
			});
			await move.execute("finish-check", {
				stageId: "done",
				basis: "Check complete",
			});
			const count = fake.appended.length;
			await exit.execute(
				"allow",
				{ basis: "Ready", allow: true },
				undefined,
				undefined,
				{},
			);
			expect(fake.appended).toHaveLength(count + 1);
			expect(fake.appended.at(-1)?.data).toEqual({
				kind: "exited",
				journalVersion: 2,
				allow: true,
			});
			expect(replayWorkflowChain(savedBranch(fake)).chain[0]?.route).toEqual([
				"start",
				"done",
			]);
			expect(triggers).toHaveLength(triggerCount + 1);
			await move.execute("rework", {
				stageId: "start",
				ground: "revise",
				basis: "Revision",
			});
			expect(replayWorkflowChain(savedBranch(fake)).chain[0]?.route).toEqual([
				"start",
				"done",
			]);
			await exit.execute(
				"skip-check",
				{ basis: "User permits early return", allow: true },
				undefined,
				undefined,
				{},
			);
			expect(replayWorkflowChain(savedBranch(fake)).chain[0]?.route).toEqual([
				"start",
			]);
			expect(triggers).toHaveLength(triggerCount + 4);
			await exit.execute("ordinary", { basis: "Stop", allow: true });
			expect(fake.appended.at(-1)?.data).toEqual({
				kind: "exited",
				journalVersion: 2,
			});
		});
	}

	test(`bound transitions ${role} start checks outside activation policy and reject running IDs without side effects`, async () => {
		// Purpose: the agent policy limits only workflows that the agent starts itself.
		// Input and expected output: policy [delivery] rejects manual check activation and starts check on the bound transition.
		await createBoundSuite();
		if (role === "child") {
			process.env[CHILD_AGENT_PROCESS_ENV] = "1";
			process.env[SUBAGENT_WORKFLOW_IDS_ENV] = '["delivery"]';
		}
		const fake = await createFakePi();
		if (role === "main") {
			setMainWorkflowPolicy(fake, ["delivery"]);
		}
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("parent", {
			workflowId: "delivery",
		});
		expect(latestWorkflowContent(fake)).toContain(
			'<transition to="done" type="advance" workflow="check" />',
		);
		const before = {
			entries: [...fake.appended],
			messages: captureMessageMetadata(fake),
			calls: [...fake.modelSetCalls],
			tools: [...fake.activeTools],
			widgets: [...fake.widgetUpdates],
			thinking: fake.thinkingLevel,
		};
		await expect(
			requireTool(fake, "workflow_activate").execute("denied", {
				workflowId: "check",
			}),
		).rejects.toThrow("not allowed");
		expect(fake.appended).toEqual(before.entries);
		expect(captureMessageMetadata(fake)).toEqual(before.messages);
		expect(fake.modelSetCalls).toEqual(before.calls);
		expect(fake.activeTools).toEqual(before.tools);
		expect(fake.widgetUpdates).toEqual(before.widgets);
		expect(fake.thinkingLevel).toBe(before.thinking);
		const branch = savedBranch(fake);
		await requireTool(fake, "workflow_transition").execute("bound", {
			stageId: "done",
			basis: "Ready",
		});
		const pending = replayWorkflowChain(savedBranch(fake)).chain;
		expect(pending[1]?.workflow.id).toBe("check");
		expect(pending[1]?.pendingTransition).toEqual({ stageId: "done" });
		if (role === "child") {
			process.env[SUBAGENT_WORKFLOW_IDS_ENV] = '["delivery","check"]';
		}
		const allowed = await createFakePi();
		if (role === "main") {
			setMainWorkflowPolicy(allowed, ["delivery", "check"]);
		}
		await runLifecycle(allowed, "session_start", branch);
		await requireTool(allowed, "workflow_activate").execute("waiting", {
			workflowId: "check",
		});
		const dynamic = createArguments("duplicate-parent");
		dynamic["nested"] = true;
		dynamic["transitions"] = (
			dynamic["transitions"] as Record<string, unknown>[]
		).map((edge) => ({ ...edge, workflow: "check" }));
		await requireTool(allowed, "workflow_create").execute("dynamic", dynamic);
		const entries = [...allowed.appended];
		const messages = captureMessageMetadata(allowed);
		const calls = [...allowed.modelSetCalls];
		await expect(
			requireTool(allowed, "workflow_transition").execute("duplicate", {
				stageId: "done",
				basis: "Ready",
			}),
		).rejects.toThrow("already runs in the chain");
		expect(allowed.appended).toEqual(entries);
		expect(captureMessageMetadata(allowed)).toEqual(messages);
		expect(allowed.modelSetCalls).toEqual(calls);
	});
}

test("bound creation validates catalog bindings before any side effect", async () => {
	await createBoundSuite();
	const fake = await createFakePi();
	await runLifecycle(fake, "session_start");
	const create = requireTool(fake, "workflow_create");
	for (const workflow of ["absent", "delivery"]) {
		const args = createArguments();
		args["transitions"] = (
			args["transitions"] as Record<string, unknown>[]
		).map((edge) => ({ ...edge, workflow }));
		const before = {
			entries: [...fake.appended],
			messages: captureMessageMetadata(fake),
			calls: [...fake.modelSetCalls],
			thinking: fake.thinkingLevel,
		};
		await expect(create.execute("invalid", args)).rejects.toThrow(
			workflow === "absent"
				? "does not exist in the catalog"
				: "must have nested: true",
		);
		expect(fake.appended).toEqual(before.entries);
		expect(captureMessageMetadata(fake)).toEqual(before.messages);
		expect(fake.modelSetCalls).toEqual(before.calls);
		expect(fake.thinkingLevel).toBe(before.thinking);
	}
});

test("bound start and permission persistence failures roll models back and apply only the resolved target", async () => {
	const { suite } = await createBoundSuite();
	await writeFile(
		join(suite, "workflow/workflows/delivery.yaml"),
		groundedYaml()
			.replace(
				"version: 2",
				"version: 3\nmodel:\n  id: openai/current-model\n  thinking: medium",
			)
			.replace("    type: advance", "    type: advance\n    workflow: check"),
	);
	await writeFile(
		join(suite, "workflow/workflows/check.yaml"),
		groundedYaml().replace(
			"version: 2",
			"version: 3\nnested: true\nmodel:\n  id: openai/workflow-model\n  thinking: low",
		),
	);
	const fake = await createFakePi();
	await runLifecycle(fake, "session_start");
	await requireTool(fake, "workflow_activate").execute("parent", {
		workflowId: "delivery",
	});
	const move = requireTool(fake, "workflow_transition");
	const exit = requireTool(fake, "workflow_exit");
	const request = { stageId: "done", ground: "ready", basis: "Ready" };
	const parent = replayWorkflowChain(savedBranch(fake)).chain;
	if (fake.api === undefined) {
		throw new Error("missing API fixture");
	}
	const setModel = fake.api.setModel;
	fake.api.setModel = async () => false;
	await expect(move.execute("failed-model", request)).rejects.toThrow();
	expect(replayWorkflowChain(savedBranch(fake)).chain).toEqual(parent);
	expect(fake.model?.id).toBe("current-model");
	expect(fake.thinkingLevel).toBe("medium");
	fake.api.setModel = setModel;
	fake.appendError = new Error("write failed");
	await expect(move.execute("failed-start", request)).rejects.toThrow(
		"write failed",
	);
	expect(fake.model?.id).toBe("current-model");
	expect(fake.thinkingLevel).toBe("medium");
	expect(replayWorkflowChain(savedBranch(fake)).chain).toEqual(parent);
	fake.appendError = undefined;
	await move.execute("start", request);
	const pending = replayWorkflowChain(savedBranch(fake)).chain;
	const messages = captureMessageMetadata(fake);
	const findModel = fake.modelRegistry.find;
	fake.modelRegistry.find = () => undefined;
	await expect(
		exit.execute("unknown-target-model", { basis: "Ready", allow: true }),
	).rejects.toThrow("was not found");
	expect(replayWorkflowChain(savedBranch(fake)).chain).toEqual(pending);
	expect(captureMessageMetadata(fake)).toEqual(messages);
	expect(fake.model?.id).toBe("workflow-model");
	expect(fake.thinkingLevel).toBe("low");
	fake.modelRegistry.find = findModel;
	fake.appendError = new Error("write failed");
	await expect(
		exit.execute("failed-exit", { basis: "Ready", allow: true }),
	).rejects.toThrow("write failed");
	expect(fake.model?.id).toBe("workflow-model");
	expect(fake.thinkingLevel).toBe("low");
	expect(replayWorkflowChain(savedBranch(fake)).chain).toEqual(pending);
	expect(captureMessageMetadata(fake)).toEqual(messages);
	fake.appendError = undefined;
	const calls = fake.modelSetCalls.length;
	await exit.execute("permit", { basis: "Ready", allow: true });
	expect(fake.modelSetCalls.slice(calls).map(({ id }) => id)).toEqual([]);
	expect(fake.thinkingLevel).toBe("high");
	expect(replayWorkflowChain(savedBranch(fake)).chain[0]?.route).toEqual([
		"start",
		"done",
	]);
});

test("saved bound requests report missing catalog checks without changing state", async () => {
	const { suite } = await createBoundSuite();
	const fake = await createFakePi();
	await runLifecycle(fake, "session_start");
	await requireTool(fake, "workflow_activate").execute("parent", {
		workflowId: "delivery",
	});
	const branch = savedBranch(fake);
	await rm(join(suite, "workflow/workflows/check.yaml"));
	const restored = await createFakePi();
	await runLifecycle(restored, "session_start", branch);
	const before = {
		entries: [...restored.appended],
		messages: captureMessageMetadata(restored),
		calls: [...restored.modelSetCalls],
		thinking: restored.thinkingLevel,
	};
	await expect(
		requireTool(restored, "workflow_transition").execute("missing", {
			stageId: "done",
			basis: "Ready",
		}),
	).rejects.toThrow("does not exist in the catalog");
	expect(restored.appended).toEqual(before.entries);
	expect(captureMessageMetadata(restored)).toEqual(before.messages);
	expect(restored.modelSetCalls).toEqual(before.calls);
	expect(restored.thinkingLevel).toBe(before.thinking);
});

for (const role of ["main", "child"] as const) {
	test(`pending transitions ${role} survive reload navigation and compaction with append-only metadata`, async () => {
		await createBoundSuite();
		if (role === "child") {
			process.env[CHILD_AGENT_PROCESS_ENV] = "1";
			process.env[SUBAGENT_WORKFLOW_IDS_ENV] = '["delivery","check"]';
		}
		const fake = await createFakePi();
		if (role === "main") {
			setMainWorkflowPolicy(fake, ["delivery", "check"]);
		}
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("parent", {
			workflowId: "delivery",
		});
		const parentBranch = savedBranch(fake);
		await requireTool(fake, "workflow_transition").execute("request", {
			stageId: "done",
			basis: "Ready",
		});
		const pendingBranch = savedBranch(fake);
		const pending = replayWorkflowChain(pendingBranch).chain;
		const restored = await createFakePi();
		await runLifecycle(restored, "session_start", pendingBranch);
		const records = structuredClone(captureMessageMetadata(restored));
		await runLifecycle(restored, "session_tree", parentBranch);
		await runLifecycle(restored, "session_tree", pendingBranch);
		await runSessionCompact(restored);
		expect(captureMessageMetadata(restored).slice(0, records.length)).toEqual(
			records,
		);
		expect(
			(restored.messages.at(-1)?.details as Record<string, unknown>)[
				"pendingTransitions"
			],
		).toEqual([
			{ workflowId: "check", parentWorkflowId: "delivery", stageId: "done" },
		]);
		await requireTool(restored, "workflow_exit").execute("allow", {
			basis: "Ready",
			allow: true,
		});
		expect(
			replayWorkflowChain([...pendingBranch, ...savedBranch(restored)]).chain[0]
				?.route,
		).toEqual(["start", "done"]);
		expect(pending[0]?.route).toEqual(["start"]);
	});
}

/** Builds one format-3 catalog graph with optional stage workflows and transition bindings. */
function stageWorkflowYaml(options: {
	readonly nested?: boolean;
	readonly initialWorkflow?: string;
	readonly finalWorkflow?: string;
	readonly finalBinding?: string;
}): string {
	return stringify({
		version: 3,
		...(options.nested === true ? { nested: true } : {}),
		description: "Fixture",
		stages: [
			{
				id: "start",
				description: "Start",
				goal: "Ready",
				prompt: "Work",
				initial: true,
				...(options.initialWorkflow === undefined
					? {}
					: { workflow: options.initialWorkflow }),
			},
			{
				id: "middle",
				description: "Middle",
				goal: "Planned",
				prompt: "Plan",
			},
			{
				id: "done",
				description: "Done",
				goal: "Delivered",
				prompt: "Report",
				final: true,
				...(options.finalWorkflow === undefined
					? {}
					: { workflow: options.finalWorkflow }),
			},
		],
		transitions: [
			{ from: "start", to: "middle", type: "advance" },
			{
				from: "middle",
				to: "done",
				type: "advance",
				...(options.finalBinding === undefined
					? {}
					: { workflow: options.finalBinding }),
			},
			{
				from: "middle",
				to: "start",
				type: "rework",
				grounds: [{ id: "retry", when: "Revision" }],
			},
			{
				from: "done",
				to: "middle",
				type: "rework",
				grounds: [{ id: "replan", when: "Replanning" }],
			},
		],
	});
}

/** Lists each running workflow with its active stage from the saved branch. */
function savedChainView(fake: FakePi): string[] {
	return replayWorkflowChain(savedBranch(fake)).chain.map(
		({ workflow, route }) => `${workflow.id}@${route.at(-1)}`,
	);
}

/** Lists the kind, workflow, and stage of each workflow record after an index. */
function recordViews(fake: FakePi, from: number): string[] {
	return fake.messages.slice(from).flatMap(({ details }) => {
		const record = details as Record<string, unknown>;
		return record["kind"] === "activation" ||
			record["kind"] === "stage_activation"
			? [
					`${record["kind"]}:${record["workflowId"]}@${record["currentStageId"]}`,
				]
			: [];
	});
}

describe("stage workflows", () => {
	test("each entry into a stage starts its workflow after the stage record, outside agent policy, and a return starts none", async () => {
		const suite = await createSuite();
		const files = {
			delivery: stageWorkflowYaml({
				initialWorkflow: "research",
				finalWorkflow: "research",
				finalBinding: "check",
			}),
			check: stageWorkflowYaml({ nested: true, initialWorkflow: "research" }),
			research: stageWorkflowYaml({ nested: true }),
		};
		for (const [id, yaml] of Object.entries(files)) {
			await writeFile(join(suite, `workflow/workflows/${id}.yaml`), yaml);
		}
		const fake = await createFakePi();
		setMainWorkflowPolicy(fake, ["delivery"]);
		await runLifecycle(fake, "session_start");
		const move = requireTool(fake, "workflow_transition");
		const exit = requireTool(fake, "workflow_exit");

		let index = fake.messages.length;
		await requireTool(fake, "workflow_activate").execute("start", {
			workflowId: "delivery",
		});
		expect(savedChainView(fake)).toEqual(["delivery@start", "research@start"]);
		expect(recordViews(fake, index)).toEqual([
			"activation:delivery@start",
			"activation:research@start",
		]);

		index = fake.messages.length;
		await exit.execute("return", { basis: "Researched" });
		expect(savedChainView(fake)).toEqual(["delivery@start"]);
		expect(recordViews(fake, index)).toEqual([
			"stage_activation:delivery@start",
		]);

		await move.execute("plan", { stageId: "middle", basis: "Ready" });
		expect(savedChainView(fake)).toEqual(["delivery@middle"]);

		index = fake.messages.length;
		await move.execute("rework", {
			stageId: "start",
			ground: "retry",
			basis: "Revision",
		});
		expect(savedChainView(fake)).toEqual(["delivery@start", "research@start"]);
		expect(recordViews(fake, index)).toEqual([
			"stage_activation:delivery@start",
			"activation:research@start",
		]);
		await exit.execute("return-again", { basis: "Researched" });
		await move.execute("plan-again", { stageId: "middle", basis: "Ready" });

		await move.execute("bound", { stageId: "done", basis: "Planned" });
		expect(savedChainView(fake)).toEqual([
			"delivery@middle",
			"check@start",
			"research@start",
		]);
		await exit.execute("check-research", { basis: "Researched" });
		expect(savedChainView(fake)).toEqual(["delivery@middle", "check@start"]);

		index = fake.messages.length;
		await exit.execute("permit", { basis: "Checked", allow: true });
		expect(savedChainView(fake)).toEqual(["delivery@done", "research@start"]);
		expect(recordViews(fake, index)).toEqual([
			"stage_activation:delivery@done",
			"activation:research@start",
		]);
	});

	test("an entry whose stage workflow already runs is rejected without side effects", async () => {
		const suite = await createSuite();
		const files = {
			check: stageWorkflowYaml({ nested: true, initialWorkflow: "research" }),
			delivery: stageWorkflowYaml({ nested: true, finalWorkflow: "research" }),
			bound: stageWorkflowYaml({ nested: true, finalBinding: "check" }),
			research: stageWorkflowYaml({ nested: true }),
		};
		for (const [id, yaml] of Object.entries(files)) {
			await writeFile(join(suite, `workflow/workflows/${id}.yaml`), yaml);
		}
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");
		await activate.execute("research", { workflowId: "research" });
		await activate.execute("delivery", { workflowId: "delivery" });
		await requireTool(fake, "workflow_transition").execute("plan", {
			stageId: "middle",
			basis: "Ready",
		});
		const before = {
			entries: [...fake.appended],
			messages: captureMessageMetadata(fake),
			calls: [...fake.modelSetCalls],
			thinking: fake.thinkingLevel,
		};
		await expect(
			activate.execute("check", { workflowId: "check" }),
		).rejects.toThrow("already runs in the chain");
		await expect(
			requireTool(fake, "workflow_transition").execute("done", {
				stageId: "done",
				basis: "Planned",
			}),
		).rejects.toThrow("already runs in the chain");
		expect(fake.appended).toEqual(before.entries);
		expect(captureMessageMetadata(fake)).toEqual(before.messages);
		expect(fake.modelSetCalls).toEqual(before.calls);
		expect(fake.thinkingLevel).toBe(before.thinking);
		await activate.execute("bound", { workflowId: "bound" });
		await requireTool(fake, "workflow_transition").execute("bound-plan", {
			stageId: "middle",
			basis: "Ready",
		});
		const entries = [...fake.appended];
		const messages = captureMessageMetadata(fake);
		await expect(
			requireTool(fake, "workflow_transition").execute("bound-done", {
				stageId: "done",
				basis: "Planned",
			}),
		).rejects.toThrow("already runs in the chain");
		expect(fake.appended).toEqual(entries);
		expect(captureMessageMetadata(fake)).toEqual(messages);
	});

	test("a permitted exit into a stage whose workflow left the catalog is rejected without side effects", async () => {
		const suite = await createSuite();
		const files = {
			delivery: stageWorkflowYaml({
				finalWorkflow: "research",
				finalBinding: "check",
			}),
			check: stageWorkflowYaml({ nested: true }),
			research: stageWorkflowYaml({ nested: true }),
		};
		for (const [id, yaml] of Object.entries(files)) {
			await writeFile(join(suite, `workflow/workflows/${id}.yaml`), yaml);
		}
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		await requireTool(fake, "workflow_activate").execute("start", {
			workflowId: "delivery",
		});
		const move = requireTool(fake, "workflow_transition");
		await move.execute("plan", { stageId: "middle", basis: "Ready" });
		await move.execute("bound", { stageId: "done", basis: "Planned" });
		const branch = savedBranch(fake);
		await rm(join(suite, "workflow/workflows/research.yaml"));
		const restored = await createFakePi();
		await runLifecycle(restored, "session_start", branch);
		const before = {
			entries: [...restored.appended],
			messages: captureMessageMetadata(restored),
			calls: [...restored.modelSetCalls],
			thinking: restored.thinkingLevel,
		};
		await expect(
			requireTool(restored, "workflow_exit").execute("permit", {
				basis: "Checked",
				allow: true,
			}),
		).rejects.toThrow("does not exist in the catalog");
		expect(restored.appended).toEqual(before.entries);
		expect(captureMessageMetadata(restored)).toEqual(before.messages);
		expect(restored.modelSetCalls).toEqual(before.calls);
		expect(restored.thinkingLevel).toBe(before.thinking);
	});
});
