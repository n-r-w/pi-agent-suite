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
import type { KnowledgeSnapshots } from "../../shared/knowledge-runtime";
import type { ReasoningLevel } from "../../shared/reasoning-levels";
import type { KnowledgeConfig, KnowledgeOperationConfig } from "./config";
import type { IdentityMetadata } from "./git-context";
import {
	createGlobalMergeState,
	type GlobalMergeState,
	type KnowledgeReplacementResult,
	type KnowledgeTarget,
} from "./owner";
import type { BranchPaths, ProjectPaths } from "./paths";

const NOT_FOUND = "NOT_FOUND";

/** Storage operations used by accumulation after the root grants a scoped lease. */
interface KnowledgeAlgorithmOwner {
	replace(
		target: KnowledgeTarget,
		text: string,
	): Promise<KnowledgeReplacementResult>;
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
}

/** Reports whether an accumulation performed a complete knowledge replacement. */
export type KnowledgeAlgorithmResult =
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
	const extraction = await resolveOperationRuntime(
		options.ctx,
		options.config.extraction,
	);
	const projected = await (options.replay ?? replayContextProjection)({
		branchEntries: options.branchEntries,
		cwd: options.ctx.cwd,
		loadedSkillRoots: options.loadedSkillRoots,
	});
	const extractionContext: Context = {
		systemPrompt: extraction.operation.systemPrompt,
		messages: convertToLlm(projected),
		tools: [],
	};
	const extracted = await extractKnowledge(
		options,
		extraction,
		extractionContext,
	);
	if (extracted === null) {
		return { kind: "noop" };
	}

	const merge = await resolveOperationRuntime(
		options.ctx,
		options.config.merge,
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
		tokenLimit: options.config.localTokenLimit,
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

	const merge = await resolveOperationRuntime(
		options.ctx,
		options.config.merge,
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
		tokenLimit: options.config.globalTokenLimit,
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

/** Runs finite extraction-format repair and distinguishes only the exact no-op marker. */
function extractKnowledge(
	options: KnowledgeAlgorithmOptions,
	operation: ResolvedOperationRuntime,
	context: Context,
): Promise<string | null> {
	return extractKnowledgeAttempt(options, operation, context, 0);
}

/** Performs one sequential extraction attempt because each repair depends on prior output. */
async function extractKnowledgeAttempt(
	options: KnowledgeAlgorithmOptions,
	operation: ResolvedOperationRuntime,
	context: Context,
	attempt: number,
): Promise<string | null> {
	const completion = await completeText(options, operation, context);
	if (completion.rawText === NOT_FOUND) {
		return null;
	}
	if (completion.text.length > 0 && !completion.rawText.includes(NOT_FOUND)) {
		return completion.text;
	}
	if (attempt === operation.operation.retryCount) {
		throw new Error("knowledge extraction response contract was not satisfied");
	}
	context.messages.push(
		completion.response,
		userMessage(
			"Return non-empty concise Markdown, or return exactly NOT_FOUND with no other text.",
		),
	);
	return extractKnowledgeAttempt(options, operation, context, attempt + 1);
}

/** Retries only oversized merge output and writes the first response within the owner limit. */
async function mergeAndReplace({
	options,
	operation,
	target,
	existing,
	incoming,
	tokenLimit,
}: {
	readonly options: KnowledgeAlgorithmOptions;
	readonly operation: ResolvedOperationRuntime;
	readonly target: KnowledgeTarget;
	readonly existing: string | null;
	readonly incoming: string;
	readonly tokenLimit: number;
}): Promise<void> {
	const context: Context = {
		systemPrompt: operation.operation.systemPrompt,
		messages: [
			userMessage(formatMergeRequest(existing ?? "", incoming, tokenLimit)),
		],
		tools: [],
	};
	await mergeAttempt(options, operation, { target, context, attempt: 0 });
}

/** Performs one sequential merge attempt because each size repair depends on its tokenizer count. */
async function mergeAttempt(
	options: KnowledgeAlgorithmOptions,
	operation: ResolvedOperationRuntime,
	state: {
		readonly target: KnowledgeTarget;
		readonly context: Context;
		readonly attempt: number;
	},
): Promise<void> {
	const completion = await completeText(options, operation, state.context);
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
	if (state.attempt === operation.operation.retryCount) {
		throw new Error("merge output exceeds the knowledge token limit");
	}
	state.context.messages.push(
		completion.response,
		userMessage(
			`The merge output contains ${replacement.tokenCount} tokens. Return a complete replacement containing at most ${replacement.tokenLimit} tokens; the limit is unchanged.`,
		),
	);
	await mergeAttempt(options, operation, {
		target: state.target,
		context: state.context,
		attempt: state.attempt + 1,
	});
}

/** Performs one authenticated, context-bounded, caller-cancelled model request. */
async function completeText(
	options: KnowledgeAlgorithmOptions,
	operation: ResolvedOperationRuntime,
	context: Context,
): Promise<CompletionText> {
	throwIfCancelled(options.signal);
	// Each request receives a stable snapshot so later repair messages cannot mutate prior call evidence.
	const requestContext: Context = {
		...context,
		messages: [...context.messages],
	};
	if (
		!doesAuxiliaryLlmInputFitContextWindow(
			requestContext,
			operation.runtime.model,
		)
	) {
		throw new Error("knowledge model input exceeds its context window");
	}
	const response = await completeAuxiliaryLlm(
		options.completeSimple,
		operation.runtime,
		requestContext,
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
		throw new Error("knowledge model request failed");
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

/** Builds the explicit opaque-Markdown merge request shared by local and global accumulation. */
function formatMergeRequest(
	existing: string,
	incoming: string,
	tokenLimit: number,
): string {
	return [
		`The complete replacement must contain at most ${tokenLimit} tokens.`,
		"<stored_knowledge>",
		existing,
		"</stored_knowledge>",
		"<incoming_knowledge>",
		incoming,
		"</incoming_knowledge>",
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
