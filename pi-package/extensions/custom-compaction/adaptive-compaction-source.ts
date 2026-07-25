import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import {
	estimateSerializedInputTokens,
	estimateTextTokens,
} from "../../shared/context-size";
import type {
	AdaptiveCompactionOptions,
	AdaptiveCompactionPreparation,
} from "./adaptive-compaction";

/** Original serialized Pi message block that has not been reduced. */
export interface OriginalBlock {
	readonly kind: "original";
	readonly id: string;
	readonly text: string;
}

/** Bounded model summary that covers one chronological source range. */
export interface SummaryNode {
	readonly kind: "summary";
	readonly id: string;
	readonly text: string;
}

/** One ordered original or reduced item in the summarization source. */
export type SourceItem = OriginalBlock | SummaryNode;

/** Converts Pi preparation groups into previous_summary, history, then turn-prefix items. */
export function buildSummarySource(
	preparation: AdaptiveCompactionPreparation,
	projectedToolResultSummaries: ReadonlyMap<string, string>,
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
			projectedToolResultSummaries,
		),
		...serializeMessageBlocks(
			preparation.turnPrefixMessages,
			"turnPrefixMessages",
			projectedToolResultSummaries,
		),
	);
	return source;
}

/** Forms user-turn blocks while keeping context-visible out-of-turn messages standalone. */
function serializeMessageBlocks(
	messages: readonly AgentMessage[],
	sourceName: "messagesToSummarize" | "turnPrefixMessages",
	projectedToolResultSummaries: ReadonlyMap<string, string>,
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
		const text = serializeMessageBlock(block, projectedToolResultSummaries);
		return text.length === 0
			? []
			: [{ kind: "original", id: `${sourceName}:${index}`, text }];
	});
}

/** Preserves complete projection summaries while delegating all other text to Pi. */
function serializeMessageBlock(
	messages: readonly AgentMessage[],
	projectedToolResultSummaries: ReadonlyMap<string, string>,
): string {
	if (
		!messages.some(
			(message) =>
				message.role === "toolResult" &&
				projectedToolResultSummaries.has(message.toolCallId),
		)
	) {
		return serializeConversation(convertToLlm([...messages]));
	}

	const parts: string[] = [];
	let pendingMessages: AgentMessage[] = [];
	const flushPendingMessages = (): void => {
		if (pendingMessages.length === 0) {
			return;
		}
		const text = serializeConversation(convertToLlm(pendingMessages));
		if (text.length > 0) {
			parts.push(text);
		}
		pendingMessages = [];
	};
	for (const message of messages) {
		const projectionSummary =
			message.role === "toolResult"
				? projectedToolResultSummaries.get(message.toolCallId)
				: undefined;
		if (projectionSummary === undefined) {
			pendingMessages.push(message);
			continue;
		}
		flushPendingMessages();
		parts.push(`[Tool result]: ${projectionSummary}`);
	}
	flushPendingMessages();
	return parts.join("\n\n");
}

/** Builds the one-message summarization context shared by all operation kinds. */
export function buildSummaryContext(
	items: readonly SourceItem[],
	prompt: string,
	systemPrompt: string,
): Context {
	return buildRawSummaryContext(renderSourceItems(items), prompt, systemPrompt);
}

/** Wraps already rendered source text without changing Pi's serialized conversation content. */
export function buildRawSummaryContext(
	source: string,
	prompt: string,
	systemPrompt: string,
): Context {
	return {
		systemPrompt,
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: `<summary_source>\n${source}\n</summary_source>\n\n${prompt}`,
					},
				],
				timestamp: 0,
			},
		],
	};
}

/** Renders source identity and chronology for final, preliminary, and merge operations. */
export function renderSourceItems(items: readonly SourceItem[]): string {
	return items.map(renderSourceItem).join("\n\n");
}

/** Preserves the update prompt's previous_summary contract after bounded merges. */
export function renderSourceItem(item: SourceItem): string {
	if (item.kind === "original") {
		return `<original_block id="${item.id}">\n${item.text}\n</original_block>`;
	}
	if (
		item.id === "previousSummary" ||
		item.id.startsWith("previousSummary..")
	) {
		return `<previous_summary>\n${item.text}\n</previous_summary>`;
	}
	return `<summary_node id="${item.id}">\n${item.text}\n</summary_node>`;
}

/** Estimates a summarization request with the selected compaction tokenizer profile. */
export function estimateSummaryInput(
	context: Context,
	options: AdaptiveCompactionOptions,
): number {
	return estimateSerializedInputTokens(
		context,
		options.summarizationModel.id,
		options.summarizationModel.provider,
	);
}

/** Counts summary text without adding synthetic chat request framing. */
export function countSummaryTextTokens(text: string): number {
	return estimateTextTokens(text, undefined, undefined);
}
