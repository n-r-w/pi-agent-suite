import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getAgentRuntimeComposition,
	MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT,
} from "../../shared/agent-runtime-composition";
import { CHILD_AGENT_PROCESS_ENV } from "../../shared/child-agent-environment";
import { SUBAGENT_WORKFLOW_IDS_ENV } from "../../shared/subagent-environment";
import workflowExtension from "./index";
import { activateWorkflow, validateWorkflowDefinition } from "./workflow";

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
	return "description: Delivery\nstages:\n  - id: start\n    description: Start\n    initial: true\n  - id: done\n    description: Done\n    final: true\ntransitions:\n  - from: start\n    to: done\n    type: advance\n  - from: done\n    to: start\n    type: rework\n";
}

/** Creates one validated saved state entry independent of the current catalog. */
function activatedEntry(): unknown {
	const workflow = validateWorkflowDefinition(
		"delivery",
		{
			description: "Delivery",
			stages: [
				{ id: "start", description: "Start", initial: true },
				{ id: "done", description: "Done", final: true },
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
	const fake: FakePi = {
		handlers: new Map(),
		listeners: new Map(),
		tools: [],
		appended: [],
		activeTools: ["read"],
		appendError: undefined,
		api: undefined,
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
): Promise<void> {
	const handler = fake.handlers.get(event);
	if (handler === undefined) {
		throw new Error(`missing ${event} handler`);
	}
	await handler(
		{ type: event },
		{ sessionManager: { getBranch: () => branch } },
	);
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
	test("registers the two sequential workflow tools during initialization", async () => {
		await createSuite(validYaml());
		const fake = await createFakePi();
		expect(fake.tools.map(({ name }) => name)).toEqual([
			"workflow_activate",
			"workflow_transition",
		]);
		expect(
			fake.tools.every(({ executionMode }) => executionMode === "sequential"),
		).toBe(true);
		await runLifecycle(fake, "session_start");
		await runLifecycle(fake, "session_tree");
		expect(fake.tools).toHaveLength(2);
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
		expect(await runContext(fake, [])).toBeUndefined();
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
		expect(fake.activeTools).toEqual([
			"read",
			"workflow_activate",
			"workflow_transition",
		]);
		await runLifecycle(fake, "session_tree", [activatedEntry()]);
		expect(fake.activeTools).toEqual([
			"read",
			"workflow_activate",
			"workflow_transition",
		]);
	});

	/** Proves a main-agent policy reset replaces stale suppression ownership. */
	test("reconciles inactive state after main-agent contribution changes", async () => {
		await createSuite();
		const fake = await createFakePi();
		fake.activeTools = ["read", "workflow_activate", "workflow_transition"];
		await runLifecycle(fake, "session_start");

		fake.activeTools = ["read", "workflow_activate"];
		for (const listener of fake.listeners.get(
			MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT,
		) ?? []) {
			listener();
		}
		expect(fake.activeTools).toEqual(["read"]);
		await runLifecycle(fake, "session_tree", [activatedEntry()]);
		expect(fake.activeTools).toEqual(["read", "workflow_activate"]);
	});

	/** Proves usable policy resets clear stale ownership without changing active names. */
	test("clears stale suppression after a usable main-agent policy change", async () => {
		await createSuite();
		const fake = await createFakePi();
		fake.activeTools = ["read", "workflow_activate"];
		await runLifecycle(fake, "session_start");
		await runLifecycle(fake, "session_tree", [activatedEntry()]);
		expect(fake.activeTools).toEqual(["read", "workflow_activate"]);

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
			expect(initialContent).toContain("<workflow_activation_options />");
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

		expect(initialContext).toBeUndefined();
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
