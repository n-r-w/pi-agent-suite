import {
	type Api,
	getSupportedThinkingLevels,
	type Model,
} from "@earendil-works/pi-ai";
import {
	isReasoningLevel,
	REASONING_LEVELS,
	type ReasoningLevel,
} from "./reasoning-levels";

/** Orders reasoning levels from the least to the most intensive. */
const THINKING_LEVEL_ORDER: readonly ReasoningLevel[] = REASONING_LEVELS;

/** Maps levels that have equivalent user intent. */
const THINKING_LEVEL_MATES: Readonly<
	Partial<Record<ReasoningLevel, ReasoningLevel>>
> = {
	minimal: "low",
	low: "minimal",
	medium: "high",
	high: "medium",
};

/** Lists the fields accepted by every nested model settings object. */
export const MODEL_SETTINGS_KEYS = ["id", "thinking"] as const;

/** Describes independently optional model and thinking settings. */
export interface ModelSettings {
	readonly id?: string;
	readonly thinking?: ReasoningLevel;
}

/** Returns true when a model selector identifier is a non-empty string. */
export function isModelSelectorId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** Returns true when a model identifier contains non-empty provider and model parts. */
export function isModelId(value: unknown): value is string {
	if (!isModelSelectorId(value)) {
		return false;
	}

	const separatorIndex = value.indexOf("/");
	return separatorIndex > 0 && separatorIndex < value.length - 1;
}

/** Splits a validated provider/model identifier at its first separator. */
export function splitModelId(modelId: string): {
	readonly provider: string;
	readonly id: string;
} {
	const separatorIndex = modelId.indexOf("/");
	if (separatorIndex <= 0 || separatorIndex === modelId.length - 1) {
		throw new Error(`model ${modelId} must use provider/model`);
	}
	return {
		provider: modelId.slice(0, separatorIndex),
		id: modelId.slice(separatorIndex + 1),
	};
}

/** Resolves a valid thinking level to the nearest level the model supports. */
export function resolveThinkingLevel(
	model: Model<Api>,
	thinking: ReasoningLevel,
	fieldPath = "thinking",
): ReasoningLevel {
	if (!isReasoningLevel(thinking)) {
		throw new Error(
			`${fieldPath} must be one of ${REASONING_LEVELS.join(", ")}`,
		);
	}
	const supportedLevels = getSupportedThinkingLevels(
		model,
	) as readonly ReasoningLevel[];
	if (supportedLevels.includes(thinking)) {
		return thinking;
	}

	const mate = THINKING_LEVEL_MATES[thinking];
	if (mate !== undefined && supportedLevels.includes(mate)) {
		return mate;
	}

	const requestedIndex = THINKING_LEVEL_ORDER.indexOf(thinking);
	for (
		let index = requestedIndex + 1;
		index < THINKING_LEVEL_ORDER.length;
		index += 1
	) {
		const candidate = THINKING_LEVEL_ORDER[index];
		if (candidate !== undefined && supportedLevels.includes(candidate)) {
			return candidate;
		}
	}
	for (let index = requestedIndex - 1; index >= 0; index -= 1) {
		const candidate = THINKING_LEVEL_ORDER[index];
		if (candidate !== undefined && supportedLevels.includes(candidate)) {
			return candidate;
		}
	}
	return "off";
}

/** Returns true when a value is a closed model settings object. */
export function isModelSettings(value: unknown): value is ModelSettings {
	if (!isRecord(value)) {
		return false;
	}
	if (
		!Object.keys(value).every((key) =>
			MODEL_SETTINGS_KEYS.includes(key as never),
		)
	) {
		return false;
	}

	const { id, thinking } = value;
	return (
		(id === undefined || isModelSelectorId(id)) &&
		(thinking === undefined || isReasoningLevel(thinking))
	);
}

/** Parses one optional model settings object and reports its boundary path in errors. */
export function parseModelSettings(
	value: unknown,
	fieldPath: string,
): ModelSettings | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new Error(`${fieldPath} must be an object`);
	}
	if (
		!Object.keys(value).every((key) =>
			MODEL_SETTINGS_KEYS.includes(key as never),
		)
	) {
		throw new Error(`${fieldPath} contains unsupported keys`);
	}

	const { id, thinking } = value;
	if (id !== undefined && !isModelSelectorId(id)) {
		throw new Error(`${fieldPath}.id must be a non-empty string`);
	}
	if (thinking !== undefined && !isReasoningLevel(thinking)) {
		throw new Error(`${fieldPath}.thinking is invalid`);
	}

	return {
		...(typeof id === "string" ? { id } : {}),
		...(isReasoningLevel(thinking) ? { thinking } : {}),
	};
}

/** Returns true when a runtime value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
