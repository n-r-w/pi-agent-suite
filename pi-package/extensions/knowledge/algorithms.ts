import type {
	AssistantMessage,
	Context,
	UserMessage,
} from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	type AuxiliaryLlmCompletion,
	buildAuxiliaryLlmOptions,
	completeAuxiliaryLlm,
	doesAuxiliaryLlmInputFitContextWindow,
	getAuxiliaryLlmResponseText,
	resolveAuxiliaryLlmRuntime,
} from "../../shared/auxiliary-llm";
import { replayContextProjection } from "../../shared/context-projection";
import { countKnowledgeTextTokens } from "../../shared/context-size";
import type { KnowledgeSnapshots } from "../../shared/knowledge-runtime";
import type { ReasoningLevel } from "../../shared/reasoning-levels";
import type { KnowledgeConfig, KnowledgeOperationConfig } from "./config";
import { renderKnowledgeBlock } from "./context";
import type { IdentityMetadata } from "./git-context";
import {
	createGlobalMergeState,
	type GlobalMergeState,
	type KnowledgeReplacementResult,
	type KnowledgeTarget,
} from "./owner";
import type { BranchPaths, ProjectPaths } from "./paths";
import {
	A4_PAGE_ANCHOR_TEXT,
	formatA4Fraction,
	nextReducedFraction,
} from "./size-target";

const NOT_FOUND = "NOT_FOUND";

/** Lists user-visible accumulation operations for progress reporting. */
export type KnowledgeAccumulationOperation =
	| "prepare_local_summary"
	| "merge_local_knowledge"
	| "merge_global_knowledge"
	| "extraction_retry"
	| "merge_retry";

/** Storage operations used by accumulation after the root grants a scoped lease. */
interface KnowledgeAlgorithmOwner {
	replace(
		target: KnowledgeTarget,
		text: string,
	): Promise<KnowledgeReplacementResult>;
	delete(target: KnowledgeTarget): Promise<void>;
	readGlobalMergeState(path: string): Promise<GlobalMergeState | null>;
	replaceGlobalMergeState(path: string, state: GlobalMergeState): Promise<void>;
	replaceIdentityMetadata(
		path: string,
		metadata: IdentityMetadata,
	): Promise<void>;
}

/** Inputs shared by local and global accumulation under one root-owned lease. */
interface KnowledgeAlgorithmOptions {
	readonly config: KnowledgeConfig;
	readonly ctx: ExtensionContext;
	readonly owner: KnowledgeAlgorithmOwner;
	readonly projectPaths: ProjectPaths;
	readonly branchPaths: BranchPaths;
	readonly identityMetadata: IdentityMetadata;
	readonly snapshots: KnowledgeSnapshots;
	readonly branchEntries: readonly SessionEntry[];
	readonly loadedSkillRoots: readonly string[];
	readonly currentThinking: ReasoningLevel | undefined;
	readonly completeSimple: AuxiliaryLlmCompletion;
	readonly signal: AbortSignal | undefined;
	readonly replay?: typeof replayContextProjection;
	readonly reportProgress?: (
		operation: KnowledgeAccumulationOperation,
		sizeTarget?: string,
	) => void;
}

/** Reports whether an accumulation performed a complete knowledge replacement. */
type KnowledgeAlgorithmResult =
	| { readonly kind: "noop" }
	| { readonly kind: "written" };

/** Holds one authenticated operation runtime and its configured provider behavior. */
interface ResolvedOperationRuntime {
	readonly operation: KnowledgeOperationConfig;
	readonly runtime: Exclude<
		Awaited<ReturnType<typeof resolveAuxiliaryLlmRuntime>>,
		{ readonly issue: string }
	>["runtime"];
	readonly resolvedThinking?: ReasoningLevel;
}

/** Couples provider response text with the message needed for repair conversation history. */
interface CompletionText {
	readonly response: AssistantMessage;
	readonly text: string;
	readonly rawText: string;
}

/** Extracts and merges current-session knowledge into the active local file. */
export async function runLocalKnowledgeAccumulation(
	options: KnowledgeAlgorithmOptions,
): Promise<KnowledgeAlgorithmResult> {
	throwIfCancelled(options.signal);
	options.reportProgress?.(
		"prepare_local_summary",
		formatA4Fraction(
			options.config.extraction.initialFraction,
			options.config.extraction.maxFractionDenominator,
		),
	);
	const extraction = await resolveOperationRuntime(
		options.ctx,
		options.config.extraction,
	);
	const projected = await (options.replay ?? replayContextProjection)({
		branchEntries: options.branchEntries,
		cwd: options.ctx.cwd,
		loadedSkillRoots: options.loadedSkillRoots,
	});
	const extractionRequest: ExtractionRequest = {
		knowledgeBlock: renderKnowledgeBlock(options.snapshots),
		source: formatSummarySource(convertToLlm(projected)),
		taskPrompt: extraction.operation.taskPrompt,
	};
	const extracted = await extractKnowledge(
		options,
		extraction,
		extractionRequest,
		options.config.localTokenLimit,
	);
	if (extracted === null) {
		return { kind: "noop" };
	}

	options.reportProgress?.(
		"merge_local_knowledge",
		formatA4Fraction(
			options.config.mergeLocal.initialFraction,
			options.config.mergeLocal.maxFractionDenominator,
		),
	);
	const merge = await resolveOperationRuntime(
		options.ctx,
		options.config.mergeLocal,
	);
	const target: KnowledgeTarget = {
		scope: "local",
		path: options.branchPaths.knowledgeFile,
	};
	await mergeAndReplace({
		options,
		operation: merge,
		target,
		existing: options.snapshots.local,
		incoming: extracted,
	});
	await options.owner.replaceIdentityMetadata(
		options.projectPaths.identityFile,
		options.identityMetadata,
	);
	return { kind: "written" };
}

/** Merges changed local knowledge into global knowledge without changing local storage. */
export async function runGlobalKnowledgeAccumulation(
	options: KnowledgeAlgorithmOptions,
): Promise<KnowledgeAlgorithmResult> {
	throwIfCancelled(options.signal);
	const local = options.snapshots.local;
	if (local === null) {
		return { kind: "noop" };
	}

	const nextState = createGlobalMergeState(local);
	const storedState = await options.owner.readGlobalMergeState(
		options.branchPaths.globalMergeStateFile,
	);
	if (storedState?.localKnowledgeDigest === nextState.localKnowledgeDigest) {
		return { kind: "noop" };
	}

	options.reportProgress?.(
		"merge_global_knowledge",
		formatA4Fraction(
			options.config.mergeGlobal.initialFraction,
			options.config.mergeGlobal.maxFractionDenominator,
		),
	);
	const merge = await resolveOperationRuntime(
		options.ctx,
		options.config.mergeGlobal,
	);
	await mergeAndReplace({
		options,
		operation: merge,
		target: {
			scope: "global",
			path: options.projectPaths.globalKnowledgeFile,
		},
		existing: options.snapshots.global,
		incoming: local,
	});
	await options.owner.delete({
		scope: "local",
		path: options.branchPaths.knowledgeFile,
	});
	// The digest becomes authoritative only after the global replacement completed.
	await options.owner.replaceGlobalMergeState(
		options.branchPaths.globalMergeStateFile,
		nextState,
	);
	await options.owner.replaceIdentityMetadata(
		options.projectPaths.identityFile,
		options.identityMetadata,
	);
	return { kind: "written" };
}

/** Carries the immutable extraction source plus the current size-target state. */
interface ExtractionRequest {
	readonly knowledgeBlock: string | null;
	readonly source: string;
	readonly taskPrompt: string;
}

/** Tracks one extraction attempt's fraction, token ceiling, and format-repair history. */
interface ExtractionAttemptState {
	readonly request: ExtractionRequest;
	readonly tokenLimit: number;
	readonly fraction: number;
	readonly context: Context;
}

/** Runs finite extraction repair and distinguishes only the exact no-op marker. */
function extractKnowledge(
	options: KnowledgeAlgorithmOptions,
	operation: ResolvedOperationRuntime,
	request: ExtractionRequest,
	tokenLimit: number,
): Promise<string | null> {
	const initialFraction = operation.operation.initialFraction;
	return extractKnowledgeAttempt(options, operation, {
		request,
		tokenLimit,
		fraction: initialFraction,
		context: buildExtractionContext(operation, request, initialFraction),
	});
}

/**
 * Performs one sequential extraction attempt with size repair only.
 * Truncated or oversized output is retried with a reduced target; empty output violates the contract.
 */
async function extractKnowledgeAttempt(
	options: KnowledgeAlgorithmOptions,
	operation: ResolvedOperationRuntime,
	state: ExtractionAttemptState,
): Promise<string | null> {
	const completion = await completeText(options, operation, state.context);
	if (completion.rawText === NOT_FOUND) {
		return null;
	}
	if (
		completion.response.stopReason === "length" ||
		(completion.text.length > 0 &&
			countKnowledgeTextTokens(completion.text) > state.tokenLimit)
	) {
		// Truncated or oversized extraction is retried with a reduced target and no previous-output history.
		const nextFraction = nextReducedFraction(
			state.fraction,
			operation.operation.reductionCoefficient,
			operation.operation.maxFractionDenominator,
		);
		if (nextFraction === state.fraction) {
			throw new Error(
				"knowledge extraction output exceeds the knowledge token limit or was truncated",
			);
		}
		options.reportProgress?.(
			"extraction_retry",
			formatA4Fraction(
				nextFraction,
				operation.operation.maxFractionDenominator,
			),
		);
		return extractKnowledgeAttempt(options, operation, {
			...state,
			fraction: nextFraction,
			context: buildExtractionContext(operation, state.request, nextFraction),
		});
	}
	if (completion.text.length > 0) {
		return completion.text;
	}
	// Empty extraction output violates the response contract.
	throw new Error(
		`knowledge extraction response contract was not satisfied: ${completion.rawText}`,
	);
}

/** Builds one extraction request with the current A4-page size target. */
function buildExtractionContext(
	operation: ResolvedOperationRuntime,
	request: ExtractionRequest,
	fraction: number,
): Context {
	return {
		systemPrompt: operation.operation.systemPrompt,
		messages: [
			userMessage(
				formatExtractionRequest({
					knowledgeBlock: request.knowledgeBlock,
					source: request.source,
					taskPrompt: request.taskPrompt,
					fraction,
					maxDenominator: operation.operation.maxFractionDenominator,
				}),
			),
		],
		tools: [],
	};
}

/** Runs one merge and retries only size-rejected output with a reduced target. */
async function mergeAndReplace({
	options,
	operation,
	target,
	existing,
	incoming,
}: {
	readonly options: KnowledgeAlgorithmOptions;
	readonly operation: ResolvedOperationRuntime;
	readonly target: KnowledgeTarget;
	readonly existing: string | null;
	readonly incoming: string;
}): Promise<void> {
	await mergeAttempt(options, operation, {
		target,
		existing: existing ?? "",
		incoming,
		taskPrompt: operation.operation.taskPrompt,
		fraction: operation.operation.initialFraction,
	});
}

/** One immutable merge request plus the current size-target state. */
interface MergeAttemptState {
	readonly target: KnowledgeTarget;
	readonly existing: string;
	readonly incoming: string;
	readonly taskPrompt: string;
	readonly fraction: number;
}

/** Performs one sequential merge attempt; each size repair resends the same request with a reduced target. */
async function mergeAttempt(
	options: KnowledgeAlgorithmOptions,
	operation: ResolvedOperationRuntime,
	state: MergeAttemptState,
): Promise<void> {
	const context: Context = {
		systemPrompt: operation.operation.systemPrompt,
		messages: [
			userMessage(
				formatMergeRequest({
					existing: state.existing,
					incoming: state.incoming,
					fraction: state.fraction,
					taskPrompt: state.taskPrompt,
					maxDenominator: operation.operation.maxFractionDenominator,
				}),
			),
		],
		tools: [],
	};
	const completion = await completeText(options, operation, context);
	// Provider truncation is a size defect that cannot be accepted as knowledge.
	if (completion.response.stopReason === "length") {
		await retryMergeWithReducedTarget(options, operation, state);
		return;
	}
	if (completion.text.length === 0) {
		throw new Error("knowledge merge returned no Markdown");
	}
	const replacement = await options.owner.replace(
		state.target,
		completion.text,
	);
	if (replacement.kind === "written") {
		return;
	}
	await retryMergeWithReducedTarget(options, operation, state);
}

/** Re-attempts one merge with a reduced A4-page target or reports exhaustion. */
async function retryMergeWithReducedTarget(
	options: KnowledgeAlgorithmOptions,
	operation: ResolvedOperationRuntime,
	state: MergeAttemptState,
): Promise<void> {
	const nextFraction = nextReducedFraction(
		state.fraction,
		operation.operation.reductionCoefficient,
		operation.operation.maxFractionDenominator,
	);
	if (nextFraction === state.fraction) {
		throw new Error(
			"merge output exceeds the knowledge token limit or was truncated",
		);
	}
	options.reportProgress?.(
		"merge_retry",
		formatA4Fraction(nextFraction, operation.operation.maxFractionDenominator),
	);
	await mergeAttempt(options, operation, {
		...state,
		fraction: nextFraction,
	});
}

/** Performs one authenticated, context-bounded, caller-cancelled model request. */
async function completeText(
	options: KnowledgeAlgorithmOptions,
	operation: ResolvedOperationRuntime,
	context: Context,
): Promise<CompletionText> {
	throwIfCancelled(options.signal);
	if (
		!doesAuxiliaryLlmInputFitContextWindow(context, operation.runtime.model)
	) {
		throw new Error("knowledge model input exceeds its context window");
	}
	const response = await completeAuxiliaryLlm(
		options.completeSimple,
		operation.runtime,
		context,
		buildAuxiliaryLlmOptions(
			operation.operation.thinking ??
				operation.resolvedThinking ??
				options.currentThinking,
			options.signal,
			operation.runtime,
		),
	);
	throwIfCancelled(options.signal);
	if (response.stopReason === "aborted") {
		throw new Error("knowledge model request was cancelled");
	}
	if (response.stopReason === "error") {
		throw new Error(
			typeof response.errorMessage === "string" &&
				response.errorMessage.trim().length > 0
				? response.errorMessage.trim()
				: "knowledge model request failed",
		);
	}
	return {
		response,
		text: getAuxiliaryLlmResponseText(response),
		rawText: response.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n"),
	};
}

/** Resolves the operation-specific model and caller-local authentication at operation time. */
async function resolveOperationRuntime(
	ctx: ExtensionContext,
	operation: KnowledgeOperationConfig,
): Promise<ResolvedOperationRuntime> {
	const result = await resolveAuxiliaryLlmRuntime(ctx, operation.model);
	if ("issue" in result) {
		throw new Error(`knowledge model unavailable: ${result.issue}`);
	}
	return {
		operation,
		runtime: result.runtime,
		...(result.thinking === undefined
			? {}
			: { resolvedThinking: result.thinking }),
	};
}

/** Builds one explicit extraction request that ends with the A4-page size target. */
function formatExtractionRequest(options: {
	readonly knowledgeBlock: string | null;
	readonly source: string;
	readonly taskPrompt: string;
	readonly fraction: number;
	readonly maxDenominator: number;
}): string {
	return [
		...(options.knowledgeBlock === null ? [] : [options.knowledgeBlock, ""]),
		"<summary_source>",
		options.source,
		"</summary_source>",
		"",
		options.taskPrompt,
		"",
		formatSizeTargetBlock(options.fraction, options.maxDenominator),
	].join("\n");
}

/** Serializes projected branch dialogue into one stable text-only source payload. */
function formatSummarySource(
	messages: ReturnType<typeof convertToLlm>,
): string {
	return messages
		.map((message, index) => {
			const textContent = serializeSummaryContent(message.content).trim();
			if (textContent.length === 0) {
				return "";
			}
			return [
				`<message index="${index}" role="${message.role}">`,
				textContent,
				"</message>",
			].join("\n");
		})
		.filter((chunk) => chunk.length > 0)
		.join("\n\n");
}

/** Serializes one projected message payload while dropping non-text helper payloads. */
function serializeSummaryContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (!isRecord(part) || part["type"] !== "text") {
					return "";
				}
				const text = part["text"];
				return typeof text === "string" ? text : "";
			})
			.filter((text) => text.length > 0)
			.join("\n");
	}
	if (isRecord(content)) {
		const text = content["text"];
		return typeof text === "string" ? text : "";
	}
	return "";
}

/** Narrows unknown values to generic string-key records. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Builds the explicit opaque-Markdown merge request ending with the A4-page size target. */
function formatMergeRequest(options: {
	readonly existing: string;
	readonly incoming: string;
	readonly fraction: number;
	readonly taskPrompt: string;
	readonly maxDenominator: number;
}): string {
	return [
		"<stored_knowledge>",
		options.existing,
		"</stored_knowledge>",
		"<incoming_knowledge>",
		options.incoming,
		"</incoming_knowledge>",
		"",
		options.taskPrompt,
		"",
		formatSizeTargetBlock(options.fraction, options.maxDenominator),
	].join("\n");
}

/** Builds the trailing A4-page size-target block without any token information. */
function formatSizeTargetBlock(
	fraction: number,
	maxDenominator: number,
): string {
	return [
		"<target_size>",
		`Output MUST NOT exceed ${formatA4Fraction(fraction, maxDenominator)}. ${A4_PAGE_ANCHOR_TEXT}`,
		"</target_size>",
	].join("\n");
}

/** Creates one explicit user instruction for an isolated auxiliary request. */
function userMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}

/** Stops before any new model or storage work after caller cancellation. */
function throwIfCancelled(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) {
		return;
	}
	throw signal.reason instanceof Error
		? signal.reason
		: new Error("knowledge operation cancelled");
}
