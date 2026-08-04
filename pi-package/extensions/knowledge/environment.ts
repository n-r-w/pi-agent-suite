import { isChildAgentProcess } from "../../shared/child-agent-environment";

/** Reads whether the current process belongs to a root-supervised child agent. */
export function isKnowledgeChildProcess(): boolean {
	return isChildAgentProcess(process.env);
}
