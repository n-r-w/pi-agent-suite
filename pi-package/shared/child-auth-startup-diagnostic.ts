import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChildAuthStartupAttemptRecord } from "./child-auth-startup";

/** Session entry type used for child authentication startup diagnostics. */
export const CHILD_AUTH_STARTUP_DIAGNOSTIC_CUSTOM_TYPE =
	"child-auth-startup-diagnostic";

/** Creates a session-backed recorder for safe child startup attempt fields. */
export function createChildAuthStartupDiagnosticRecorder(
	pi: Pick<ExtensionAPI, "appendEntry">,
): (record: ChildAuthStartupAttemptRecord) => void {
	return (record) => {
		const data: ChildAuthStartupAttemptRecord = { ...record };
		try {
			pi.appendEntry(CHILD_AUTH_STARTUP_DIAGNOSTIC_CUSTOM_TYPE, data);
		} catch {
			// Session diagnostics are observational and must not affect startup recovery.
		}
	};
}
