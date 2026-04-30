import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { getSuiteConfigLocation } from "../../shared/agent-suite-storage";
import {
	CONVENE_COUNCIL_EXTENSION_DIR,
	DEFAULT_FINAL_ANSWER_PARTICIPANT,
	DEFAULT_PARTICIPANT_ITERATION_LIMIT,
	DEFAULT_PROVIDER_REQUEST_RETRIES,
	DEFAULT_PROVIDER_RETRY_DELAY_MS,
	DEFAULT_RESPONSE_DEFECT_RETRIES,
	ENABLED_CONFIG_KEY,
	PARTICIPANT_IDS,
	THINKING_VALUES,
} from "./constants";
import {
	formatError,
	hasOnlyKeys,
	hasProviderModelShape,
	isFileNotFoundError,
	isNonNegativeInteger,
	isParticipantId,
	isPositiveInteger,
	isRecord,
	isThinking,
} from "./guards";
import type {
	ConveneCouncilConfig,
	ParticipantConfig,
	ParticipantId,
	ParticipantModelConfig,
} from "./types";

type ConveneCouncilConfigResult =
	| { readonly disabled: true }
	| { readonly config: ConveneCouncilConfig }
	| { readonly issue: string };

type RawConveneCouncilConfigResult =
	| { readonly rawConfig: string }
	| { readonly issue: string };

/** Returns registration state without treating invalid config as enabled prompt guidance. */
export function readConveneCouncilRegistrationState():
	| { readonly kind: "enabled" }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid" } {
	const configResult = readConveneCouncilConfigSync();
	if ("disabled" in configResult) {
		return { kind: "disabled" };
	}
	if ("issue" in configResult) {
		return { kind: "invalid" };
	}
	return { kind: "enabled" };
}

/** Reads and validates suite-owned council config. */
export async function readConveneCouncilConfig(): Promise<ConveneCouncilConfigResult> {
	return parseRawConveneCouncilConfig(await readRawConveneCouncilConfig());
}

/** Synchronously reads config for registration-time tool and prompt setup. */
function readConveneCouncilConfigSync(): ConveneCouncilConfigResult {
	return parseRawConveneCouncilConfig(readRawConveneCouncilConfigSync());
}

/** Reads raw config text for execution-time validation. */
async function readRawConveneCouncilConfig(): Promise<RawConveneCouncilConfigResult> {
	const location = getSuiteConfigLocation(CONVENE_COUNCIL_EXTENSION_DIR);
	try {
		return { rawConfig: await readFile(location.path, "utf8") };
	} catch (error) {
		return isFileNotFoundError(error)
			? { rawConfig: "{}" }
			: { issue: `failed to read config: ${formatError(error)}` };
	}
}

/** Synchronously reads raw config text for registration-time validation. */
function readRawConveneCouncilConfigSync(): RawConveneCouncilConfigResult {
	const location = getSuiteConfigLocation(CONVENE_COUNCIL_EXTENSION_DIR);
	try {
		return { rawConfig: readFileSync(location.path, "utf8") };
	} catch (error) {
		return isFileNotFoundError(error)
			? { rawConfig: "{}" }
			: { issue: `failed to read config: ${formatError(error)}` };
	}
}

/** Parses raw config text with the same rules for registration and execution. */
function parseRawConveneCouncilConfig(
	configResult: RawConveneCouncilConfigResult,
): ConveneCouncilConfigResult {
	if ("issue" in configResult) {
		return configResult;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(configResult.rawConfig);
	} catch (error) {
		return { issue: `failed to parse config: ${formatError(error)}` };
	}

	const config = parseConveneCouncilConfig(parsed);
	return "issue" in config || "disabled" in config ? config : { config };
}

/** Parses strict council config and applies approved default values. */
function parseConveneCouncilConfig(
	value: unknown,
):
	| ConveneCouncilConfig
	| { readonly disabled: true }
	| { readonly issue: string } {
	const validationResult = validateConveneCouncilConfig(value);
	if ("issue" in validationResult) {
		return validationResult;
	}
	if (validationResult.config[ENABLED_CONFIG_KEY] === false) {
		return { disabled: true };
	}

	const raw = validationResult.config;
	return {
		llm1: parseParticipantConfig(raw["llm1"]),
		llm2: parseParticipantConfig(raw["llm2"]),
		participantIterationLimit: getIntegerConfig(
			raw,
			"participantIterationLimit",
			DEFAULT_PARTICIPANT_ITERATION_LIMIT,
		),
		finalAnswerParticipant: isParticipantId(raw["finalAnswerParticipant"])
			? raw["finalAnswerParticipant"]
			: DEFAULT_FINAL_ANSWER_PARTICIPANT,
		responseDefectRetries: getIntegerConfig(
			raw,
			"responseDefectRetries",
			DEFAULT_RESPONSE_DEFECT_RETRIES,
		),
		providerRequestRetries: getIntegerConfig(
			raw,
			"providerRequestRetries",
			DEFAULT_PROVIDER_REQUEST_RETRIES,
		),
		providerRetryDelayMs: getIntegerConfig(
			raw,
			"providerRetryDelayMs",
			DEFAULT_PROVIDER_RETRY_DELAY_MS,
		),
	};
}

/** Validates raw config before values are trusted by the loop. */
function validateConveneCouncilConfig(
	value: unknown,
): { readonly config: Record<string, unknown> } | { readonly issue: string } {
	if (!isRecord(value)) {
		return { issue: "config must be an object" };
	}
	if (!hasOnlyKeys(value, getConfigKeys())) {
		return { issue: "config contains unsupported keys" };
	}

	const enabled = value[ENABLED_CONFIG_KEY];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return { issue: `${ENABLED_CONFIG_KEY} must be a boolean` };
	}
	if (enabled === false) {
		return { config: value };
	}

	for (const participantId of PARTICIPANT_IDS) {
		const participantIssue = validateParticipantConfig(
			value[participantId],
			participantId,
		);
		if (participantIssue !== undefined) {
			return { issue: participantIssue };
		}
	}

	const integerIssue = validateIntegerConfig(value);
	if (integerIssue !== undefined) {
		return { issue: integerIssue };
	}

	const finalAnswerParticipant = value["finalAnswerParticipant"];
	if (
		finalAnswerParticipant !== undefined &&
		!isParticipantId(finalAnswerParticipant)
	) {
		return { issue: "finalAnswerParticipant must be one of llm1, llm2" };
	}

	return { config: value };
}

/** Returns the complete finite set of supported config keys. */
function getConfigKeys(): readonly string[] {
	return [
		ENABLED_CONFIG_KEY,
		"llm1",
		"llm2",
		"participantIterationLimit",
		"finalAnswerParticipant",
		"responseDefectRetries",
		"providerRequestRetries",
		"providerRetryDelayMs",
	];
}

/** Validates one optional participant config object. */
function validateParticipantConfig(
	value: unknown,
	participantId: ParticipantId,
): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		return `${participantId} must be an object`;
	}
	if (!hasOnlyKeys(value, ["model"])) {
		return `${participantId} contains unsupported keys`;
	}
	return validateParticipantModelConfig(value["model"], participantId);
}

/** Validates one optional participant model config object. */
function validateParticipantModelConfig(
	value: unknown,
	participantId: ParticipantId,
): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		return `${participantId}.model must be an object`;
	}
	if (!hasOnlyKeys(value, ["id", "thinking"])) {
		return `${participantId}.model contains unsupported keys`;
	}

	const { id, thinking } = value;
	if (id !== undefined && (typeof id !== "string" || id.length === 0)) {
		return `${participantId}.model.id must be a non-empty string`;
	}
	if (typeof id === "string" && !hasProviderModelShape(id)) {
		return `${participantId}.model.id must use provider/model`;
	}
	if (thinking !== undefined && !isThinking(thinking)) {
		return `${participantId}.model.thinking must be one of ${THINKING_VALUES.join(", ")}`;
	}

	return undefined;
}

/** Validates bounded integer config fields. */
function validateIntegerConfig(
	config: Record<string, unknown>,
): string | undefined {
	for (const key of ["participantIterationLimit"] as const) {
		const value = config[key];
		if (value !== undefined && !isPositiveInteger(value)) {
			return `${key} must be a positive integer`;
		}
	}

	for (const key of getNonNegativeIntegerKeys()) {
		const value = config[key];
		if (value !== undefined && !isNonNegativeInteger(value)) {
			return `${key} must be a non-negative integer`;
		}
	}

	return undefined;
}

/** Returns config keys that accept non-negative integers. */
function getNonNegativeIntegerKeys(): readonly string[] {
	return [
		"responseDefectRetries",
		"providerRequestRetries",
		"providerRetryDelayMs",
	];
}

/** Builds one typed participant config from a validated raw object. */
function parseParticipantConfig(value: unknown): ParticipantConfig {
	if (!isRecord(value)) {
		return {};
	}
	const model = parseParticipantModelConfig(value["model"]);
	return model === undefined ? {} : { model };
}

/** Builds one typed participant model config from a validated raw object. */
function parseParticipantModelConfig(
	value: unknown,
): ParticipantModelConfig | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	return {
		...(typeof value["id"] === "string" ? { id: value["id"] } : {}),
		...(isThinking(value["thinking"]) ? { thinking: value["thinking"] } : {}),
	};
}

/** Reads one integer config value after validation has accepted it. */
function getIntegerConfig(
	config: Record<string, unknown>,
	key: string,
	defaultValue: number,
): number {
	const value = config[key];
	return typeof value === "number" ? value : defaultValue;
}
