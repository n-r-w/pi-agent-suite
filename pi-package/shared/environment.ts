const PATH_ENV = "PATH";

/** Reads PATH from the current process environment for executable discovery. */
export function readPathEnvironment(): string | undefined {
	return process.env[PATH_ENV];
}
