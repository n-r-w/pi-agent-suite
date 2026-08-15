import {
	buildRetryConfig,
	type RetryConfig,
	validateRetryConfig,
} from "../../shared/retry";

const DEFAULT_JPEG_QUALITY = 85;
const DEFAULT_MAX_BYTES = 4_718_592;
const MIN_JPEG_QUALITY = 1;
const MAX_JPEG_QUALITY = 100;
const CONFIG_KEYS = [
	"enabled",
	"provider",
	"model",
	"compression",
	"retry",
] as const;
const COMPRESSION_KEYS = ["enabled", "jpegQuality", "maxBytes"] as const;

type RecordValue = Record<string, unknown>;

export interface VisionConfig {
	readonly enabled: boolean;
	readonly provider: string | undefined;
	readonly model: string | undefined;
	readonly compression: {
		readonly enabled: boolean;
		readonly jpegQuality: number;
		readonly maxBytes: number;
	};
	readonly retry: RetryConfig;
}

export type VisionConfigResult =
	| { readonly kind: "valid"; readonly config: VisionConfig }
	| { readonly kind: "invalid"; readonly issue: string };

export function parseVisionConfig(value: unknown): VisionConfigResult {
	if (!isRecord(value)) {
		return invalid("config must be an object");
	}
	if (!hasOnlyKeys(value, CONFIG_KEYS)) {
		return invalid("config contains unsupported fields");
	}
	const enabled = value["enabled"];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return invalid("enabled must be a boolean");
	}
	const provider = optionalString(value["provider"], "provider");
	if (typeof provider === "string") {
		return invalid(provider);
	}
	const model = optionalString(value["model"], "model");
	if (typeof model === "string") {
		return invalid(model);
	}
	const compression = parseCompression(value["compression"]);
	if (typeof compression === "string") {
		return invalid(compression);
	}
	const retryIssue = validateRetryConfig(value["retry"], "retry");
	if (retryIssue !== undefined) {
		return invalid(retryIssue);
	}
	return {
		kind: "valid",
		config: {
			enabled: enabled ?? false,
			provider: provider.value,
			model: model.value,
			compression,
			retry: buildRetryConfig(value["retry"]),
		},
	};
}

function parseCompression(
	value: unknown,
): VisionConfig["compression"] | string {
	if (value !== undefined && !isRecord(value)) {
		return "compression must be an object";
	}
	const record = value ?? {};
	if (!hasOnlyKeys(record, COMPRESSION_KEYS)) {
		return "compression contains unsupported fields";
	}
	const enabled = record["enabled"];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return "compression.enabled must be a boolean";
	}
	const jpegQuality = record["jpegQuality"] ?? DEFAULT_JPEG_QUALITY;
	if (!isIntegerInRange(jpegQuality, MIN_JPEG_QUALITY, MAX_JPEG_QUALITY)) {
		return `compression.jpegQuality must be an integer between ${MIN_JPEG_QUALITY} and ${MAX_JPEG_QUALITY}`;
	}
	const maxBytes = record["maxBytes"] ?? DEFAULT_MAX_BYTES;
	if (!isPositiveInteger(maxBytes)) {
		return "compression.maxBytes must be a positive integer";
	}
	return { enabled: enabled ?? true, jpegQuality, maxBytes };
}

function optionalString(
	value: unknown,
	field: string,
): { readonly value: string | undefined } | string {
	if (value === undefined) {
		return { value: undefined };
	}
	return typeof value === "string" ? { value } : `${field} must be a string`;
}
function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value: RecordValue, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}
function isIntegerInRange(
	value: unknown,
	min: number,
	max: number,
): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= min &&
		value <= max
	);
}
function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function invalid(issue: string): VisionConfigResult {
	return { kind: "invalid", issue };
}
