import { SUBAGENT_AGENT_ID_ENV } from "../../shared/subagent-environment";

/** Returns true inside child processes whose prompt and tools are owned by run-subagent. */
export function isChildSubagentProcess(): boolean {
	return process.env[SUBAGENT_AGENT_ID_ENV] !== undefined;
}
