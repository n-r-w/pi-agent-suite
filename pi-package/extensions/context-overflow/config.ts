import { readExtensionConfigFile } from "../../shared/agent-suite-storage";

/** Suite directory owned only by context-overflow. */
const CONTEXT_OVERFLOW_EXTENSION_DIR = "context-overflow";

/** Legacy config file name supported for existing installations. */
const CONTEXT_OVERFLOW_LEGACY_CONFIG_FILE = "context-overflow.json";

/** Default remaining-token reserve that triggers standard compaction. */
const DEFAULT_COMPACT_REMAINING_TOKENS = 49_152;

/** Config key that disables or enables preventive compaction. */
const ENABLED_CONFIG_KEY = "enabled";

/** Config key that carries the remaining-token compaction threshold. */
const COMPACT_REMAINING_TOKENS_CONFIG_KEY = "compactRemainingTokens";

/** Config keys accepted by the context-overflow config object. */
const CONTEXT_OVERFLOW_CONFIG_KEYS = [
	ENABLED_CONFIG_KEY,
	COMPACT_REMAINING_TOKENS_CONFIG_KEY,
] as const;

type ContextOverflowConfigResult =
	| { readonly kind: "valid"; readonly config: ContextOverflowConfig }
	| { readonly kind: "invalid" };

export interface ContextOverflowConfig {
	readonly enabled: boolean;
	readonly compactRemainingTokens: number;
}

/** Reads and parses the context-overflow config while missing config keeps default behavior enabled. */
export async function readContextOverflowConfig(): Promise<ContextOverflowConfigResult> {
	const configFile = await readExtensionConfigFile({
		extensionDir: CONTEXT_OVERFLOW_EXTENSION_DIR,
		legacyConfigFileName: CONTEXT_OVERFLOW_LEGACY_CONFIG_FILE,
	});
	if (configFile.kind === "missing") {
		return {
			kind: "valid",
			config: buildContextOverflowConfig({}),
		};
	}
	if (configFile.kind === "read-error") {
		return { kind: "invalid" };
	}

	try {
		const config: unknown = JSON.parse(configFile.file.content);

		return parseContextOverflowConfig(config);
	} catch {
		return { kind: "invalid" };
	}
}

/** Parses config JSON into the typed context-overflow contract used by turn handling and footer rendering. */
function parseContextOverflowConfig(
	config: unknown,
): ContextOverflowConfigResult {
	if (!isRecord(config)) {
		return { kind: "invalid" };
	}

	const unsupportedKey = Object.keys(config).find(
		(key) =>
			!CONTEXT_OVERFLOW_CONFIG_KEYS.includes(
				key as (typeof CONTEXT_OVERFLOW_CONFIG_KEYS)[number],
			),
	);
	if (unsupportedKey !== undefined) {
		return { kind: "invalid" };
	}

	const enabled = config[ENABLED_CONFIG_KEY];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return { kind: "invalid" };
	}

	const compactRemainingTokens = config[COMPACT_REMAINING_TOKENS_CONFIG_KEY];
	if (
		compactRemainingTokens !== undefined &&
		!isValidCompactRemainingTokens(compactRemainingTokens)
	) {
		return { kind: "invalid" };
	}

	const partialConfig: {
		enabled?: boolean;
		compactRemainingTokens?: number;
	} = {};
	if (enabled !== undefined) {
		partialConfig.enabled = enabled;
	}
	if (compactRemainingTokens !== undefined) {
		partialConfig.compactRemainingTokens = compactRemainingTokens;
	}

	return {
		kind: "valid",
		config: buildContextOverflowConfig(partialConfig),
	};
}

/** Builds the effective config by applying extension defaults to omitted fields. */
function buildContextOverflowConfig(config: {
	readonly enabled?: boolean;
	readonly compactRemainingTokens?: number;
}): ContextOverflowConfig {
	return {
		enabled: config.enabled ?? true,
		compactRemainingTokens:
			config.compactRemainingTokens ?? DEFAULT_COMPACT_REMAINING_TOKENS,
	};
}

/** Returns true when the threshold value is a non-negative integer token count. */
function isValidCompactRemainingTokens(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Returns true when a runtime value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
