import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { Type } from "typebox";
import { createToolRenderContext } from "../../../test/support/tool-render-context.ts";
import { registerPackageToolPresentation } from "../../shared/tool-presentation/registry.ts";
import {
	renderMcpToolCall,
	renderMcpToolResult,
} from "../mcp-wrapper/rendering.ts";
import {
	renderSubagentQueryCall,
	renderSubagentQueryResult,
} from "./query-rendering.ts";
import {
	renderSubagentFeedback,
	renderSubagentStartCall,
	renderSubagentStartResult,
	renderSubagentSteerCall,
	renderSubagentSteerResult,
	renderSubagentWaitCall,
	renderSubagentWaitResult,
} from "./semantic-rendering.ts";
import { createToolPresentationRegistry } from "./tool-rendering.ts";

const MCP_PARAMETERS = Type.Object({ path: Type.Optional(Type.String()) });
const PLAIN_THEME = {
	bold: (value: string) => value,
	fg: (_color: string, value: string) => value,
} as Theme;
const MARKED_THEME = {
	bold: (value: string) => `<bold>${value}</bold>`,
	fg: (color: string, value: string) => `<${color}>${value}</${color}>`,
	bg: (color: string, value: string) => `<${color}>${value}</${color}>`,
} as Theme;
const TOOL_NAMES = [
	"subagent_start",
	"subagent_steer",
	"subagent_wait",
	"subagent_query",
] as const;
const EXPAND_HINT_PATTERN =
	/^\.\.\. \(\d+ more lines, \d+ total, alt\+x to expand\)$/;
/** Maps each subagent tool name to the renderers registered by its extension entry point. */
const SUBAGENT_PRESENTATIONS = {
	subagent_start: {
		renderCall: renderSubagentStartCall,
		renderResult: renderSubagentStartResult,
	},
	subagent_steer: {
		renderCall: renderSubagentSteerCall,
		renderResult: renderSubagentSteerResult,
	},
	subagent_wait: {
		renderCall: renderSubagentWaitCall,
		renderResult: renderSubagentWaitResult,
	},
	subagent_query: {
		renderCall: renderSubagentQueryCall,
		renderResult: renderSubagentQueryResult,
	},
} as const;

/** Supplies a fail-closed execution member for presentation-only test definitions. */
async function rejectPresentationExecution(): Promise<
	AgentToolResult<unknown>
> {
	throw new Error("presentation test definitions cannot execute");
}

/** Creates one MCP definition whose closures match its normal dynamic registration. */
function createMcpDefinition(): ToolDefinition<typeof MCP_PARAMETERS> {
	const name = "files_read";
	const widgetLineBudget = 5;
	return {
		name,
		label: name,
		description: "MCP presentation fixture",
		parameters: MCP_PARAMETERS,
		renderCall: (args, theme, context) =>
			renderMcpToolCall(name, args, theme, context),
		renderResult: (result, options, theme, context) =>
			renderMcpToolResult(result, options, theme, {
				isError: context.isError,
				widgetLineBudget,
			}),
		execute: rejectPresentationExecution,
	};
}

/** Creates the smallest extension API needed by the package presentation publisher. */
function createPresentationApi(events: ExtensionAPI["events"]): ExtensionAPI {
	return {
		events,
		on(): void {},
	} as unknown as ExtensionAPI;
}

/** Resolves one registered subagent presentation definition for semantic rendering. */
function resolveSubagentDefinition(
	name: (typeof TOOL_NAMES)[number],
): ToolDefinition {
	const events = createEventBus();
	registerPackageToolPresentation(createPresentationApi(events), {
		name,
		label: name,
		...SUBAGENT_PRESENTATIONS[name],
		renderShell: "default",
	});
	const registry = createToolPresentationRegistry("/tmp", events);
	const resolution = registry.resolve(name);
	if (
		resolution.category !== "package" ||
		resolution.definition === undefined
	) {
		throw new Error(`${name} did not resolve as a package presentation`);
	}
	return resolution.definition;
}

/** Renders one tool call before or after its result updates shared row state. */
function renderTool(options: {
	readonly name: (typeof TOOL_NAMES)[number];
	readonly args: unknown;
	readonly result?: AgentToolResult<unknown>;
	readonly expanded?: boolean;
	readonly isError?: boolean;
	readonly width?: number;
	readonly theme?: Theme;
}): { readonly call: readonly string[]; readonly result: readonly string[] } {
	const definition = resolveSubagentDefinition(options.name);
	const renderCall = definition.renderCall;
	const renderResult = definition.renderResult;
	if (renderCall === undefined || renderResult === undefined) {
		throw new Error(`${options.name} presentation renderers are missing`);
	}
	const expanded = options.expanded === true;
	const context = createToolRenderContext({
		args: options.args,
		expanded,
		isError: options.isError === true,
	});
	const theme = options.theme ?? PLAIN_THEME;
	const width = options.width ?? 100;
	const resultLines =
		options.result === undefined
			? []
			: renderResult(
					options.result,
					{ expanded, isPartial: false },
					theme,
					context,
				).render(width);
	return {
		call: renderCall(options.args, theme, context).render(width),
		result: resultLines,
	};
}

/** Creates accepted start or steer presentation evidence without changing public JSON. */
function acceptedDetails(sessionId = 1): Record<string, unknown> {
	return {
		outcome: "accepted",
		sessionId,
		presentationKind: "accepted",
		agentId: "SubAgentCoder",
		taskName: "Trace semantic rendering",
		modelId: "openai/test-model",
		thinking: "high",
	};
}

/** Creates one terminal feedback snapshot delivered by subagent_wait. */
function waitFeedbackDetails(status: "success" | "failure" = "success") {
	const common = {
		feedbackId: "feedback-1",
		invocationId: "invocation-1",
		sessionKey: { ownerPiSessionId: "owner-1", ownerLocalSessionId: 1 },
		presentation: {
			agentId: "SubAgentCoder",
			taskName: "Trace semantic rendering",
			invocationMetadata: {
				startedAtMs: 1_700_000_000_000,
				elapsedMs: 2_400,
				modelId: "openai/test-model",
				thinking: "high",
				contextWindow: 128_000,
				contextTokens: 58_000,
				projectionSavedTokens: 20_000,
			},
		},
	};
	const evidence = {
		outcome: "feedback",
		sessionId: 1,
		elapsedSeconds: 3,
		presentationKind: "wait-feedback",
		feedbackId: common.feedbackId,
		invocationId: common.invocationId,
		waitRequestId: "wait-1",
		waitElapsedMs: 15_000,
	};
	if (status === "success") {
		const output = "Rendered **semantic** output.";
		return {
			...evidence,
			status,
			output,
			feedback: { ...common, status, output },
		};
	}
	const error = "Child failed cleanly.";
	return {
		...evidence,
		status,
		error,
		feedback: { ...common, status, error },
	};
}

/** Creates one normal tool result with exact model-visible JSON and richer details. */
function result(details: Record<string, unknown>): AgentToolResult<unknown> {
	const outcome = details["outcome"];
	let modelResult: Record<string, unknown>;
	if (outcome === "accepted") {
		modelResult = { outcome, sessionId: details["sessionId"] };
	} else if (outcome === "feedback") {
		modelResult = {
			outcome,
			sessionId: details["sessionId"],
			status: details["status"],
			elapsedSeconds: details["elapsedSeconds"],
			...(details["status"] === "success"
				? { output: details["output"] }
				: { error: details["error"] }),
		};
	} else {
		modelResult = { outcome };
	}
	return {
		content: [{ type: "text", text: JSON.stringify(modelResult) }],
		details,
	};
}

describe("Subagents semantic rendering", () => {
	beforeEach(() => {
		// Pi's Markdown renderer reads the process-global theme, so each test establishes its own render state.
		initTheme(undefined, false);
	});

	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	test("keeps built-in, package, and unknown presentation ownership isolated", () => {
		// Purpose: management replay must use public built-ins, static subagent definitions, runtime-local package definitions, and universal unknown definitions.
		// Input and expected output: bash, all subagent names, one registered MCP name, and one unknown name resolve through their distinct public paths.
		// Edge case: a second Pi event bus cannot observe the first runtime's dynamic MCP registration.
		// Dependencies: public Pi tool factories, event buses, and package presentation registry.
		const firstEvents = createEventBus();
		const secondEvents = createEventBus();
		const mcp = createMcpDefinition();
		registerPackageToolPresentation(createPresentationApi(firstEvents), mcp);
		const secondApi = createPresentationApi(secondEvents);
		for (const name of TOOL_NAMES) {
			registerPackageToolPresentation(secondApi, {
				name,
				label: name,
				...SUBAGENT_PRESENTATIONS[name],
				renderShell: "default",
			});
		}
		const first = createToolPresentationRegistry("/tmp", firstEvents);
		const second = createToolPresentationRegistry("/tmp", secondEvents);

		expect({
			bash: second.resolve("bash").category,
			subagents: TOOL_NAMES.map((name) => second.resolve(name).category),
			firstMcp: first.resolve(mcp.name).category,
			secondMcp: second.resolve(mcp.name).category,
			unknown: second.resolve("third_party").category,
		}).toEqual({
			bash: "builtin",
			subagents: ["package", "package", "package", "package"],
			firstMcp: "package",
			secondMcp: "unknown",
			unknown: "unknown",
		});

		const resolution = second.resolve("bash");
		if (resolution.category !== "builtin") {
			throw new Error("bash did not resolve as a built-in");
		}
		const component = new ToolExecutionComponent(
			"bash",
			"bash-call",
			{ command: "printf ok" },
			{},
			resolution.definition,
			{ requestRender(): void {} } as TUI,
			"/tmp",
		);
		component.setArgsComplete();
		expect(component.render(40).length).toBeGreaterThan(0);
	});

	test("renders settled semantic cards through the public Pi component", () => {
		// Purpose: result-driven call-header updates must not recurse into Pi's fallback renderer or duplicate raw JSON.
		// Input and expected output: accepted start, successful wait, and settled query render once through ToolExecutionComponent with semantic text only.
		// Edge case: Pi invalidate is synchronous, so a result renderer must not invalidate while updateDisplay is active.
		// Dependencies: public ToolExecutionComponent and the same static definitions used by normal conversation.
		const ui = { requestRender(): void {} } as TUI;
		const startResult = result(acceptedDetails());
		const start = new ToolExecutionComponent(
			"subagent_start",
			"start-call",
			{
				agentId: "SubAgentCoder",
				taskName: "Trace semantic rendering",
				prompt: "Inspect the semantic card.",
			},
			{},
			resolveSubagentDefinition("subagent_start"),
			ui,
			"/tmp",
		);
		start.markExecutionStarted();
		start.setArgsComplete();
		start.updateResult({ ...startResult, isError: false });

		const waitResult = result(waitFeedbackDetails());
		const wait = new ToolExecutionComponent(
			"subagent_wait",
			"wait-call",
			{ sessionIds: [1], timeout: 30 },
			{},
			resolveSubagentDefinition("subagent_wait"),
			ui,
			"/tmp",
		);
		wait.markExecutionStarted();
		wait.setArgsComplete();
		wait.updateResult({ ...waitResult, isError: false });

		const query = new ToolExecutionComponent(
			"subagent_query",
			"query-call",
			{ sessionId: 7, question: "What happened in the child session?" },
			{},
			resolveSubagentDefinition("subagent_query"),
			ui,
			"/tmp",
		);
		query.markExecutionStarted();
		query.setArgsComplete();
		query.updateResult({
			content: [{ type: "text", text: "Saved answer." }],
			details: { answer: "Saved answer.", elapsedMs: 5_000 },
			isError: false,
		});

		const startText = stripVTControlCharacters(start.render(100).join("\n"));
		const waitText = stripVTControlCharacters(wait.render(100).join("\n"));
		const queryText = stripVTControlCharacters(query.render(100).join("\n"));
		expect(startText).toContain(
			"subagent_start SubAgentCoder · openai/test-model/high · #1",
		);
		expect(startText).not.toContain('{"outcome":"accepted"');
		expect(waitText).toContain("subagent_wait #1 · 15s/30s · -> #1");
		expect(waitText).toContain("Output:");
		expect(waitText).toContain("Rendered **semantic** output.");
		expect(waitText).not.toContain('{"outcome":"feedback"');
		expect(queryText).toContain("subagent_query #7 · 5s");
		expect(queryText).toContain(
			"Question: What happened in the child session?",
		);
		expect(queryText).toContain("Answer: Saved answer.");
		expect(queryText).not.toContain('{"sessionId":7');
	});

	test("styles direct feedback with the matching tool outcome background", () => {
		// Purpose: direct feedback must remain visually consistent with successful and failed tool cards.
		// Input and expected output: success uses the tool success background and failure uses the tool error background.
		// Edge case: the custom renderer owns its background because Pi skips the default custom-message shell.
		// Dependencies: public message-renderer contract and authoritative terminal feedback details.
		const renderFeedback = (status: "success" | "failure") => {
			const evidence = waitFeedbackDetails(status);
			const component = renderSubagentFeedback(
				{
					role: "custom",
					customType: "subagents-feedback",
					content: "terminal feedback",
					display: true,
					details: evidence.feedback,
					timestamp: 1,
				},
				{ expanded: false, outputPad: 1 },
				MARKED_THEME,
			);
			if (component === undefined) {
				throw new Error("semantic feedback renderer rejected valid details");
			}
			return component.render(100).join("\n");
		};

		expect(renderFeedback("success")).toContain("<toolSuccessBg>");
		expect(renderFeedback("failure")).toContain("<toolErrorBg>");
	});

	test("uses one semantic color contract across tool and feedback headers", () => {
		// Purpose: identical semantic roles must keep identical colors across every subagent presentation surface.
		// Inputs and expected output: tool names, agents, runtime metadata, identifiers, durations, and separators use their approved roles.
		// Edge case: the wait metadata row and direct feedback use the same agent and runtime colors as start and steer.
		// Dependencies: shared semantic header and metadata presentation.
		const accepted = result(acceptedDetails());
		const start =
			renderTool({
				name: "subagent_start",
				args: {
					agentId: "SubAgentCoder",
					taskName: "Trace semantic rendering",
					prompt: "Inspect colors",
				},
				result: accepted,
				theme: MARKED_THEME,
			}).call[0] ?? "";
		const steer =
			renderTool({
				name: "subagent_steer",
				args: { sessionId: 1, prompt: "Continue" },
				result: accepted,
				theme: MARKED_THEME,
			}).call[0] ?? "";
		const feedbackEvidence = waitFeedbackDetails();
		const wait = renderTool({
			name: "subagent_wait",
			args: { sessionIds: [1], timeout: 30 },
			result: result(feedbackEvidence),
			theme: MARKED_THEME,
		}).result;
		const direct =
			renderSubagentFeedback(
				{
					role: "custom",
					customType: "subagents-feedback",
					content: "terminal feedback",
					display: true,
					details: feedbackEvidence.feedback,
					timestamp: 1,
				},
				{ expanded: false, outputPad: 1 },
				MARKED_THEME,
			)
				?.render(300)
				.join("\n") ?? "";
		const toolTitle = (name: string) =>
			`<toolTitle><bold>${name}</bold></toolTitle>`;
		const agent = "<accent>SubAgentCoder</accent>";
		const runtime = "<muted>openai/test-model/high</muted>";
		const separator = "<muted> · </muted>";

		expect(start).toContain(toolTitle("subagent_start"));
		expect(start).toContain(agent);
		expect(start).toContain(runtime);
		expect(start).toContain(separator);
		expect(start).toContain("#1");
		expect(start).not.toContain("<muted>#1</muted>");
		expect(
			renderTool({
				name: "subagent_start",
				args: {
					agentId: "SubAgentCoder",
					taskName: "Trace semantic rendering",
					prompt: "Inspect colors",
				},
				theme: MARKED_THEME,
			}).call.join("\n"),
		).toContain(
			"<toolTitle><bold>Name:</bold></toolTitle><muted> Trace semantic rendering</muted>",
		);
		expect(steer).toContain(toolTitle("subagent_steer"));
		expect(steer).toContain(agent);
		expect(steer).toContain(runtime);
		expect(wait[0]).toContain(toolTitle("subagent_wait"));
		expect(wait[0]).toContain("<muted>15s/30s</muted>");
		expect(wait[0]).toContain("<muted>-></muted><muted> </muted>#1");
		expect(wait[1]).toContain(agent);
		expect(wait[1]).toContain(runtime);
		expect(wait.join("\n")).toContain(
			"<toolTitle><bold>Output:</bold></toolTitle><muted> Rendered **semantic** output.</muted>",
		);
		expect(direct).toContain(toolTitle("subagent feedback"));
		expect(direct).toContain(agent);
		expect(direct).toContain(runtime);
		expect(direct).toContain("<muted>2s</muted>");
	});

	test("applies context pressure thresholds to cards and direct feedback", () => {
		// Purpose: every semantic context display must share the warning and error thresholds.
		// Inputs and expected output: 49%, 50%, 79%, and 80% produce normal, warning, warning, and error usage colors.
		// Edge case: projected savings remain warning-colored independently of current usage.
		// Dependencies: wait-card metadata, direct-feedback headers, and shared context presentation.
		const renderAt = (contextTokens: number) => {
			const evidence = waitFeedbackDetails();
			evidence.feedback.presentation.invocationMetadata.contextTokens =
				contextTokens;
			evidence.feedback.presentation.invocationMetadata.contextWindow = 100;
			evidence.feedback.presentation.invocationMetadata.projectionSavedTokens = 10;
			const card = renderTool({
				name: "subagent_wait",
				args: { sessionIds: [1], timeout: 30 },
				result: result(evidence),
				theme: MARKED_THEME,
				width: 300,
			}).result.join("\n");
			const direct = renderSubagentFeedback(
				{
					role: "custom",
					customType: "subagents-feedback",
					content: "terminal feedback",
					display: true,
					details: evidence.feedback,
					timestamp: 1,
				},
				{ expanded: false, outputPad: 1 },
				MARKED_THEME,
			)
				?.render(300)
				.join("\n");
			return { card, direct };
		};
		const cases = [
			{
				tokens: 49,
				card: "<muted>49/100</muted>",
				direct: "<muted>49/100</muted>",
			},
			{
				tokens: 50,
				card: "<warning>50/100</warning>",
				direct: "<warning>50/100</warning>",
			},
			{
				tokens: 79,
				card: "<warning>79/100</warning>",
				direct: "<warning>79/100</warning>",
			},
			{
				tokens: 80,
				card: "<error>80/100</error>",
				direct: "<error>80/100</error>",
			},
		];

		for (const expected of cases) {
			const rendered = renderAt(expected.tokens);
			expect(rendered.card).toContain("<warning>~10/</warning>");
			expect(rendered.card).toContain(expected.card);
			expect(rendered.direct).toContain("<warning>~10/</warning>");
			expect(rendered.direct).toContain(expected.direct);
		}
	});

	test("renders pending and accepted start and steer on one semantic card", () => {
		// Purpose: start and steer must replace raw JSON with compact semantic identity while accepted evidence updates the same row.
		// Input and expected output: pending calls show progress verbs; accepted results add agent, model, thinking, logical name, and session without result rows.
		// Edge case: active steering and terminal continuation share the same accepted evidence shape.
		// Dependencies: shared Pi renderer state between call and result slots.
		const startArgs = {
			agentId: "SubAgentCoder",
			taskName: "Trace semantic rendering",
			prompt: "Inspect\n  the semantic   card.",
		};
		const steerArgs = { sessionId: 1, prompt: "Continue\n  the analysis." };
		const pendingStart = renderTool({
			name: "subagent_start",
			args: startArgs,
		});
		const acceptedStart = renderTool({
			name: "subagent_start",
			args: startArgs,
			result: result(acceptedDetails()),
		});
		const pendingSteer = renderTool({
			name: "subagent_steer",
			args: steerArgs,
		});
		const acceptedSteer = renderTool({
			name: "subagent_steer",
			args: steerArgs,
			result: result(acceptedDetails()),
		});

		expect(pendingStart.call).toEqual([
			"subagent_start SubAgentCoder · starting…",
			"Name: Trace semantic rendering",
			"Prompt: Inspect the semantic card.",
		]);
		expect(acceptedStart).toEqual({
			call: [
				"subagent_start SubAgentCoder · openai/test-model/high · #1",
				"Name: Trace semantic rendering",
				"Prompt: Inspect the semantic card.",
			],
			result: [],
		});
		expect(pendingSteer.call).toEqual([
			"subagent_steer #1 · sending…",
			"Prompt: Continue the analysis.",
		]);
		expect(acceptedSteer).toEqual({
			call: [
				"subagent_steer #1 · SubAgentCoder · openai/test-model/high",
				"Name: Trace semantic rendering",
				"Prompt: Continue the analysis.",
			],
			result: [],
		});
	});

	test("renders wait feedback, normal outcomes, and tool failures without fabricated metadata", () => {
		// Purpose: wait cards must distinguish delivered feedback and normal outcomes from failed tool execution.
		// Input and expected output: feedback shows a terminal snapshot, normal outcomes use muted result text, and tool failures retain error styling.
		// Edge case: ordered multiple IDs and compact timeout formatting remain stable after result classification.
		// Dependencies: validated wait evidence, structured failed-tool details, and semantic theme roles.
		const args = { sessionIds: [1, 3, 8], timeout: 30 };
		const pending = renderTool({ name: "subagent_wait", args });
		const feedback = renderTool({
			name: "subagent_wait",
			args,
			result: result(waitFeedbackDetails()),
		});
		const timeout = renderTool({
			name: "subagent_wait",
			args,
			result: result({ outcome: "timeout" }),
		});
		const noActive = renderTool({
			name: "subagent_wait",
			args,
			result: result({ outcome: "no_active_sessions" }),
		});
		const failedResult = {
			content: [{ type: "text" as const, text: "Pi validation wrapper" }],
			details: { code: "invalid_request", message: "timeout is invalid" },
		};
		const failed = renderTool({
			name: "subagent_wait",
			args,
			result: failedResult,
			isError: true,
		});
		const markedTimeout = renderTool({
			name: "subagent_wait",
			args,
			result: result({ outcome: "timeout" }),
			theme: MARKED_THEME,
		});
		const markedFailure = renderTool({
			name: "subagent_wait",
			args,
			result: failedResult,
			isError: true,
			theme: MARKED_THEME,
		});

		expect(pending.call).toEqual([
			"subagent_wait #1,3,8 · up to 30s · waiting…",
		]);
		expect(feedback.result).toEqual([
			"subagent_wait #1,3,8 · 15s/30s · -> #1",
			"SubAgentCoder · openai/test-model/high · ~20k/58k/128k",
			"Name: Trace semantic rendering",
			"Output: Rendered **semantic** output.",
		]);
		expect(timeout.result).toEqual([
			"subagent_wait #1,3,8 · 30s/30s · timeout",
			"Result: No feedback before timeout",
		]);
		expect(noActive.result).toEqual([
			"subagent_wait #1,3,8 · no active sessions",
			"Result: None of the requested sessions is active.",
		]);
		expect(failed.result).toEqual([
			"subagent_wait #1,3,8",
			"Error: timeout is invalid",
		]);
		expect(failed.result.join("\n")).not.toContain("invalid_request");
		expect(failed.result.join("\n")).not.toContain("SubAgentCoder");
		expect(markedTimeout.result.join("\n")).toContain(
			"<toolTitle><bold>Result:</bold></toolTitle><muted> No feedback before timeout</muted>",
		);
		expect(markedTimeout.result.join("\n")).not.toContain("<error>");
		expect(markedFailure.result.join("\n")).toContain(
			"<toolTitle><bold>Error:</bold></toolTitle><error> timeout is invalid</error>",
		);
	});

	test("uses bounded previews, configured hints, expanded formatting, and shell widths", () => {
		// Purpose: collapsed arbitrary text must use a visual-line budget and configured hint while expanded text remains complete and formatted.
		// Input and expected output: long start prompt and wait output collapse with one hint; expansion wraps Name and renders complete Markdown sections.
		// Edge case: every line remains inside Pi's default Box(1,1) shell contract at a narrow width.
		// Dependencies: public Text, Markdown, Box, keybinding, and visible-width APIs.
		setKeybindings(
			new KeybindingsManager(
				{
					...TUI_KEYBINDINGS,
					"app.tools.expand": {
						defaultKeys: "ctrl+o",
						description: "Expand collapsed tool output",
					},
				},
				{ "app.tools.expand": "alt+x" },
			),
		);
		const args = {
			agentId: "SubAgentCoder",
			taskName:
				"A logical name that must remain visible across narrow terminal widths",
			prompt: "semantic prompt ".repeat(30),
		};
		const collapsed = renderTool({
			name: "subagent_start",
			args,
			width: 36,
		});
		const wideCollapsed = renderTool({
			name: "subagent_start",
			args,
			width: 72,
		});
		const expanded = renderTool({
			name: "subagent_start",
			args,
			expanded: true,
			width: 36,
		});
		const shell = new Box(1, 1);
		shell.addChild(
			resolveSubagentDefinition("subagent_start").renderCall?.(
				args,
				PLAIN_THEME,
				createToolRenderContext({ args, expanded: false, isError: false }),
			) ?? { render: () => [], invalidate(): void {} },
		);
		const shellLines = shell.render(38);

		expect(collapsed.call[1]).toBe("Name: A logical name that must rema…");
		expect(wideCollapsed.call.at(-1)).toMatch(EXPAND_HINT_PATTERN);
		expect(expanded.call.join("\n")).toContain("--- Prompt ---");
		expect(expanded.call.join("\n")).toContain(
			"semantic prompt semantic prompt",
		);
		expect(expanded.call.join("\n").split("semantic prompt").length).toBe(31);
		for (const line of [...collapsed.call, ...expanded.call, ...shellLines]) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(
				shellLines.includes(line) ? 38 : 36,
			);
		}
	});

	test("renders pending query questions as bounded semantic previews or full Markdown", () => {
		// Purpose: pending queries must match the semantic Subagents presentation instead of exposing raw JSON.
		// Input and expected output: collapsed text is whitespace-normalized and bounded, while expansion renders the complete Question section.
		// Edge case: a long question preserves the shell width and reports hidden visual lines.
		// Dependencies: shared semantic headers, bounded previews, Markdown sections, and the static query presentation registry.
		setKeybindings(
			new KeybindingsManager(
				{
					...TUI_KEYBINDINGS,
					"app.tools.expand": {
						defaultKeys: "ctrl+o",
						description: "Expand collapsed tool output",
					},
				},
				{ "app.tools.expand": "alt+x" },
			),
		);
		const args = {
			sessionId: 7,
			question: `What   changed?\n\t${"Explain the **saved** conversation in detail. ".repeat(12)}`,
		};
		const collapsed = renderTool({
			name: "subagent_query",
			args,
			width: 64,
		});
		const expanded = renderTool({
			name: "subagent_query",
			args,
			expanded: true,
			width: 64,
		});

		expect(collapsed.call[0]).toBe("subagent_query #7 · querying…");
		expect(collapsed.call[1]).toStartWith("Question: What changed? Explain");
		expect(collapsed.call.join("\n")).not.toContain("\t");
		expect(collapsed.call.at(-1)).toMatch(EXPAND_HINT_PATTERN);
		expect(expanded.call[0]).toBe("subagent_query #7 · querying…");
		expect(expanded.call).toContain("--- Question ---");
		expect(expanded.call.join("\n")).toContain("saved");
		for (const line of [...collapsed.call, ...expanded.call]) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(64);
		}
	});

	test("renders settled query questions and answers by expansion state", () => {
		// Purpose: completed queries must identify their child, elapsed time, normalized question summary, and answer without a separate result card.
		// Input and expected output: collapsed Question uses one clipped row; expansion renders complete Question and Answer Markdown sections.
		// Edge case: neither collapsed nor expanded content exceeds the narrow default shell width.
		// Dependencies: query result presentation details, standard duration formatting, semantic clipping, and Markdown sections.
		setKeybindings(
			new KeybindingsManager(
				{
					...TUI_KEYBINDINGS,
					"app.tools.expand": {
						defaultKeys: "ctrl+o",
						description: "Expand collapsed tool output",
					},
				},
				{ "app.tools.expand": "alt+x" },
			),
		);
		const args = {
			sessionId: 7,
			question: `What   changed?\n\t${"Explain the saved conversation in detail. ".repeat(12)}Final **question** detail.`,
		};
		const answer = `# Answer\n\n${"Saved detail. ".repeat(30)}`;
		const result = {
			content: [{ type: "text" as const, text: answer }],
			details: { answer, elapsedMs: 5_000 },
		};
		const collapsed = renderTool({
			name: "subagent_query",
			args,
			result,
			width: 64,
		});
		const expanded = renderTool({
			name: "subagent_query",
			args,
			result,
			expanded: true,
			width: 64,
		});

		expect(collapsed.call[0]).toBe("subagent_query #7 · 5s");
		expect(collapsed.call[1]).toStartWith("Question: What changed? Explain");
		expect(collapsed.call[1]).toEndWith("…");
		expect(collapsed.call[2]).toStartWith("Answer:");
		expect(collapsed.call.at(-1)).toMatch(EXPAND_HINT_PATTERN);
		expect(collapsed.result).toEqual([]);
		const expandedText = stripVTControlCharacters(expanded.call.join("\n"));
		expect(expanded.call[0]).toBe("subagent_query #7 · 5s");
		expect(expanded.call[1]).toBe("--- Question ---");
		expect(expanded.call).toContain("--- Answer ---");
		expect(expandedText).toContain("Final question detail.");
		expect(expandedText).toContain("Saved detail.");
		expect(expanded.result).toEqual([]);
		for (const line of [...collapsed.call, ...expanded.call]) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(64);
		}
	});

	test("renders structured errors as text only in collapsed and expanded views", () => {
		// Purpose: Subagent and Pi validation failures must never expose internal error codes.
		// Input and expected output: start failure preserves available call identity and renders only Error text in both expansion states.
		// Edge case: expanded error wraps fully instead of being formatted as Markdown.
		// Dependencies: failed tool details supplied by the public tool_result hook.
		const args = {
			agentId: "SubAgentCoder",
			taskName: "Fail visibly",
			prompt: "Attempt launch",
		};
		const errorResult: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "validation wrapper" }],
			details: { code: "agent_unavailable", message: "agent is unavailable" },
		};
		const collapsed = renderTool({
			name: "subagent_start",
			args,
			result: errorResult,
			isError: true,
		});
		const marked = renderTool({
			name: "subagent_start",
			args,
			result: errorResult,
			isError: true,
			theme: MARKED_THEME,
		});
		const expanded = renderTool({
			name: "subagent_start",
			args,
			result: errorResult,
			isError: true,
			expanded: true,
		});

		expect(collapsed.result.join("\n")).toContain(
			"Error: agent is unavailable",
		);
		expect(marked.result.join("\n")).toContain("<error>");
		expect(collapsed.result.join("\n")).not.toContain("agent_unavailable");
		expect(expanded.result.map((line) => line.trimEnd())).toEqual([
			"Error: agent is unavailable",
		]);
	});

	test("normalizes only collapsed subagent error text", () => {
		// Purpose: subagent errors must compact layout whitespace only while the tool remains collapsed.
		// Input and expected output: a multiline semantic error becomes one spaced preview and remains multiline when expanded.
		// Edge case: duplicate spaces after a tab remain observable only in the expanded view.
		// Dependencies: the public subagent result renderer reads the structured error message from tool details.
		const args = {
			agentId: "SubAgentCoder",
			taskName: "Fail visibly",
			prompt: "Attempt launch",
		};
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "validation wrapper" }],
			details: {
				code: "agent_unavailable",
				message: "first\n\tsecond  third",
			},
		};

		const collapsed = renderTool({
			name: "subagent_start",
			args,
			result,
			isError: true,
		});
		const expanded = renderTool({
			name: "subagent_start",
			args,
			result,
			isError: true,
			expanded: true,
		});

		expect(collapsed.result.map((line) => line.trimEnd())).toEqual([
			"Error: first second third",
		]);
		expect(expanded.result.map((line) => line.trimEnd())).toEqual([
			"Error: first",
			"\tsecond  third",
		]);
	});
});
