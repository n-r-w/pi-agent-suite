import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	estimateTextTokens,
	takeTextTokenPrefix,
} from "../../shared/context-size";
import {
	type AdaptiveCompactionOptions,
	type AdaptiveCompactionProgressEvent,
	type AdaptiveCompactionRequest,
	adaptiveCompactHistory,
} from "./adaptive-compaction";

/** Detects useful whitespace inside serialized fragment text. */
const WHITESPACE_PATTERN = /\s/;

/** Creates one context-visible user message for deterministic summary-source fixtures. */
function userMessage(text: string, timestamp = 0): AgentMessage {
	return { role: "user", content: text, timestamp };
}

/** Creates one successful text tool result for summary-source projection tests. */
function toolResultMessage(
	toolCallId: string,
	text: string,
	timestamp: number,
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

/** Creates a successful Pi assistant response without model, auth, or network access. */
function response(
	text: string,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content: text.length === 0 ? [] : [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}

/** Reads the single text message emitted by one engine request. */
function requestText(request: AdaptiveCompactionRequest): string {
	const message = request.context.messages[0];
	if (message?.role !== "user") {
		throw new Error("expected one user request message");
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** Builds an isolated engine fixture with deterministic completion and request IDs. */
function createOptions(overrides: Partial<AdaptiveCompactionOptions> = {}): {
	readonly options: AdaptiveCompactionOptions;
	readonly progressEvents: AdaptiveCompactionProgressEvent[];
	readonly requests: AdaptiveCompactionRequest[];
} {
	const progressEvents: AdaptiveCompactionProgressEvent[] = [];
	const requests: AdaptiveCompactionRequest[] = [];
	let requestId = 0;
	const options: AdaptiveCompactionOptions = {
		preparation: {
			previousSummary: "previous-summary",
			messagesToSummarize: [userMessage("history-message", 1)],
			turnPrefixMessages: [userMessage("turn-prefix-message", 2)],
			tokensBefore: 5_000,
		},
		summarySystemPrompt: "SUMMARY_SYSTEM",
		reductionSystemPrompt: "REDUCTION_SYSTEM",
		finalPrompt: "FINAL_PROMPT",
		reductionPrompt: "REDUCTION_PROMPT",
		summarizationModel: {
			id: "gpt-5",
			provider: "openai",
			contextWindow: 4_096,
			maxTokens: 512,
		},
		mainModel: {
			id: "gpt-5",
			provider: "openai",
			contextWindow: 8_192,
			maxTokens: 512,
		},
		currentProjectedMainMessages: [userMessage("x".repeat(6_000))],
		projectedRetainedMessages: [userMessage("retained-message")],
		projectedToolResultSummaries: new Map(),
		finalSummarySuffix: "",
		mainSystemPrompt: "MAIN_SYSTEM",
		activeTools: [],
		mainModelReserveTokens: 512,
		safetyMarginTokens: 32,
		retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
		signal: new AbortController().signal,
		createRequestId: () => {
			requestId += 1;
			return `request-${requestId}`;
		},
		onProgress: (event) => {
			progressEvents.push(event);
		},
		complete: async (request) => {
			requests.push(request);
			return response("final-summary");
		},
		...overrides,
	};
	return { options, progressEvents, requests };
}

/** Verifies that final and intermediate requests use their assigned prompt pair. */
function expectPromptRouting(
	requests: readonly AdaptiveCompactionRequest[],
): void {
	for (const request of requests) {
		const isFinal = request.operation === "final";
		expect(request.context.systemPrompt).toBe(
			isFinal ? "SUMMARY_SYSTEM" : "REDUCTION_SYSTEM",
		);
		expect(requestText(request)).toContain(
			isFinal ? "FINAL_PROMPT" : "REDUCTION_PROMPT",
		);
	}
}

describe("adaptiveCompactHistory", () => {
	/** Proves planning cannot start until asynchronous start progress delivery completes. */
	test("awaits start progress before token budgeting", async () => {
		// Purpose: the engine must let an injected progress consumer finish before synchronous planning.
		// Input and expected output: a blocked start handler keeps a known budget failure unsettled until released.
		// Edge case: the budget is invalid, so any early planning would reject immediately without a model request.
		// Dependencies: an in-memory progress gate and the deterministic final-budget validation path.
		let releaseStart: (() => void) | undefined;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const { options, requests } = createOptions({
			currentProjectedMainMessages: [userMessage("current")],
			projectedRetainedMessages: [userMessage("retained ".repeat(500))],
			mainModel: {
				id: "gpt-5",
				provider: "openai",
				contextWindow: 1_000,
				maxTokens: 128,
			},
			mainModelReserveTokens: 512,
			safetyMarginTokens: 64,
			onProgress: (event) => (event.type === "start" ? startGate : undefined),
		});
		let settled = false;

		// ACT: Start compaction while progress delivery remains blocked.
		const compaction = adaptiveCompactHistory(options);
		const settlement = compaction.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await Promise.resolve();

		// ASSERT: Planning remains pending until the handler releases the start event.
		expect(settled).toBeFalse();
		expect(requests).toHaveLength(0);
		if (releaseStart === undefined) {
			throw new Error("expected the start progress handler to run");
		}
		releaseStart();
		await expect(compaction).rejects.toThrow("final summary budget");
		await settlement;
	});

	/** Proves direct compaction preserves Pi's three-part source order and skips reductions. */
	test("uses full projection summaries and keeps Pi truncation for other tool results", async () => {
		// Purpose: projection summaries must replace arbitrary tool-result prefixes in the durable summary source.
		// Input and expected output: one projected result keeps its tail while one unprojected result loses its tail through Pi serialization.
		// Edge case: the projection summary exceeds Pi's 2,000-character tool-result cap.
		// Dependencies: injected projection map and completion request capture.
		const projectedTail = "PROJECTED_SUMMARY_TAIL";
		const rawProjectedTail = "RAW_PROJECTED_TAIL";
		const unprojectedTail = "UNPROJECTED_RAW_TAIL";
		const projectionSummary = `${"projected ".repeat(300)}${projectedTail}`;
		const projectedRaw = `${"raw projected ".repeat(300)}${rawProjectedTail}`;
		const unprojectedRaw = `${"raw unprojected ".repeat(300)}${unprojectedTail}`;
		const { options, requests } = createOptions({
			preparation: {
				messagesToSummarize: [
					userMessage("inspect results", 1),
					toolResultMessage("projected-call", projectedRaw, 2),
					toolResultMessage("unprojected-call", unprojectedRaw, 3),
				],
				turnPrefixMessages: [],
				tokensBefore: 5_000,
			},
			projectedToolResultSummaries: new Map([
				["projected-call", projectionSummary],
			]),
			summarizationModel: {
				id: "gpt-5",
				provider: "openai",
				contextWindow: 16_384,
				maxTokens: 512,
			},
		});

		await adaptiveCompactHistory(options);

		const finalRequest = requests.at(-1);
		expect(finalRequest).toBeDefined();
		const text = requestText(finalRequest as AdaptiveCompactionRequest);
		expect(text).toContain(projectedTail);
		expect(text).not.toContain(rawProjectedTail);
		expect(text).not.toContain(unprojectedTail);
	});

	test("uses one final request when the ordered source fits", async () => {
		// ARRANGE: The default fixture leaves ample space in both model windows.
		const { options, progressEvents, requests } = createOptions();

		// ACT: Compact the Pi preparation source.
		const summary = await adaptiveCompactHistory(options);

		// ASSERT: Only the final result escapes and its request preserves chronological source order.
		expect(summary).toBe("final-summary");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.operation).toBe("final");
		expectPromptRouting(requests);
		const text = requestText(requests[0] as AdaptiveCompactionRequest);
		expect(text).toContain("<previous-summary>\nprevious-summary");
		expect(text).toContain("[User]: history-message");
		expect(text).toContain("[User]: turn-prefix-message");
		expect(text.indexOf("previous-summary")).toBeLessThan(
			text.indexOf("history-message"),
		);
		expect(text.indexOf("history-message")).toBeLessThan(
			text.indexOf("turn-prefix-message"),
		);
		expect(progressEvents).toEqual([
			{ type: "start" },
			{ type: "operation", operation: "final" },
			{ type: "complete", completedRequests: 1 },
		]);
	});

	/** Proves adaptive ranges consume the largest fitting original prefix without recursive summary input. */
	test("summarizes original ranges oldest-first and stops when final input first fits", async () => {
		// ARRANGE: Twenty original blocks need preliminary ranges and hierarchical node consolidation.
		const preliminarySources: string[] = [];
		let preliminaryCount = 0;
		const { options, progressEvents, requests } = createOptions({
			preparation: {
				messagesToSummarize: Array.from({ length: 20 }, (_, index) =>
					userMessage(`BLOCK_${index}_${"old ".repeat(170)}`, index),
				),
				turnPrefixMessages: [],
				tokensBefore: 10_000,
			},
			summarizationModel: {
				id: "gpt-5",
				provider: "openai",
				contextWindow: 1_050,
				maxTokens: 96,
			},
			complete: async (request) => {
				requests.push(request);
				if (request.operation === "preliminary") {
					preliminarySources.push(requestText(request));
					preliminaryCount += 1;
					return response(
						`INTERMEDIATE_${preliminaryCount}_${"compressed ".repeat(70)}`,
					);
				}
				return response("adaptive-final");
			},
		});

		// ACT: Compact until the final request becomes admissible.
		const summary = await adaptiveCompactHistory(options);

		// ASSERT: Ranges are original-only, chronological, and processing stops before all blocks need summaries.
		expect(summary).toBe("adaptive-final");
		expect(preliminarySources.length).toBeGreaterThanOrEqual(2);
		expect(preliminarySources[0]).toContain("BLOCK_0_");
		expect(preliminarySources[1]).not.toContain("INTERMEDIATE_1");
		expect(preliminarySources[1]).toContain("BLOCK_");
		const preliminaryIndexes = requests.flatMap((request, index) =>
			request.operation === "preliminary" ? [index] : [],
		);
		expect(preliminaryIndexes.length).toBeGreaterThanOrEqual(3);
		const secondPreliminaryIndex = preliminaryIndexes[1] as number;
		const thirdPreliminaryIndex = preliminaryIndexes[2] as number;
		expect(
			requests
				.slice(secondPreliminaryIndex + 1, thirdPreliminaryIndex)
				.some((request) => request.operation === "merge"),
		).toBeTrue();
		expect(requests.at(-1)?.operation).toBe("final");
		expectPromptRouting(requests);
		const operationEvents = progressEvents.filter(
			(event) => event.type === "operation",
		);
		expect(new Set(operationEvents.map((event) => event.operation))).toEqual(
			new Set(["preliminary", "merge", "final"]),
		);
		expect(progressEvents.at(-1)).toEqual({
			type: "complete",
			completedRequests: operationEvents.length,
		});
	});

	/** Proves one oversized serialized block uses ordered fragments with stable block identity. */
	test("splits one oversized block at useful boundaries and preserves fragment order", async () => {
		// ARRANGE: Paragraph-rich input cannot fit as one reduction request.
		let fragmentNumber = 0;
		let progressDeliveryActive = false;
		let progressDeliveryOverlapped = false;
		const deliveredProgressEvents: AdaptiveCompactionProgressEvent[] = [];
		const { options, requests } = createOptions({
			preparation: {
				messagesToSummarize: [
					userMessage(
						Array.from(
							{ length: 40 },
							(_, index) => `PARAGRAPH_${index} ${"detail ".repeat(80)}`,
						).join("\n\n"),
					),
				],
				turnPrefixMessages: [],
				tokensBefore: 20_000,
			},
			summarizationModel: {
				id: "gpt-5",
				provider: "openai",
				contextWindow: 900,
				maxTokens: 80,
			},
			onProgress: async (event) => {
				deliveredProgressEvents.push(event);
				if (event.type !== "operation" || event.operation !== "fragment") {
					return;
				}
				if (progressDeliveryActive) {
					progressDeliveryOverlapped = true;
				}
				progressDeliveryActive = true;
				await Promise.resolve();
				progressDeliveryActive = false;
			},
			complete: async (request) => {
				requests.push(request);
				if (request.operation === "fragment") {
					fragmentNumber += 1;
					return response(
						`FRAGMENT_SUMMARY_${fragmentNumber}_${"summary ".repeat(40)}`,
					);
				}
				if (request.operation === "merge") {
					return response(`MERGED_FRAGMENT_SUMMARY_${"summary ".repeat(30)}`);
				}
				return response("fragment-final");
			},
		});

		// ACT: Compact the oversized block.
		const summary = await adaptiveCompactHistory(options);

		// ASSERT: Multiple fragments retain one block ID and increasing part markers.
		expect(summary).toBe("fragment-final");
		const fragmentRequests = requests.filter(
			(request) => request.operation === "fragment",
		);
		expect(fragmentRequests.length).toBeGreaterThan(1);
		for (const [index, request] of fragmentRequests.entries()) {
			const text = requestText(request);
			expect(text).toContain('block-id="messagesToSummarize:0"');
			expect(text).toContain(`part="${index + 1}/`);
			if (index < fragmentRequests.length - 1) {
				const fragmentEnd = text.indexOf("\n</source-fragment>");
				expect(text.slice(0, fragmentEnd)).toEndWith("\n\n");
			}
		}
		const paragraphOrder = fragmentRequests.flatMap((request) =>
			Array.from(requestText(request).matchAll(/PARAGRAPH_(\d+)/g), (match) =>
				Number(match[1]),
			),
		);
		expect(paragraphOrder).toEqual(
			Array.from({ length: 40 }, (_, index) => index),
		);
		const mergeRequests = requests.filter(
			(request) => request.operation === "merge",
		);
		expect(mergeRequests.length).toBeGreaterThan(0);
		const firstMergeText = requestText(
			mergeRequests[0] as AdaptiveCompactionRequest,
		);
		expect(firstMergeText.indexOf(":fragment:1")).toBeLessThan(
			firstMergeText.indexOf(":fragment:2"),
		);
		expect(new Set(requests.map((request) => request.requestId)).size).toBe(
			requests.length,
		);
		expect(deliveredProgressEvents).toContainEqual({
			type: "split",
			fragments: fragmentRequests.length,
		});
		expect(
			deliveredProgressEvents.filter(
				(event) => event.type === "operation" && event.operation === "fragment",
			),
		).toEqual(
			fragmentRequests.map((_, index) => ({
				type: "operation",
				operation: "fragment",
				fragmentIndex: index + 1,
				totalFragments: fragmentRequests.length,
			})),
		);
		expect(progressDeliveryOverlapped).toBeFalse();
		expectPromptRouting(requests);
	});

	/** Proves dense oversized text falls back to selected-model token prefixes. */
	test("uses token boundaries when an oversized block has no useful text boundary", async () => {
		// ARRANGE: After Pi's role prefix, the serialized block is one dense unbroken token stream.
		const denseText = "界".repeat(600);
		const { options, requests } = createOptions({
			preparation: {
				messagesToSummarize: [userMessage(denseText)],
				turnPrefixMessages: [],
				tokensBefore: 20_000,
			},
			summarizationModel: {
				id: "gpt-5",
				provider: "openai",
				contextWindow: 900,
				maxTokens: 80,
			},
			complete: async (request) => {
				requests.push(request);
				if (request.operation === "merge") {
					return response("merged");
				}
				return response(
					request.operation === "final" ? "dense-final" : "fragment-summary",
				);
			},
		});

		// ACT: Compact the dense block through fragment fallback.
		const summary = await adaptiveCompactHistory(options);

		// ASSERT: Every dense fragment is the exact selected-tokenizer prefix of its remainder.
		expect(summary).toBe("dense-final");
		const fragmentTexts = requests
			.filter((request) => request.operation === "fragment")
			.map((request) => {
				const text = requestText(request);
				const start = text.indexOf(">\n") + 2;
				const end = text.indexOf("\n</source-fragment>");
				return text.slice(start, end);
			});
		let remaining = `[User]: ${denseText}`;
		for (const fragment of fragmentTexts) {
			if (!WHITESPACE_PATTERN.test(fragment.trim())) {
				const tokenCount = estimateTextTokens(fragment, "gpt-5", "openai");
				expect(
					takeTextTokenPrefix(remaining, tokenCount, "gpt-5", "openai"),
				).toBe(fragment);
			}
			remaining = remaining.slice(fragment.length);
		}
		expect(remaining).toBe("");
	});

	/** Proves hierarchical merges reject non-reducing output through the configured retry policy. */
	test("retries non-reducing adjacent merges without accepting a partial tree", async () => {
		// ARRANGE: Many ranges become small nodes, but merge responses are larger than each adjacent pair.
		const { options, requests } = createOptions({
			preparation: {
				messagesToSummarize: Array.from({ length: 100 }, (_, index) =>
					userMessage(`RANGE_${index}_${"history ".repeat(100)}`),
				),
				turnPrefixMessages: [],
				tokensBefore: 40_000,
			},
			summarizationModel: {
				id: "gpt-5",
				provider: "openai",
				contextWindow: 900,
				maxTokens: 80,
			},
			complete: async (request) => {
				requests.push(request);
				if (request.operation === "preliminary") {
					return response(`NODE_${"summary ".repeat(8)}`);
				}
				if (request.operation === "merge") {
					return response("nonreducing ".repeat(20));
				}
				return response("unexpected-final");
			},
		});

		// ACT and ASSERT: The first invalid merge exhausts retries and no final result escapes.
		await expect(adaptiveCompactHistory(options)).rejects.toThrow(
			"merge summary is not smaller",
		);
		const mergeRequests = requests.filter(
			(request) => request.operation === "merge",
		);
		expect(mergeRequests).toHaveLength(3);
		expect(
			new Set(mergeRequests.map((request) => request.requestId)).size,
		).toBe(1);
		expect(
			requests.some((request) => request.operation === "final"),
		).toBeFalse();
	});

	/** Proves oversized previous summaries are bounded before original history reductions begin. */
	test("normalizes an oversized previous summary before original history", async () => {
		// ARRANGE: Previous summary and original history together exceed the final request window.
		const { options, progressEvents, requests } = createOptions({
			preparation: {
				previousSummary: `PREVIOUS_${"state ".repeat(360)}`,
				messagesToSummarize: [
					userMessage(`ORIGINAL_${"history ".repeat(500)}`),
				],
				turnPrefixMessages: [],
				tokensBefore: 12_000,
			},
			summarizationModel: {
				id: "gpt-5",
				provider: "openai",
				contextWindow: 1_100,
				maxTokens: 96,
			},
			complete: async (request) => {
				requests.push(request);
				if (request.operation === "normalization") {
					return response("NORMALIZED_PREVIOUS");
				}
				if (request.operation === "fragment") {
					return response("NORMALIZED_FRAGMENT");
				}
				if (request.operation === "preliminary") {
					return response("ORIGINAL_SUMMARY");
				}
				if (request.operation === "merge") {
					return response("MERGED_SUMMARY");
				}
				return response("normalized-final");
			},
		});

		// ACT: Compact with previous-summary normalization enabled by its size.
		const summary = await adaptiveCompactHistory(options);

		// ASSERT: Normalization or its fragment path precedes every original-history preliminary request.
		expect(summary).toBe("normalized-final");
		const firstReduction = requests.find(
			(request) => request.operation !== "final",
		);
		if (firstReduction === undefined) {
			throw new Error("expected previous-summary reduction");
		}
		expect(["fragment", "normalization"]).toContain(firstReduction.operation);
		const preliminaryIndex = requests.findIndex(
			(request) => request.operation === "preliminary",
		);
		const normalizationEndIndex = requests
			.map(
				(request) =>
					request.operation === "normalization" ||
					request.operation === "fragment",
			)
			.lastIndexOf(true);
		if (preliminaryIndex >= 0) {
			expect(normalizationEndIndex).toBeLessThan(preliminaryIndex);
		}
		expect(
			progressEvents.some(
				(event) =>
					event.type === "operation" && event.operation === "normalization",
			),
		).toBeTrue();
		expectPromptRouting(requests);
	});

	/** Proves response defects use the configured retry count and one logical request ID. */
	test("retries empty and output-limit responses without accepting partial results", async () => {
		// ARRANGE: Two defective final responses precede one complete response.
		let attempt = 0;
		const { options, progressEvents, requests } = createOptions({
			complete: async (request) => {
				requests.push(request);
				attempt += 1;
				if (attempt === 1) {
					return response("");
				}
				if (attempt === 2) {
					return response("partial", "length");
				}
				return response("complete-summary");
			},
		});

		// ACT: Run the final operation through the injected retry policy.
		const summary = await adaptiveCompactHistory(options);

		// ASSERT: Only the complete response is returned and retries share one isolated logical ID.
		expect(summary).toBe("complete-summary");
		expect(requests).toHaveLength(3);
		expect(new Set(requests.map((request) => request.requestId))).toEqual(
			new Set(["request-1"]),
		);
		expect(progressEvents).toEqual([
			{ type: "start" },
			{ type: "operation", operation: "final" },
			{
				type: "retry",
				operation: "final",
				nextAttempt: 2,
				totalAttempts: 3,
			},
			{
				type: "retry",
				operation: "final",
				nextAttempt: 3,
				totalAttempts: 3,
			},
			{ type: "complete", completedRequests: 1 },
		]);
	});

	/** Proves aborted completion responses stop immediately instead of consuming retry attempts. */
	test("does not retry an aborted model response", async () => {
		// ARRANGE: The completion boundary reports an aborted final operation.
		const { options, requests } = createOptions({
			complete: async (request) => {
				requests.push(request);
				return response("partial", "aborted");
			},
		});

		// ACT and ASSERT: Abort propagation uses one request and returns no partial summary.
		await expect(adaptiveCompactHistory(options)).rejects.toThrow("aborted");
		expect(requests).toHaveLength(1);
	});

	/** Proves a fragment retry waits for every request from the failed attempt to settle. */
	test("does not overlap fragment retry attempts", async () => {
		// ARRANGE: Fragment one fails immediately while sibling requests remain active briefly.
		const activeRequestIds = new Set<string>();
		const attemptByRequestId = new Map<string, number>();
		const fragmentRequestIds = new Set<string>();
		let overlapped = false;
		const { options, progressEvents } = createOptions({
			preparation: {
				messagesToSummarize: [
					userMessage(
						Array.from(
							{ length: 20 },
							(_, index) => `FRAGMENT_${index}_${"detail ".repeat(80)}`,
						).join("\n\n"),
					),
				],
				turnPrefixMessages: [],
				tokensBefore: 20_000,
			},
			summarizationModel: {
				id: "gpt-5",
				provider: "openai",
				contextWindow: 900,
				maxTokens: 80,
			},
			complete: async (request) => {
				if (request.operation === "fragment") {
					fragmentRequestIds.add(request.requestId);
				}
				const attempt = (attemptByRequestId.get(request.requestId) ?? 0) + 1;
				attemptByRequestId.set(request.requestId, attempt);
				if (activeRequestIds.has(request.requestId)) {
					overlapped = true;
				}
				activeRequestIds.add(request.requestId);
				const isFirstFragment = requestText(request).includes('part="1/');
				if (
					request.operation === "fragment" &&
					isFirstFragment &&
					attempt === 1
				) {
					activeRequestIds.delete(request.requestId);
					return response("");
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
				activeRequestIds.delete(request.requestId);
				if (request.operation === "merge") {
					return response("merged");
				}
				return response(
					request.operation === "final" ? "fragment-final" : "fragment-summary",
				);
			},
		});

		// ACT: Retry the failed fragment operation and finish compaction.
		const summary = await adaptiveCompactHistory(options);

		// ASSERT: No logical fragment request has two attempts active at once.
		expect(summary).toBe("fragment-final");
		expect(overlapped).toBeFalse();
		expect(
			progressEvents.filter(
				(event) => event.type === "operation" && event.operation === "fragment",
			),
		).toHaveLength(fragmentRequestIds.size);
		const fragmentRetryEvents = progressEvents.filter(
			(
				event,
			): event is Extract<
				AdaptiveCompactionProgressEvent,
				{ readonly type: "retry" }
			> => event.type === "retry" && event.operation === "fragment",
		);
		expect(fragmentRetryEvents).toHaveLength(fragmentRequestIds.size);
		expect(
			fragmentRetryEvents.every(
				(event) => event.nextAttempt === 2 && event.totalAttempts === 3,
			),
		).toBeTrue();
		const operationCount = progressEvents.filter(
			(event) => event.type === "operation",
		).length;
		expect(progressEvents.at(-1)).toEqual({
			type: "complete",
			completedRequests: operationCount,
		});
	});

	/** Proves actual final output is rechecked against the main request replacement limits. */
	test("retries and rejects a final summary that grows beyond its projected replacement", async () => {
		// ARRANGE: The fake ignores maxTokens and always returns a representation larger than the current request.
		const { options, requests } = createOptions({
			currentProjectedMainMessages: [
				userMessage(`current ${"representation ".repeat(80)}`),
			],
			projectedRetainedMessages: [],
			mainModelReserveTokens: 0,
			safetyMarginTokens: 0,
			complete: async (request) => {
				requests.push(request);
				return response("oversized ".repeat(2_000));
			},
		});

		// ACT and ASSERT: No oversized attempt becomes an accepted final summary.
		await expect(adaptiveCompactHistory(options)).rejects.toThrow(
			"final summary",
		);
		expect(requests).toHaveLength(3);
	});

	/** Proves deterministic file-operation tags reserve main-model space before completion. */
	test("includes the final summary suffix in prospective main-request budgeting", async () => {
		// Purpose: file-operation tags appended after completion must not bypass the next-request size invariant.
		// Input and expected output: a suffix larger than the remaining main window rejects before model requests.
		// Edge case: the same history fits when the suffix is empty in the direct-path test.
		// Dependencies: tokenizer-based prospective request estimation only.
		const { options, requests } = createOptions({
			finalSummarySuffix: `<previously_read_files>\n${"large/path.ts\n".repeat(2_000)}</previously_read_files>`,
		});

		await expect(adaptiveCompactHistory(options)).rejects.toThrow(
			"no positive final summary budget",
		);
		expect(requests).toHaveLength(0);
	});

	/** Proves the final budget includes complete main-request inputs and fails before completion. */
	test("fails before model requests when the complete prospective main request has no summary budget", async () => {
		// ARRANGE: Fixed retained input, system prompt, tools, reserve, and margin consume the main window.
		const activeTools: NonNullable<Context["tools"]> = [
			{
				name: "large_tool",
				description: "schema ".repeat(500),
				parameters: Type.Object({ value: Type.String() }),
			},
		];
		const { options, requests } = createOptions({
			currentProjectedMainMessages: [userMessage("current")],
			projectedRetainedMessages: [userMessage("retained ".repeat(500))],
			mainSystemPrompt: "system ".repeat(500),
			activeTools,
			mainModel: {
				id: "gpt-5",
				provider: "openai",
				contextWindow: 1_000,
				maxTokens: 128,
			},
			mainModelReserveTokens: 256,
			safetyMarginTokens: 64,
		});

		// ACT and ASSERT: Budget validation fails without invoking the injected model boundary.
		await expect(adaptiveCompactHistory(options)).rejects.toThrow(
			"final summary budget",
		);
		expect(requests).toHaveLength(0);
	});

	/** Proves direct summarization does not depend on hierarchical reduction feasibility. */
	test("skips the common node budget when the direct final request fits", async () => {
		// Purpose: direct compaction must not calculate or require a hierarchical summary-node budget.
		// Input and expected output: a direct-fit source completes once although merge framing leaves no positive node budget.
		// Edge case: oversized reduction framing makes the common-node invariants impossible.
		// Dependencies: deterministic request estimates and the injected completion fake only.
		const { options, requests } = createOptions({
			reductionPrompt: "reduction framing ".repeat(5_000),
		});

		// ACT: Compact through the complete direct final request.
		const summary = await adaptiveCompactHistory(options);

		// ASSERT: The direct request succeeds without entering hierarchical planning.
		expect(summary).toBe("final-summary");
		expect(requests.map((request) => request.operation)).toEqual(["final"]);
	});

	/** Proves adaptive work still requires a feasible common summary-node budget. */
	test("requires the common node budget when the direct final request does not fit", async () => {
		// Purpose: preliminary and hierarchical work must remain guarded by the shared node-size invariants.
		// Input and expected output: an oversized direct source with no feasible node budget fails before completion.
		// Edge case: final-summary budgeting remains positive while common-node feasibility is impossible.
		// Dependencies: deterministic request estimates; no model response or timing behavior is involved.
		const { options, requests } = createOptions({
			preparation: {
				messagesToSummarize: [userMessage("history ".repeat(500))],
				turnPrefixMessages: [],
				tokensBefore: 5_000,
			},
			summarizationModel: {
				id: "gpt-5",
				provider: "openai",
				contextWindow: 300,
				maxTokens: 128,
			},
			safetyMarginTokens: 64,
		});

		// ACT and ASSERT: Adaptive planning rejects the impossible common budget before any operation.
		await expect(adaptiveCompactHistory(options)).rejects.toThrow(
			"common summary-node budget",
		);
		expect(requests).toHaveLength(0);
	});
});
