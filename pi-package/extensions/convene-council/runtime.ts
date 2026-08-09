import type { Api, Model } from "@earendil-works/pi-ai";
import {
	resolveThinkingLevel,
	splitModelId,
} from "../../shared/model-settings";
import { resolveModelSettingsWithAliases } from "../model-aliases/config";
import type {
	ConveneCouncilConfig,
	CouncilContext,
	CouncilRuntime,
	ParticipantConfig,
	ParticipantId,
	ParticipantRuntime,
	Thinking,
} from "./types";

/** Resolves both participant models through the pi model registry. */
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

/** Resolves one participant model and thinking level. */
async function resolveParticipantRuntime(
	ctx: CouncilContext,
	participantId: ParticipantId,
	config: ParticipantConfig,
	currentThinking: Thinking | undefined,
): Promise<
	{ readonly runtime: ParticipantRuntime } | { readonly issue: string }
> {
	const resolvedSettings = await resolveModelSettingsWithAliases(config.model);
	if ("issue" in resolvedSettings) {
		return { issue: `${participantId} ${resolvedSettings.issue}` };
	}
	const model =
		resolvedSettings.settings.id === undefined
			? ctx.model
			: resolveConfiguredModel(ctx, resolvedSettings.settings.id);
	if (model === undefined) {
		return {
			issue:
				resolvedSettings.settings.id === undefined
					? "current model is unavailable"
					: `${participantId} model ${resolvedSettings.settings.id} was not found`,
		};
	}
	const thinking = resolveThinking(
		resolvedSettings.settings.thinking,
		currentThinking,
	);
	let resolvedThinking: Thinking | undefined;
	if (thinking.thinking !== undefined) {
		try {
			resolvedThinking = resolveThinkingLevel(model, thinking.thinking);
		} catch (error) {
			return { issue: error instanceof Error ? error.message : String(error) };
		}
	}

	return {
		runtime: {
			model,
			...(resolvedThinking === undefined ? {} : { thinking: resolvedThinking }),
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
	const { provider, id } = splitModelId(modelId);
	return ctx.modelRegistry.find(provider, id);
}
