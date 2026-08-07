const PATH_ENV = "PATH";

/** Reads PATH from the current process environment for executable discovery. */
export function readPathEnvironment(): string | undefined {
	return process.env[PATH_ENV];
}

const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";

/** Reads the suite root override from the current process environment. */
export function readAgentSuiteDirEnv(): string | undefined {
	return process.env[AGENT_SUITE_DIR_ENV];
}
