import { readFileSync } from "node:fs";
import {
	getSuiteConfigLocation,
	isFileNotFoundError,
} from "../../shared/agent-suite-storage";
import {
	formatSupportedSchemeIssue,
	isSupportedScheme,
	type SupportedScheme,
} from "./editor-url";

/** Suite directory owned only by this extension. */
const URL_SCHEME_EXTENSION_DIR = "url-scheme";

/** Config key that disables all behavior owned by this extension. */
const ENABLED_CONFIG_KEY = "enabled";

/** Config key that selects the editor URL scheme formatter. */
const SCHEME_CONFIG_KEY = "scheme";

/** Config keys accepted by the url-scheme config object. */
const URL_SCHEME_CONFIG_KEYS = [ENABLED_CONFIG_KEY, SCHEME_CONFIG_KEY] as const;

/** Raw config values accepted after strict JSON validation. */
interface UrlSchemeRawConfig {
	readonly enabled?: boolean;
	readonly scheme?: SupportedScheme;
}

/** Effective config used by lifecycle handlers after defaults are applied. */
export interface UrlSchemeConfig {
	readonly enabled: boolean;
	readonly scheme: SupportedScheme;
}

/** Config read result that keeps invalid config fail-closed. */
export type UrlSchemeConfigResult =
	| { readonly kind: "valid"; readonly config: UrlSchemeConfig }
	| { readonly kind: "invalid"; readonly issue: string };

/** Minimal object shape needed before reading dynamic fields. */
type UnknownRecord = Record<string, unknown>;

/** Reads and validates suite-owned config while missing config keeps url-scheme disabled. */
export function readUrlSchemeConfig(): UrlSchemeConfigResult {
	const configLocation = getSuiteConfigLocation(URL_SCHEME_EXTENSION_DIR);

	let content: string;
	try {
		content = readFileSync(configLocation.path, "utf8");
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return {
				kind: "valid",
				config: buildUrlSchemeConfig({}),
			};
		}

		return invalidConfig(`failed to read config: ${formatError(error)}`);
	}

	try {
		const config: unknown = JSON.parse(content);
		return parseUrlSchemeConfig(config);
	} catch (error) {
		return invalidConfig(`failed to parse config: ${formatError(error)}`);
	}
}

/** Parses config JSON before lifecycle logic uses it to rewrite assistant text. */
function parseUrlSchemeConfig(config: unknown): UrlSchemeConfigResult {
	if (!isRecord(config)) {
		return invalidConfig("config must be an object");
	}

	const unsupportedKey = Object.keys(config).find(
		(key) =>
			!URL_SCHEME_CONFIG_KEYS.includes(
				key as (typeof URL_SCHEME_CONFIG_KEYS)[number],
			),
	);
	if (unsupportedKey !== undefined) {
		return invalidConfig("config contains unsupported keys");
	}

	const rawConfig = parseUrlSchemeFields(config);
	if (rawConfig.kind === "invalid") {
		return rawConfig;
	}

	return {
		kind: "valid",
		config: buildUrlSchemeConfig(rawConfig.config),
	};
}

/** Parses known config fields after object shape and key ownership are proven. */
function parseUrlSchemeFields(
	config: UnknownRecord,
):
	| { readonly kind: "valid"; readonly config: UrlSchemeRawConfig }
	| { readonly kind: "invalid"; readonly issue: string } {
	const enabled = config[ENABLED_CONFIG_KEY];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return invalidConfig("enabled must be a boolean");
	}

	const scheme = config[SCHEME_CONFIG_KEY];
	if (scheme !== undefined && !isSupportedScheme(scheme)) {
		return invalidConfig(formatSupportedSchemeIssue());
	}

	return {
		kind: "valid",
		config: {
			...(enabled === undefined ? {} : { enabled }),
			...(scheme === undefined ? {} : { scheme }),
		},
	};
}

/** Builds effective config by applying extension defaults to omitted fields. */
function buildUrlSchemeConfig(config: UrlSchemeRawConfig): UrlSchemeConfig {
	return {
		enabled: config.enabled ?? false,
		scheme: config.scheme ?? "vscode",
	};
}

/** Builds fail-closed config result with an isolated extension issue. */
function invalidConfig(
	issue: string,
): UrlSchemeConfigResult & { readonly kind: "invalid" } {
	return {
		kind: "invalid",
		issue,
	};
}

/** Returns true when an unknown value is safe for dynamic property reads. */
function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null;
}

/** Formats unknown errors without exposing unsafe structured payloads. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
