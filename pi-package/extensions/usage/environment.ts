import { CHILD_AGENT_PROCESS_ENV } from "../../shared/child-agent-environment";
import {
	SUBAGENT_AGENT_ID_ENV,
	SUBAGENT_ROOT_SESSION_ID_ENV,
} from "../../shared/subagent-environment";
/** Reads only the process role and attribution fields used by usage runtime ownership. */
export function readUsageProcessEnvironment(): NodeJS.ProcessEnv {
	return {
		[CHILD_AGENT_PROCESS_ENV]: process.env[CHILD_AGENT_PROCESS_ENV],
		[SUBAGENT_AGENT_ID_ENV]: process.env[SUBAGENT_AGENT_ID_ENV],
		[SUBAGENT_ROOT_SESSION_ID_ENV]: process.env[SUBAGENT_ROOT_SESSION_ID_ENV],
	};
}
