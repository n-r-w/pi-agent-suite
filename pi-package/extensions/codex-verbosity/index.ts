import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readExtensionConfigFile } from "../../shared/agent-suite-storage";

/** Provider name used by the built-in OpenAI provider. */
const OPENAI_PROVIDER = "openai";

/** Provider API used by OpenAI Codex responses requests. */
const OPENAI_CODEX_API = "openai-codex-responses";

/** Suite directory owned only by this extension. */
const CODEX_VERBOSITY_EXTENSION_DIR = "codex-verbosity";

/** Legacy config file name supported for existing installations. */
const CODEX_VERBOSITY_LEGACY_CONFIG_FILE = "codex-verbosity.json";

/** Accepted verbosity values supported by the OpenAI Codex request payload. */
const CODEX_VERBOSITY_VALUES = ["low", "medium", "high"] as const;

/** Default verbosity applied when the extension is explicitly enabled without a custom value. */
const DEFAULT_CODEX_VERBOSITY: CodexVerbosity = "medium";

/** Config key that disables or enables Codex verbosity injection. */
const ENABLED_CONFIG_KEY = "enabled";

/** Config key that carries the requested Codex verbosity. */
const VERBOSITY_CONFIG_KEY = "verbosity";

/** Config keys accepted by this extension. */
const CODEX_VERBOSITY_CONFIG_KEYS = [
	ENABLED_CONFIG_KEY,
	VERBOSITY_CONFIG_KEY,
] as const;

/** Provider payload key that carries text generation options. */
const TEXT_PAYLOAD_KEY = "text";

type CodexVerbosity = (typeof CODEX_VERBOSITY_VALUES)[number];

type VerbosityConfigResult =
	| { readonly kind: "disabled" }
	| { readonly kind: "valid"; readonly verbosity: CodexVerbosity }
	| { readonly kind: "invalid"; readonly issue: string };

/** Model fields used to decide whether this provider request belongs to OpenAI Codex. */
interface ProviderRequestModel {
	readonly provider?: string;
	readonly api?: string;
}

/** Returns true only for OpenAI Codex provider requests owned by this extension. */
function shouldHandleRequest(model: ProviderRequestModel | undefined): boolean {
	return model?.provider === OPENAI_PROVIDER && model.api === OPENAI_CODEX_API;
}

/** Reads and parses the extension config without leaking failures outside this extension. */
async function readConfiguredVerbosity(): Promise<VerbosityConfigResult> {
	const configFile = await readExtensionConfigFile({
		extensionDir: CODEX_VERBOSITY_EXTENSION_DIR,
		legacyConfigFileName: CODEX_VERBOSITY_LEGACY_CONFIG_FILE,
	});
	if (configFile.kind === "missing") {
		return { kind: "disabled" };
	}
	if (configFile.kind === "read-error") {
		return {
			kind: "invalid",
			issue: `failed to read ${configFile.location.displayPath}: ${formatError(configFile.error)}`,
		};
	}

	try {
		const config: unknown = JSON.parse(configFile.file.content);

		return parseConfiguredVerbosity(config, configFile.file.displayPath);
	} catch (error) {
		return {
			kind: "invalid",
			issue: `failed to parse ${configFile.file.displayPath}: ${formatError(error)}`,
		};
	}
}

/** Parses config JSON into a typed result before request mutation logic can use it. */
function parseConfiguredVerbosity(
	config: unknown,
	configDisplayPath: string,
): VerbosityConfigResult {
	if (!isRecord(config)) {
		return {
			kind: "invalid",
			issue: `${configDisplayPath} must contain a JSON object`,
		};
	}

	const unsupportedKey = Object.keys(config).find(
		(key) =>
			!CODEX_VERBOSITY_CONFIG_KEYS.includes(
				key as (typeof CODEX_VERBOSITY_CONFIG_KEYS)[number],
			),
	);
	if (unsupportedKey !== undefined) {
		return {
			kind: "invalid",
			issue: `unsupported key "${unsupportedKey}" in ${configDisplayPath}`,
		};
	}

	const enabled = config[ENABLED_CONFIG_KEY];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return {
			kind: "invalid",
			issue: `${ENABLED_CONFIG_KEY} must be a boolean`,
		};
	}
	if (enabled !== true) {
		return { kind: "disabled" };
	}

	const verbosity = config[VERBOSITY_CONFIG_KEY];
	if (verbosity === undefined) {
		return { kind: "valid", verbosity: DEFAULT_CODEX_VERBOSITY };
	}

	if (!isCodexVerbosity(verbosity)) {
		return {
			kind: "invalid",
			issue: `${VERBOSITY_CONFIG_KEY} must be one of ${CODEX_VERBOSITY_VALUES.join(", ")}`,
		};
	}

	return { kind: "valid", verbosity };
}

/** Returns existing text object fields that must survive verbosity injection. */
function getExistingTextPayload(payload: unknown): Record<string, unknown> {
	if (!isRecord(payload)) {
		return {};
	}

	const text = payload[TEXT_PAYLOAD_KEY];
	if (!isRecord(text)) {
		return {};
	}

	return text;
}

/** Returns true when a runtime value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns true when a runtime value is an accepted Codex verbosity. */
function isCodexVerbosity(value: unknown): value is CodexVerbosity {
	return (
		typeof value === "string" &&
		(CODEX_VERBOSITY_VALUES as readonly string[]).includes(value)
	);
}

/** Converts unknown failures into safe diagnostics for config issue messages. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Reports an invalid config without interrupting other extensions or the provider request. */
function reportConfigIssue(
	ctx: {
		readonly hasUI?: boolean;
		readonly ui: {
			notify(message: string, type?: "info" | "warning" | "error"): void;
		};
	},
	issue: string,
): void {
	if (ctx.hasUI === false) {
		return;
	}

	ctx.ui.notify(`[codex-verbosity] ${issue}`, "warning");
}

/** Extension entry point for OpenAI Codex verbosity request handling. */
export default function codexVerbosity(pi: ExtensionAPI): void {
	pi.on("before_provider_request", async (event, ctx) => {
		if (!shouldHandleRequest(ctx.model)) {
			return undefined;
		}

		const config = await readConfiguredVerbosity();
		if (config.kind === "invalid") {
			reportConfigIssue(ctx, config.issue);
			return undefined;
		}
		if (config.kind === "disabled") {
			return undefined;
		}

		return {
			...(isRecord(event.payload) ? event.payload : {}),
			text: {
				...getExistingTextPayload(event.payload),
				verbosity: config.verbosity,
			},
		};
	});
}
