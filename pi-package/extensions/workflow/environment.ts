import { isChildAgentProcess } from "../../shared/child-agent-environment";
import { SUBAGENT_WORKFLOW_IDS_ENV } from "../../shared/subagent-environment";

/** Process-owned workflow policy input selected before runtime metadata is read. */
export type WorkflowPolicyEnvironment =
	| { readonly kind: "main" }
	| { readonly kind: "child"; readonly rawPolicy: string | undefined };

/** Reads the child marker and its dedicated policy payload once during workflow initialization. */
export function readWorkflowPolicyEnvironment(): WorkflowPolicyEnvironment {
	if (!isChildAgentProcess(process.env)) {
		return { kind: "main" };
	}
	return {
		kind: "child",
		rawPolicy: process.env[SUBAGENT_WORKFLOW_IDS_ENV],
	};
}

/** Returns true inside child agent processes where CLI flags are not available. */
export function isWorkflowChildProcess(): boolean {
	return isChildAgentProcess(process.env);
}
