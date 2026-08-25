import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Effective native compaction state after Pi merges and validates settings. */
export type NativeCompactionSettings =
	| {
			readonly status: "enabled";
			readonly reserveTokens: number;
	  }
	| { readonly status: "disabled" }
	| { readonly status: "invalid" };

/** Reads Pi's merged native compaction settings and preserves load errors as state. */
export function readNativeCompactionSettings(
	cwd: string,
): NativeCompactionSettings {
	const settings = SettingsManager.create(cwd, getAgentDir());
	const compactionSettings = settings.getCompactionSettings();
	if (settings.drainErrors().length > 0) {
		return { status: "invalid" };
	}
	if (!compactionSettings.enabled) {
		return { status: "disabled" };
	}

	return {
		status: "enabled",
		reserveTokens: compactionSettings.reserveTokens,
	};
}
