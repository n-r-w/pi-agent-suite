import { isChildAgentProcess } from "../../shared/child-agent-environment";

/** Returns true when the process has the shared child-agent marker. */
export function isSystemPromptChildProcess(): boolean {
	return isChildAgentProcess(process.env);
}
