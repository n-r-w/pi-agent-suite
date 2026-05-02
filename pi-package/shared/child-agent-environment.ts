/** Environment variable that marks a child pi or agent process. */
export const CHILD_AGENT_PROCESS_ENV = "PI_AGENT_SUITE_CHILD_AGENT_PROCESS";

/** Environment value that enables the shared child agent process marker. */
export const CHILD_AGENT_PROCESS_ENV_VALUE = "1";

/** Returns a child-agent environment copy with the shared child process marker. */
export function withChildAgentProcessMarker(
	env: Record<string, string>,
): Record<string, string> {
	return {
		...env,
		[CHILD_AGENT_PROCESS_ENV]: CHILD_AGENT_PROCESS_ENV_VALUE,
	};
}

/** Returns true when the current process is a marked child agent process. */
export function isChildAgentProcess(env: NodeJS.ProcessEnv): boolean {
	return env[CHILD_AGENT_PROCESS_ENV] === CHILD_AGENT_PROCESS_ENV_VALUE;
}
