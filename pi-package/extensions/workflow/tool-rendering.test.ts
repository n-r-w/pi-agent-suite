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
import { Box, type TUI, visibleWidth } from "@earendil-works/pi-tui";
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
	let thinkingLevel = "medium";
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
		registerFlag(): void {},
		getFlag(): undefined {
			return undefined;
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names: string[]) {
			activeTools.splice(0, activeTools.length, ...names);
		},
		getThinkingLevel() {
			return thinkingLevel;
		},
		setThinkingLevel(level: string) {
			thinkingLevel = level;
		},
		appendEntry(): void {},
		sendMessage(): void {},
	} as unknown as ExtensionAPI;
	const renderingModel = {
		provider: "test",
		id: "current",
		api: "test-api",
		baseUrl: "https://example.test",
		reasoning: true,
		name: "test/current",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_192,
	};
	await workflowExtension(api);
	for (const sessionStart of handlers.get("session_start") ?? []) {
		await sessionStart({ type: "session_start" }, {
			mode: "rpc",
			hasUI: true,
			model: renderingModel,
			modelRegistry: {
				find(provider: string, id: string) {
					return provider === "test" && id === "current"
						? renderingModel
						: undefined;
				},
			},
			sessionManager: { getBranch: () => [] },
			shutdown: () => {},
		} as never);
	}
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
	name:
		| "workflow_activate"
		| "workflow_get_stage"
		| "workflow_edit_stage"
		| "workflow_transition"
		| "workflow_create",
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
	name:
		| "workflow_activate"
		| "workflow_get_stage"
		| "workflow_edit_stage"
		| "workflow_transition"
		| "workflow_create",
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
				model: { thinking: "medium" },
				initial: true,
			},
			{
				id: "review",
				description: "Review stage",
				prompt: "Review the change",
				model: { thinking: "medium" },
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
	 * Proves partial workflow fields render as they arrive without persisting incomplete identity.
	 * Input and expected output: successive incomplete arguments add YAML and the initial stage.
	 * Edge case: YAML with at most three visual lines has no hidden-content hint.
	 * Dependencies: current render arguments, shared renderer state, and session reconstruction.
	 */
	test("streams bounded workflow creation YAML in active and subagent screens", async () => {
		await createWorkflowSuite();
		const fixture = await createFixture();
		const activeDefinition = fixture.tools.find(
			({ name }) => name === "workflow_create",
		);
		const sessionDefinition = resolveSessionDefinition(
			fixture,
			"workflow_create",
		);
		if (
			activeDefinition?.renderCall === undefined ||
			sessionDefinition.renderCall === undefined
		) {
			throw new Error("workflow_create renderer missing");
		}
		const activeRenderCall = activeDefinition.renderCall;
		const sessionRenderCall = sessionDefinition.renderCall;
		const activeContext = createToolRenderContext({
			args: {},
			expanded: false,
			isError: false,
		});
		const sessionContext = createToolRenderContext({
			args: {},
			expanded: false,
			isError: false,
		});
		activeContext.argsComplete = false;
		sessionContext.argsComplete = false;
		const renderBoth = (args: Record<string, unknown>) => {
			const active = activeRenderCall(args, PLAIN_THEME, activeContext)
				.render(80)
				.map((line) => line.trimEnd());
			const session = sessionRenderCall(args, PLAIN_THEME, sessionContext)
				.render(80)
				.map((line) => line.trimEnd());
			expect(session).toEqual(active);
			return active;
		};

		expect(renderBoth({})).toEqual(["workflow_create"]);
		expect(
			renderBoth({
				id: "streaming-delivery",
				description: "Streaming delivery process",
			}),
		).toEqual([
			"workflow_create",
			"Workflow: streaming-delivery · Streaming delivery process",
			"Content:",
			"description: Streaming delivery process",
		]);

		const partialArgs = createArguments(
			"streaming-delivery",
			"Streaming delivery process",
		);
		const collapsed = renderBoth(partialArgs);
		expect(collapsed.slice(0, 4)).toEqual([
			"workflow_create",
			"Workflow: streaming-delivery · Streaming delivery process",
			"Stage: implementation · Implementation stage",
			"Content:",
		]);
		expect(collapsed.slice(4, -1)).toHaveLength(3);
		expect(collapsed.at(-1)).toMatch(HIDDEN_LINE_HINT);

		activeContext.expanded = true;
		sessionContext.expanded = true;
		const expanded = renderBoth(partialArgs);
		const contentIndex = expanded.indexOf("--- Content ---");
		const content = parse(expanded.slice(contentIndex + 1).join("\n"));
		expect(content["description"]).toBe(partialArgs["description"]);
		expect(typeof content["prompt"]).toBe("string");
		expect(Array.isArray(content["stages"])).toBe(true);
		expect(Array.isArray(content["transitions"])).toBe(true);
		expect(content).not.toHaveProperty("id");
	});

	/**
	 * Proves creation shows complete semantic content in active and reconstructed session rendering.
	 * Input and expected output: collapsed calls show bounded YAML; expanded calls show catalog-shaped YAML.
	 * Edge case: an exact catalog collision retains the submitted identity and YAML preview.
	 * Dependencies: presentation events, package registry reconstruction, Pi keybindings, and create tool execution.
	 */
	test("renders workflow creation before and after execution", async () => {
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
		expect(activeCreated.call.slice(0, 4)).toEqual([
			"workflow_create",
			"Workflow: dynamic-delivery · Dynamic delivery process",
			"Stage: implementation · Implementation stage",
			"Content:",
		]);
		expect(activeCreated.call.slice(4, -1)).toHaveLength(3);
		expect(activeCreated.call.at(-1)).toMatch(HIDDEN_LINE_HINT);
		expect(activeCreated.result).toEqual([]);
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
		const expandedContent = parse(activeExpanded.call.slice(6).join("\n"));
		expect(expandedContent.description).toBe("Dynamic delivery process");
		expect(typeof expandedContent.prompt).toBe("string");
		expect(Array.isArray(expandedContent.stages)).toBe(true);
		expect(Array.isArray(expandedContent.transitions)).toBe(true);
		expect(expandedContent).not.toHaveProperty("id");
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
		expect(activeRejected.call.slice(0, 4)).toEqual([
			"workflow_create",
			"Workflow: delivery · Conflicting delivery process",
			"Stage: implementation · Implementation stage",
			"Content:",
		]);
		expect(activeRejected.call.slice(4, -1)).toHaveLength(3);
		expect(activeRejected.call.at(-1)).toMatch(HIDDEN_LINE_HINT);
		expect(activeRejected.result.join("\n")).toContain("Error:");
		expect(sessionRejected).toEqual(activeRejected);
	});

	/**
	 * Proves compact reference and content labels use semantic title styling.
	 * Input and expected output: creation and transition calls style labels separately from values.
	 * Edge case: YAML remains tool output below the styled Content label.
	 * Dependencies: marked theme rendering and width-aware labeled text.
	 */
	test("styles compact workflow labels separately from values", async () => {
		await createWorkflowSuite();
		const fixture = await createFixture();
		const creation = await executeTool(
			fixture,
			"workflow_create",
			createArguments("styled-delivery", "Styled delivery process"),
		);
		const transition = await executeTool(fixture, "workflow_transition", {
			stageId: "review",
		});
		const renderedCreation = renderCompletedTool(
			creation.definition,
			creation,
			MARKED_THEME,
		);
		const renderedTransition = renderCompletedTool(
			transition.definition,
			transition,
			MARKED_THEME,
		);
		const expandedCreation = renderCompletedTool(
			creation.definition,
			creation,
			MARKED_THEME,
			100,
			true,
		);

		expect(renderedCreation.call.slice(0, 5)).toEqual([
			"<toolTitle><bold>workflow_create</bold></toolTitle>",
			"<toolTitle><bold>Workflow:</bold></toolTitle><toolOutput> styled-delivery · Styled delivery process</toolOutput>",
			"<toolTitle><bold>Stage:</bold></toolTitle><toolOutput> implementation · Implementation stage</toolOutput>",
			"<toolTitle><bold>Content:</bold></toolTitle>",
			"<toolOutput>description: Styled delivery process</toolOutput>",
		]);
		expect(renderedTransition.call).toEqual([
			"<toolTitle><bold>workflow_transition</bold></toolTitle>",
			"<toolTitle><bold>From:</bold></toolTitle><toolOutput> implementation · Implementation stage</toolOutput>",
			"<toolTitle><bold>To:</bold></toolTitle><toolOutput> review · Review stage</toolOutput>",
		]);
		expect(expandedCreation.call.slice(0, 6)).toEqual([
			"<toolTitle><bold>workflow_create</bold></toolTitle>",
			"<muted>--- Workflow ---</muted>",
			"<toolOutput>styled-delivery · Styled delivery process</toolOutput>",
			"<muted>--- Stage ---</muted>",
			"<toolOutput>implementation · Implementation stage</toolOutput>",
			"<muted>--- Content ---</muted>",
		]);
	});

	/**
	 * Proves stage inspection and editing use the same semantic rows in active and reconstructed session screens.
	 * Input and expected output: get shows the saved stage; edit shows replacement fields in collapsed and expanded modes.
	 * Edge case: successful TUI result rows hide model-visible get JSON and internal edit success JSON.
	 * Dependencies: presentation events, package registry reconstruction, dynamic workflow state, and YAML rendering.
	 */
	test("renders stage get and edit identically in active and subagent screens", async () => {
		await createWorkflowSuite();
		const fixture = await createFixture();
		await executeTool(
			fixture,
			"workflow_create",
			createArguments("dynamic-delivery", "Dynamic delivery process"),
		);
		const get = await executeTool(fixture, "workflow_get_stage", {
			stageId: "implementation",
		});
		const edit = await executeTool(fixture, "workflow_edit_stage", {
			stageId: "implementation",
			description: "Revised implementation",
			prompt: "Follow the corrected implementation requirements.",
			model: { thinking: "high" },
		});

		const getCollapsed = renderCompletedTool(
			get.definition,
			get,
			PLAIN_THEME,
			500,
		);
		const getSessionCollapsed = renderCompletedTool(
			resolveSessionDefinition(fixture, "workflow_get_stage"),
			get,
			PLAIN_THEME,
			500,
		);
		expect(getSessionCollapsed).toEqual(getCollapsed);
		expect(getCollapsed.call.slice(0, -1)).toEqual([
			"workflow_get_stage: implementation",
			"Description: Implementation stage",
			"Prompt: Implement the change",
			"Thinking: medium",
			"Initial: true",
		]);
		expect(getCollapsed.call.at(-1)).toMatch(HIDDEN_LINE_HINT);
		expect(getCollapsed.result).toEqual([]);

		const getExpanded = renderCompletedTool(
			get.definition,
			get,
			PLAIN_THEME,
			100,
			true,
		);
		expect(
			renderCompletedTool(
				resolveSessionDefinition(fixture, "workflow_get_stage"),
				get,
				PLAIN_THEME,
				100,
				true,
			),
		).toEqual(getExpanded);
		expect(getExpanded).toEqual({
			call: [
				"workflow_get_stage: implementation",
				"--- Description ---",
				"Implementation stage",
				"--- Prompt ---",
				"Implement the change",
				"--- Thinking ---",
				"medium",
				"--- Initial ---",
				"true",
				"--- Final ---",
				"false",
			],
			result: [],
		});

		const editCollapsed = renderCompletedTool(
			edit.definition,
			edit,
			PLAIN_THEME,
			500,
		);
		expect(
			renderCompletedTool(
				resolveSessionDefinition(fixture, "workflow_edit_stage"),
				edit,
				PLAIN_THEME,
				500,
			),
		).toEqual(editCollapsed);
		expect(editCollapsed).toEqual({
			call: [
				"workflow_edit_stage: implementation",
				"Description: Implementation stage -> Revised implementation",
				"Prompt: Implement the change -> Follow the corrected implementation requirements.",
				"Thinking: medium -> high",
			],
			result: [],
		});
		const styledEdit = renderCompletedTool(
			edit.definition,
			edit,
			MARKED_THEME,
			500,
		);
		expect(styledEdit.call[1]).toBe(
			"<toolTitle><bold>Description:</bold></toolTitle><toolOutput> Implementation stage </toolOutput><success>-></success><toolOutput> Revised implementation</toolOutput>",
		);
		expect(styledEdit.call[2]).toContain(
			"<toolTitle><bold>Prompt:</bold></toolTitle>",
		);

		const editExpanded = renderCompletedTool(
			edit.definition,
			edit,
			PLAIN_THEME,
			100,
			true,
		);
		expect(
			renderCompletedTool(
				resolveSessionDefinition(fixture, "workflow_edit_stage"),
				edit,
				PLAIN_THEME,
				100,
				true,
			),
		).toEqual(editExpanded);
		expect(editExpanded).toEqual({
			call: [
				"workflow_edit_stage: implementation",
				"--- Description ---",
				"Implementation stage",
				"->",
				"Revised implementation",
				"--- Prompt ---",
				"Implement the change",
				"->",
				"Follow the corrected implementation requirements.",
				"--- Thinking ---",
				"medium",
				"->",
				"high",
			],
			result: [],
		});
		const styledExpandedEdit = renderCompletedTool(
			edit.definition,
			edit,
			MARKED_THEME,
			100,
			true,
		);
		expect(styledExpandedEdit.call[1]).toBe(
			"<muted>--- Description ---</muted>",
		);
		expect(styledExpandedEdit.call[3]).toBe("<success>-></success>");

		const unchanged = await executeTool(fixture, "workflow_edit_stage", {
			stageId: "implementation",
			description: "Revised implementation",
			prompt: "Follow the corrected implementation requirements.",
			model: { thinking: "high" },
		});
		expect(
			renderCompletedTool(
				unchanged.definition,
				unchanged,
				PLAIN_THEME,
				100,
				true,
			),
		).toEqual({
			call: ["workflow_edit_stage: implementation", "No changes."],
			result: [],
		});
		expect(get.result.content).toEqual([
			{
				type: "text",
				text: '{"id":"implementation","description":"Implementation stage","prompt":"Implement the change","model":{"thinking":"medium"},"initial":true,"final":false}',
			},
		]);
		expect(edit.result.content).toEqual([
			{ type: "text", text: '{"success":true}' },
		]);
	});

	/** Proves multiline stage values retain labels and unambiguous edit boundaries. */
	test("renders multiline stage values as labeled semantic blocks", async () => {
		await createWorkflowSuite();
		const fixture = await createFixture();
		const args = createArguments(
			"dynamic-delivery",
			"Dynamic delivery process",
		);
		const implementation = (args["stages"] as Record<string, unknown>[])[0];
		if (implementation === undefined) {
			throw new Error("implementation stage fixture is missing");
		}
		implementation["prompt"] = "Inspect current state.\nImplement the change.";
		await executeTool(fixture, "workflow_create", args);
		const get = await executeTool(fixture, "workflow_get_stage", {
			stageId: "implementation",
		});
		const edit = await executeTool(fixture, "workflow_edit_stage", {
			stageId: "implementation",
			description: "Implementation stage",
			prompt: "Read corrected requirements.\nImplement the corrected change.",
			model: { thinking: "medium" },
		});

		const getExpanded = renderCompletedTool(
			get.definition,
			get,
			PLAIN_THEME,
			100,
			true,
		);
		expect(getExpanded.call).toContain("--- Prompt ---");
		expect(getExpanded.call).toContain("Inspect current state.");
		expect(getExpanded.call).toContain("Implement the change.");

		const editExpanded = renderCompletedTool(
			edit.definition,
			edit,
			PLAIN_THEME,
			100,
			true,
		);
		expect(editExpanded.call).toEqual([
			"workflow_edit_stage: implementation",
			"--- Prompt ---",
			"Inspect current state.",
			"Implement the change.",
			"->",
			"Read corrected requirements.",
			"Implement the corrected change.",
		]);

		const getCollapsed = renderCompletedTool(
			get.definition,
			get,
			PLAIN_THEME,
			500,
		);
		expect(getCollapsed.call).toContain(
			"Prompt: Inspect current state. Implement the change.",
		);
		expect(getCollapsed.call).not.toContain("  Inspect current state.");
		const editCollapsed = renderCompletedTool(
			edit.definition,
			edit,
			PLAIN_THEME,
			500,
		);
		expect(editCollapsed.call).toEqual([
			"workflow_edit_stage: implementation",
			"Prompt: Inspect current state. Implement the change. -> Read corrected requirements. Implement the corrected change.",
		]);
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
			"<toolTitle><bold>From:</bold></toolTitle><toolOutput> implementation · Implementation stage</toolOutput>",
			"<toolTitle><bold>To:</bold></toolTitle><toolOutput> implementation · Implementation stage</toolOutput>",
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
		const stageGet = await executeTool(fixture, "workflow_get_stage", {
			stageId: "implementation",
		});
		const narrowStageGet = renderCompletedTool(
			resolveSessionDefinition(fixture, "workflow_get_stage"),
			stageGet,
			PLAIN_THEME,
			20,
			true,
		);
		const stageEdit = await executeTool(fixture, "workflow_edit_stage", {
			stageId: "implementation",
			description: "A revised implementation description",
			prompt: "A revised implementation prompt that wraps",
			model: { thinking: "high" },
		});
		const narrowStageEdit = renderCompletedTool(
			resolveSessionDefinition(fixture, "workflow_edit_stage"),
			stageEdit,
			PLAIN_THEME,
			20,
			true,
		);
		const contentIndex = expandedCreation.call.indexOf("--- Content ---");
		const yamlLines = expandedCreation.call.slice(contentIndex + 1);
		const { description, stages, transitions } = creationArgs;
		const parsedContent = parse(yamlLines.join("\n"));
		expect(parsedContent["description"]).toEqual(description);
		expect(typeof parsedContent["prompt"]).toBe("string");
		expect(parsedContent["stages"]).toEqual(stages);
		expect(parsedContent["transitions"]).toEqual(transitions);
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
			...narrowStageGet.call,
			...narrowStageEdit.call,
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
