import { withChildAgentProcessMarker } from "../../shared/child-agent-environment";
import {
	SUBAGENT_AGENT_ID_ENV,
	SUBAGENT_DEPTH_ENV,
	SUBAGENT_OWNER_SESSION_ENV,
	SUBAGENT_RUNTIME_LEASE_ENV,
	SUBAGENT_TOOL_PATTERNS_ENV,
} from "../../shared/subagent-environment";

/** Safe diagnostic returned for every malformed child tool-pattern payload. */
const INVALID_TOOL_PATTERNS_ENV_ISSUE =
	"child tool policy environment is invalid";

type SubagentToolPatternsResult =
	| { readonly patterns: readonly string[] | undefined }
	| { readonly issue: string };

/** Reads the effective child-agent id from the current process environment. */
export function readSubagentAgentId(): string | undefined {
	return process.env[SUBAGENT_AGENT_ID_ENV];
}

/** Reads the current subagent nesting depth from the current process environment. */
export function readSubagentDepth(): string | undefined {
	return process.env[SUBAGENT_DEPTH_ENV];
}

/** Reads the root-supervised runtime lease from the current process environment. */
export function readSubagentRuntimeLeaseId(): string | undefined {
	return process.env[SUBAGENT_RUNTIME_LEASE_ENV];
}

/** Reads the child Pi owner identity from the current process environment. */
export function readSubagentOwnerSessionId(): string | undefined {
	return process.env[SUBAGENT_OWNER_SESSION_ENV];
}

/** Parses the optional child tool-pattern snapshot at the process boundary. */
export function readSubagentToolPatterns(): SubagentToolPatternsResult {
	const rawPatterns = process.env[SUBAGENT_TOOL_PATTERNS_ENV];
	if (rawPatterns === undefined) {
		return { patterns: undefined };
	}

	let parsedPatterns: unknown;
	try {
		parsedPatterns = JSON.parse(rawPatterns);
	} catch {
		return { issue: INVALID_TOOL_PATTERNS_ENV_ISSUE };
	}
	if (!isValidToolPatternList(parsedPatterns)) {
		return { issue: INVALID_TOOL_PATTERNS_ENV_ISSUE };
	}
	return { patterns: parsedPatterns };
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

	return withChildAgentProcessMarker({ ...env, ...explicitEnv });
}

/** Validates the same non-empty, duplicate-free string-list invariant as agent definitions. */
function isValidToolPatternList(value: unknown): value is readonly string[] {
	if (!Array.isArray(value)) {
		return false;
	}
	const seen = new Set<string>();
	for (const pattern of value) {
		if (
			typeof pattern !== "string" ||
			pattern.trim().length === 0 ||
			seen.has(pattern)
		) {
			return false;
		}
		seen.add(pattern);
	}
	return true;
}

/** Returns true for environment keys owned by the Subagents runtime. */
function isSubagentOwnedEnvKey(key: string): boolean {
	return (
		key === SUBAGENT_AGENT_ID_ENV ||
		key === SUBAGENT_DEPTH_ENV ||
		key === SUBAGENT_OWNER_SESSION_ENV ||
		key === SUBAGENT_RUNTIME_LEASE_ENV ||
		key === SUBAGENT_TOOL_PATTERNS_ENV
	);
}
