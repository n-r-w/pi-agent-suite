import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { estimateSerializedInputTokens } from "../../shared/context-size";
import type {
	AdaptiveCompactionModel,
	AdaptiveCompactionOptions,
} from "./adaptive-compaction";
import {
	canFitMinimumFragment,
	doesReductionRequestFit,
	findLargestFittingOriginalPrefix,
} from "./adaptive-compaction-reduction";
import {
	buildSummaryContext,
	countSummaryTextTokens,
	estimateSummaryInput,
	type OriginalBlock,
	type SourceItem,
	type SummaryNode,
} from "./adaptive-compaction-source";

/** Three input nodes plus output share the merge request's variable token space. */
const MERGE_VARIABLE_TOKEN_PARTS = 3;

/** Direct-path budgets proven positive before the final request fit decision. */
export interface FinalSummaryBudget {
	readonly currentMainInputTokens: number;
	readonly finalSummaryTokens: number;
}

/** Adaptive-path budgets proven positive before hierarchical reduction starts. */
export interface CompactionBudgets extends FinalSummaryBudget {
	readonly summaryNodeTokens: number;
}

/** Calculates only the budgets required to decide and execute the direct path. */
export function calculateFinalSummaryBudget(
	options: AdaptiveCompactionOptions,
): FinalSummaryBudget {
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
	return { currentMainInputTokens, finalSummaryTokens };
}

/** Calculates the common node budget only after the complete direct request does not fit. */
export function calculateCommonNodeBudget(
	options: AdaptiveCompactionOptions,
	items: readonly SourceItem[],
	finalSummaryTokens: number,
): number {
	// Two bounded inputs plus one equally bounded output must fit every merge request.
	const emptyMergeInputTokens = estimateSummaryInput(
		buildSummaryContext(
			[
				{ kind: "summary", id: "left", text: "" },
				{ kind: "summary", id: "right", text: "" },
			],
			options.reductionPrompt,
			options.reductionSystemPrompt,
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
			"adaptive compaction has no positive common summary_node budget",
		);
	}
	return summaryNodeTokens;
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
		options.summarySystemPrompt,
	);
	return (
		estimateSummaryInput(context, options) +
			summaryNodeTokens +
			finalSummaryTokens +
			options.safetyMarginTokens <=
		options.summarizationModel.contextWindow
	);
}

/** Checks a final request with its full reserved output rather than input alone. */
export function doesFinalRequestFit(
	items: readonly SourceItem[],
	finalSummaryTokens: number,
	options: AdaptiveCompactionOptions,
): boolean {
	const context = buildSummaryContext(
		items,
		options.finalPrompt,
		options.summarySystemPrompt,
	);
	return (
		estimateSummaryInput(context, options) +
			finalSummaryTokens +
			options.safetyMarginTokens <=
		options.summarizationModel.contextWindow
	);
}

/** Estimates the prospective request with Pi's summary wrapper and fixed projected suffix. */
export function estimateProspectiveMainInput(
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

/** Returns the selected model's positive output cap or its context window as the cap. */
function modelOutputLimit(model: AdaptiveCompactionModel): number {
	return model.maxTokens > 0 ? model.maxTokens : model.contextWindow;
}
