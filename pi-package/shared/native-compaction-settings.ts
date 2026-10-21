import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Represents resolved token limits and native automatic-compaction state. */
export type NativeCompactionSettings =
	| {
			readonly status: "enabled";
			readonly reserveTokens: number;
			/** Token budget for recent messages retained during compaction. */
			readonly keepRecentTokens: number;
	  }
	| {
			readonly status: "disabled";
			readonly reserveTokens: number;
			/** Token budget for recent messages retained during compaction. */
			readonly keepRecentTokens: number;
	  }
	| { readonly status: "invalid" };

/** Provides model-specific compaction settings or an invalid result for load or validation errors. */
export function readNativeCompactionSettings(
	cwd: string,
	model: Pick<Model<string>, "provider" | "id"> | undefined,
): NativeCompactionSettings {
	const settings = SettingsManager.create(cwd, getAgentDir());
	try {
		const compactionSettings = settings.getCompactionSettings(model);
		if (settings.drainErrors().length > 0) {
			return { status: "invalid" };
		}
		return {
			status: compactionSettings.enabled ? "enabled" : "disabled",
			reserveTokens: compactionSettings.reserveTokens,
			keepRecentTokens: compactionSettings.keepRecentTokens,
		};
	} catch {
		return { status: "invalid" };
	}
}
