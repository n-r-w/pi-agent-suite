import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
} from "@earendil-works/pi-ai";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { RetryConfig } from "../../shared/retry";
import {
	type CompactionBudgets,
	calculateCommonNodeBudget,
	calculateFinalSummaryBudget,
	doesFinalRequestFit,
	estimateProspectiveMainInput,
	type FinalSummaryBudget,
} from "./adaptive-compaction-budget";
import {
	countContiguousOriginals,
	executeSingleRequest,
	findAdjacentSummaryNodes,
	findLargestFittingOriginalPrefix,
	mergeSummaryNodes,
	normalizePreviousSummary,
	summarizeOversizedBlock,
	summarizeReducingSource,
} from "./adaptive-compaction-reduction";
import {
	buildSummaryContext,
	buildSummarySource,
	countSummaryTextTokens,
	type OriginalBlock,
	type SourceItem,
} from "./adaptive-compaction-source";

/** Logical model operation exposed to the injected completion boundary. */
export type AdaptiveCompactionOperation =
	| "final"
	| "fragment"
	| "merge"
	| "normalization"
	| "preliminary";

/** Progress emitted by the functional core without depending on Pi UI contracts. */
export type AdaptiveCompactionProgressEvent =
	| { readonly type: "start" }
	| { readonly type: "planning" }
	| {
			readonly type: "operation";
			readonly operation: AdaptiveCompactionOperation;
			readonly sourceBlocks?: number;
			readonly fragmentIndex?: number;
			readonly totalFragments?: number;
	  }
	| { readonly type: "split"; readonly fragments: number }
	| {
			readonly type: "retry";
			readonly operation: AdaptiveCompactionOperation;
			readonly nextAttempt: number;
			readonly totalAttempts: number;
	  }
	| { readonly type: "complete"; readonly completedRequests: number };

/** Completion request produced by the adaptive compaction functional core. */
export interface AdaptiveCompactionRequest {
	readonly operation: AdaptiveCompactionOperation;
	readonly context: Context;
	readonly maxTokens: number;
	readonly requestId: string;
	readonly signal: AbortSignal;
}

/** Model fields used for tokenizer selection and bounded request planning. */
export type AdaptiveCompactionModel = Pick<
	Model<Api>,
	"contextWindow" | "id" | "maxTokens" | "provider"
>;

/** Pi preparation fields consumed as the immutable chronological summary source. */
export type AdaptiveCompactionPreparation = Pick<
	SessionBeforeCompactEvent["preparation"],
	| "messagesToSummarize"
	| "previousSummary"
	| "tokensBefore"
	| "turnPrefixMessages"
>;

/** Complete input contract for the extension-local adaptive compaction engine. */
export interface AdaptiveCompactionOptions {
	readonly preparation: AdaptiveCompactionPreparation;
	/** System prompt for final summary requests. */
	readonly summarySystemPrompt: string;
	/** System prompt for intermediate reduction requests. */
	readonly reductionSystemPrompt: string;
	readonly finalPrompt: string;
	readonly reductionPrompt: string;
	readonly summarizationModel: AdaptiveCompactionModel;
	readonly mainModel: AdaptiveCompactionModel;
	readonly currentProjectedMainMessages: readonly AgentMessage[];
	readonly projectedRetainedMessages: readonly AgentMessage[];
	readonly projectedToolResultSummaries: ReadonlyMap<string, string>;
	readonly mainSystemPrompt: string;
	readonly activeTools: NonNullable<Context["tools"]>;
	readonly mainModelReserveTokens: number;
	readonly safetyMarginTokens: number;
	readonly retry: RetryConfig;
	readonly signal: AbortSignal;
	readonly createRequestId: () => string;
	readonly onProgress?: (
		event: AdaptiveCompactionProgressEvent,
	) => void | Promise<void>;
	/** Cooperative event-loop yield invoked by planning and reduction loops during heavy computation. */
	readonly onStep?: () => Promise<void>;
	readonly complete: (
		request: AdaptiveCompactionRequest,
	) => Promise<AssistantMessage>;
}

/** Produces only the durable summary; Pi lifecycle state remains owned by the caller. */
export async function adaptiveCompactHistory(
	options: AdaptiveCompactionOptions,
): Promise<string> {
	let logicalRequestCount = 0;
	const emitProgress = async (
		event: AdaptiveCompactionProgressEvent,
	): Promise<void> => {
		if (event.type === "operation") {
			logicalRequestCount += 1;
		}
		await options.onProgress?.(event);
	};
	const runtimeOptions: AdaptiveCompactionOptions = {
		...options,
		onProgress: emitProgress,
		onStep: options.onStep ?? createThrottledPlanningStep(options.signal),
	};
	await emitProgress({ type: "start" });
	validateOptions(runtimeOptions);
	const items = buildSummarySource(
		runtimeOptions.preparation,
		runtimeOptions.projectedToolResultSummaries,
	);
	if (items.length === 0) {
		throw new Error("adaptive compaction summary source is empty");
	}
	await emitProgress({ type: "planning" });
	const finalBudget = await calculateFinalSummaryBudget(runtimeOptions);

	// Direct final summarization is preferred because it avoids every lossy reduction step.
	let summary: string;
	if (
		await doesFinalRequestFit(
			items,
			finalBudget.finalSummaryTokens,
			runtimeOptions,
		)
	) {
		summary = await executeFinalSummary(items, finalBudget, runtimeOptions);
	} else {
		const budgets: CompactionBudgets = {
			...finalBudget,
			summaryNodeTokens: await calculateCommonNodeBudget(
				runtimeOptions,
				items,
				finalBudget.finalSummaryTokens,
			),
		};
		await normalizeOldestPreviousSummary(items, budgets, runtimeOptions);
		const reducedItems = await reduceUntilFinalFits(
			items,
			budgets,
			runtimeOptions,
		);
		summary = await executeFinalSummary(reducedItems, budgets, runtimeOptions);
	}
	await emitProgress({
		type: "complete",
		completedRequests: logicalRequestCount,
	});
	return summary;
}

/** Minimum elapsed time between cooperative planning yields. */
const PLANNING_YIELD_INTERVAL_MS = 100;

/** Returns a throttled step that honors abort requests and yields to the event loop. */
export function createThrottledPlanningStep(
	signal: AbortSignal,
): () => Promise<void> {
	let lastYieldAt = 0;
	return async () => {
		signal.throwIfAborted();
		const now = performance.now();
		if (now - lastYieldAt < PLANNING_YIELD_INTERVAL_MS) {
			return;
		}
		lastYieldAt = now;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	};
}

/** Normalizes the oldest previous summary before any original history reduction. */
async function normalizeOldestPreviousSummary(
	items: SourceItem[],
	budgets: CompactionBudgets,
	options: AdaptiveCompactionOptions,
): Promise<void> {
	const previousSummary = items[0];
	if (
		previousSummary?.kind !== "summary" ||
		previousSummary.id !== "previousSummary" ||
		countSummaryTextTokens(previousSummary.text) <= budgets.summaryNodeTokens
	) {
		return;
	}
	const normalized = await normalizePreviousSummary(
		previousSummary,
		budgets.summaryNodeTokens,
		options,
	);
	items.splice(0, 1, normalized);
}

/** Reduces original ranges and then adjacent nodes until the first final-fit state. */
async function reduceUntilFinalFits(
	items: SourceItem[],
	budgets: CompactionBudgets,
	options: AdaptiveCompactionOptions,
): Promise<SourceItem[]> {
	if (await doesFinalRequestFit(items, budgets.finalSummaryTokens, options)) {
		return items;
	}
	if (findAdjacentSummaryNodes(items) >= 0) {
		await reduceOldestSummaryPair(items, budgets.summaryNodeTokens, options);
		return reduceUntilFinalFits(items, budgets, options);
	}
	const firstOriginalIndex = items.findIndex(
		(item) => item.kind === "original",
	);
	if (firstOriginalIndex < 0) {
		throw new Error(
			"adaptive compaction cannot reduce the final summary source",
		);
	}
	await reduceOldestOriginalRange(
		items,
		firstOriginalIndex,
		budgets.summaryNodeTokens,
		options,
	);
	return reduceUntilFinalFits(items, budgets, options);
}

/** Replaces the largest fitting original prefix or fragments its oversized first block. */
async function reduceOldestOriginalRange(
	items: SourceItem[],
	firstOriginalIndex: number,
	summaryNodeTokens: number,
	options: AdaptiveCompactionOptions,
): Promise<void> {
	const fittingCount = await findLargestFittingOriginalPrefix({
		items,
		startIndex: firstOriginalIndex,
		originalCount: countContiguousOriginals(items, firstOriginalIndex),
		summaryNodeTokens,
		options,
	});
	if (fittingCount === 0) {
		await replaceOversizedOriginal(
			items,
			firstOriginalIndex,
			summaryNodeTokens,
			options,
		);
		return;
	}
	const source = items.slice(
		firstOriginalIndex,
		firstOriginalIndex + fittingCount,
	) as OriginalBlock[];
	const summary = await summarizeReducingSource(
		"preliminary",
		source,
		summaryNodeTokens,
		options,
	);
	items.splice(firstOriginalIndex, fittingCount, {
		kind: "summary",
		id: source.map((item) => item.id).join(".."),
		text: summary,
	});
}

/** Replaces one oversized original block with ordered bounded fragment summaries. */
async function replaceOversizedOriginal(
	items: SourceItem[],
	index: number,
	summaryNodeTokens: number,
	options: AdaptiveCompactionOptions,
): Promise<void> {
	const oversizedBlock = items[index];
	if (oversizedBlock?.kind !== "original") {
		throw new Error("adaptive compaction lost the oldest original block");
	}
	const fragmentNodes = await summarizeOversizedBlock(
		oversizedBlock,
		summaryNodeTokens,
		options,
	);
	items.splice(index, 1, ...fragmentNodes);
}

/** Replaces the oldest adjacent summary pair with one reducing bounded node. */
async function reduceOldestSummaryPair(
	items: SourceItem[],
	summaryNodeTokens: number,
	options: AdaptiveCompactionOptions,
): Promise<void> {
	const mergeIndex = findAdjacentSummaryNodes(items);
	const left = items[mergeIndex];
	const right = items[mergeIndex + 1];
	if (mergeIndex < 0 || left?.kind !== "summary" || right?.kind !== "summary") {
		throw new Error(
			"adaptive compaction cannot reduce the final summary source",
		);
	}
	const merged = await mergeSummaryNodes(
		left,
		right,
		summaryNodeTokens,
		options,
	);
	items.splice(mergeIndex, 2, merged);
}

/** Executes the final request and validates the actual prospective next main request. */
async function executeFinalSummary(
	items: readonly SourceItem[],
	budgets: FinalSummaryBudget,
	options: AdaptiveCompactionOptions,
): Promise<string> {
	const context = buildSummaryContext(
		items,
		options.finalPrompt,
		options.summarySystemPrompt,
	);
	return executeSingleRequest({
		operation: "final",
		progressEvent: { type: "operation", operation: "final" },
		context,
		maxTokens: budgets.finalSummaryTokens,
		options,
		validate: (summary) => {
			if (countSummaryTextTokens(summary) > budgets.finalSummaryTokens) {
				return "final summary exceeds its output budget";
			}
			const prospectiveInputTokens = estimateProspectiveMainInput(
				summary,
				options,
			);
			if (
				prospectiveInputTokens +
					options.mainModelReserveTokens +
					options.safetyMarginTokens >
				options.mainModel.contextWindow
			) {
				return "final summary makes the prospective main request exceed its model window";
			}
			if (prospectiveInputTokens > budgets.currentMainInputTokens) {
				return "final summary grows beyond the projected request representation it replaces";
			}
			return undefined;
		},
	});
}

/** Rejects invalid numeric limits before budget arithmetic or model requests. */
function validateOptions(options: AdaptiveCompactionOptions): void {
	const positiveLimits = [
		[
			"summarization model context window",
			options.summarizationModel.contextWindow,
		],
		["main model context window", options.mainModel.contextWindow],
	] as const;
	for (const [label, value] of positiveLimits) {
		if (!Number.isInteger(value) || value <= 0) {
			throw new Error(
				`adaptive compaction ${label} must be a positive integer`,
			);
		}
	}
	for (const [label, value] of [
		["main model reserve", options.mainModelReserveTokens],
		["safety margin", options.safetyMarginTokens],
	] as const) {
		if (!Number.isInteger(value) || value < 0) {
			throw new Error(
				`adaptive compaction ${label} must be a non-negative integer`,
			);
		}
	}
}
