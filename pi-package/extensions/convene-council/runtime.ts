import type { Api, Model } from "@mariozechner/pi-ai";
import { hasProviderModelShape } from "./guards";
import type {
	ConveneCouncilConfig,
	CouncilContext,
	CouncilRuntime,
	ParticipantConfig,
	ParticipantId,
	ParticipantRuntime,
	Thinking,
} from "./types";

/** Resolves both participant models and auth through the pi model registry. */
export async function resolveCouncilRuntime(
	ctx: CouncilContext,
	config: ConveneCouncilConfig,
	currentThinking: Thinking | undefined,
): Promise<{ readonly runtime: CouncilRuntime } | { readonly issue: string }> {
	const llm1 = await resolveParticipantRuntime(
		ctx,
		"llm1",
		config.llm1,
		currentThinking,
	);
	if ("issue" in llm1) {
		return llm1;
	}

	const llm2 = await resolveParticipantRuntime(
		ctx,
		"llm2",
		config.llm2,
		currentThinking,
	);
	if ("issue" in llm2) {
		return llm2;
	}

	return { runtime: { llm1: llm1.runtime, llm2: llm2.runtime } };
}

/** Resolves one participant model, auth, and thinking level. */
async function resolveParticipantRuntime(
	ctx: CouncilContext,
	participantId: ParticipantId,
	config: ParticipantConfig,
	currentThinking: Thinking | undefined,
): Promise<
	{ readonly runtime: ParticipantRuntime } | { readonly issue: string }
> {
	const model =
		config.model?.id === undefined
			? ctx.model
			: resolveConfiguredModel(ctx, config.model.id);
	if (model === undefined) {
		return {
			issue:
				config.model?.id === undefined
					? "current model is unavailable"
					: `${participantId} model ${config.model.id} was not found`,
		};
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { issue: `${participantId} model auth unavailable: ${auth.error}` };
	}

	return {
		runtime: {
			model,
			...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
			...(auth.headers !== undefined ? { headers: auth.headers } : {}),
			...resolveThinking(config.model?.thinking, currentThinking),
		},
	};
}

/** Resolves explicit participant thinking before falling back to current thinking. */
function resolveThinking(
	configuredThinking: Thinking | undefined,
	currentThinking: Thinking | undefined,
): { readonly thinking?: Thinking } {
	if (configuredThinking !== undefined) {
		return { thinking: configuredThinking };
	}
	return currentThinking === undefined ? {} : { thinking: currentThinking };
}

/** Resolves a provider/model ID through the model registry. */
function resolveConfiguredModel(
	ctx: CouncilContext,
	modelId: string,
): Model<Api> | undefined {
	if (!hasProviderModelShape(modelId)) {
		return undefined;
	}
	const separatorIndex = modelId.indexOf("/");
	return ctx.modelRegistry.find(
		modelId.slice(0, separatorIndex),
		modelId.slice(separatorIndex + 1),
	);
}
