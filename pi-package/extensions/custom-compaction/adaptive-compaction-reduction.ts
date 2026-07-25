import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import {
	estimateTextTokens,
	takeTextTokenPrefix,
} from "../../shared/context-size";
import {
	createRetryableExternalError,
	isAbortError,
	isRetryableExternalError,
	type WithRetryOptions,
	withRetry,
} from "../../shared/retry";
import type {
	AdaptiveCompactionOperation,
	AdaptiveCompactionOptions,
	AdaptiveCompactionProgressEvent,
} from "./adaptive-compaction";
import {
	buildRawSummaryContext,
	buildSummaryContext,
	countSummaryTextTokens,
	estimateSummaryInput,
	type OriginalBlock,
	renderSourceItem,
	renderSourceItems,
	type SourceItem,
	type SummaryNode,
} from "./adaptive-compaction-source";

/** Conservative marker value reserved while the final fragment count is unknown. */
const FRAGMENT_MARKER_LIMIT = 999_999;

/** Response defect that must use the configured retry policy. */
class AdaptiveCompactionResponseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdaptiveCompactionResponseError";
	}
}

/** Normalizes one oversized previous summary through bounded reduction and adjacent merges. */
export async function normalizePreviousSummary(
	previousSummary: SummaryNode,
	summaryNodeTokens: number,
	options: AdaptiveCompactionOptions,
): Promise<SummaryNode> {
	if (doesReductionRequestFit([previousSummary], summaryNodeTokens, options)) {
		const text = await summarizeReducingSource(
			"normalization",
			[previousSummary],
			summaryNodeTokens,
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
		summaryNodeTokens,
		options,
	);
	const normalized = await mergeNodesToOne(nodes, summaryNodeTokens, options);
	if (normalized === undefined) {
		throw new Error(
			"adaptive compaction produced no previous_summary replacement",
		);
	}
	return { ...normalized, id: previousSummary.id };
}

/** Recursively merges adjacent nodes until previous_summary normalization has one result. */
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
		throw new Error("adaptive compaction lost previous_summary fragments");
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
export function countContiguousOriginals(
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
export function findLargestFittingOriginalPrefix({
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
export function doesReductionRequestFit(
	items: readonly SourceItem[],
	summaryNodeTokens: number,
	options: AdaptiveCompactionOptions,
): boolean {
	const context = buildSummaryContext(
		items,
		options.reductionPrompt,
		options.reductionSystemPrompt,
	);
	return (
		estimateSummaryInput(context, options) +
			summaryNodeTokens +
			options.safetyMarginTokens <=
		options.summarizationModel.contextWindow
	);
}

/** Summarizes one range and rejects empty, truncated, oversized, or non-reducing output. */
export async function summarizeReducingSource(
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
		progressEvent:
			operation === "preliminary"
				? {
						type: "operation",
						operation,
						sourceBlocks: source.length,
					}
				: { type: "operation", operation },
		context: buildSummaryContext(
			source,
			options.reductionPrompt,
			options.reductionSystemPrompt,
		),
		maxTokens: summaryNodeTokens,
		options,
		validate: (summary) => {
			const summaryTextTokens = countSummaryTextTokens(summary);
			if (summaryTextTokens > summaryNodeTokens) {
				return `${operation} summary exceeds the common summary_node budget`;
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
export async function summarizeOversizedBlock(
	block: OriginalBlock,
	summaryNodeTokens: number,
	options: AdaptiveCompactionOptions,
): Promise<SummaryNode[]> {
	const fragments = splitOversizedText(block, summaryNodeTokens, options);
	const requestIds = fragments.map(() => options.createRequestId());
	let operationsStarted = false;
	return withRetry(
		async () => {
			if (!operationsStarted) {
				await options.onProgress?.({
					type: "split",
					fragments: requestIds.length,
				});
				await emitFragmentProgress(options, 0, requestIds.length);
				operationsStarted = true;
			}
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
				(result): result is PromiseRejectedResult =>
					result.status === "rejected",
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
		},
		buildProgressRetryOptions(options, "fragment", requestIds.length),
	);
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
			"fragment summary exceeds the common summary_node budget",
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

/** Proves that an oversized block can make progress with one token-budget fragment. */
export function canFitMinimumFragment(
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
		`<source_fragment block-id="${blockId}" part="${index + 1}/${total}">\n${fragment}\n</source_fragment>`,
		options.reductionPrompt,
		options.reductionSystemPrompt,
	);
}

/** Locates the oldest adjacent summary pair available for hierarchical reduction. */
export function findAdjacentSummaryNodes(items: readonly SourceItem[]): number {
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
export async function mergeSummaryNodes(
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
	readonly progressEvent: Extract<
		AdaptiveCompactionProgressEvent,
		{ readonly type: "operation" }
	>;
	readonly context: Context;
	readonly maxTokens: number;
	readonly options: AdaptiveCompactionOptions;
	readonly validate: (summary: string) => string | undefined;
}

/** Executes one logical request with one isolated ID shared only by its retries. */
export async function executeSingleRequest({
	operation,
	progressEvent,
	context,
	maxTokens,
	options,
	validate,
}: ExecuteSingleRequestOptions): Promise<string> {
	const requestId = options.createRequestId();
	let operationStarted = false;
	return withRetry(
		async () => {
			if (!operationStarted) {
				await options.onProgress?.(progressEvent);
				operationStarted = true;
			}
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
		},
		buildProgressRetryOptions(options, operation),
	);
}

/** Applies retry policy and reports only retries that remain scheduled. */
function buildProgressRetryOptions(
	options: AdaptiveCompactionOptions,
	operation: AdaptiveCompactionOperation,
	logicalRequestCount = 1,
): WithRetryOptions {
	const shouldRetry = (error: Error): boolean =>
		!isAbortError(error) &&
		(error instanceof AdaptiveCompactionResponseError ||
			isRetryableExternalError(error));
	return {
		retry: options.retry,
		signal: options.signal,
		shouldRetry,
		onFailedAttempt: async (context) => {
			if (context.retriesLeft <= 0 || !shouldRetry(context.error)) {
				return;
			}
			await emitRepeatedProgress(
				options,
				{
					type: "retry",
					operation,
					nextAttempt: context.attemptNumber + 1,
					totalAttempts: options.retry.enabled
						? options.retry.maxRetries + 1
						: 1,
				},
				logicalRequestCount,
			);
		},
	};
}

/** Delivers ordered fragment progress without overlapping asynchronous handlers. */
async function emitFragmentProgress(
	options: AdaptiveCompactionOptions,
	index: number,
	total: number,
): Promise<void> {
	if (index >= total) {
		return;
	}
	await options.onProgress?.({
		type: "operation",
		operation: "fragment",
		fragmentIndex: index + 1,
		totalFragments: total,
	});
	await emitFragmentProgress(options, index + 1, total);
}

/** Delivers repeated logical-request progress sequentially through one injected handler. */
async function emitRepeatedProgress(
	options: AdaptiveCompactionOptions,
	event: AdaptiveCompactionProgressEvent,
	remaining: number,
): Promise<void> {
	if (remaining <= 0) {
		return;
	}
	await options.onProgress?.(event);
	await emitRepeatedProgress(options, event, remaining - 1);
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
