import { describe, expect, test } from "bun:test";

import mermaidExtension from "./index.js";
import type { MermaidRenderClient } from "./render-client.js";
import type { MermaidRenderOperationResult } from "./types.js";

/** Complete Mermaid source used by orchestration behavior tests. */
const MERMAID_TEXT = "```mermaid\nflowchart TD\nA --> B\n```";
/** Exact generic failure guidance sent to the model. */
const MODEL_FAILURE_MESSAGE =
	"Mermaid rendering failed. Please simplify the diagram. Supported types: flowchart, state, sequence, class, er, xychart.";

interface ExtensionHarness {
	appendedEntries: Array<{ customType: string; data: unknown }>;
	disposeCalls: number;
	renderCalls: number;
	runBeforeAgentStart: (systemPrompt: string) => unknown;
	sentMessages: Array<{ message: unknown; options: unknown }>;
	shutdownHandler: () => void;
	turnEndHandler: (event: unknown, ctx: unknown) => Promise<void>;
}

/** Captures extension registrations and Pi side effects with an injected renderer. */
function createHarness(result: MermaidRenderOperationResult): ExtensionHarness {
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const sentMessages: Array<{ message: unknown; options: unknown }> = [];
	const handlers = new Map<string, (...args: never[]) => unknown>();
	let renderCalls = 0;
	let disposeCalls = 0;
	const renderClient: MermaidRenderClient = {
		dispose: () => {
			disposeCalls += 1;
		},
		render: async () => {
			renderCalls += 1;
			return result;
		},
	};
	const pi = {
		appendEntry: (customType: string, data: unknown) => {
			appendedEntries.push({ customType, data });
		},
		on: (event: string, handler: (...args: never[]) => unknown) => {
			handlers.set(event, handler);
		},
		registerEntryRenderer: () => {},
		sendMessage: (message: unknown, options: unknown) => {
			sentMessages.push({ message, options });
		},
	};
	mermaidExtension(pi as never, { renderClient });
	const turnEndHandler = handlers.get("turn_end");
	const shutdownHandler = handlers.get("session_shutdown");
	if (turnEndHandler === undefined || shutdownHandler === undefined) {
		throw new Error("Mermaid extension did not register its required handlers");
	}
	return {
		appendedEntries,
		get disposeCalls() {
			return disposeCalls;
		},
		get renderCalls() {
			return renderCalls;
		},
		runBeforeAgentStart: (systemPrompt) => {
			const handler = handlers.get("before_agent_start");
			if (handler === undefined) {
				throw new Error("Mermaid extension did not register prompt guidance");
			}
			return handler({ systemPrompt } as never);
		},
		sentMessages,
		shutdownHandler: shutdownHandler as () => void,
		turnEndHandler: turnEndHandler as (
			event: unknown,
			ctx: unknown,
		) => Promise<void>,
	};
}

/** Creates one finalized assistant turn event. */
function assistantEvent(text = MERMAID_TEXT, stopReason = "stop"): unknown {
	return {
		type: "turn_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason,
		},
	};
}

/** Creates the TUI event context used by automatic rendering. */
function tuiContext(): unknown {
	return { mode: "tui", signal: new AbortController().signal };
}

/** Covers extension orchestration and context isolation. */
describe("Mermaid extension", () => {
	/** Adds model guidance through the per-turn system-prompt hook only. */
	test("adds per-turn Mermaid model guidance", () => {
		// Arrange
		const harness = createHarness({ status: "completed", results: [] });
		const originalPrompt = "Base system prompt";

		// Act
		const result = harness.runBeforeAgentStart(originalPrompt);

		// Assert
		expect(result).toEqual({ systemPrompt: expect.any(String) });
		expect((result as { systemPrompt: string }).systemPrompt).not.toBe(
			originalPrompt,
		);
	});

	/** Persists successful previews without adding model context. */
	test("automatically persists successful TUI previews", async () => {
		// Arrange
		const harness = createHarness({
			status: "completed",
			results: [
				{
					status: "rendered",
					compatibilityWarnings: [],
					sourceHash: "placeholder",
					variants: {
						default: { text: "A --> B", maxLineWidth: 7 },
						tight: { text: "A-->B", maxLineWidth: 5 },
					},
				},
			],
		});

		// Act
		await harness.turnEndHandler(assistantEvent(), tuiContext());

		// Assert
		expect(harness.renderCalls).toBe(1);
		expect(harness.appendedEntries).toEqual([
			{
				customType: "mermaid-render",
				data: {
					status: "rendered",
					variants: {
						default: { text: "A --> B", maxLineWidth: 7 },
						tight: { text: "A-->B", maxLineWidth: 5 },
					},
				},
			},
		]);
		expect(harness.sentMessages).toEqual([]);
	});

	/** Skips automatic work outside TUI and for incomplete assistant outcomes. */
	test("gates automatic rendering to final TUI assistant turns", async () => {
		// Arrange
		const harness = createHarness({ status: "completed", results: [] });

		// Act
		await harness.turnEndHandler(assistantEvent(), { mode: "rpc" });
		await harness.turnEndHandler(
			assistantEvent(MERMAID_TEXT, "toolUse"),
			tuiContext(),
		);
		await harness.turnEndHandler(
			{ message: { role: "user", content: "text" } },
			tuiContext(),
		);

		// Assert
		expect(harness.renderCalls).toBe(0);
		expect(harness.appendedEntries).toEqual([]);
	});

	/** Persists known warnings and queues one compact next-turn diagnostic. */
	test("queues warning diagnostics without source or ASCII output", async () => {
		// Arrange
		const warningText = "```mermaid\nflowchart TD\nA --o B\n```";
		const harness = createHarness({
			status: "completed",
			results: [
				{
					status: "rendered",
					compatibilityWarnings: ["circle_edge_omission"],
					sourceHash: "placeholder",
					variants: {
						default: { text: "ASCII OUTPUT", maxLineWidth: 12 },
						tight: { text: "ASCII", maxLineWidth: 5 },
					},
				},
			],
		});

		// Act
		await harness.turnEndHandler(assistantEvent(warningText), tuiContext());

		// Assert
		expect(harness.appendedEntries[0]).toEqual({
			customType: "mermaid-render",
			data: {
				status: "warning",
				variants: {
					default: { text: "ASCII OUTPUT", maxLineWidth: 12 },
					tight: { text: "ASCII", maxLineWidth: 5 },
				},
				warnings: [
					{
						code: "circle_edge_omission",
						explanation:
							'The renderer can omit the target node or edge for "--o".',
					},
				],
			},
		});
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]).toMatchObject({
			message: {
				content: 'The renderer can omit the target node or edge for "--o".',
				customType: "mermaid-render-diagnostic",
				display: false,
			},
			options: { deliverAs: "nextTurn" },
		});
		const diagnosticPayload = JSON.stringify(harness.sentMessages[0]);
		expect(diagnosticPayload).not.toContain(warningText);
		expect(diagnosticPayload).not.toContain("ASCII OUTPUT");
	});

	/** Sends each unique warning explanation once across multiple blocks. */
	test("deduplicates individual warning explanations", async () => {
		// Arrange
		const text = [
			"```mermaid\nflowchart TD\nA[🚀] --o B\n```",
			"```mermaid\nflowchart TD\nC --o D\n```",
		].join("\n");
		const variants = {
			default: { text: "ASCII", maxLineWidth: 5 },
			tight: { text: "ASCII", maxLineWidth: 5 },
		};
		const harness = createHarness({
			status: "completed",
			results: [
				{
					status: "rendered",
					compatibilityWarnings: ["circle_edge_omission"],
					sourceHash: "first",
					variants,
				},
				{
					status: "rendered",
					compatibilityWarnings: ["circle_edge_omission"],
					sourceHash: "second",
					variants,
				},
			],
		});

		// Act
		await harness.turnEndHandler(assistantEvent(text), tuiContext());

		// Assert
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]).toMatchObject({
			message: {
				content: [
					'The renderer can omit the target node or edge for "--o".',
					"CJK or emoji labels can be misaligned in the ASCII preview.",
				].join("\n"),
			},
		});
	});

	/** Persists unsupported types without starting the isolated renderer. */
	test("records preflight failures before worker execution", async () => {
		// Arrange
		const harness = createHarness({ status: "completed", results: [] });
		const unsupportedText = "```mermaid\ngantt\ntitle Plan\n```";

		// Act
		await harness.turnEndHandler(assistantEvent(unsupportedText), tuiContext());

		// Assert
		expect(harness.renderCalls).toBe(0);
		expect(harness.appendedEntries[0]).toEqual({
			customType: "mermaid-render",
			data: {
				status: "failed",
				explanation: "Unsupported Mermaid diagram type",
			},
		});
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]).toMatchObject({
			message: { content: MODEL_FAILURE_MESSAGE },
		});
	});

	/** Collapses repeated failures into one generic model diagnostic. */
	test("collapses repeated failures without block identity", async () => {
		// Arrange
		const harness = createHarness({ status: "completed", results: [] });
		const unsupportedText = [
			"```mermaid\ngantt\ntitle First\n```",
			"```mermaid\npie\ntitle Second\n```",
		].join("\n");

		// Act
		await harness.turnEndHandler(assistantEvent(unsupportedText), tuiContext());

		// Assert
		expect(harness.appendedEntries).toHaveLength(2);
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]).toMatchObject({
			message: { content: MODEL_FAILURE_MESSAGE },
		});
		const payload = JSON.stringify(harness.sentMessages[0]);
		expect(payload).not.toContain("Block 1");
		expect(payload).not.toContain("unsupported_type");
		expect(payload).not.toContain("title First");
	});

	/** Keeps warning explanations distinct beside one generic failure. */
	test("combines generic failures with distinct warning explanations", async () => {
		// Arrange
		const text = [
			"```mermaid\nflowchart TD\nA --o B\n```",
			"```mermaid\ngantt\ntitle Plan\n```",
		].join("\n");
		const harness = createHarness({
			status: "completed",
			results: [
				{
					status: "rendered",
					compatibilityWarnings: ["circle_edge_omission"],
					sourceHash: "placeholder",
					variants: {
						default: { text: "ASCII OUTPUT", maxLineWidth: 12 },
						tight: { text: "ASCII", maxLineWidth: 5 },
					},
				},
			],
		});

		// Act
		await harness.turnEndHandler(assistantEvent(text), tuiContext());

		// Assert
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]).toMatchObject({
			message: {
				content: [
					MODEL_FAILURE_MESSAGE,
					'The renderer can omit the target node or edge for "--o".',
				].join("\n"),
			},
		});
		const payload = JSON.stringify(harness.sentMessages[0]);
		expect(payload).not.toContain("Block 1");
		expect(payload).not.toContain("unsupported_type");
		expect(payload).not.toContain("ASCII OUTPUT");
	});

	/** Keeps maximum-length unsupported tokens out of next-turn model context. */
	test("bounds unsupported type diagnostics", async () => {
		// Arrange
		const unsupportedToken = "x".repeat(20_000);
		const harness = createHarness({ status: "completed", results: [] });

		// Act
		await harness.turnEndHandler(
			assistantEvent(`\`\`\`mermaid\n${unsupportedToken}\n\`\`\``),
			tuiContext(),
		);

		// Assert
		const persistedPayload = JSON.stringify(harness.appendedEntries);
		const diagnosticPayload = JSON.stringify(harness.sentMessages);
		expect(persistedPayload.length).toBeLessThan(1_000);
		expect(diagnosticPayload.length).toBeLessThan(1_000);
		expect(persistedPayload).not.toContain(unsupportedToken);
		expect(diagnosticPayload).not.toContain(unsupportedToken);
	});

	/** Converts renderer failures into durable entries and model diagnostics. */
	test("records finite renderer failures", async () => {
		// Arrange
		const harness = createHarness({
			status: "completed",
			results: [
				{
					status: "failed",
					sourceHash: "placeholder",
					diagnosticCode: "render_timeout",
					explanation: "The renderer timed out.",
				},
			],
		});

		// Act
		await harness.turnEndHandler(assistantEvent(), tuiContext());

		// Assert
		expect(harness.appendedEntries[0]).toEqual({
			customType: "mermaid-render",
			data: { status: "failed", explanation: "The renderer timed out." },
		});
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]).toMatchObject({
			message: { content: MODEL_FAILURE_MESSAGE },
		});
		const payload = JSON.stringify(harness.sentMessages[0]);
		expect(payload).not.toContain("render_timeout");
		expect(payload).not.toContain("timed out");
	});

	/** Discards all staged effects when the user aborts worker rendering. */
	test("creates no entry or diagnostic after abort", async () => {
		// Arrange
		const harness = createHarness({ status: "aborted" });

		// Act
		await harness.turnEndHandler(assistantEvent(), tuiContext());

		// Assert
		expect(harness.appendedEntries).toEqual([]);
		expect(harness.sentMessages).toEqual([]);
	});

	/** Disposes active worker processes during session shutdown. */
	test("disposes the renderer on session shutdown", () => {
		// Arrange
		const harness = createHarness({ status: "completed", results: [] });

		// Act
		harness.shutdownHandler();

		// Assert
		expect(harness.disposeCalls).toBe(1);
	});
});
