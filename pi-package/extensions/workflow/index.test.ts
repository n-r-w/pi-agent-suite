import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
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
import { activateWorkflow, validateWorkflowDefinition } from "./workflow";

type WidgetFactory = (tui: TUI, theme: Theme) => Component;
type WidgetContent = string[] | WidgetFactory | undefined;

interface FakeTool {
	readonly name: string;
	readonly description: string;
	readonly executionMode?: string;
	readonly parameters: unknown;
	readonly execute: (...args: unknown[]) => Promise<unknown>;
}

interface FakePi {
	readonly handlers: Map<string, (...args: unknown[]) => unknown>;
	readonly listeners: Map<string, Set<(...args: unknown[]) => void>>;
	readonly tools: FakeTool[];
	readonly appended: Array<{ customType: string; data: unknown }>;
	readonly notifications: Array<{ message: string; type: string | undefined }>;
	activeTools: string[];
	appendError: Error | undefined;
	api: ExtensionAPI | undefined;
	readonly ui: ExtensionContext["ui"];
	readonly widgetUpdates: Array<{ key: string; content: WidgetContent }>;
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
				initial: true,
			},
			{
				id: "done",
				description: "Done",
				prompt: "Finish dynamic work",
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
		data: { kind: "activated", workflow, route: state.route },
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
	const fake: FakePi = {
		handlers: new Map(),
		listeners: new Map(),
		tools: [],
		appended: [],
		notifications,
		activeTools: ["read"],
		appendError: undefined,
		api: undefined,
		ui,
		widgetUpdates,
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
		appendEntry(customType: string, data: unknown) {
			if (fake.appendError !== undefined) {
				throw fake.appendError;
			}
			fake.appended.push({ customType, data });
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
): void {
	if (fake.api === undefined) {
		throw new Error("extension API missing");
	}
	getAgentRuntimeComposition(fake.api).setMainAgentContribution({
		prompt: "main",
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
			sessionManager: { getBranch: () => branch },
		},
	);
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

/** Invokes the context handler and returns its optional replacement. */
async function runContext(
	fake: FakePi,
	messages: readonly unknown[],
): Promise<unknown> {
	const handler = fake.handlers.get("context");
	if (handler === undefined) {
		throw new Error("context handler missing");
	}
	return handler({ messages }, {});
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
	test("registers the three sequential workflow tools during initialization", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		expect(fake.tools.map(({ name }) => name)).toEqual([
			"workflow_activate",
			"workflow_transition",
			"workflow_create",
		]);
		expect(
			fake.tools.every(({ executionMode }) => executionMode === "sequential"),
		).toBe(true);
		await runLifecycle(fake, "session_start");
		await runLifecycle(fake, "session_tree");
		expect(fake.tools).toHaveLength(3);
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
	 * Proves a valid empty catalog keeps workflow_create and universal guidance without activation options.
	 * Input and expected output: no YAML and no saved state leave only workflow_create active and project guidelines only.
	 * Edge case: workflow_activate and workflow_transition are system-suppressed independently.
	 * Dependencies: lifecycle reconciliation, prompt loading, and provider-context projection.
	 */
	test("keeps creation active for an empty catalog", async () => {
		await createSuite();
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");

		expect(fake.activeTools).toEqual(["read", "workflow_create"]);
		const context = await runContext(fake, []);
		const content = String(
			(context as { messages: Array<{ content: unknown }> }).messages[0]
				?.content,
		);
		expect(content).toContain("<workflow_guidelines>");
		expect(content).not.toContain("<workflow_activation_options");
		expect(content).not.toContain("<active_workflow");
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
			"workflow_create",
			"workflow_transition",
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
		const context = await runContext(fake, []);
		const content = String(
			(context as { messages: Array<{ content: unknown }> }).messages[0]
				?.content,
		);
		expect(content).toContain(
			'<active_workflow id="dynamic-delivery" active_stage_id="done"',
		);
		expect(content).not.toContain("<workflow_activation_options");
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
	])(
		"keeps workflow success after a %s runner failure",
		async (_case, failure) => {
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
		},
	);

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
		const retained = String(
			(
				(await runContext(fake, [])) as {
					messages: Array<{ content: unknown }>;
				}
			).messages[0]?.content,
		);
		expect(retained).toContain(
			'<active_workflow id="delivery" active_stage_id="done"',
		);

		await create.execute("create", createArguments("new-delivery"));
		const entriesBeforeDuplicate = [...fake.appended];
		await expect(
			create.execute("create", createArguments("new-delivery")),
		).rejects.toThrow("already active");
		expect(fake.appended).toEqual(entriesBeforeDuplicate);
		const replaced = String(
			(
				(await runContext(fake, [])) as {
					messages: Array<{ content: unknown }>;
				}
			).messages[0]?.content,
		);
		expect(replaced).toContain(
			'<active_workflow id="new-delivery" active_stage_id="start"',
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

	/** Proves successful tools keep model content stable while persisting state. */
	test("persists activation and transition with stable success content", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const activate = fake.tools[0];
		const transition = fake.tools[1];
		if (activate === undefined || transition === undefined) {
			throw new Error("tools missing");
		}
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
		const activate = fake.tools[0];
		const transition = fake.tools[1];
		if (activate === undefined || transition === undefined) {
			throw new Error("tools missing");
		}
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
		const result = await runContext(fake, []);
		const content = String(
			(result as { messages: Array<{ content: unknown }> }).messages[0]
				?.content,
		);
		expect(content).toContain('active_stage_id="done"');
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
		fake.activeTools = ["read", "workflow_activate"];
		await runLifecycle(fake, "session_start");
		const activate = requireTool(fake, "workflow_activate");

		await activate.execute("activate", { workflowId: "delivery" });
		expect(fake.activeTools).toEqual(["read"]);
		const context = await runContext(fake, []);
		const content = String(
			(context as { messages: Array<{ content: unknown }> }).messages[0]
				?.content,
		);
		expect(content).toContain(
			'<active_workflow id="delivery" active_stage_id="start"',
		);
		expect(content).toContain("<active_stage_guidelines>\nStart work");
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
		fake.appendError = new Error("append failed");
		await expect(
			activate.execute("call", { workflowId: "delivery" }),
		).rejects.toThrow("append failed");
		expect(triggerCalls).toEqual([]);
		fake.appendError = undefined;
		const result = await runContext(fake, []);
		expect(
			String(
				(result as { messages: Array<{ content: unknown }> }).messages[0]
					?.content,
			),
		).not.toContain("<active_workflow");
	});

	/** Proves either current workflow tool independently enables complete projection. */
	test("projects while any workflow tool is active", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const incoming = [{ role: "user", content: "preserve", timestamp: 1 }];

		for (const activeTools of [
			["read", "workflow_activate"],
			["read", "workflow_transition"],
			["read", "workflow_activate", "workflow_transition"],
		]) {
			fake.activeTools = activeTools;
			const eligible = await runContext(fake, incoming);
			expect(eligible).toBeDefined();
			const messages = (eligible as { messages: unknown[] }).messages;
			expect(messages[0]).toBe(incoming[0]);
			expect(messages).toHaveLength(2);
		}

		fake.activeTools = ["read"];
		expect(await runContext(fake, incoming)).toBeUndefined();
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
		const switchedContext = await runContext(fake, []);
		const switchedContent = String(
			(switchedContext as { messages: Array<{ content: unknown }> }).messages[0]
				?.content,
		);
		expect(switchedContent).toContain(
			'<active_workflow id="delivery" active_stage_id="done"',
		);
		expect(switchedContent).toContain("<workflow_activation_options>");
		expect(switchedContent).toContain('id="review"');

		await transition.execute("reopen-delivery", { stageId: "start" });
		await activate.execute("activate-review", { workflowId: "review" });
		const replacedContext = await runContext(fake, []);
		const replacedContent = String(
			(replacedContext as { messages: Array<{ content: unknown }> }).messages[0]
				?.content,
		);
		expect(replacedContent).toContain(
			'<active_workflow id="review" active_stage_id="start"',
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

		const initialContext = await runContext(fake, []);
		const initialContent = String(
			(initialContext as { messages: Array<{ content: unknown }> }).messages[0]
				?.content,
		);
		expect(initialContent).toContain(
			'<active_workflow id="delivery" active_stage_id="start"',
		);
		expect(initialContent).toContain('id="review"');

		await transition.execute("finish-delivery", { stageId: "done" });
		await activate.execute("activate-review", { workflowId: "review" });
		const replacedContext = await runContext(fake, []);
		const replacedContent = String(
			(replacedContext as { messages: Array<{ content: unknown }> }).messages[0]
				?.content,
		);
		expect(replacedContent).toContain(
			'<active_workflow id="review" active_stage_id="start"',
		);
	});

	/** Proves invalid child policy disables provider behavior without deleting replayed state. */
	test.each([
		["malformed", "{", "valid JSON"],
		["unknown", '["missing"]', "missing"],
	] as const)(
		"fails closed for %s child workflow policy",
		async (_case, rawPolicy, expectedIssue) => {
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
			expect(await runContext(fake, [])).toBeUndefined();
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
		},
	);

	/** Proves usable lifecycle reconciliation never overrides agent policy. */
	test("leaves active names unchanged while the subsystem is usable", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		fake.activeTools = ["read"];
		await runLifecycle(fake, "session_start");
		expect(fake.activeTools).toEqual(["read"]);
	});

	/** Proves ordinary suppression is retained and restored exactly once. */
	test("restores only names suppressed by unusable lifecycle reconciliation", async () => {
		await createSuite();
		const fake = await createFakePi();
		fake.activeTools = ["read", "workflow_activate", "workflow_transition"];
		await runLifecycle(fake, "session_start");
		expect(fake.activeTools).toEqual(["read"]);

		fake.activeTools = ["read", "workflow_transition"];
		await runLifecycle(fake, "session_tree");
		expect(fake.activeTools).toEqual(["read"]);

		await runLifecycle(fake, "session_tree", [activatedEntry()]);
		expect(fake.activeTools).toEqual(["read", "workflow_transition"]);
		await runLifecycle(fake, "session_tree", [activatedEntry()]);
		expect(fake.activeTools).toEqual(["read", "workflow_transition"]);
	});

	/** Proves a main-agent policy reset replaces stale suppression ownership. */
	test("reconciles inactive state after main-agent contribution changes", async () => {
		await createSuite();
		const fake = await createFakePi();
		fake.activeTools = ["read", "workflow_activate", "workflow_transition"];
		await runLifecycle(fake, "session_start");

		fake.activeTools = ["read", "workflow_transition"];
		for (const listener of fake.listeners.get(
			MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT,
		) ?? []) {
			listener();
		}
		expect(fake.activeTools).toEqual(["read"]);
		await runLifecycle(fake, "session_tree", [activatedEntry()]);
		expect(fake.activeTools).toEqual(["read", "workflow_transition"]);
	});

	/** Proves usable policy resets clear stale ownership without changing active names. */
	test("clears stale suppression after a usable main-agent policy change", async () => {
		await createSuite();
		const fake = await createFakePi();
		fake.activeTools = ["read", "workflow_transition"];
		await runLifecycle(fake, "session_start");
		await runLifecycle(fake, "session_tree", [activatedEntry()]);
		expect(fake.activeTools).toEqual(["read", "workflow_transition"]);

		fake.activeTools = ["read"];
		for (const listener of fake.listeners.get(
			MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT,
		) ?? []) {
			listener();
		}
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
	] as const)(
		"keeps a saved snapshot with %s catalog and %s policy",
		async (catalogKind, _policyName, policy) => {
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

			const initialContext = await runContext(fake, []);
			expect(initialContext).toBeDefined();
			const initialContent = String(
				(initialContext as { messages: Array<{ content: unknown }> })
					.messages[0]?.content,
			);
			expect(initialContent).not.toContain("<workflow_activation_options");
			expect(initialContent).toContain(
				'<active_workflow id="delivery" active_stage_id="start"',
			);

			await transition.execute("finish-delivery", { stageId: "done" });
			expect(fake.appended).toHaveLength(1);
			const transitionedContext = await runContext(fake, []);
			const transitionedContent = String(
				(transitionedContext as { messages: Array<{ content: unknown }> })
					.messages[0]?.content,
			);
			expect(transitionedContent).toContain('active_stage_id="done"');
		},
	);

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
		fake.activeTools = ["read", "workflow_activate", "workflow_transition"];
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
