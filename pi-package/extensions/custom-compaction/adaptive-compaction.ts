import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
} from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type SessionBeforeCompactEvent,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import {
	estimateSerializedInputTokens,
	estimateTextTokens,
	takeTextTokenPrefix,
} from "../../shared/context-size";
import {
	createRetryableExternalError,
	isAbortError,
	isRetryableExternalError,
	type RetryConfig,
	withRetry,
} from "../../shared/retry";

/** Logical model operation exposed to the injected completion boundary. */
export type AdaptiveCompactionOperation =
	| "final"
	| "fragment"
	| "merge"
	| "normalization"
	| "preliminary";

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
	readonly summarySystemPrompt: string;
	readonly finalPrompt: string;
	readonly reductionPrompt: string;
	readonly summarizationModel: AdaptiveCompactionModel;
	readonly mainModel: AdaptiveCompactionModel;
	readonly currentProjectedMainMessages: readonly AgentMessage[];
	readonly projectedRetainedMessages: readonly AgentMessage[];
	readonly mainSystemPrompt: string;
	readonly activeTools: NonNullable<Context["tools"]>;
	readonly mainModelReserveTokens: number;
	readonly safetyMarginTokens: number;
	readonly retry: RetryConfig;
	readonly signal: AbortSignal;
	readonly createRequestId: () => string;
	readonly complete: (
		request: AdaptiveCompactionRequest,
	) => Promise<AssistantMessage>;
}

/** Original serialized Pi message block that has not been reduced. */
interface OriginalBlock {
	readonly kind: "original";
	readonly id: string;
	readonly text: string;
}

/** Bounded model summary that covers one chronological source range. */
interface SummaryNode {
	readonly kind: "summary";
	readonly id: string;
	readonly text: string;
}

type SourceItem = OriginalBlock | SummaryNode;

/** Three input nodes plus output share the merge request's variable token space. */
const MERGE_VARIABLE_TOKEN_PARTS = 3;

/** Conservative marker value reserved while the final fragment count is unknown. */
const FRAGMENT_MARKER_LIMIT = 999_999;

/** Budgets proven positive before the first external completion request. */
interface CompactionBudgets {
	readonly currentMainInputTokens: number;
	readonly finalSummaryTokens: number;
	readonly summaryNodeTokens: number;
}

/** Response defect that must use the configured retry policy. */
class AdaptiveCompactionResponseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdaptiveCompactionResponseError";
	}
}

/** Produces only the durable summary; Pi lifecycle state remains owned by the caller. */
export async function adaptiveCompactHistory(
	options: AdaptiveCompactionOptions,
): Promise<string> {
	validateOptions(options);
	const items = buildSummarySource(options.preparation);
	if (items.length === 0) {
		throw new Error("adaptive compaction summary source is empty");
	}
	const budgets = calculateBudgets(options, items);

	// Direct final summarization is preferred because it avoids every lossy reduction step.
	if (doesFinalRequestFit(items, budgets.finalSummaryTokens, options)) {
		return executeFinalSummary(items, budgets, options);
	}

	await normalizeOldestPreviousSummary(items, budgets, options);
	const reducedItems = await reduceUntilFinalFits(items, budgets, options);
	return executeFinalSummary(reducedItems, budgets, options);
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
		budgets,
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
	if (doesFinalRequestFit(items, budgets.finalSummaryTokens, options)) {
		return items;
	}
	// Consolidate accumulated summaries before reducing another independent original range.
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
	const fittingCount = findLargestFittingOriginalPrefix({
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

/** Calculates final-summary and common-node budgets from both complete request shapes. */
function calculateBudgets(
	options: AdaptiveCompactionOptions,
	items: readonly SourceItem[],
): CompactionBudgets {
	const currentMainInputTokens = estimateMainInput(
		options.currentProjectedMainMessages,
		options,
	);
	const emptyProspectiveInputTokens = estimateProspectiveMainInput("", options);
	const mainWindowInputLimit =
		options.mainModel.contextWindow -
		options.mainModelReserveTokens -
		options.safetyMarginTokens;
	const finalSummaryTokens = Math.floor(
		Math.min(
			mainWindowInputLimit - emptyProspectiveInputTokens,
			currentMainInputTokens - emptyProspectiveInputTokens,
			modelOutputLimit(options.summarizationModel),
		),
	);
	if (finalSummaryTokens <= 0) {
		throw new Error("adaptive compaction has no positive final summary budget");
	}

	// Two bounded inputs plus one equally bounded output must fit every merge request.
	const emptyMergeInputTokens = estimateSummaryInput(
		buildSummaryContext(
			[
				{ kind: "summary", id: "left", text: "" },
				{ kind: "summary", id: "right", text: "" },
			],
			options.reductionPrompt,
			options,
		),
		options,
	);
	const mergeNodeTokens = Math.floor(
		(options.summarizationModel.contextWindow -
			options.safetyMarginTokens -
			emptyMergeInputTokens) /
			MERGE_VARIABLE_TOKEN_PARTS,
	);
	const maximumNodeTokens = Math.floor(
		Math.min(mergeNodeTokens, modelOutputLimit(options.summarizationModel)),
	);
	const summaryNodeTokens = findLargestFeasibleNodeBudget(
		maximumNodeTokens,
		items,
		finalSummaryTokens,
		options,
	);
	if (summaryNodeTokens <= 0) {
		throw new Error(
			"adaptive compaction has no positive common summary-node budget",
		);
	}

	return { currentMainInputTokens, finalSummaryTokens, summaryNodeTokens };
}

/** Finds the largest monotonic node cap whose dry-run reduction reaches a final-fit suffix. */
function findLargestFeasibleNodeBudget(
	maximumNodeTokens: number,
	items: readonly SourceItem[],
	finalSummaryTokens: number,
	options: AdaptiveCompactionOptions,
): number {
	let low = 1;
	let high = maximumNodeTokens;
	let best = 0;
	while (low <= high) {
		const candidate = Math.floor((low + high) / 2);
		if (isNodeBudgetFeasible(candidate, items, finalSummaryTokens, options)) {
			best = candidate;
			low = candidate + 1;
		} else {
			high = candidate - 1;
		}
	}
	return best;
}

/** Simulates worst-case cap-sized nodes without issuing model requests. */
function isNodeBudgetFeasible(
	summaryNodeTokens: number,
	items: readonly SourceItem[],
	finalSummaryTokens: number,
	options: AdaptiveCompactionOptions,
): boolean {
	const previousSummary = items.find(
		(item): item is SummaryNode => item.id === "previousSummary",
	);
	if (
		previousSummary !== undefined &&
		countSummaryTextTokens(previousSummary.text) > summaryNodeTokens &&
		!doesReductionRequestFit([previousSummary], summaryNodeTokens, options) &&
		!canFitMinimumFragment(
			previousSummary.id,
			previousSummary.text,
			summaryNodeTokens,
			options,
		)
	) {
		return false;
	}
	const remainingOriginals = items.filter(
		(item): item is OriginalBlock => item.kind === "original",
	);
	let hasSummaryNode = previousSummary !== undefined;
	while (hasSummaryNode || remainingOriginals.length > 0) {
		if (
			hasSummaryNode &&
			doesSimulatedFinalRequestFit(
				remainingOriginals,
				summaryNodeTokens,
				finalSummaryTokens,
				options,
			)
		) {
			return true;
		}
		if (remainingOriginals.length === 0) {
			return false;
		}
		const fittingCount = findLargestFittingOriginalPrefix({
			items: remainingOriginals,
			startIndex: 0,
			originalCount: remainingOriginals.length,
			summaryNodeTokens,
			options,
		});
		if (fittingCount > 0) {
			remainingOriginals.splice(0, fittingCount);
		} else if (
			canFitMinimumFragment(
				(remainingOriginals[0] as OriginalBlock).id,
				(remainingOriginals[0] as OriginalBlock).text,
				summaryNodeTokens,
				options,
			)
		) {
			remainingOriginals.shift();
		} else {
			return false;
		}
		hasSummaryNode = true;
	}
	return false;
}

/** Checks the final invariant with one cap-sized node and the simulated original suffix. */
function doesSimulatedFinalRequestFit(
	remainingOriginals: readonly OriginalBlock[],
	summaryNodeTokens: number,
	finalSummaryTokens: number,
	options: AdaptiveCompactionOptions,
): boolean {
	const context = buildSummaryContext(
		[{ kind: "summary", id: "simulated", text: "" }, ...remainingOriginals],
		options.finalPrompt,
		options,
	);
	return (
		estimateSummaryInput(context, options) +
			summaryNodeTokens +
			finalSummaryTokens +
			options.safetyMarginTokens <=
		options.summarizationModel.contextWindow
	);
}

/** Proves that an oversized block can make progress with one token-budget fragment. */
function canFitMinimumFragment(
	blockId: string,
	text: string,
	summaryNodeTokens: number,
	options: AdaptiveCompactionOptions,
): boolean {
	const firstCodePoint = Array.from(text)[0];
	return (
		firstCodePoint !== undefined &&
		doesFragmentRequestFit(blockId, firstCodePoint, summaryNodeTokens, options)
	);
}

/** Converts Pi preparation groups into previous-summary, history, then turn-prefix items. */
function buildSummarySource(
	preparation: AdaptiveCompactionPreparation,
): SourceItem[] {
	const source: SourceItem[] = [];
	if (preparation.previousSummary !== undefined) {
		source.push({
			kind: "summary",
			id: "previousSummary",
			text: preparation.previousSummary,
		});
	}
	source.push(
		...serializeMessageBlocks(
			preparation.messagesToSummarize,
			"messagesToSummarize",
		),
		...serializeMessageBlocks(
			preparation.turnPrefixMessages,
			"turnPrefixMessages",
		),
	);
	return source;
}

/** Forms user-turn blocks while keeping context-visible out-of-turn messages standalone. */
function serializeMessageBlocks(
	messages: readonly AgentMessage[],
	sourceName: "messagesToSummarize" | "turnPrefixMessages",
): OriginalBlock[] {
	const blocks: AgentMessage[][] = [];
	let currentTurn: AgentMessage[] | undefined;
	for (const message of messages) {
		if (convertToLlm([message]).length === 0) {
			continue;
		}
		if (message.role === "user") {
			if (currentTurn !== undefined) {
				blocks.push(currentTurn);
			}
			currentTurn = [message];
			continue;
		}
		if (
			currentTurn !== undefined &&
			(message.role === "assistant" || message.role === "toolResult")
		) {
			currentTurn.push(message);
			continue;
		}
		if (currentTurn !== undefined) {
			blocks.push(currentTurn);
			currentTurn = undefined;
		}
		blocks.push([message]);
	}
	if (currentTurn !== undefined) {
		blocks.push(currentTurn);
	}

	return blocks.flatMap((block, index) => {
		const text = serializeConversation(convertToLlm(block));
		return text.length === 0
			? []
			: [{ kind: "original", id: `${sourceName}:${index}`, text }];
	});
}

/** Builds the one-message summarization context shared by all operation kinds. */
function buildSummaryContext(
	items: readonly SourceItem[],
	prompt: string,
	options: AdaptiveCompactionOptions,
): Context {
	return buildRawSummaryContext(renderSourceItems(items), prompt, options);
}

/** Wraps already rendered source text without changing Pi's serialized conversation content. */
function buildRawSummaryContext(
	source: string,
	prompt: string,
	options: AdaptiveCompactionOptions,
): Context {
	return {
		systemPrompt: options.summarySystemPrompt,
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: `<summary-source>\n${source}\n</summary-source>\n\n${prompt}`,
					},
				],
				timestamp: 0,
			},
		],
	};
}

/** Renders source identity and chronology for final, preliminary, and merge operations. */
function renderSourceItems(items: readonly SourceItem[]): string {
	return items.map(renderSourceItem).join("\n\n");
}

/** Preserves the configured update prompt's previous-summary contract after bounded merges. */
function renderSourceItem(item: SourceItem): string {
	if (item.kind === "original") {
		return `<original-block id="${item.id}">\n${item.text}\n</original-block>`;
	}
	if (
		item.id === "previousSummary" ||
		item.id.startsWith("previousSummary..")
	) {
		return `<previous-summary>\n${item.text}\n</previous-summary>`;
	}
	return `<summary-node id="${item.id}">\n${item.text}\n</summary-node>`;
}

/** Checks a final request with its full reserved output rather than input alone. */
function doesFinalRequestFit(
	items: readonly SourceItem[],
	finalSummaryTokens: number,
	options: AdaptiveCompactionOptions,
): boolean {
	const context = buildSummaryContext(items, options.finalPrompt, options);
	return (
		estimateSummaryInput(context, options) +
			finalSummaryTokens +
			options.safetyMarginTokens <=
		options.summarizationModel.contextWindow
	);
}

/** Executes the final request and validates the actual prospective next main request. */
async function executeFinalSummary(
	items: readonly SourceItem[],
	budgets: CompactionBudgets,
	options: AdaptiveCompactionOptions,
): Promise<string> {
	const context = buildSummaryContext(items, options.finalPrompt, options);
	return executeSingleRequest({
		operation: "final",
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

/** Normalizes one oversized previous summary through bounded reduction and adjacent merges. */
async function normalizePreviousSummary(
	previousSummary: SummaryNode,
	budgets: CompactionBudgets,
	options: AdaptiveCompactionOptions,
): Promise<SummaryNode> {
	if (
		doesReductionRequestFit(
			[previousSummary],
			budgets.summaryNodeTokens,
			options,
		)
	) {
		const text = await summarizeReducingSource(
			"normalization",
			[previousSummary],
			budgets.summaryNodeTokens,
			options,
		);
		return { kind: "summary", id: previousSummary.id, text };
	}

	const original: OriginalBlock = {
		kind: "original",
		id: previousSummary.id,
		text: previousSummary.text,
	};
	const nodes = await summarizeOversizedBlock(
		original,
		budgets.summaryNodeTokens,
		options,
	);
	const normalized = await mergeNodesToOne(
		nodes,
		budgets.summaryNodeTokens,
		options,
	);
	if (normalized === undefined) {
		throw new Error(
			"adaptive compaction produced no previous-summary replacement",
		);
	}
	return { ...normalized, id: previousSummary.id };
}

/** Recursively merges adjacent nodes until previous-summary normalization has one result. */
async function mergeNodesToOne(
	nodes: SummaryNode[],
	summaryNodeTokens: number,
	options: AdaptiveCompactionOptions,
): Promise<SummaryNode | undefined> {
	if (nodes.length <= 1) {
		return nodes[0];
	}
	const left = nodes[0];
	const right = nodes[1];
	if (left === undefined || right === undefined) {
		throw new Error("adaptive compaction lost previous-summary fragments");
	}
	const merged = await mergeSummaryNodes(
		left,
		right,
		summaryNodeTokens,
		options,
	);
	nodes.splice(0, 2, merged);
	return mergeNodesToOne(nodes, summaryNodeTokens, options);
}

/** Counts originals until the first already summarized range. */
function countContiguousOriginals(
	items: readonly SourceItem[],
	startIndex: number,
): number {
	let count = 0;
	while (items[startIndex + count]?.kind === "original") {
		count += 1;
	}
	return count;
}

interface OriginalPrefixSelection {
	readonly items: readonly SourceItem[];
	readonly startIndex: number;
	readonly originalCount: number;
	readonly summaryNodeTokens: number;
	readonly options: AdaptiveCompactionOptions;
}

/** Selects the largest oldest contiguous original range that fits one reduction request. */
function findLargestFittingOriginalPrefix({
	items,
	startIndex,
	originalCount,
	summaryNodeTokens,
	options,
}: OriginalPrefixSelection): number {
	let low = 1;
	let high = originalCount;
	let best = 0;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = items.slice(startIndex, startIndex + middle);
		if (doesReductionRequestFit(candidate, summaryNodeTokens, options)) {
			best = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return best;
}

/** Checks one reduction request with the common bounded-node response reserve. */
function doesReductionRequestFit(
	items: readonly SourceItem[],
	summaryNodeTokens: number,
	options: AdaptiveCompactionOptions,
): boolean {
	const context = buildSummaryContext(items, options.reductionPrompt, options);
	return (
		estimateSummaryInput(context, options) +
			summaryNodeTokens +
			options.safetyMarginTokens <=
		options.summarizationModel.contextWindow
	);
}

/** Summarizes one range and rejects empty, truncated, oversized, or non-reducing output. */
async function summarizeReducingSource(
	operation: "merge" | "normalization" | "preliminary",
	source: readonly SourceItem[],
	summaryNodeTokens: number,
	options: AdaptiveCompactionOptions,
): Promise<string> {
	const sourceTokens = source.reduce(
		(total, item) => total + countSummaryTextTokens(item.text),
		0,
	);
	return executeSingleRequest({
		operation,
		context: buildSummaryContext(source, options.reductionPrompt, options),
		maxTokens: summaryNodeTokens,
		options,
		validate: (summary) => {
			const summaryTextTokens = countSummaryTextTokens(summary);
			if (summaryTextTokens > summaryNodeTokens) {
				return `${operation} summary exceeds the common summary-node budget`;
			}
			const resultTokens =
				operation === "normalization"
					? countSummaryTextTokens(
							renderSourceItem({
								kind: "summary",
								id: source[0]?.id ?? "normalized",
								text: summary,
							}),
						)
					: summaryTextTokens;
			return resultTokens < sourceTokens
				? undefined
				: `${operation} summary is not smaller than its source`;
		},
	});
}

/** Splits one oversized serialized block at useful text boundaries before hard boundaries. */
async function summarizeOversizedBlock(
	block: OriginalBlock,
	summaryNodeTokens: number,
	options: AdaptiveCompactionOptions,
): Promise<SummaryNode[]> {
	const fragments = splitOversizedText(block, summaryNodeTokens, options);
	const requestIds = fragments.map(() => options.createRequestId());
	return withRetry(async () => {
		const results = await Promise.allSettled(
			fragments.map((fragment, index) =>
				summarizeFragment({
					block,
					fragment,
					index,
					total: fragments.length,
					requestId: requestIds[index] as string,
					summaryNodeTokens,
					options,
				}),
			),
		);
		const failedResult = results.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (failedResult !== undefined) {
			throw failedResult.reason instanceof Error
				? failedResult.reason
				: new Error(String(failedResult.reason));
		}
		const summaries = results.map(
			(result) => (result as PromiseFulfilledResult<SummaryNode>).value,
		);
		if (
			countSummaryTextTokens(renderSourceItems(summaries)) >=
			countSummaryTextTokens(block.text)
		) {
			throw new AdaptiveCompactionResponseError(
				"combined fragment summaries are not smaller than their source block",
			);
		}
		return summaries;
	}, buildRetryOptions(options));
}

interface SummarizeFragmentOptions {
	readonly block: OriginalBlock;
	readonly fragment: string;
	readonly index: number;
	readonly total: number;
	readonly requestId: string;
	readonly summaryNodeTokens: number;
	readonly options: AdaptiveCompactionOptions;
}

/** Summarizes one ordered fragment while the enclosing operation owns retry acceptance. */
async function summarizeFragment({
	block,
	fragment,
	index,
	total,
	requestId,
	summaryNodeTokens,
	options,
}: SummarizeFragmentOptions): Promise<SummaryNode> {
	const context = buildFragmentContext({
		blockId: block.id,
		fragment,
		index,
		total,
		options,
	});
	const response = await options.complete({
		operation: "fragment",
		context,
		maxTokens: summaryNodeTokens,
		requestId,
		signal: options.signal,
	});
	const text = extractValidResponse(response, "fragment");
	if (countSummaryTextTokens(text) > summaryNodeTokens) {
		throw new AdaptiveCompactionResponseError(
			"fragment summary exceeds the common summary-node budget",
		);
	}
	return {
		kind: "summary",
		id: `${block.id}:fragment:${index + 1}`,
		text,
	};
}

/** Divides oversized text using paragraph, line, sentence, word, then hard fit boundaries. */
function splitOversizedText(
	block: OriginalBlock,
	summaryNodeTokens: number,
	options: AdaptiveCompactionOptions,
): string[] {
	const fragments: string[] = [];
	let remaining = block.text;
	while (remaining.length > 0) {
		const prefixLength = findLargestFittingTextPrefix(remaining, (blockText) =>
			doesFragmentRequestFit(block.id, blockText, summaryNodeTokens, options),
		);
		if (prefixLength <= 0) {
			throw new Error(
				`adaptive compaction cannot fit a fragment request for ${block.id}`,
			);
		}
		const usefulPrefixLength = findUsefulBoundary(remaining, prefixLength);
		const tokenPrefix =
			usefulPrefixLength > 0
				? undefined
				: findLargestFittingTokenPrefix(
						remaining,
						(blockText) =>
							doesFragmentRequestFit(
								block.id,
								blockText,
								summaryNodeTokens,
								options,
							),
						options,
					);
		const fragment =
			usefulPrefixLength > 0
				? remaining.slice(0, usefulPrefixLength)
				: tokenPrefix;
		if (fragment === undefined || fragment.length === 0) {
			throw new Error(
				`adaptive compaction cannot find a token boundary for ${block.id}`,
			);
		}
		fragments.push(fragment);
		remaining = remaining.slice(fragment.length);
	}
	return fragments;
}

/** Finds the largest Unicode-safe prefix accepted by a token-budget fit predicate. */
function findLargestFittingTextPrefix(
	text: string,
	fits: (candidate: string) => boolean,
): number {
	const boundaries = Array.from(text).reduce<number[]>(
		(offsets, character) => {
			offsets.push((offsets.at(-1) ?? 0) + character.length);
			return offsets;
		},
		[0],
	);
	let low = 1;
	let high = boundaries.length - 1;
	let best = 0;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const boundary = boundaries[middle] as number;
		if (fits(text.slice(0, boundary))) {
			best = boundary;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return best;
}

/** Finds the largest selected-tokenizer prefix accepted by the fragment fit predicate. */
function findLargestFittingTokenPrefix(
	text: string,
	fits: (candidate: string) => boolean,
	options: AdaptiveCompactionOptions,
): string | undefined {
	let low = 1;
	let high = estimateTextTokens(
		text,
		options.summarizationModel.id,
		options.summarizationModel.provider,
	);
	let best: string | undefined;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = takeTextTokenPrefix(
			text,
			middle,
			options.summarizationModel.id,
			options.summarizationModel.provider,
		);
		if (candidate.length === 0) {
			// A larger token limit can complete the first multi-token Unicode code point.
			low = middle + 1;
		} else if (text.startsWith(candidate) && fits(candidate)) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return best;
}

/** Prefers the strongest useful text boundary available inside one fitting prefix. */
function findUsefulBoundary(text: string, maxLength: number): number {
	const prefix = text.slice(0, maxLength);
	for (const pattern of [/\n\n/g, /\n/g, /[.!?](?:\s|$)/g, /\s/g]) {
		let boundary = 0;
		for (const match of prefix.matchAll(pattern)) {
			boundary = (match.index ?? 0) + match[0].length;
		}
		if (boundary > 0) {
			return boundary;
		}
	}
	return 0;
}

/** Uses a conservative part marker while planning so final fragment markers also fit. */
function doesFragmentRequestFit(
	blockId: string,
	fragment: string,
	summaryNodeTokens: number,
	options: AdaptiveCompactionOptions,
): boolean {
	const context = buildFragmentContext({
		blockId,
		fragment,
		index: FRAGMENT_MARKER_LIMIT,
		total: FRAGMENT_MARKER_LIMIT,
		options,
	});
	return (
		estimateSummaryInput(context, options) +
			summaryNodeTokens +
			options.safetyMarginTokens <=
		options.summarizationModel.contextWindow
	);
}

interface FragmentContextOptions {
	readonly blockId: string;
	readonly fragment: string;
	readonly index: number;
	readonly total: number;
	readonly options: AdaptiveCompactionOptions;
}

/** Marks fragments as ordered parts of one incomplete serialized Pi block. */
function buildFragmentContext({
	blockId,
	fragment,
	index,
	total,
	options,
}: FragmentContextOptions): Context {
	return buildRawSummaryContext(
		`<source-fragment block-id="${blockId}" part="${index + 1}/${total}">\n${fragment}\n</source-fragment>`,
		options.reductionPrompt,
		options,
	);
}

/** Locates the oldest adjacent summary pair available for hierarchical reduction. */
function findAdjacentSummaryNodes(items: readonly SourceItem[]): number {
	for (let index = 0; index < items.length - 1; index += 1) {
		if (
			items[index]?.kind === "summary" &&
			items[index + 1]?.kind === "summary"
		) {
			return index;
		}
	}
	return -1;
}

/** Merges two adjacent nodes into one bounded reducing chronological replacement. */
async function mergeSummaryNodes(
	left: SummaryNode,
	right: SummaryNode,
	summaryNodeTokens: number,
	options: AdaptiveCompactionOptions,
): Promise<SummaryNode> {
	const text = await summarizeReducingSource(
		"merge",
		[left, right],
		summaryNodeTokens,
		options,
	);
	return { kind: "summary", id: `${left.id}..${right.id}`, text };
}

interface ExecuteSingleRequestOptions {
	readonly operation: AdaptiveCompactionOperation;
	readonly context: Context;
	readonly maxTokens: number;
	readonly options: AdaptiveCompactionOptions;
	readonly validate: (summary: string) => string | undefined;
}

/** Executes one logical request with one isolated ID shared only by its retries. */
async function executeSingleRequest({
	operation,
	context,
	maxTokens,
	options,
	validate,
}: ExecuteSingleRequestOptions): Promise<string> {
	const requestId = options.createRequestId();
	return withRetry(async () => {
		const response = await options.complete({
			operation,
			context,
			maxTokens,
			requestId,
			signal: options.signal,
		});
		const summary = extractValidResponse(response, operation);
		const issue = validate(summary);
		if (issue !== undefined) {
			throw new AdaptiveCompactionResponseError(issue);
		}
		return summary;
	}, buildRetryOptions(options));
}

/** Applies one retry policy to response defects and existing transient external failures. */
function buildRetryOptions(options: AdaptiveCompactionOptions): {
	readonly retry: RetryConfig;
	readonly signal: AbortSignal;
	readonly shouldRetry: (error: Error) => boolean;
} {
	return {
		retry: options.retry,
		signal: options.signal,
		shouldRetry: (error) =>
			!isAbortError(error) &&
			(error instanceof AdaptiveCompactionResponseError ||
				isRetryableExternalError(error)),
	};
}

/** Extracts complete non-empty text while mapping provider responses into retry defects. */
function extractValidResponse(
	response: AssistantMessage,
	operation: AdaptiveCompactionOperation,
): string {
	if (response.stopReason === "error") {
		throw createRetryableExternalError(
			response.errorMessage ?? `${operation} provider returned an error`,
		);
	}
	if (response.stopReason === "aborted") {
		const error = new Error(`${operation} response was aborted`);
		error.name = "AbortError";
		throw error;
	}
	if (response.stopReason === "length") {
		throw new AdaptiveCompactionResponseError(
			`${operation} response reached its output limit`,
		);
	}
	if (response.stopReason !== "stop") {
		throw new AdaptiveCompactionResponseError(
			`${operation} response stopped with ${response.stopReason}`,
		);
	}
	const text = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (text.length === 0) {
		throw new AdaptiveCompactionResponseError(
			`${operation} response did not contain text`,
		);
	}
	return text;
}

/** Estimates a summarization request with the selected compaction tokenizer profile. */
function estimateSummaryInput(
	context: Context,
	options: AdaptiveCompactionOptions,
): number {
	return estimateSerializedInputTokens(
		context,
		options.summarizationModel.id,
		options.summarizationModel.provider,
	);
}

/** Estimates the current projected main request including system prompt and active tools. */
function estimateMainInput(
	messages: readonly AgentMessage[],
	options: AdaptiveCompactionOptions,
): number {
	return estimateSerializedInputTokens(
		{
			systemPrompt: options.mainSystemPrompt,
			messages: convertToLlm([...messages]),
			tools: [...options.activeTools],
		},
		options.mainModel.id,
		options.mainModel.provider,
	);
}

/** Estimates the prospective request with Pi's summary wrapper and fixed projected suffix. */
function estimateProspectiveMainInput(
	summary: string,
	options: AdaptiveCompactionOptions,
): number {
	const summaryMessage: AgentMessage = {
		role: "compactionSummary",
		summary,
		tokensBefore: options.preparation.tokensBefore,
		timestamp: 0,
	};
	return estimateMainInput(
		[summaryMessage, ...options.projectedRetainedMessages],
		options,
	);
}

/** Counts summary text without adding synthetic chat request framing. */
function countSummaryTextTokens(text: string): number {
	return estimateTextTokens(text, undefined, undefined);
}

/** Returns the selected model's positive output cap or its context window as the cap. */
function modelOutputLimit(model: AdaptiveCompactionModel): number {
	return model.maxTokens > 0 ? model.maxTokens : model.contextWindow;
}
