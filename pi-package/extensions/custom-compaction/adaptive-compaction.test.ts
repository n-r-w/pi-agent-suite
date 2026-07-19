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
	type AdaptiveCompactionRequest,
	adaptiveCompactHistory,
} from "./adaptive-compaction";

/** Detects useful whitespace inside serialized fragment text. */
const WHITESPACE_PATTERN = /\s/;

/** Creates one context-visible user message for deterministic summary-source fixtures. */
function userMessage(text: string, timestamp = 0): AgentMessage {
	return { role: "user", content: text, timestamp };
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
	readonly requests: AdaptiveCompactionRequest[];
} {
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
		complete: async (request) => {
			requests.push(request);
			return response("final-summary");
		},
		...overrides,
	};
	return { options, requests };
}

describe("adaptiveCompactHistory", () => {
	/** Proves direct compaction preserves Pi's three-part source order and skips reductions. */
	test("uses one final request when the ordered source fits", async () => {
		// ARRANGE: The default fixture leaves ample space in both model windows.
		const { options, requests } = createOptions();

		// ACT: Compact the Pi preparation source.
		const summary = await adaptiveCompactHistory(options);

		// ASSERT: Only the final result escapes and its request preserves chronological source order.
		expect(summary).toBe("final-summary");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.operation).toBe("final");
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
	});

	/** Proves adaptive ranges consume the largest fitting original prefix without recursive summary input. */
	test("summarizes original ranges oldest-first and stops when final input first fits", async () => {
		// ARRANGE: Twenty original blocks need preliminary ranges and hierarchical node consolidation.
		const preliminarySources: string[] = [];
		let preliminaryCount = 0;
		const { options, requests } = createOptions({
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
	});

	/** Proves one oversized serialized block uses ordered fragments with stable block identity. */
	test("splits one oversized block at useful boundaries and preserves fragment order", async () => {
		// ARRANGE: Paragraph-rich input cannot fit as one reduction request.
		let fragmentNumber = 0;
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
		const { options, requests } = createOptions({
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
	});

	/** Proves response defects use the configured retry count and one logical request ID. */
	test("retries empty and output-limit responses without accepting partial results", async () => {
		// ARRANGE: Two defective final responses precede one complete response.
		let attempt = 0;
		const { options, requests } = createOptions({
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
		let overlapped = false;
		const { options } = createOptions({
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

	/** Proves the common bounded-node budget is mandatory even when direct source text is small. */
	test("fails before model requests when the summarization model has no common node budget", async () => {
		// ARRANGE: Request framing and safety margin leave no room for bounded reduction nodes.
		const { options, requests } = createOptions({
			summarizationModel: {
				id: "gpt-5",
				provider: "openai",
				contextWindow: 300,
				maxTokens: 128,
			},
			safetyMarginTokens: 64,
		});

		// ACT and ASSERT: Node-budget validation fails before the otherwise direct completion.
		await expect(adaptiveCompactHistory(options)).rejects.toThrow(
			"common summary-node budget",
		);
		expect(requests).toHaveLength(0);
	});
});
