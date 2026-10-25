import { realpathSync, statSync } from "node:fs";
import { errorMessage } from "./error-message";
import { InvocationStartError } from "./invocation-contracts";

/** Returns the physical process directory or rejects an unavailable working directory. */
export function resolveWorkingDirectory(cwd: string): string {
	try {
		if (statSync(cwd).isDirectory()) {
			return realpathSync(cwd);
		}
	} catch (error) {
		throw new InvocationStartError(
			"start_failed",
			`Working directory ${cwd} is unavailable: ${errorMessage(error)}`,
		);
	}
	throw new InvocationStartError(
		"start_failed",
		`Working directory ${cwd} is not a directory`,
	);
}
