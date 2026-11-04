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
import { WORKFLOW_STATE_JOURNAL_VERSION } from "./workflow.ts";

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
/** Matches the collapsed hint for six single-line stage attributes. */
const GOAL_STAGE_HINT = /^\.\.\. \(2 more lines, 6 total,/;
/** Matches the collapsed hint for five single-line stage attributes. */
const LEGACY_STAGE_HINT = /^\.\.\. \(1 more line, 5 total,/;

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
async function createFixture(
	branch: readonly unknown[] = [],
): Promise<WorkflowRenderingFixture> {
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
			sessionManager: {
				getBranch: () => branch,
				buildSessionProjection: () => ({ entries: [] }),
			},
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
		| "workflow_create"
		| "workflow_exit",
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
		| "workflow_create"
		| "workflow_exit",
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
	const call = definition.renderCall(execution.args, theme, context);
	const result = definition.renderResult(
		execution.result,
		{ expanded, isPartial: false },
		theme,
		context,
	);
	return {
		call: call.render(width).map((line) => line.trimEnd()),
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
				goal: "The implementation passes its checks",
				prompt: "Implement the change",
				model: { thinking: "medium" },
				initial: true,
			},
			{
				id: "review",
				description: "Review stage",
				goal: "The reviewer has approved the change",
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
	test("renders streamed kind YAML consistently on both screens and expansion modes", async () => {
		await createWorkflowSuite();
		const fixture = await createFixture();
		const main = fixture.tools.find(({ name }) => name === "workflow_create");
		const child = resolveSessionDefinition(fixture, "workflow_create");
		if (!main?.renderCall || !child.renderCall) {
			throw new Error("missing create renderer");
		}
		for (const expanded of [false, true]) {
			const args = { id: "kind-stream", kind: "review<&>" };
			const lines = main
				.renderCall(
					args,
					PLAIN_THEME,
					createToolRenderContext({ args, expanded, isError: false }),
				)
				.render(100)
				.map((line) => line.trimEnd());
			expect(
				child
					.renderCall(
						args,
						PLAIN_THEME,
						createToolRenderContext({ args, expanded, isError: false }),
					)
					.render(100)
					.map((line) => line.trimEnd()),
			).toEqual(lines);
			const marker = expanded ? "--- Content ---" : "Content:";
			expect(
				parse(lines.slice(lines.indexOf(marker) + 1).join("\n")).kind,
			).toBe(args.kind);
		}
	});
	test.each([
		true,
		false,
	])("renders streamed nested=%s as YAML on both screens", async (nested) => {
		await createWorkflowSuite();
		const fixture = await createFixture();
		const active = fixture.tools.find(({ name }) => name === "workflow_create");
		if (!active?.renderCall) {
			throw new Error("missing create renderer");
		}
		const child = resolveSessionDefinition(fixture, "workflow_create");
		if (!child.renderCall) {
			throw new Error("missing child create renderer");
		}
		for (const expanded of [false, true]) {
			const args = { id: "nested-stream", nested };
			const context = createToolRenderContext({
				args,
				expanded,
				isError: false,
			});
			const mainCall = active.renderCall(args, PLAIN_THEME, context);
			const childCall = child.renderCall(
				args,
				PLAIN_THEME,
				createToolRenderContext({ args, expanded, isError: false }),
			);
			const lines = mainCall.render(100).map((line) => line.trimEnd());
			expect(childCall.render(100).map((line) => line.trimEnd())).toEqual(
				lines,
			);
			const marker = expanded ? "--- Content ---" : "Content:";
			const parsed = parse(lines.slice(lines.indexOf(marker) + 1).join("\n"));
			expect(parsed.nested).toBe(nested);
			for (const width of [18, 40]) {
				const shell = new Box(1, 1);
				shell.addChild(mainCall);
				for (const line of shell.render(width)) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		}
	});
	/** Keeps unconditional and legacy evidence limited to transition endpoints. */
	test.each(
		[false, true].flatMap((legacy) =>
			[false, true].flatMap((replayed) =>
				[false, true].flatMap((subagent) =>
					[false, true].map((expanded) => ({
						legacy,
						replayed,
						subagent,
						expanded,
					})),
				),
			),
		),
	)("omits unconditional transition ground %j", async ({
		legacy,
		replayed,
		subagent,
		expanded,
	}) => {
		await createWorkflowSuite();
		const workflow = createArguments("unconditional", "Unconditional");
		if (legacy) {
			for (const stage of workflow["stages"] as Record<string, unknown>[]) {
				delete stage["goal"];
			}
		}
		const fixture = await createFixture(
			legacy
				? [
						{
							type: "custom",
							customType: "workflow-state",
							data: {
								kind: "created",
								workflow,
								route: ["implementation"],
								journalVersion: WORKFLOW_STATE_JOURNAL_VERSION,
							},
						},
					]
				: [],
		);
		if (!legacy) {
			await executeTool(fixture, "workflow_create", workflow);
		}
		const transition = await executeTool(fixture, "workflow_transition", {
			basis: "Stage checks passed.",
			stageId: "review",
		});
		expect(transition.isError).toBe(false);
		const screen = replayed ? await createFixture() : fixture;
		const definition = subagent
			? resolveSessionDefinition(screen, "workflow_transition")
			: screen.tools.find(({ name }) => name === "workflow_transition");
		const component = new ToolExecutionComponent(
			"workflow_transition",
			"unconditional",
			transition.args,
			{},
			definition,
			{ requestRender(): void {} } as TUI,
			"/tmp",
		);
		component.setArgsComplete();
		component.setExpanded(expanded);
		component.updateResult({
			...JSON.parse(JSON.stringify(transition.result)),
			isError: false,
		});
		const lines = component
			.render(120)
			.map((line) => stripVTControlCharacters(line).trim())
			.filter(Boolean);
		expect(lines).toEqual(
			expanded
				? [
						"workflow_transition",
						"--- From ---",
						"implementation · Implementation stage",
						"--- To ---",
						"review · Review stage",
					]
				: [
						"workflow_transition",
						"From: implementation · Implementation stage",
						"To: review · Review stage",
					],
		);
	});

	/** Shows the selected edge condition on the first live or replay Pi render. */
	test.each(
		[false, true].flatMap((replayed) =>
			[false, true].flatMap((subagent) =>
				[false, true].map((expanded) => ({ replayed, subagent, expanded })),
			),
		),
	)("renders selected transition ground %j", async ({
		replayed,
		subagent,
		expanded,
	}) => {
		await createWorkflowSuite();
		const fixture = await createFixture();
		const workflow = createArguments("ground-choice", "Ground choice");
		const selected = { id: "shared", when: "A finding needs uncovered units." };
		workflow["transitions"] = [
			{
				from: "implementation",
				to: "review",
				type: "advance",
				grounds: [
					{ id: "shared", when: "An unrelated edge condition." },
					{ id: "other", when: "Another advance condition." },
				],
			},
			{
				from: "review",
				to: "implementation",
				type: "rework",
				grounds: [
					{ id: "first", when: "A different rework condition." },
					{ ...selected, when: `  ${selected.when}\n  ` },
				],
			},
		];
		await executeTool(fixture, "workflow_create", workflow);
		await executeTool(fixture, "workflow_transition", {
			basis: "Stage checks passed.",
			stageId: "review",
			ground: "other",
		});
		const args = {
			basis: "The selected condition holds.",
			stageId: "implementation",
			ground: selected.id,
		};
		const tool = fixture.tools.find(
			({ name }) => name === "workflow_transition",
		);
		if (tool?.renderCall === undefined || tool.renderResult === undefined) {
			throw new Error("missing transition renderers");
		}
		const context = createToolRenderContext({ args, expanded, isError: false });
		const call = tool.renderCall(args, PLAIN_THEME, context);
		const groundRow = expanded
			? `${selected.id} · ${selected.when}`
			: `Ground: ${selected.when}`;
		expect(call.render(120).map((line) => line.trimEnd())).toContain(groundRow);
		const transition = await executeTool(fixture, "workflow_transition", args);
		tool.renderResult(
			transition.result,
			{ expanded, isPartial: false },
			PLAIN_THEME,
			context,
		);
		expect(call.render(120).map((line) => line.trimEnd())).toContain(groundRow);
		expect(transition.isError).toBe(false);
		const hooked = renderCompletedTool(
			transition.definition,
			transition,
			PLAIN_THEME,
			120,
			expanded,
		);
		expect(hooked.call).toContain(
			expanded
				? `${selected.id} · ${selected.when}`
				: `Ground: ${selected.when}`,
		);
		// Replace the active definition to prove rendering uses captured evidence.
		await executeTool(
			fixture,
			"workflow_create",
			createArguments("replacement", "Replacement"),
		);
		const screen = replayed ? await createFixture() : fixture;
		const definition = subagent
			? resolveSessionDefinition(screen, "workflow_transition")
			: screen.tools.find(({ name }) => name === "workflow_transition");
		const component = new ToolExecutionComponent(
			"workflow_transition",
			"ground-choice",
			transition.args,
			{},
			definition,
			{ requestRender(): void {} } as TUI,
			"/tmp",
		);
		component.markExecutionStarted();
		component.setArgsComplete();
		component.setExpanded(expanded);
		component.updateResult({
			...JSON.parse(JSON.stringify(transition.result)),
			isError: false,
		});
		for (const width of [8, 22, 120]) {
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		const lines = component
			.render(120)
			.map((line) => stripVTControlCharacters(line).trim())
			.filter(Boolean);
		expect(lines).toEqual(
			expanded
				? [
						"workflow_transition",
						"--- From ---",
						"review · Review stage",
						"--- To ---",
						"implementation · Implementation stage",
						"--- Ground ---",
						`${selected.id} · ${selected.when}`,
					]
				: [
						"workflow_transition",
						"From: review · Review stage",
						"To: implementation · Implementation stage",
						`Ground: ${selected.when}`,
					],
		);
		expect(transition.result.details).toMatchObject({
			from: { id: "review" },
			to: { id: "implementation" },
			ground: selected,
		});
	});

	/** Shows the sole ground of a transition whose call names no ground. */
	test.each([
		false,
		true,
	])("renders the sole transition ground when the call omits it, expanded %p", async (expanded) => {
		await createWorkflowSuite();
		const fixture = await createFixture();
		const workflow = createArguments("sole-ground", "Sole ground");
		const sole = { id: "ready", when: "The implementation is ready." };
		workflow["transitions"] = [
			{
				from: "implementation",
				to: "review",
				type: "advance",
				grounds: [sole],
			},
		];
		await executeTool(fixture, "workflow_create", workflow);
		const transition = await executeTool(fixture, "workflow_transition", {
			basis: "Stage checks passed.",
			stageId: "review",
		});
		expect(transition.isError).toBe(false);
		expect(transition.result.details).toMatchObject({ ground: sole });
		const hooked = renderCompletedTool(
			transition.definition,
			transition,
			PLAIN_THEME,
			120,
			expanded,
		);
		expect(hooked.call).toContain(
			expanded ? `${sole.id} · ${sole.when}` : `Ground: ${sole.when}`,
		);
	});

	/**
	 * Proves that the rows of a bound transition and of its exit show the nested workflow and the outcome.
	 * Input and expected output: review is bound to check; the request shows check, and exits show allowed or refused.
	 * Edge case: the same rows appear in compact and expanded mode from saved evidence.
	 */
	test("renders the nested workflow of a bound transition and the outcome of its exit", async () => {
		await createWorkflowSuite();
		const directory = join(
			process.env["PI_AGENT_SUITE_DIR"] ?? "",
			"workflow",
			"workflows",
		);
		await writeFile(
			join(directory, "bound.yaml"),
			"version: 3\ndescription: Bound process\nprompt: Follow bound rules\nstages:\n  - id: implementation\n    description: Implementation stage\n    goal: Implemented\n    prompt: Implement\n    initial: true\n  - id: review\n    description: Review stage\n    goal: Reviewed\n    prompt: Review\n    final: true\ntransitions:\n  - from: implementation\n    to: review\n    type: advance\n    workflow: check\n",
		);
		await writeFile(
			join(directory, "check.yaml"),
			"version: 3\nnested: true\ndescription: Check process\nprompt: Follow check rules\nstages:\n  - id: start\n    description: Start stage\n    goal: Started\n    prompt: Start\n    initial: true\n  - id: done\n    description: Done stage\n    goal: Done\n    prompt: Finish\n    final: true\ntransitions:\n  - from: start\n    to: done\n    type: advance\n",
		);
		const fixture = await createFixture();
		await executeTool(fixture, "workflow_activate", { workflowId: "bound" });
		const render = (execution: ExecutedTool, expanded: boolean) =>
			renderCompletedTool(
				execution.definition,
				execution,
				PLAIN_THEME,
				120,
				expanded,
			).call.filter(Boolean);
		const request = { basis: "Implemented.", stageId: "review" };
		const transition = await executeTool(
			fixture,
			"workflow_transition",
			request,
		);
		expect(render(transition, false)).toEqual([
			"workflow_transition",
			"From: implementation · Implementation stage",
			"To: review · Review stage",
			"Nested workflow: check · Check process",
		]);
		expect(render(transition, true)).toEqual([
			"workflow_transition",
			"--- From ---",
			"implementation · Implementation stage",
			"--- To ---",
			"review · Review stage",
			"--- Nested workflow ---",
			"check · Check process",
		]);
		const refusal = await executeTool(fixture, "workflow_exit", {
			basis: "Not ready.",
			allow: false,
		});
		expect(render(refusal, false)).toEqual([
			"workflow_exit",
			"Workflow: check · Check process",
			"Transition: review · refused",
		]);
		await executeTool(fixture, "workflow_transition", request);
		const permission = await executeTool(fixture, "workflow_exit", {
			basis: "Ready.",
			allow: true,
		});
		expect(render(permission, true)).toEqual([
			"workflow_exit",
			"--- Workflow ---",
			"check · Check process",
			"--- Transition ---",
			"review · allowed",
		]);
	});

	test("renders explicit exit identically in main and subagent screens after state removal", async () => {
		await createWorkflowSuite();
		const fixture = await createFixture();
		await executeTool(fixture, "workflow_activate", { workflowId: "delivery" });
		const execution = await executeTool(fixture, "workflow_exit", {
			basis: "The task is complete.",
		});
		const active = renderCompletedTool(execution.definition, execution);
		const child = renderCompletedTool(
			resolveSessionDefinition(fixture, "workflow_exit"),
			execution,
		);
		expect(active.call.join("\n")).toContain("delivery");
		expect(active.result).toEqual([]);
		expect(child).toEqual(active);
		expect(execution.result.details).toMatchObject({
			toolName: "workflow_exit",
			workflow: { id: "delivery" },
		});
		for (const expanded of [false, true]) {
			for (const width of [12, 40]) {
				const context = createToolRenderContext({
					args: execution.args,
					expanded,
					isError: false,
				});
				execution.definition.renderResult?.(
					execution.result,
					{ expanded, isPartial: false },
					PLAIN_THEME,
					context,
				);
				const call = execution.definition.renderCall?.(
					execution.args,
					PLAIN_THEME,
					context,
				);
				if (call === undefined) {
					throw new Error("missing exit renderer");
				}
				const shell = new Box(1, 1);
				shell.addChild(call);
				for (const line of shell.render(width)) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		}
	});

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
			basis: "Stage checks passed.",
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
		const getDefinition = fixture.tools.find(
			({ name }) => name === "workflow_get_stage",
		);
		const renderCall = getDefinition?.renderCall;
		if (renderCall === undefined) {
			throw new Error("stage inspection renderer is missing");
		}
		const liveRows = [false, true].map((expanded) =>
			renderCall(
				{ stageId: "implementation" },
				PLAIN_THEME,
				createToolRenderContext({
					args: { stageId: "implementation" },
					expanded,
					isError: false,
				}),
			)
				.render(expanded ? 100 : 500)
				.map((line) => line.trimEnd()),
		);
		const get = await executeTool(fixture, "workflow_get_stage", {
			stageId: "implementation",
		});
		const edit = await executeTool(fixture, "workflow_edit_stage", {
			stageId: "implementation",
			goal: "The implementation passes its checks",
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
			"Goal: The implementation passes its checks",
			expect.stringContaining("Prompt:"),
			"Thinking: medium",
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
		expect([getCollapsed.call, getExpanded.call]).toEqual(liveRows);
		expect(getExpanded).toEqual({
			call: [
				"workflow_get_stage: implementation",
				"--- Description ---",
				"Implementation stage",
				"--- Goal ---",
				"The implementation passes its checks",
				"--- Prompt ---",
				expect.any(String),
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
			goal: "The implementation passes its checks",
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
		expect(get.result.content).toHaveLength(1);
		const stageResult = get.result.content[0];
		if (stageResult?.type !== "text") {
			throw new Error("stage inspection must return text JSON");
		}
		expect(JSON.parse(stageResult.text)).toMatchObject({
			id: "implementation",
			description: "Implementation stage",
			goal: "The implementation passes its checks",
			model: { thinking: "medium" },
			initial: true,
			final: false,
		});
		expect(edit.result.content).toEqual([
			{ type: "text", text: '{"success":true}' },
		]);
	});

	/** Checks goal-only change rows in real Pi shells on the first live or replay render. */
	test.each(
		[false, true].flatMap((replayed) =>
			[false, true].flatMap((subagent) =>
				[false, true].map((expanded) => ({ replayed, subagent, expanded })),
			),
		),
	)("renders first goal-only stage edit %j", async ({
		replayed,
		subagent,
		expanded,
	}) => {
		await createWorkflowSuite();
		const fixture = await createFixture();
		const args = createArguments("goal-edit", "Goal edit");
		await executeTool(fixture, "workflow_create", args);
		const stage = (args["stages"] as Record<string, unknown>[])[0];
		if (stage === undefined) {
			throw new Error("missing stage fixture");
		}
		const replacement = {
			stageId: "implementation",
			description: stage["description"],
			prompt: stage["prompt"],
			model: stage["model"],
			goal: "  Revised outcome\n  ",
		};
		const edit = await executeTool(fixture, "workflow_edit_stage", replacement);
		expect(edit.isError).toBe(false);
		expect(edit.result.details).toMatchObject({
			editedContent: { goal: replacement.goal.trim() },
		});
		const screen = replayed ? await createFixture() : fixture;
		const definition = subagent
			? resolveSessionDefinition(screen, "workflow_edit_stage")
			: screen.tools.find(({ name }) => name === "workflow_edit_stage");
		const component = new ToolExecutionComponent(
			"workflow_edit_stage",
			"goal-edit",
			edit.args,
			{},
			definition,
			{ requestRender(): void {} } as TUI,
			"/tmp",
		);
		component.markExecutionStarted();
		component.setArgsComplete();
		component.setExpanded(expanded);
		component.updateResult({
			...(replayed ? JSON.parse(JSON.stringify(edit.result)) : edit.result),
			isError: false,
		});
		const lines = component
			.render(100)
			.map((line) => stripVTControlCharacters(line).trim())
			.filter(Boolean);
		expect(lines).toEqual(
			expanded
				? [
						"workflow_edit_stage: implementation",
						"--- Goal ---",
						String(stage["goal"]),
						"->",
						"Revised outcome",
					]
				: [
						"workflow_edit_stage: implementation",
						`Goal: ${String(stage["goal"])} -> Revised outcome`,
					],
		);
		for (const line of component.render(100)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		}
		const unchanged = await executeTool(
			fixture,
			"workflow_edit_stage",
			replacement,
		);
		expect(unchanged.isError).toBe(false);
		expect(
			renderCompletedTool(
				unchanged.definition,
				unchanged,
				PLAIN_THEME,
				100,
				expanded,
			).call,
		).toEqual(["workflow_edit_stage: implementation", "No changes."]);
	});

	/** Checks stage attributes on the first render after result delivery. */
	test.each(
		[false, true].flatMap((format2) =>
			[false, true].flatMap((replayed) =>
				[false, true].flatMap((subagent) =>
					[false, true].map((expanded) => ({
						format2,
						replayed,
						subagent,
						expanded,
					})),
				),
			),
		),
	)("renders first stage inspection %j", async ({
		format2,
		replayed,
		subagent,
		expanded,
	}) => {
		await createWorkflowSuite();
		const workflow = createArguments("saved-delivery", "Saved delivery");
		if (format2) {
			workflow["version"] = 2;
		} else {
			for (const stage of workflow["stages"] as Record<string, unknown>[]) {
				delete stage["goal"];
			}
		}
		const fixture = await createFixture([
			{
				type: "custom",
				customType: "workflow-state",
				data: {
					kind: "created",
					workflow,
					route: ["implementation"],
					journalVersion: WORKFLOW_STATE_JOURNAL_VERSION,
				},
			},
		]);
		const get = await executeTool(fixture, "workflow_get_stage", {
			stageId: "implementation",
		});
		expect(get.isError).toBe(false);
		// A replay screen has saved evidence but no active workflow to prime its call.
		const screen = replayed ? await createFixture() : fixture;
		const definition = subagent
			? resolveSessionDefinition(screen, "workflow_get_stage")
			: screen.tools.find(({ name }) => name === "workflow_get_stage");
		expect(definition).toBeDefined();
		const component = new ToolExecutionComponent(
			"workflow_get_stage",
			"first-stage-inspection",
			get.args,
			{},
			definition,
			{ requestRender(): void {} } as TUI,
			"/tmp",
		);
		component.markExecutionStarted();
		component.setArgsComplete();
		component.setExpanded(expanded);
		const result = replayed
			? JSON.parse(JSON.stringify(get.result))
			: get.result;
		component.updateResult({ ...result, isError: false });
		// Render immediately after result delivery, without another display update.
		const lines = component
			.render(100)
			.map((line) => stripVTControlCharacters(line).trim());
		expect(lines).toContain("workflow_get_stage: implementation");
		expect(lines).toContain(
			expanded ? "--- Description ---" : "Description: Implementation stage",
		);
		expect(
			lines.some((line) => line.includes(expanded ? "--- Goal ---" : "Goal:")),
		).toBe(format2);
		if (format2) {
			expect(lines).toContain(
				expanded
					? "The implementation passes its checks"
					: "Goal: The implementation passes its checks",
			);
		}
		if (expanded) {
			expect(lines).toContain("--- Prompt ---");
			expect(lines).toContain("--- Initial ---");
			expect(lines).toContain("--- Final ---");
		} else {
			expect(
				lines.some((line) =>
					(format2 ? GOAL_STAGE_HINT : LEGACY_STAGE_HINT).test(line),
				),
			).toBe(true);
		}
		expect(lines.join("\n")).not.toContain('"id":"implementation"');
		for (const line of component.render(100)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		}
	});

	/** Checks absent thinking through restored execution and independent persisted evidence. */
	test.each(
		["live", "replay", "synthetic"].flatMap((mode) =>
			[false, true].flatMap((subagent) =>
				[false, true].map((expanded) => ({ mode, subagent, expanded })),
			),
		),
	)("renders stage attributes without stored thinking %j", async ({
		mode,
		subagent,
		expanded,
	}) => {
		const synthetic = mode === "synthetic";
		await createWorkflowSuite();
		const workflow = createArguments("optional-thinking", "Optional thinking");
		for (const stage of workflow["stages"] as Record<string, unknown>[]) {
			delete stage["model"];
			delete stage["goal"];
		}
		const source = await createFixture([
			{
				type: "custom",
				customType: "workflow-state",
				data: {
					kind: "created",
					workflow,
					route: ["implementation"],
					journalVersion: WORKFLOW_STATE_JOURNAL_VERSION,
				},
			},
		]);
		const execution = await executeTool(source, "workflow_get_stage", {
			stageId: "implementation",
		});
		expect(execution.isError).toBe(false);
		expect(
			JSON.parse((execution.result.content[0] as { text: string }).text),
		).toMatchObject({ model: {} });
		const screen = mode === "live" ? source : await createFixture();
		const result = synthetic
			? {
					content: [{ type: "text" as const, text: "{}" }],
					details: {
						presentationKind: "workflow-tool",
						toolName: "workflow_get_stage",
						stage: { id: "implementation" },
						content: {
							id: "implementation",
							description: "Implementation stage",
							goal: "Saved outcome",
							prompt: "Saved instructions",
							model: {},
							initial: true,
							final: false,
						},
					},
				}
			: execution.result;
		const definition = subagent
			? resolveSessionDefinition(screen, "workflow_get_stage")
			: screen.tools.find(({ name }) => name === "workflow_get_stage");
		const component = new ToolExecutionComponent(
			"workflow_get_stage",
			"optional-thinking",
			execution.args,
			{},
			definition,
			{ requestRender(): void {} } as TUI,
			"/tmp",
		);
		component.markExecutionStarted();
		component.setArgsComplete();
		component.setExpanded(expanded);
		component.updateResult({
			...JSON.parse(JSON.stringify(result)),
			isError: false,
		});
		const lines = component
			.render(100)
			.map((line) => stripVTControlCharacters(line).trim())
			.filter(Boolean);
		expect(lines).toContain(
			expanded ? "--- Description ---" : "Description: Implementation stage",
		);
		expect(
			lines.some((line) =>
				expanded ? line === "--- Prompt ---" : line.startsWith("Prompt:"),
			),
		).toBe(true);
		expect(lines.some((line) => line.includes("Thinking"))).toBe(false);
		expect(lines.join("\n")).not.toContain("undefined");
		if (synthetic) {
			expect(lines).toContain(
				expanded ? "--- Goal ---" : "Goal: Saved outcome",
			);
		} else {
			expect(lines.some((line) => line.includes("Goal"))).toBe(false);
		}
		if (expanded) {
			expect(lines).toContain("--- Initial ---");
			expect(lines).toContain("--- Final ---");
			expect(lines).toContain("true");
			expect(lines).toContain("false");
		} else {
			expect(lines).toContain("Initial: true");
			expect(
				lines.some((line) =>
					synthetic ? LEGACY_STAGE_HINT.test(line) : line === "Final: false",
				),
			).toBe(true);
		}
		for (const width of [22, 100]) {
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	/** Keeps known edit values when the saved stage has no thinking override. */
	test.each(
		[false, true].flatMap((replayed) =>
			[false, true].flatMap((subagent) =>
				[false, true].map((expanded) => ({ replayed, subagent, expanded })),
			),
		),
	)("renders stage edit without prior thinking %j", async ({
		replayed,
		subagent,
		expanded,
	}) => {
		await createWorkflowSuite();
		const workflow = createArguments(
			"optional-edit-thinking",
			"Optional edit thinking",
		);
		for (const stage of workflow["stages"] as Record<string, unknown>[]) {
			delete stage["model"];
			delete stage["goal"];
		}
		const fixture = await createFixture([
			{
				type: "custom",
				customType: "workflow-state",
				data: {
					kind: "created",
					workflow,
					route: ["implementation"],
					journalVersion: WORKFLOW_STATE_JOURNAL_VERSION,
				},
			},
		]);
		const edit = await executeTool(fixture, "workflow_edit_stage", {
			stageId: "implementation",
			description: "Revised stage",
			prompt: "Revised instructions",
			model: { thinking: "high" },
		});
		expect(edit.isError).toBe(false);
		const screen = replayed ? await createFixture() : fixture;
		const definition = subagent
			? resolveSessionDefinition(screen, "workflow_edit_stage")
			: screen.tools.find(({ name }) => name === "workflow_edit_stage");
		const component = new ToolExecutionComponent(
			"workflow_edit_stage",
			"optional-edit-thinking",
			edit.args,
			{},
			definition,
			{ requestRender(): void {} } as TUI,
			"/tmp",
		);
		component.markExecutionStarted();
		component.setArgsComplete();
		component.setExpanded(expanded);
		component.updateResult({
			...JSON.parse(JSON.stringify(edit.result)),
			isError: false,
		});
		const lines = component
			.render(100)
			.map((line) => stripVTControlCharacters(line).trim())
			.filter(Boolean);
		expect(lines).toContain(
			expanded
				? "--- Description ---"
				: "Description: Implementation stage -> Revised stage",
		);
		expect(
			lines.some((line) =>
				expanded ? line === "--- Prompt ---" : line.startsWith("Prompt:"),
			),
		).toBe(true);
		expect(lines).toContain(expanded ? "--- Thinking ---" : "Thinking: high");
		if (expanded) {
			expect(lines).toContain("high");
		}
		expect(lines.join("\n")).not.toContain("undefined");
		if (expanded) {
			expect(lines.filter((line) => line === "->")).toHaveLength(2);
		}
		for (const width of [22, 100]) {
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	/** Validates optional presentation thinking without weakening other saved attributes. */
	test.each([
		{ model: {}, accepted: true },
		{ model: { thinking: "medium" }, accepted: true },
		{ model: { thinking: "" }, accepted: false },
		{ model: { thinking: null }, accepted: false },
		{ model: { thinking: 1 }, accepted: false },
		{ model: { thinking: false }, accepted: false },
		{ model: { thinking: [] }, accepted: false },
		{ model: null, accepted: false },
		{ model: {}, description: "", accepted: false },
	])("validates persisted stage attributes %j", async ({
		model,
		accepted,
		description,
	}) => {
		await createWorkflowSuite();
		const fixture = await createFixture();
		const definition = resolveSessionDefinition(fixture, "workflow_get_stage");
		const component = new ToolExecutionComponent(
			"workflow_get_stage",
			"validation",
			{ stageId: "saved" },
			{},
			definition,
			{ requestRender(): void {} } as TUI,
			"/tmp",
		);
		component.setExpanded(true);
		component.updateResult({
			content: [],
			isError: false,
			details: {
				presentationKind: "workflow-tool",
				toolName: "workflow_get_stage",
				stage: { id: "saved" },
				content: {
					id: "saved",
					description: description ?? "Saved stage",
					prompt: "Saved instructions",
					model,
				},
			},
		});
		const text = stripVTControlCharacters(component.render(100).join("\n"));
		expect(text.includes("--- Description ---")).toBe(accepted);
		expect(text.includes("--- Thinking ---")).toBe(
			accepted && model !== null && "thinking" in model,
		);
		if (accepted && model !== null && "thinking" in model) {
			expect(text).toContain("medium");
		}
	});

	/** Preserves edit details when replacement thinking is absent. */
	test.each(
		[undefined, "medium"].flatMap((previousThinking) =>
			[false, true].flatMap((subagent) =>
				[false, true].map((expanded) => ({
					previousThinking,
					subagent,
					expanded,
				})),
			),
		),
	)("renders persisted edit details without replacement thinking %j", async ({
		previousThinking,
		subagent,
		expanded,
	}) => {
		await createWorkflowSuite();
		const fixture = await createFixture();
		const content = {
			id: "saved",
			description: "Saved stage",
			prompt: "Saved instructions",
			model: {},
		};
		const definition = subagent
			? resolveSessionDefinition(fixture, "workflow_edit_stage")
			: fixture.tools.find(({ name }) => name === "workflow_edit_stage");
		const component = new ToolExecutionComponent(
			"workflow_edit_stage",
			"saved-edit",
			{ stageId: "saved" },
			{},
			definition,
			{ requestRender(): void {} } as TUI,
			"/tmp",
		);
		component.setExpanded(expanded);
		component.updateResult({
			content: [],
			isError: false,
			details: {
				presentationKind: "workflow-tool",
				toolName: "workflow_edit_stage",
				stage: { id: "saved" },
				content: {
					...content,
					model:
						previousThinking === undefined
							? {}
							: { thinking: previousThinking },
				},
				editedContent: { ...content, description: "Revised stage" },
			},
		});
		const lines = component
			.render(100)
			.map((line) => stripVTControlCharacters(line).trim())
			.filter(Boolean);
		expect(lines).toEqual(
			expanded
				? [
						"workflow_edit_stage: saved",
						"--- Description ---",
						"Saved stage",
						"->",
						"Revised stage",
					]
				: [
						"workflow_edit_stage: saved",
						"Description: Saved stage -> Revised stage",
					],
		);
		for (const width of [22, 100]) {
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
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
		implementation["goal"] = "Checks pass.\nEvidence is saved.";
		implementation["prompt"] = "Inspect current state.\nImplement the change.";
		await executeTool(fixture, "workflow_create", args);
		const get = await executeTool(fixture, "workflow_get_stage", {
			stageId: "implementation",
		});
		const edit = await executeTool(fixture, "workflow_edit_stage", {
			stageId: "implementation",
			goal: "Checks pass.\nEvidence is saved.",
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
		expect(getExpanded.call).toContain("--- Goal ---");
		expect(getExpanded.call).toContain("Checks pass.");
		expect(getExpanded.call).toContain("Evidence is saved.");
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
		expect(getCollapsed.call).toContain(
			"Goal: Checks pass. Evidence is saved.",
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
			basis: "Stage checks passed.",
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
			basis: "Stage checks passed.",
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
			basis: "Stage checks passed.",
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
			basis: "Stage checks passed.",
			stageId: "implementation",
		});
		// Advance live state so the failed row can only retain its source through persisted details.
		await executeTool(fixture, "workflow_transition", {
			basis: "Stage checks passed.",
			stageId: "review",
		});
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
			basis: "Stage checks passed.",
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
			goal: "The implementation passes its checks",
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
