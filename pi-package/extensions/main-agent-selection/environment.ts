const SUBAGENT_AGENT_ID_ENV = "PI_SUBAGENT_AGENT_ID";

/** Returns true inside child processes whose prompt and tools are owned by run-subagent. */
export function isChildSubagentProcess(): boolean {
	return process.env[SUBAGENT_AGENT_ID_ENV] !== undefined;
}
