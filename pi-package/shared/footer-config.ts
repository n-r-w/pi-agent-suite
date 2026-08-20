import { readExtensionConfigFile } from "./agent-suite-storage";

const FOOTER_EXTENSION_DIR = "footer";
const FOOTER_LEGACY_CONFIG_FILE = "footer.json";
const ENABLED_CONFIG_KEY = "enabled";
const SHOW_PROVIDER_CONFIG_KEY = "showProvider";
const SHOW_MODEL_CONFIG_KEY = "showModel";
const SHOW_THINKING_LEVEL_CONFIG_KEY = "showThinkingLevel";
const SHOW_API_COST_CONFIG_KEY = "showApiCost";
const SHOW_CACHE_HIT_RATE_CONFIG_KEY = "showCacheHitRate";
const SHOW_GIT_BRANCH_CONFIG_KEY = "showGitBranch";
const SHOW_ADDITIONAL_STATUS_LINE_CONFIG_KEY = "showAdditionalStatusLine";

const FOOTER_DISPLAY_CONFIG_KEYS = [
	SHOW_PROVIDER_CONFIG_KEY,
	SHOW_MODEL_CONFIG_KEY,
	SHOW_THINKING_LEVEL_CONFIG_KEY,
	SHOW_API_COST_CONFIG_KEY,
	SHOW_CACHE_HIT_RATE_CONFIG_KEY,
	SHOW_GIT_BRANCH_CONFIG_KEY,
	SHOW_ADDITIONAL_STATUS_LINE_CONFIG_KEY,
] as const;

const FOOTER_CONFIG_KEYS = [
	ENABLED_CONFIG_KEY,
	...FOOTER_DISPLAY_CONFIG_KEYS,
] as const;

export interface FooterConfig {
	readonly showProvider: boolean;
	readonly showModel: boolean;
	readonly showThinkingLevel: boolean;
	readonly showApiCost: boolean;
	readonly showCacheHitRate: boolean;
	readonly showGitBranch: boolean;
	readonly showAdditionalStatusLine: boolean;
}

export type FooterConfigResult =
	| { readonly kind: "enabled"; readonly config: FooterConfig }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid" };

/** Reads footer config while missing config keeps the footer enabled with defaults. */
export async function readFooterConfig(): Promise<FooterConfigResult> {
	const configFile = await readExtensionConfigFile({
		extensionDir: FOOTER_EXTENSION_DIR,
		legacyConfigFileName: FOOTER_LEGACY_CONFIG_FILE,
	});
	if (configFile.kind === "missing") {
		return { kind: "enabled", config: buildFooterConfig({}) };
	}
	if (configFile.kind === "read-error") {
		return { kind: "invalid" };
	}

	try {
		const config: unknown = JSON.parse(configFile.file.content);
		return parseFooterConfig(config);
	} catch {
		return { kind: "invalid" };
	}
}

function parseFooterConfig(config: unknown): FooterConfigResult {
	if (!isRecord(config)) {
		return { kind: "invalid" };
	}

	const unsupportedKey = Object.keys(config).find(
		(key) => !(FOOTER_CONFIG_KEYS as readonly string[]).includes(key),
	);
	if (unsupportedKey !== undefined) {
		return { kind: "invalid" };
	}

	const enabled = config[ENABLED_CONFIG_KEY];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return { kind: "invalid" };
	}
	if (enabled === false) {
		return { kind: "disabled" };
	}

	const invalidDisplayValue = FOOTER_DISPLAY_CONFIG_KEYS.some(
		(key) => config[key] !== undefined && typeof config[key] !== "boolean",
	);
	if (invalidDisplayValue) {
		return { kind: "invalid" };
	}

	return { kind: "enabled", config: buildFooterConfig(config) };
}

function buildFooterConfig(config: Record<string, unknown>): FooterConfig {
	return {
		showProvider: config[SHOW_PROVIDER_CONFIG_KEY] !== false,
		showModel: config[SHOW_MODEL_CONFIG_KEY] !== false,
		showThinkingLevel: config[SHOW_THINKING_LEVEL_CONFIG_KEY] !== false,
		showApiCost: config[SHOW_API_COST_CONFIG_KEY] !== false,
		showCacheHitRate: config[SHOW_CACHE_HIT_RATE_CONFIG_KEY] !== false,
		showGitBranch: config[SHOW_GIT_BRANCH_CONFIG_KEY] === true,
		showAdditionalStatusLine:
			config[SHOW_ADDITIONAL_STATUS_LINE_CONFIG_KEY] !== false,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
