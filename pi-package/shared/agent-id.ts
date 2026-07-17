/** Normalizes an agent ID for case-insensitive matching while preserving stored IDs for runtime state. */
export function toAgentIdMatchKey(agentId: string): string {
	return agentId.toLowerCase();
}

/** Compares agent IDs through the shared case-insensitive identity rule. */
export function agentIdMatches(left: string, right: string): boolean {
	return toAgentIdMatchKey(left) === toAgentIdMatchKey(right);
}
