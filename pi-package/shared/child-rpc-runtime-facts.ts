import type { Api, Model } from "@mariozechner/pi-ai";
import { getAgentDir, SettingsManager } from "@mariozechner/pi-coding-agent";
import type {
	ChildRpcRuntimeFacts,
	RecoveryEnablement,
} from "./child-rpc-completion";

export interface ChildModelLookup {
	find(provider: string, modelId: string): Model<Api> | undefined;
}

export interface ResolveChildRpcRuntimeFactsOptions {
	readonly modelId: string;
	readonly modelRegistry: ChildModelLookup;
	readonly cwd: string;
	readonly env: Record<string, string>;
}

/** Resolves child recovery facts from the same cwd and agent dir used by the spawned child. */
export function resolveChildRpcRuntimeFacts(
	options: ResolveChildRpcRuntimeFactsOptions,
): ChildRpcRuntimeFacts {
	const [provider, ...modelParts] = options.modelId.split("/");
	const childModelId = modelParts.join("/");
	const model =
		provider !== undefined && childModelId.length > 0
			? options.modelRegistry.find(provider, childModelId)
			: undefined;
	const recovery = resolveChildRecoveryEnablement(options.cwd, options.env);
	return {
		modelProvider: provider ?? "",
		modelId: childModelId,
		contextWindow: model?.contextWindow ?? 0,
		retryEnabled: recovery.retryEnabled,
		compactionEnabled: recovery.compactionEnabled,
	};
}

/** Resolves child retry and compaction settings without mutating Pi settings. */
function resolveChildRecoveryEnablement(
	cwd: string,
	env: Record<string, string>,
): {
	readonly retryEnabled: RecoveryEnablement;
	readonly compactionEnabled: RecoveryEnablement;
} {
	const settings = SettingsManager.create(
		cwd,
		env["PI_CODING_AGENT_DIR"] ?? getAgentDir(),
	);
	const retryEnabled = settings.getRetrySettings().enabled;
	const compactionEnabled = settings.getCompactionSettings().enabled;
	const errors = settings.drainErrors();
	return errors.length === 0
		? { retryEnabled, compactionEnabled }
		: { retryEnabled: "unverified", compactionEnabled: "unverified" };
}
