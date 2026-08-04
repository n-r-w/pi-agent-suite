import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModelSettingsWithAliases } from "../extensions/model-aliases/config";
import { createAuxiliaryLlmSessionId } from "./auxiliary-llm-session";
import { estimateSerializedInputTokens } from "./context-size";
import { assertThinkingLevelSupported, splitModelId } from "./model-settings";
import type { ReasoningLevel } from "./reasoning-levels";

/** Provides the caller-local model registry and current model. */
export interface AuxiliaryLlmContext {
	readonly model: Model<Api> | undefined;
	readonly modelRegistry: Pick<
		ExtensionContext["modelRegistry"],
		"find" | "getApiKeyAndHeaders"
	>;
}

/** Carries one authenticated model without exposing credentials to model context. */
export interface AuxiliaryLlmRuntime {
	readonly model: Model<Api>;
	readonly apiKey?: string;
	readonly headers?: Record<string, string>;
}

/** Reports either an authenticated runtime or one safe resolution issue. */
type AuxiliaryLlmRuntimeResult =
	| {
			readonly runtime: AuxiliaryLlmRuntime;
			readonly thinking?: ReasoningLevel;
	  }
	| { readonly issue: string };

/** Defines the injected one-request completion boundary used by helper tools. */
export type AuxiliaryLlmCompletion = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

/** Resolves the configured or current model and its caller-local authentication. */
export async function resolveAuxiliaryLlmRuntime(
	ctx: AuxiliaryLlmContext,
	modelId: string | undefined,
	thinking: ReasoningLevel | undefined = undefined,
): Promise<AuxiliaryLlmRuntimeResult> {
	const resolvedSettings = await resolveModelSettingsWithAliases(
		modelId === undefined
			? undefined
			: {
					id: modelId,
					...(thinking === undefined ? {} : { thinking }),
				},
	);
	if ("issue" in resolvedSettings) {
		return { issue: resolvedSettings.issue };
	}

	const model = resolveRuntimeModel(ctx, resolvedSettings.settings.id);
	if (model === undefined) {
		return {
			issue:
				resolvedSettings.settings.id === undefined
					? "current model is unavailable"
					: `model ${resolvedSettings.settings.id} was not found`,
		};
	}

	const effectiveThinking = resolvedSettings.settings.thinking;
	const supportedThinking = ensureThinkingSupported(model, effectiveThinking);
	if (typeof supportedThinking === "string") {
		return { issue: supportedThinking };
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { issue: `model auth unavailable: ${auth.error}` };
	}
	return {
		runtime: {
			model,
			...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
			...(auth.headers === undefined ? {} : { headers: auth.headers }),
		},
		...(effectiveThinking === undefined ? {} : { thinking: effectiveThinking }),
	};
}

/** Builds isolated provider options for one caller-cancelled auxiliary request. */
export function buildAuxiliaryLlmOptions(
	thinking: ReasoningLevel | undefined,
	signal: AbortSignal | undefined,
	runtime: AuxiliaryLlmRuntime,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = {
		sessionId: createAuxiliaryLlmSessionId(),
	};
	if (signal !== undefined) {
		options.signal = signal;
	}
	if (runtime.apiKey !== undefined) {
		options.apiKey = runtime.apiKey;
	}
	if (runtime.headers !== undefined) {
		options.headers = runtime.headers;
	}
	if (thinking !== undefined && thinking !== "off") {
		options.reasoning = thinking;
	}
	return options;
}

/** Rejects serialized auxiliary input that exceeds the selected model window. */
export function doesAuxiliaryLlmInputFitContextWindow(
	context: Context,
	model: Model<Api>,
): boolean {
	return (
		estimateSerializedInputTokens(context, model.id, model.provider) <=
		model.contextWindow
	);
}

/** Performs exactly one tool-less auxiliary model request. */
export function completeAuxiliaryLlm(
	complete: AuxiliaryLlmCompletion,
	runtime: AuxiliaryLlmRuntime,
	context: Context,
	options: SimpleStreamOptions,
): Promise<AssistantMessage> {
	return complete(runtime.model, context, options);
}

/** Extracts all text response blocks in provider order. */
export function getAuxiliaryLlmResponseText(message: AssistantMessage): string {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/** Resolves provider/model against the caller's current model registry. */
function resolveConfiguredModel(
	ctx: AuxiliaryLlmContext,
	modelId: string,
): Model<Api> | undefined {
	const { provider, id } = splitModelId(modelId);
	return ctx.modelRegistry.find(provider, id);
}

/** Resolves either the current model or one configured provider/model identifier. */
function resolveRuntimeModel(
	ctx: AuxiliaryLlmContext,
	modelId: string | undefined,
): Model<Api> | undefined {
	return modelId === undefined
		? ctx.model
		: resolveConfiguredModel(ctx, modelId);
}

/** Verifies optional reasoning support and returns the error message when unsupported. */
function ensureThinkingSupported(
	model: Model<Api>,
	thinking: ReasoningLevel | undefined,
): true | string {
	if (thinking === undefined) {
		return true;
	}
	try {
		assertThinkingLevelSupported(model, thinking);
		return true;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
