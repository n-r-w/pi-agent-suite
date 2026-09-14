import { CHILD_AGENT_PROCESS_ENV } from "../../shared/child-agent-environment";

/** Reads only the process role field used by footer runtime ownership. */
export function readFooterProcessEnvironment(): NodeJS.ProcessEnv {
	return {
		[CHILD_AGENT_PROCESS_ENV]: process.env[CHILD_AGENT_PROCESS_ENV],
	};
}
