import { homedir } from "node:os";

/** Environment key used by shell sessions to expose the user home directory. */
const HOME_ENV_KEY = "HOME";

/** Resolves the user home directory from the current process environment or Node fallback. */
export function readHomeDirectory(): string {
	return process.env[HOME_ENV_KEY] ?? homedir();
}
