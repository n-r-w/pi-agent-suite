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
import {
	getAgentRuntimeComposition,
	MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT,
} from "../../shared/agent-runtime-composition";
import { CHILD_AGENT_PROCESS_ENV } from "../../shared/child-agent-environment";
import { SUBAGENT_WORKFLOW_IDS_ENV } from "../../shared/subagent-environment";
import workflowExtension from "./index";
import { activateWorkflow, validateWorkflowDefinition } from "./workflow";

type WidgetFactory = (tui: TUI, theme: Theme) => Component;
type WidgetContent = string[] | WidgetFactory | undefined;

interface FakeTool {
	readonly name: string;
	readonly description: string;
	readonly executionMode?: string;
	readonly execute: (...args: unknown[]) => Promise<unknown>;
}

interface FakePi {
	readonly handlers: Map<string, (...args: unknown[]) => unknown>;
	readonly listeners: Map<string, Set<(...args: unknown[]) => void>>;
	readonly tools: FakeTool[];
	readonly appended: Array<{ customType: string; data: unknown }>;
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
	const ui = {
		setWidget(key: string, content: WidgetContent): void {
			widgetUpdates.push({ key, content });
		},
	} as unknown as ExtensionContext["ui"];
	const fake: FakePi = {
		handlers: new Map(),
		listeners: new Map(),
		tools: [],
		appended: [],
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
		{ mode, ui: fake.ui, sessionManager: { getBranch: () => branch } },
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
	 * Proves workflow IDs use one case-insensitive identity rule and rejected creates are atomic.
	 * Input and expected output: catalog and active-dynamic case variants reject before append; a different ID replaces state.
	 * Edge case: append failure retains the prior catalog route before a later successful replacement.
	 * Dependencies: catalog normalization, dynamic state identity, and append-before-memory ordering.
	 */
	test("rejects duplicate IDs and atomically replaces a different workflow", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const create = requireTool(fake, "workflow_create");
		const activate = requireTool(fake, "workflow_activate");
		const transition = requireTool(fake, "workflow_transition");

		await expect(
			create.execute("create", createArguments("DELIVERY")),
		).rejects.toThrow("delivery");
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
			create.execute("create", createArguments("NEW-DELIVERY")),
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
		expect(
			(entriesBeforeReactivation[1]?.data as { route: readonly string[] })
				.route,
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
		await createSuite(validYaml());
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
		fake.appendError = new Error("append failed");
		await expect(
			activate.execute("call", { workflowId: "delivery" }),
		).rejects.toThrow("append failed");
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

	/** Proves canonical agent policy filters context and protects both tools without deleting saved state. */
	test("enforces main-agent workflow policy across context and tools", async () => {
		const root = await createSuite(validYaml());
		await writeFile(
			join(root, "workflow", "workflows", "review.yaml"),
			validYaml().replace("description: Delivery", "description: Review"),
		);
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		setMainWorkflowPolicy(fake, ["delivery"]);

		const initialContext = await runContext(fake, []);
		const initialContent = String(
			(initialContext as { messages: Array<{ content: unknown }> }).messages[0]
				?.content,
		);
		expect(initialContent).toContain('id="delivery"');
		expect(initialContent).not.toContain('id="review"');

		const activate = fake.tools[0];
		const transition = fake.tools[1];
		if (activate === undefined || transition === undefined) {
			throw new Error("tools missing");
		}
		await expect(
			activate.execute("call", { workflowId: "review" }),
		).rejects.toThrow("not allowed");
		expect(fake.appended).toEqual([]);
		await activate.execute("call", { workflowId: "delivery" });
		await transition.execute("call", { stageId: "done" });
		const entriesBeforeDeny = [...fake.appended];

		setMainWorkflowPolicy(fake, []);
		const deniedContext = await runContext(fake, []);
		const deniedContent = String(
			(deniedContext as { messages: Array<{ content: unknown }> }).messages[0]
				?.content,
		);
		expect(deniedContent).toContain("<workflow_guidelines>");
		expect(deniedContent).not.toContain("<active_workflow");
		expect(deniedContent).not.toContain("<workflow_activation_options");
		await expect(
			transition.execute("call", { stageId: "start" }),
		).rejects.toThrow("not allowed");
		expect(fake.appended).toEqual(entriesBeforeDeny);

		setMainWorkflowPolicy(fake, ["delivery"]);
		const restoredContext = await runContext(fake, []);
		const restoredContent = String(
			(restoredContext as { messages: Array<{ content: unknown }> }).messages[0]
				?.content,
		);
		expect(restoredContent).toContain('active_stage_id="done"');
	});

	/** Proves child transport applies canonical explicit policy from its dedicated environment. */
	test("enforces valid child workflow policy from its dedicated environment", async () => {
		const root = await createSuite(validYaml());
		await writeFile(
			join(root, "workflow", "workflows", "review.yaml"),
			validYaml().replace("description: Delivery", "description: Review"),
		);
		process.env[CHILD_AGENT_PROCESS_ENV] = "1";
		process.env[SUBAGENT_WORKFLOW_IDS_ENV] = '["review"]';
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start");
		const result = await runContext(fake, []);
		const content = String(
			(result as { messages: Array<{ content: unknown }> }).messages[0]
				?.content,
		);
		expect(content).toContain('id="review"');
		expect(content).not.toContain('id="delivery"');
	});

	/** Proves invalid child policy disables provider behavior without deleting replayed state. */
	test.each([
		["malformed", "{", "valid JSON"],
		["unknown", '["missing"]', "missing"],
	] as const)("fails closed for %s child workflow policy", async (_case, rawPolicy, expectedIssue) => {
		// Purpose: policy rejection must remove both callable workflow names and suppress every provider-facing path.
		// Input and expected output: malformed or unknown transport throws, hides context, appends nothing, and disables both tools.
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
	});

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

	/** Proves saved-snapshot precedence across removed and invalid catalogs for every policy state. */
	test.each([
		["removed", "unrestricted", undefined, true],
		["removed", "empty", [], false],
		["removed", "matching explicit", ["delivery"], true],
		["removed", "non-matching explicit", ["review"], false],
		["invalid", "unrestricted", undefined, true],
		["invalid", "empty", [], false],
		["invalid", "matching explicit", ["delivery"], true],
		["invalid", "non-matching explicit", ["review"], false],
	] as const)("keeps a saved snapshot with %s catalog and %s policy", async (catalogKind, _policyName, policy, allowed) => {
		// Purpose: catalog failure or removal must not bypass snapshot filtering or direct transition authorization.
		// Input and expected output: each policy either exposes and advances Delivery or hides and rejects it without append.
		// Edge case: a rejected transition must retain replayed state so a later unrestricted policy sees the original start stage.
		// Dependencies: production lifecycle replay, context filtering, transition enforcement, and isolated catalog fixtures.
		await createSuite(
			catalogKind === "invalid" ? "invalid: true\n" : undefined,
		);
		const fake = await createFakePi();
		await runLifecycle(fake, "session_start", [activatedEntry()]);
		setMainWorkflowPolicy(fake, policy);
		const transition = fake.tools.find(
			({ name }) => name === "workflow_transition",
		);
		if (transition === undefined) {
			throw new Error("transition tool missing");
		}

		const initialContext = await runContext(fake, []);
		if (allowed) {
			const initialContent = String(
				(initialContext as { messages: Array<{ content: unknown }> })
					.messages[0]?.content,
			);
			expect(initialContent).not.toContain("<workflow_activation_options");
			expect(initialContent).toContain(
				'<active_workflow id="delivery" active_stage_id="start"',
			);
			await transition.execute("call", { stageId: "done" });
			expect(fake.appended).toHaveLength(1);
			const transitionedContent = String(
				(
					(await runContext(fake, [])) as {
						messages: Array<{ content: unknown }>;
					}
				).messages[0]?.content,
			);
			expect(transitionedContent).toContain('active_stage_id="done"');
			return;
		}

		if (catalogKind === "removed") {
			const deniedContent = String(
				(initialContext as { messages: Array<{ content: unknown }> })
					.messages[0]?.content,
			);
			expect(deniedContent).toContain("<workflow_guidelines>");
			expect(deniedContent).not.toContain("<active_workflow");
			expect(deniedContent).not.toContain("<workflow_activation_options");
		} else {
			expect(initialContext).toBeUndefined();
		}
		await expect(
			transition.execute("call", { stageId: "done" }),
		).rejects.toThrow("not allowed");
		expect(fake.appended).toEqual([]);
		setMainWorkflowPolicy(fake, undefined);
		const retainedContent = String(
			(
				(await runContext(fake, [])) as {
					messages: Array<{ content: unknown }>;
				}
			).messages[0]?.content,
		);
		expect(retainedContent).toContain(
			'<active_workflow id="delivery" active_stage_id="start"',
		);
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
