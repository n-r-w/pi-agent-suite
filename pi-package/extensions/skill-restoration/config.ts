import { readSuiteConfigFile } from "../../shared/agent-suite-storage";

/** Represents enabled-only configuration or invalid external input. */
export type RestorationConfig =
	| { readonly kind: "valid"; readonly enabled: boolean }
	| { readonly kind: "invalid" };

/** Reads suite storage while keeping missing configuration enabled. */
export async function readRestorationConfig(): Promise<RestorationConfig> {
	const result = await readSuiteConfigFile("skill-restoration");
	if (result.kind === "missing") {
		return { kind: "valid", enabled: true };
	}
	return result.kind === "found"
		? parseRestorationConfig(result.file.content)
		: { kind: "invalid" };
}

/** Validates the enabled-only configuration boundary. */
export function parseRestorationConfig(content: string): RestorationConfig {
	try {
		const value: unknown = JSON.parse(content);
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return { kind: "invalid" };
		}
		const config = value as Record<string, unknown>;
		if (
			Object.keys(config).some((key) => key !== "enabled") ||
			(config["enabled"] !== undefined &&
				typeof config["enabled"] !== "boolean")
		) {
			return { kind: "invalid" };
		}
		return { kind: "valid", enabled: config["enabled"] !== false };
	} catch {
		return { kind: "invalid" };
	}
}
