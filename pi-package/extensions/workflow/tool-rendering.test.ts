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
import { createToolRenderContext } from "../../../test/support/tool-render-context.ts";
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

/** Creates one workflow catalog whose descriptions are the user-visible names. */
async function createWorkflowSuite(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-workflow-rendering-"));
	temporaryDirectories.push(root);
	const workflowDirectory = join(root, "workflow", "workflows");
	await mkdir(workflowDirectory, { recursive: true });
	await writeFile(
		join(workflowDirectory, "delivery.yaml"),
		"description: Delivery process\nstages:\n  - id: implementation\n    description: Implementation stage\n    initial: true\n  - id: review\n    description: Review stage\n    final: true\ntransitions:\n  - from: implementation\n    to: review\n    type: advance\n",
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
	name: "workflow_activate" | "workflow_transition",
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
	name: "workflow_activate" | "workflow_transition",
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

/** Renders a completed tool row after its result restores persisted row evidence. */
function renderCompletedTool(
	definition: ToolDefinition,
	execution: ExecutedTool,
	theme: Theme = PLAIN_THEME,
	width = 100,
): { readonly call: readonly string[]; readonly result: readonly string[] } {
	if (
		definition.renderCall === undefined ||
		definition.renderResult === undefined
	) {
		throw new Error(`${definition.name} semantic renderers are missing`);
	}
	const context = createToolRenderContext({
		args: execution.args,
		expanded: false,
		isError: execution.isError,
	});
	const result = definition.renderResult(
		execution.result,
		{ expanded: false, isPartial: false },
		theme,
		context,
	);
	return {
		call: definition.renderCall(execution.args, theme, context).render(width),
		result: result.render(width),
	};
}

/** Initializes the global theme used by Pi's public tool execution component. */
beforeEach(() => {
	initTheme(undefined, false);
});

afterEach(async () => {
	if (originalSuiteDirectory === undefined) {
		delete process.env["PI_AGENT_SUITE_DIR"];
	} else {
		process.env["PI_AGENT_SUITE_DIR"] = originalSuiteDirectory;
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
			call: ["workflow_activate delivery · Delivery process"],
			result: [],
		});
		expect(session).toEqual(active);
		expect(execution.result.content).toEqual([
			{ type: "text", text: '{"success":true}' },
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
			"<muted>From: implementation · Implementation stage</muted>",
			"<muted>To: implementation · Implementation stage</muted>",
		]);
		expect(rendered.result).toEqual([
			"<toolTitle><bold>Error:</bold></toolTitle><muted> transition to implementation is not allowed; available transitions: review</muted>",
		]);
	});

	/** Proves semantic rows honor the child width supplied by Pi's default tool shell. */
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
		const shell = new Box(1, 1);
		for (const line of [...rendered.call, ...rendered.result]) {
			shell.addChild({ render: () => [line], invalidate: () => {} });
		}

		for (const line of shell.render(24)) {
			expect(visibleWidth(stripVTControlCharacters(line))).toBeLessThanOrEqual(
				24,
			);
		}
	});
});
