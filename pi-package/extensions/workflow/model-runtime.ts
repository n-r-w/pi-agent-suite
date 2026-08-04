import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	assertThinkingLevelSupported,
	type ModelSettings,
	splitModelId,
} from "../../shared/model-settings";
import type { ReasoningLevel } from "../../shared/reasoning-levels";
import type { WorkflowDefinition } from "./workflow";

type ModelRegistry = ExtensionContext["modelRegistry"];
type WorkflowModelAPI = Pick<
	ExtensionAPI,
	"getThinkingLevel" | "setModel" | "setThinkingLevel"
>;

/** Resolves workflow-owned settings while preserving the selected runtime model. */
export interface WorkflowModelResolution {
	readonly configuredModelId?: string;
	readonly effectiveModelId?: string;
	readonly thinking: ReasoningLevel;
	readonly shouldApplyModel: boolean;
	readonly shouldApplyThinking: boolean;
}

/** Captures runtime values needed to restore a failed workflow operation. */
export interface WorkflowModelApplication {
	readonly previousModel: Model<Api> | undefined;
	readonly previousThinking: ReasoningLevel;
	readonly currentModel: Model<Api> | undefined;
	readonly modelChanged: boolean;
}

/** Resolves model and thinking fields independently for one active workflow stage. */
export function resolveWorkflowModelSettings(
	workflow: WorkflowDefinition,
	stageId: string,
	agentSettings: ModelSettings | undefined,
	currentThinking: ReasoningLevel,
): WorkflowModelResolution {
	const stage = workflow.stages.find(({ id }) => id === stageId);
	if (stage === undefined) {
		throw new Error(`workflow stage ${stageId} was not found`);
	}

	const configuredModelId = stage.model?.id ?? workflow.model?.id;
	const effectiveModelId = configuredModelId ?? agentSettings?.id;
	const explicitThinking =
		stage.model?.thinking ??
		workflow.model?.thinking ??
		agentSettings?.thinking;
	return {
		...(configuredModelId === undefined ? {} : { configuredModelId }),
		...(effectiveModelId === undefined ? {} : { effectiveModelId }),
		thinking: explicitThinking ?? currentThinking,
		shouldApplyModel: effectiveModelId !== undefined,
		shouldApplyThinking:
			explicitThinking !== undefined || configuredModelId !== undefined,
	};
}

/** Applies validated workflow-owned settings without changing session workflow state. */
export async function applyWorkflowModelSettings(
	pi: WorkflowModelAPI,
	modelRegistry: ModelRegistry | undefined,
	currentModel: Model<Api> | undefined,
	resolution: WorkflowModelResolution,
): Promise<WorkflowModelApplication> {
	const previousThinking = pi.getThinkingLevel() as ReasoningLevel;
	const previousModel = currentModel;
	if (!resolution.shouldApplyModel && !resolution.shouldApplyThinking) {
		return {
			previousModel,
			previousThinking,
			currentModel,
			modelChanged: false,
		};
	}

	const targetModel = resolveTargetModel(
		modelRegistry,
		currentModel,
		resolution,
	);
	validateTargetModel(resolution, targetModel);
	const modelChanged =
		resolution.shouldApplyModel &&
		targetModel !== undefined &&
		!sameModel(currentModel, targetModel);
	try {
		await applyResolvedWorkflowModelSettings(
			pi,
			targetModel,
			resolution,
			modelChanged,
		);
	} catch (error) {
		await rollbackWorkflowModelSettings(pi, {
			previousModel,
			previousThinking,
			currentModel: previousModel,
			modelChanged,
		});
		throw error;
	}

	return {
		previousModel,
		previousThinking,
		currentModel: targetModel ?? currentModel,
		modelChanged,
	};
}

/** Validates the target model before any Pi runtime mutation. */
function validateTargetModel(
	resolution: WorkflowModelResolution,
	targetModel: Model<Api> | undefined,
): void {
	if (!resolution.shouldApplyThinking) {
		return;
	}
	if (targetModel === undefined) {
		throw new Error("current model is unavailable");
	}
	assertThinkingLevelSupported(targetModel, resolution.thinking);
}

/** Applies model and thinking changes after validation has completed. */
async function applyResolvedWorkflowModelSettings(
	pi: WorkflowModelAPI,
	targetModel: Model<Api> | undefined,
	resolution: WorkflowModelResolution,
	modelChanged: boolean,
): Promise<void> {
	if (modelChanged && targetModel !== undefined) {
		const applied = await pi.setModel(targetModel);
		if (!applied) {
			throw new Error(
				`model ${targetModel.provider}/${targetModel.id} could not be applied`,
			);
		}
	}
	if (!resolution.shouldApplyThinking) {
		return;
	}
	pi.setThinkingLevel(resolution.thinking);
	if (pi.getThinkingLevel() !== resolution.thinking) {
		throw new Error(
			`thinking level ${resolution.thinking} could not be applied`,
		);
	}
}

/** Restores runtime model and thinking values after a failed workflow operation. */
export async function rollbackWorkflowModelSettings(
	pi: WorkflowModelAPI,
	application: WorkflowModelApplication,
): Promise<void> {
	if (application.modelChanged && application.previousModel !== undefined) {
		const restored = await pi.setModel(application.previousModel);
		if (!restored) {
			throw new Error("previous model could not be restored");
		}
	}
	if (pi.getThinkingLevel() !== application.previousThinking) {
		pi.setThinkingLevel(application.previousThinking);
	}
}

/** Resolves an explicitly configured workflow model or keeps the selected runtime model. */
function resolveTargetModel(
	modelRegistry: ModelRegistry | undefined,
	currentModel: Model<Api> | undefined,
	resolution: WorkflowModelResolution,
): Model<Api> | undefined {
	if (!resolution.shouldApplyModel) {
		return currentModel;
	}
	if (
		modelRegistry === undefined ||
		resolution.effectiveModelId === undefined
	) {
		throw new Error("model registry is unavailable");
	}
	const { provider, id } = splitModelId(resolution.effectiveModelId);
	const model = modelRegistry.find(provider, id);
	if (model === undefined) {
		throw new Error(`model ${resolution.effectiveModelId} was not found`);
	}
	return model as Model<Api>;
}

/** Compares models by the stable provider and model identifier pair. */
function sameModel(
	left: Model<Api> | undefined,
	right: Model<Api> | undefined,
): boolean {
	return left?.provider === right?.provider && left?.id === right?.id;
}
