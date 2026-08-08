import { isChildAgentProcess } from "../../shared/child-agent-environment";

/** Returns true inside child agent processes where CLI flags are not available. */
export function isAlgorithmsChildProcess(): boolean {
	return isChildAgentProcess(process.env);
}
