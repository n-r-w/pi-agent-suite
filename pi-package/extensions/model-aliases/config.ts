import {
	readSuiteConfigFile,
	readSuiteConfigFileSync,
	type StorageFileReadResult,
} from "../../shared/agent-suite-storage";
import {
	isModelId,
	isModelSelectorId,
	type ModelSettings,
} from "../../shared/model-settings";
import {
	isReasoningLevel,
	REASONING_LEVELS,
	type ReasoningLevel,
} from "../../shared/reasoning-levels";

/** Suite directory that owns model alias configuration. */
const MODEL_ALIASES_EXTENSION_DIR = "model-aliases";

/** Accepted one-alias config keys. */
const MODEL_ALIAS_KEYS = ["id", "thinking"] as const;

/** Parsed alias target for one model alias name. */
interface ModelAliasTarget {
	readonly id: string;
	readonly thinking?: ReasoningLevel;
}

/** Result of reading and validating model alias configuration. */
type ModelAliasConfigReadResult =
	| {
			readonly kind: "valid";
			readonly config: ReadonlyMap<string, ModelAliasTarget>;
	  }
	| { readonly kind: "invalid"; readonly issue: string };

/** Resolved model settings that can be applied directly to Pi runtime calls. */
export interface ResolvedModelSettings {
	readonly id?: string;
	readonly thinking?: ReasoningLevel;
}

/** Resolves one configured model selection against provider/model IDs and configured aliases. */
export async function resolveModelSettingsWithAliases(
	settings: ModelSettings | undefined,
): Promise<
	{ readonly settings: ResolvedModelSettings } | { readonly issue: string }
> {
	if (settings?.id === undefined) {
		return {
			settings:
				settings === undefined
					? {}
					: {
							...(settings.thinking === undefined
								? {}
								: { thinking: settings.thinking }),
						},
		};
	}
	if (!isModelSelectorId(settings.id)) {
		return { issue: "model id must be a non-empty string" };
	}
	if (isModelId(settings.id)) {
		return { settings };
	}

	const config = await readModelAliasConfig();
	if (config.kind === "invalid") {
		return config;
	}
	const alias = config.config.get(settings.id);
	if (alias === undefined) {
		return { issue: `model alias ${settings.id} was not found` };
	}
	return {
		settings: {
			id: alias.id,
			...(settings.thinking === undefined && alias.thinking !== undefined
				? { thinking: alias.thinking }
				: {}),
			...(settings.thinking !== undefined
				? { thinking: settings.thinking }
				: {}),
		},
	};
}

/** Synchronously resolves one configured model selection against provider/model IDs and configured aliases. */
export function resolveModelSettingsWithAliasesSync(
	settings: ModelSettings | undefined,
): { readonly settings: ResolvedModelSettings } | { readonly issue: string } {
	if (settings?.id === undefined) {
		return {
			settings:
				settings === undefined
					? {}
					: {
							...(settings.thinking === undefined
								? {}
								: { thinking: settings.thinking }),
						},
		};
	}
	if (!isModelSelectorId(settings.id)) {
		return { issue: "model id must be a non-empty string" };
	}
	if (isModelId(settings.id)) {
		return { settings };
	}

	const config = readModelAliasConfigSync();
	if (config.kind === "invalid") {
		return config;
	}
	const alias = config.config.get(settings.id);
	if (alias === undefined) {
		return { issue: `model alias ${settings.id} was not found` };
	}
	return {
		settings: {
			id: alias.id,
			...(settings.thinking === undefined && alias.thinking !== undefined
				? { thinking: alias.thinking }
				: {}),
			...(settings.thinking !== undefined
				? { thinking: settings.thinking }
				: {}),
		},
	};
}

/** Reads and validates model alias config from suite-owned extension storage. */
async function readModelAliasConfig(): Promise<ModelAliasConfigReadResult> {
	const file = await readSuiteConfigFile(MODEL_ALIASES_EXTENSION_DIR);
	if (file.kind === "missing") {
		return { kind: "valid", config: new Map() };
	}
	if (file.kind === "read-error") {
		return {
			kind: "invalid",
			issue: `failed to read ${file.location.displayPath}: ${formatError(file.error)}`,
		};
	}
	return parseModelAliasConfig(file.file);
}

/** Synchronously reads and validates model alias config from suite-owned extension storage. */
function readModelAliasConfigSync(): ModelAliasConfigReadResult {
	const file = readSuiteConfigFileSync(MODEL_ALIASES_EXTENSION_DIR);
	if (file.kind === "missing") {
		return { kind: "valid", config: new Map() };
	}
	if (file.kind === "read-error") {
		return {
			kind: "invalid",
			issue: `failed to read ${file.location.displayPath}: ${formatError(file.error)}`,
		};
	}
	return parseModelAliasConfig(file.file);
}

/** Parses one JSON config file into a strict alias catalog. */
function parseModelAliasConfig(
	file: StorageFileReadResult,
): ModelAliasConfigReadResult {
	let raw: unknown;
	try {
		raw = JSON.parse(file.content);
	} catch (error) {
		return {
			kind: "invalid",
			issue: `failed to parse ${file.displayPath}: ${formatError(error)}`,
		};
	}
	if (!isRecord(raw)) {
		return {
			kind: "invalid",
			issue: `${file.displayPath} must contain a JSON object`,
		};
	}
	const aliases = new Map<string, ModelAliasTarget>();
	for (const [aliasId, aliasTarget] of Object.entries(raw)) {
		if (!isModelSelectorId(aliasId)) {
			return { kind: "invalid", issue: "alias keys must be non-empty" };
		}
		const parsedAlias = parseAliasTarget(aliasId, aliasTarget);
		if ("issue" in parsedAlias) {
			return { kind: "invalid", issue: parsedAlias.issue };
		}
		aliases.set(aliasId, parsedAlias.alias);
	}
	return { kind: "valid", config: aliases };
}

/** Parses and validates one alias target object. */
function parseAliasTarget(
	aliasId: string,
	value: unknown,
): { readonly alias: ModelAliasTarget } | { readonly issue: string } {
	if (!isRecord(value)) {
		return { issue: `${aliasId} must be an object` };
	}
	if (
		!Object.keys(value).every((key) => MODEL_ALIAS_KEYS.includes(key as never))
	) {
		return { issue: `${aliasId} contains unsupported keys` };
	}
	const id = value["id"];
	if (!isModelId(id)) {
		return { issue: `${aliasId}.id must use provider/model` };
	}
	const thinking = value["thinking"];
	if (thinking !== undefined && !isReasoningLevel(thinking)) {
		return {
			issue: `${aliasId}.thinking must be one of ${REASONING_LEVELS.join(", ")}`,
		};
	}
	return {
		alias: {
			id,
			...(thinking === undefined ? {} : { thinking }),
		},
	};
}

/** Checks whether unknown JSON is an object and not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalizes unknown errors into stable config diagnostics. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
