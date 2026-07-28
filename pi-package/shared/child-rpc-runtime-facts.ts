import type { Api, Model } from "@earendil-works/pi-ai";
import type { ChildRpcRuntimeFacts } from "./child-rpc-completion";

export interface ChildModelLookup {
	find(provider: string, modelId: string): Model<Api> | undefined;
}

export interface ResolveChildRpcRuntimeFactsOptions {
	readonly modelId: string;
	readonly modelRegistry: ChildModelLookup;
}

/** Resolves the child model facts needed to classify an unrecovered context overflow. */
export function resolveChildRpcRuntimeFacts(
	options: ResolveChildRpcRuntimeFactsOptions,
): ChildRpcRuntimeFacts {
	const [provider, ...modelParts] = options.modelId.split("/");
	const childModelId = modelParts.join("/");
	const model =
		provider !== undefined && childModelId.length > 0
			? options.modelRegistry.find(provider, childModelId)
			: undefined;
	return {
		modelProvider: provider ?? "",
		modelId: childModelId,
		contextWindow: model?.contextWindow ?? 0,
	};
}
