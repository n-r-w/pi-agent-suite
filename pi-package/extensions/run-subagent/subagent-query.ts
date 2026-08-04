import type { Context } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionAPI,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { escapeUTF8 } from "entities";
import {
	type AuxiliaryLlmCompletion,
	type AuxiliaryLlmContext,
	buildAuxiliaryLlmOptions,
	completeAuxiliaryLlm,
	doesAuxiliaryLlmInputFitContextWindow,
	getAuxiliaryLlmResponseText,
	resolveAuxiliaryLlmRuntime,
} from "../../shared/auxiliary-llm";
import { replayPersistedContextProjection } from "../../shared/context-projection";
import { recordHelperApiCost } from "../../shared/helper-api-cost";
import { isReasoningLevel } from "../../shared/reasoning-levels";
import { readCancellationError } from "./cancellation-reason";
import type { SubagentQueryModelConfig } from "./entry-config";

const QUESTION_TAG = "question";

/** Reports either one auxiliary answer or a query-specific runtime issue. */
type SubagentQueryExecutionResult =
	| { readonly kind: "success"; readonly answer: string }
	| { readonly kind: "issue"; readonly issue: string };

/** Carries caller-local dependencies and saved context for one query. */
interface ExecuteSubagentQueryOptions {
	readonly completeSimple: AuxiliaryLlmCompletion;
	readonly ctx: AuxiliaryLlmContext;
	readonly pi: Pick<ExtensionAPI, "appendEntry">;
	readonly branchEntries: readonly SessionEntry[];
	readonly question: string;
	readonly systemPrompt: string;
	readonly modelConfig?: SubagentQueryModelConfig;
	readonly currentThinkingLevel: unknown;
	readonly signal?: AbortSignal;
}

/** Executes exactly one tool-less auxiliary request in the calling Pi process. */
export async function executeSubagentQuery({
	completeSimple,
	ctx,
	pi,
	branchEntries,
	question,
	systemPrompt,
	modelConfig,
	currentThinkingLevel,
	signal,
}: ExecuteSubagentQueryOptions): Promise<SubagentQueryExecutionResult> {
	if (signal?.aborted) {
		throw readCancellationError(signal);
	}

	const thinking =
		modelConfig?.thinking ??
		(isReasoningLevel(currentThinkingLevel) ? currentThinkingLevel : undefined);
	const runtimeResult = await resolveAuxiliaryLlmRuntime(
		ctx,
		modelConfig?.id,
		thinking,
	);
	if ("issue" in runtimeResult) {
		return { kind: "issue", issue: "Query model is unavailable" };
	}

	const context = buildQueryContext(branchEntries, systemPrompt, question);
	if (
		!doesAuxiliaryLlmInputFitContextWindow(context, runtimeResult.runtime.model)
	) {
		return {
			kind: "issue",
			issue: "Subagent conversation is too large to query",
		};
	}

	const options = buildAuxiliaryLlmOptions(
		thinking,
		signal,
		runtimeResult.runtime,
	);
	let response: Awaited<ReturnType<AuxiliaryLlmCompletion>>;
	try {
		response = await completeAuxiliaryLlm(
			completeSimple,
			runtimeResult.runtime,
			context,
			options,
		);
	} catch {
		if (signal?.aborted) {
			throw readCancellationError(signal);
		}
		return {
			kind: "issue",
			issue: "The query failed, please try again later",
		};
	}

	recordHelperApiCost(pi, "subagent-query", response);
	if (signal?.aborted) {
		throw readCancellationError(signal);
	}
	if (response.stopReason === "aborted") {
		return { kind: "issue", issue: "The query was cancelled" };
	}
	if (response.stopReason === "error") {
		return {
			kind: "issue",
			issue: "The query failed, please try again later",
		};
	}
	const answer = getAuxiliaryLlmResponseText(response);
	return answer.length === 0
		? { kind: "issue", issue: "The query returned no answer" }
		: { kind: "success", answer };
}

/** Builds saved model messages before appending the plain query question. */
function buildQueryContext(
	branchEntries: readonly SessionEntry[],
	systemPrompt: string,
	question: string,
): Context {
	const messages = convertToLlm(
		replayPersistedContextProjection(branchEntries),
	);
	messages.push({
		role: "user",
		content: formatQueryQuestion(question),
		timestamp: Date.now(),
	});
	return { systemPrompt, messages, tools: [] };
}

/** Preserves one question block by escaping tag-like user content. */
function formatQueryQuestion(question: string): string {
	return `<${QUESTION_TAG}>\n${escapeUTF8(question)}\n</${QUESTION_TAG}>`;
}
