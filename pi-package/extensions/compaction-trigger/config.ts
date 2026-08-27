import { readSuiteConfigFileSync } from "../../shared/agent-suite-storage";

const EXTENSION_DIR = "compaction-trigger";
const CONFIG_KEYS = ["enabled", "tolerancePercent"] as const;

export interface CompactionTriggerConfig {
	readonly tolerancePercent: number;
}

export type CompactionTriggerConfigResult =
	| { readonly kind: "enabled"; readonly config: CompactionTriggerConfig }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid" };

/** Reads and validates the extension configuration from agent-suite storage. */
export function readCompactionTriggerConfig(): CompactionTriggerConfigResult {
	const configFile = readSuiteConfigFileSync(EXTENSION_DIR);
	if (configFile.kind === "missing") {
		return enabledConfig(0);
	}
	if (configFile.kind === "read-error") {
		return { kind: "invalid" };
	}

	try {
		return parseConfig(JSON.parse(configFile.file.content));
	} catch {
		return { kind: "invalid" };
	}
}

/** Parses the closed config shape without changing invalid values to defaults. */
function parseConfig(value: unknown): CompactionTriggerConfigResult {
	if (!isRecord(value)) {
		return { kind: "invalid" };
	}
	if (
		Object.keys(value).some(
			(key) => !(CONFIG_KEYS as readonly string[]).includes(key),
		)
	) {
		return { kind: "invalid" };
	}

	const enabled = value["enabled"];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return { kind: "invalid" };
	}
	const configuredTolerance = value["tolerancePercent"];
	const tolerancePercent =
		configuredTolerance === undefined ? 0 : configuredTolerance;
	if (
		typeof tolerancePercent !== "number" ||
		!Number.isFinite(tolerancePercent) ||
		tolerancePercent < 0
	) {
		return { kind: "invalid" };
	}
	if (enabled === false) {
		return { kind: "disabled" };
	}
	return enabledConfig(tolerancePercent);
}

/** Builds the enabled config after strict parsing. */
function enabledConfig(
	tolerancePercent: number,
): CompactionTriggerConfigResult {
	return { kind: "enabled", config: { tolerancePercent } };
}

/** Narrows JSON objects while rejecting arrays and null. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
