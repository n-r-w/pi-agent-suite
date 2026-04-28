import {
	SUBAGENT_AGENT_ID_ENV,
	SUBAGENT_DEPTH_ENV,
	SUBAGENT_TOOLS_ENV,
} from "../../shared/subagent-environment";

/** Reads the effective child-agent id from the current process environment. */
export function readSubagentAgentId(): string | undefined {
	return process.env[SUBAGENT_AGENT_ID_ENV];
}

/** Reads the current subagent nesting depth from the current process environment. */
export function readSubagentDepth(): string | undefined {
	return process.env[SUBAGENT_DEPTH_ENV];
}

/** Builds child environment without stale parent-owned subagent variables. */
export function createChildEnvironment(
	explicitEnv: Record<string, string>,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || isSubagentOwnedEnvKey(key)) {
			continue;
		}
		env[key] = value;
	}

	return { ...env, ...explicitEnv };
}

/** Returns true for environment keys fully owned by run-subagent. */
function isSubagentOwnedEnvKey(key: string): boolean {
	return (
		key === SUBAGENT_AGENT_ID_ENV ||
		key === SUBAGENT_DEPTH_ENV ||
		key === SUBAGENT_TOOLS_ENV
	);
}
