import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
	AgentToolResult,
	ExtensionAPI,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	createEventBus,
	initTheme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	KeybindingsManager,
	setKeybindings,
	type TUI,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { parse } from "yaml";
import { createToolRenderContext } from "../../../test/support/tool-render-context.ts";
import { CHILD_AGENT_PROCESS_ENV } from "../../shared/child-agent-environment.ts";
import { SUBAGENT_WORKFLOW_IDS_ENV } from "../../shared/subagent-environment.ts";
import { createToolPresentationRegistry } from "../run-subagent/tool-rendering.ts";
import workflowExtension from "./index.ts";

const PLAIN_THEME = {
	bold: (value: string) => value,
	fg: (_color: string, value: string) => value,
} as Theme;
const MARKED_THEME = {
	bold: (value: string) => `<bold>${value}</bold>`,
	fg: (color: string, value: string) => `<${color}>${value}</${color}>`,
} as Theme;
/** Matches Pi's standard summary for wrapped lines hidden in collapsed mode. */
const HIDDEN_LINE_HINT =
	/^\.\.\. \(\d+ more lines?, \d+ total, .* to expand\)$/;

interface WorkflowRenderingFixture {
	readonly api: ExtensionAPI;
	readonly handlers: ReadonlyMap<
		string,
		readonly ((event: unknown, context: unknown) => unknown)[]
	>;
	readonly tools: readonly ToolDefinition[];
}

interface ExecutedTool {
	readonly args: Record<string, unknown>;
	readonly definition: ToolDefinition;
	readonly result: AgentToolResult<unknown>;
	readonly isError: boolean;
}

const temporaryDirectories: string[] = [];
const originalSuiteDirectory = process.env["PI_AGENT_SUITE_DIR"];
const originalChildMarker = process.env[CHILD_AGENT_PROCESS_ENV];
const originalChildWorkflowIds = process.env[SUBAGENT_WORKFLOW_IDS_ENV];

/** Creates one workflow catalog whose descriptions are the user-visible names. */
async function createWorkflowSuite(
	workflowDescription = "Delivery process",
	implementationDescription = "Implementation stage",
	reviewDescription = "Review stage",
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-workflow-rendering-"));
	temporaryDirectories.push(root);
	const workflowDirectory = join(root, "workflow", "workflows");
	await mkdir(workflowDirectory, { recursive: true });
	await writeFile(
		join(workflowDirectory, "delivery.yaml"),
		`description: ${JSON.stringify(workflowDescription)}\nstages:\n  - id: implementation\n    description: ${JSON.stringify(implementationDescription)}\n    prompt: Implement the change\n    initial: true\n  - id: review\n    description: ${JSON.stringify(reviewDescription)}\n    prompt: Review the change\n    final: true\ntransitions:\n  - from: implementation\n    to: review\n    type: advance\n`,
	);
	process.env["PI_AGENT_SUITE_DIR"] = root;
}

/** Creates the smallest Pi runtime that preserves lifecycle and presentation events. */
async function createFixture(): Promise<WorkflowRenderingFixture> {
	const handlers = new Map<
		string,
		Array<(event: unknown, context: unknown) => unknown>
	>();
	const tools: ToolDefinition[] = [];
	const activeTools: string[] = [];
	const events = createEventBus();
	const api = {
		events,
		on(
			eventName: string,
			handler: (event: unknown, context: unknown) => unknown,
		) {
			const registered = handlers.get(eventName) ?? [];
			registered.push(handler);
			handlers.set(eventName, registered);
		},
		registerTool(definition: ToolDefinition) {
			tools.push(definition);
			activeTools.push(definition.name);
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names: string[]) {
			activeTools.splice(0, activeTools.length, ...names);
		},
		appendEntry(): void {},
	} as unknown as ExtensionAPI;
	await workflowExtension(api);
	return { api, handlers, tools };
}

/** Runs extension handlers in registration order and merges tool-result overrides. */
async function applyToolResultHandlers(
	fixture: WorkflowRenderingFixture,
	event: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
	let current = { ...event };
	for (const handler of fixture.handlers.get("tool_result") ?? []) {
		const override = await handler(current, {});
		if (typeof override === "object" && override !== null) {
			current = { ...current, ...override };
		}
	}
	return {
		content: current["content"] as AgentToolResult<unknown>["content"],
		details: current["details"],
	};
}

/** Executes one workflow tool through the same start/result event boundaries as Pi. */
async function executeTool(
	fixture: WorkflowRenderingFixture,
	name: "workflow_activate" | "workflow_transition" | "workflow_create",
	args: Record<string, unknown>,
): Promise<ExecutedTool> {
	const definition = fixture.tools.find((candidate) => candidate.name === name);
	if (definition === undefined) {
		throw new Error(`missing ${name} definition`);
	}
	const toolCallId = `${name}-call`;
	for (const handler of fixture.handlers.get("tool_execution_start") ?? []) {
		await handler(
			{ type: "tool_execution_start", toolCallId, toolName: name, args },
			{},
		);
	}
	let baseResult: AgentToolResult<unknown>;
	let isError = false;
	try {
		baseResult = await definition.execute(
			toolCallId,
			args,
			undefined,
			undefined,
			{} as never,
		);
	} catch (error) {
		isError = true;
		baseResult = {
			content: [
				{
					type: "text",
					text: error instanceof Error ? error.message : String(error),
				},
			],
			details: {},
		};
	}
	const result = await applyToolResultHandlers(fixture, {
		type: "tool_result",
		toolCallId,
		toolName: name,
		input: args,
		content: baseResult.content,
		details: baseResult.details,
		isError,
	});
	return { args, definition, result, isError };
}

/** Resolves the renderer used by the subagent session screen. */
function resolveSessionDefinition(
	fixture: WorkflowRenderingFixture,
	name: "workflow_activate" | "workflow_transition" | "workflow_create",
): ToolDefinition {
	const resolution = createToolPresentationRegistry(
		"/tmp",
		fixture.api.events,
	).resolve(name);
	if (
		resolution.category !== "package" ||
		resolution.definition === undefined
	) {
		throw new Error(`${name} did not resolve as package presentation`);
	}
	return resolution.definition;
}

/** Renders a completed tool row in the selected mode after restoring persisted evidence. */
function renderCompletedTool(
	definition: ToolDefinition,
	execution: ExecutedTool,
	theme: Theme = PLAIN_THEME,
	width = 100,
	expanded = false,
): { readonly call: readonly string[]; readonly result: readonly string[] } {
	if (
		definition.renderCall === undefined ||
		definition.renderResult === undefined
	) {
		throw new Error(`${definition.name} semantic renderers are missing`);
	}
	const context = createToolRenderContext({
		args: execution.args,
		expanded,
		isError: execution.isError,
	});
	const result = definition.renderResult(
		execution.result,
		{ expanded, isPartial: false },
		theme,
		context,
	);
	return {
		call: definition
			.renderCall(execution.args, theme, context)
			.render(width)
			.map((line) => line.trimEnd()),
		result: result.render(width).map((line) => line.trimEnd()),
	};
}

/** Builds one complete dynamic definition whose identity is visible before execution. */
function createArguments(
	id: string,
	description: string,
): Record<string, unknown> {
	return {
		id,
		description,
		prompt: "Follow delivery rules",
		stages: [
			{
				id: "implementation",
				description: "Implementation stage",
				prompt: "Implement the change",
				initial: true,
			},
			{
				id: "review",
				description: "Review stage",
				prompt: "Review the change",
				final: true,
			},
		],
		transitions: [{ from: "implementation", to: "review", type: "advance" }],
	};
}

/** Initializes theme and isolates main-agent fixtures from ambient child policy. */
beforeEach(() => {
	delete process.env[CHILD_AGENT_PROCESS_ENV];
	delete process.env[SUBAGENT_WORKFLOW_IDS_ENV];
	initTheme(undefined, false);
});

afterEach(async () => {
	// Restore Pi's global keybinding registry after renderer-specific bindings.
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
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

describe("workflow semantic tool rendering", () => {
	/** Proves activation is semantic and its internal success payload stays hidden. */
	test("renders activation identically in the active and subagent session screens", async () => {
		await createWorkflowSuite();
		const fixture = await createFixture();
		const execution = await executeTool(fixture, "workflow_activate", {
			workflowId: "delivery",
		});
		const active = renderCompletedTool(execution.definition, execution);
		const session = renderCompletedTool(
			resolveSessionDefinition(fixture, "workflow_activate"),
			execution,
		);

		expect(active).toEqual({
			call: ["workflow_activate", "Workflow: delivery · Delivery process"],
			result: [],
		});
		expect(session).toEqual(active);
		expect(execution.result.content).toEqual([
			{ type: "text", text: '{"success":true}' },
		]);
	});

	/**
	 * Proves streaming arguments cannot freeze an empty workflow reference in renderer state.
	 * Input and expected output: an incomplete empty ID followed by complete Coding renders Workflow: Coding.
	 * Edge case: both render calls reuse the same tool-row state, matching Pi streaming behavior.
	 * Dependencies: Pi ToolRenderContext.argsComplete and the workflow activation renderer.
	 */
	test("waits for complete activation arguments before caching identity", async () => {
		await createWorkflowSuite();
		const fixture = await createFixture();
		const definition = fixture.tools.find(
			({ name }) => name === "workflow_activate",
		);
		if (definition?.renderCall === undefined) {
			throw new Error("workflow_activate renderer missing");
		}
		const context = createToolRenderContext({
			args: { workflowId: "" },
			expanded: false,
			isError: false,
		});
		context.argsComplete = false;
		const partial = definition
			.renderCall({ workflowId: "" }, PLAIN_THEME, context)
			.render(80);
		expect(partial).toEqual(["workflow_activate"]);

		context.argsComplete = true;
		const completed = definition
			.renderCall({ workflowId: "Coding" }, PLAIN_THEME, context)
			.render(80)
			.map((line) => line.trimEnd());
		expect(completed).toEqual(["workflow_activate", "Workflow: Coding"]);
	});

	/**
	 * Proves creation shows complete semantic content in active and reconstructed session rendering.
	 * Input and expected output: collapsed calls show references and the configured expansion binding; expanded calls show catalog-shaped YAML.
	 * Edge case: an exact catalog collision retains the submitted identity and configurable hint.
	 * Dependencies: presentation events, package registry reconstruction, Pi keybindings, and create tool execution.
	 */
	test("renders workflow creation before and after execution", async () => {
		setKeybindings(
			new KeybindingsManager({
				...TUI_KEYBINDINGS,
				"app.tools.expand": {
					defaultKeys: "ctrl+e",
					description: "Expand collapsed tool output",
				},
			}),
		);
		await createWorkflowSuite();
		const fixture = await createFixture();
		const created = await executeTool(
			fixture,
			"workflow_create",
			createArguments("dynamic-delivery", "Dynamic delivery process"),
		);
		const activeCreated = renderCompletedTool(created.definition, created);
		const sessionCreated = renderCompletedTool(
			resolveSessionDefinition(fixture, "workflow_create"),
			created,
		);
		expect(activeCreated).toEqual({
			call: [
				"workflow_create",
				"Workflow: dynamic-delivery · Dynamic delivery process",
				"Stage: implementation · Implementation stage",
				"Content: ctrl+e to show",
			],
			result: [],
		});
		expect(sessionCreated).toEqual(activeCreated);

		const activeExpanded = renderCompletedTool(
			created.definition,
			created,
			PLAIN_THEME,
			100,
			true,
		);
		const sessionExpanded = renderCompletedTool(
			resolveSessionDefinition(fixture, "workflow_create"),
			created,
			PLAIN_THEME,
			100,
			true,
		);
		expect(activeExpanded.result).toEqual([]);
		expect(activeExpanded.call.slice(0, 6)).toEqual([
			"workflow_create",
			"--- Workflow ---",
			"dynamic-delivery · Dynamic delivery process",
			"--- Stage ---",
			"implementation · Implementation stage",
			"--- Content ---",
		]);
		expect(activeExpanded.call.join("\n")).toContain(
			"description: Dynamic delivery process\nprompt: Follow delivery rules\nstages:\n  - id: implementation",
		);
		expect(activeExpanded.call.join("\n")).toContain(
			"transitions:\n  - from: implementation\n    to: review\n    type: advance",
		);
		expect(activeExpanded.call.join("\n")).not.toContain(
			"id: dynamic-delivery",
		);
		expect(sessionExpanded).toEqual(activeExpanded);

		const rejected = await executeTool(
			fixture,
			"workflow_create",
			createArguments("delivery", "Conflicting delivery process"),
		);
		expect(rejected.isError).toBe(true);
		const activeRejected = renderCompletedTool(rejected.definition, rejected);
		const sessionRejected = renderCompletedTool(
			resolveSessionDefinition(fixture, "workflow_create"),
			rejected,
		);
		expect(activeRejected.call).toEqual([
			"workflow_create",
			"Workflow: delivery · Conflicting delivery process",
			"Stage: implementation · Implementation stage",
			"Content: ctrl+e to show",
		]);
		expect(activeRejected.result.join("\n")).toContain("Error:");
		expect(sessionRejected).toEqual(activeRejected);
	});

	/** Proves the transition snapshot keeps the source stage after state mutation. */
	test("renders transition source and target identically after success", async () => {
		await createWorkflowSuite();
		const fixture = await createFixture();
		await executeTool(fixture, "workflow_activate", { workflowId: "delivery" });
		const execution = await executeTool(fixture, "workflow_transition", {
			stageId: "review",
		});
		const active = renderCompletedTool(execution.definition, execution);
		const session = renderCompletedTool(
			resolveSessionDefinition(fixture, "workflow_transition"),
			execution,
		);

		expect(active).toEqual({
			call: [
				"workflow_transition",
				"From: implementation · Implementation stage",
				"To: review · Review stage",
			],
			result: [],
		});
		expect(session).toEqual(active);

		// The session overlay uses Pi's public component around the package presentation.
		const component = new ToolExecutionComponent(
			"workflow_transition",
			"replayed-transition",
			execution.args,
			{},
			resolveSessionDefinition(fixture, "workflow_transition"),
			{ requestRender(): void {} } as TUI,
			"/tmp",
		);
		component.markExecutionStarted();
		component.setArgsComplete();
		component.updateResult({ ...execution.result, isError: false });
		const componentText = stripVTControlCharacters(
			component.render(100).join("\n"),
		);
		expect(componentText).toContain("workflow_transition");
		expect(componentText).toContain(
			"From: implementation · Implementation stage",
		);
		expect(componentText).toContain("To: review · Review stage");
		expect(componentText).not.toContain('{"success":true}');
	});

	/** Proves both tools normalize, wrap, and summarize long references in collapsed mode. */
	test("bounds collapsed workflow references in active and subagent screens", async () => {
		await createWorkflowSuite(
			"Delivery    process with enough detail to wrap while preserving the complete workflow reference for expansion "
				.repeat(3)
				.trim(),
			"Implementation    stage with enough detail to wrap while preserving the complete source reference for expansion "
				.repeat(3)
				.trim(),
			"Review    stage with enough detail to wrap while preserving the complete target reference for expansion "
				.repeat(3)
				.trim(),
		);
		const fixture = await createFixture();
		const activation = await executeTool(fixture, "workflow_activate", {
			workflowId: "delivery",
		});
		const transition = await executeTool(fixture, "workflow_transition", {
			stageId: "review",
		});
		const activeActivation = renderCompletedTool(
			activation.definition,
			activation,
			PLAIN_THEME,
			60,
		);
		const sessionActivation = renderCompletedTool(
			resolveSessionDefinition(fixture, "workflow_activate"),
			activation,
			PLAIN_THEME,
			60,
		);
		const activeTransition = renderCompletedTool(
			transition.definition,
			transition,
			PLAIN_THEME,
			60,
		);
		const sessionTransition = renderCompletedTool(
			resolveSessionDefinition(fixture, "workflow_transition"),
			transition,
			PLAIN_THEME,
			60,
		);

		expect(sessionActivation).toEqual(activeActivation);
		expect(sessionTransition).toEqual(activeTransition);
		expect(activeActivation.call).toHaveLength(6);
		expect(activeActivation.call[0]).toBe("workflow_activate");
		expect(activeActivation.call[1]).toStartWith(
			"Workflow: delivery · Delivery",
		);
		expect(activeActivation.call[5]).toMatch(HIDDEN_LINE_HINT);
		expect(activeTransition.call).toHaveLength(11);
		expect(activeTransition.call[0]).toBe("workflow_transition");
		expect(activeTransition.call[1]).toStartWith("From: implementation ·");
		expect(activeTransition.call[5]).toMatch(HIDDEN_LINE_HINT);
		expect(activeTransition.call[6]).toStartWith("To: review · Review stage");
		expect(activeTransition.call[10]).toMatch(HIDDEN_LINE_HINT);
		expect(activeActivation.call.join("\n")).not.toContain("    ");
		expect(activeTransition.call.join("\n")).not.toContain("    ");
	});

	/** Proves both tools expose every reference under semantic section headings when expanded. */
	test("renders complete expanded workflow references in active and subagent screens", async () => {
		await createWorkflowSuite();
		const fixture = await createFixture();
		const activation = await executeTool(fixture, "workflow_activate", {
			workflowId: "delivery",
		});
		const transition = await executeTool(fixture, "workflow_transition", {
			stageId: "review",
		});
		const activeActivation = renderCompletedTool(
			activation.definition,
			activation,
			PLAIN_THEME,
			100,
			true,
		);
		const sessionActivation = renderCompletedTool(
			resolveSessionDefinition(fixture, "workflow_activate"),
			activation,
			PLAIN_THEME,
			100,
			true,
		);
		const activeTransition = renderCompletedTool(
			transition.definition,
			transition,
			PLAIN_THEME,
			100,
			true,
		);
		const sessionTransition = renderCompletedTool(
			resolveSessionDefinition(fixture, "workflow_transition"),
			transition,
			PLAIN_THEME,
			100,
			true,
		);

		expect(activeActivation).toEqual({
			call: [
				"workflow_activate",
				"--- Workflow ---",
				"delivery · Delivery process",
			],
			result: [],
		});
		expect(sessionActivation).toEqual(activeActivation);
		expect(activeTransition).toEqual({
			call: [
				"workflow_transition",
				"--- From ---",
				"implementation · Implementation stage",
				"--- To ---",
				"review · Review stage",
			],
			result: [],
		});
		expect(sessionTransition).toEqual(activeTransition);
	});

	/** Proves failed transitions retain semantic rows and use the approved color roles. */
	test("renders transition errors with a bright label and muted evidence", async () => {
		await createWorkflowSuite();
		const fixture = await createFixture();
		await executeTool(fixture, "workflow_activate", { workflowId: "delivery" });
		const execution = await executeTool(fixture, "workflow_transition", {
			stageId: "implementation",
		});
		// Advance live state so the failed row can only retain its source through persisted details.
		await executeTool(fixture, "workflow_transition", { stageId: "review" });
		const sessionDefinition = resolveSessionDefinition(
			fixture,
			"workflow_transition",
		);
		const rendered = renderCompletedTool(
			sessionDefinition,
			execution,
			MARKED_THEME,
		);

		expect(rendered.call).toEqual([
			"<toolTitle><bold>workflow_transition</bold></toolTitle>",
			"<toolOutput>From: implementation · Implementation stage</toolOutput>",
			"<toolOutput>To: implementation · Implementation stage</toolOutput>",
		]);
		expect(rendered.result).toEqual([
			"<toolTitle><bold>Error:</bold></toolTitle><muted> transition to implementation is not allowed; available transitions: review</muted>",
		]);
	});

	/** Proves semantic references, hints, and expanded YAML honor Pi's default tool-shell child width. */
	test("keeps workflow rows inside the default shell width", async () => {
		await createWorkflowSuite();
		const fixture = await createFixture();
		await executeTool(fixture, "workflow_activate", { workflowId: "delivery" });
		const execution = await executeTool(fixture, "workflow_transition", {
			stageId: "review",
		});
		const definition = resolveSessionDefinition(fixture, "workflow_transition");
		const rendered = renderCompletedTool(
			definition,
			execution,
			PLAIN_THEME,
			22,
		);
		const creationArgs = createArguments(
			"dynamic-delivery",
			"Dynamic delivery process",
		);
		const creation = await executeTool(
			fixture,
			"workflow_create",
			creationArgs,
		);
		const creationDefinition = resolveSessionDefinition(
			fixture,
			"workflow_create",
		);
		const collapsedCreation = renderCompletedTool(
			creationDefinition,
			creation,
			PLAIN_THEME,
			22,
		);
		const expandedCreation = renderCompletedTool(
			creationDefinition,
			creation,
			PLAIN_THEME,
			20,
			true,
		);
		const contentIndex = expandedCreation.call.indexOf("--- Content ---");
		const yamlLines = expandedCreation.call.slice(contentIndex + 1);
		const { description, prompt, stages, transitions } = creationArgs;
		expect(parse(yamlLines.join("\n"))).toEqual({
			description,
			prompt,
			stages,
			transitions,
		});
		for (const line of yamlLines) {
			expect(visibleWidth(stripVTControlCharacters(line))).toBeLessThanOrEqual(
				20,
			);
		}
		const shell = new Box(1, 1);
		for (const line of [
			...rendered.call,
			...rendered.result,
			...collapsedCreation.call,
			...expandedCreation.call,
		]) {
			shell.addChild({ render: () => [line], invalidate: () => {} });
		}

		for (const line of shell.render(24)) {
			expect(visibleWidth(stripVTControlCharacters(line))).toBeLessThanOrEqual(
				24,
			);
		}
	});
});
