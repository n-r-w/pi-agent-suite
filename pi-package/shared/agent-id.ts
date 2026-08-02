/** Normalizes an agent ID to its exact canonical Unicode identity key. */
export function toAgentIdMatchKey(agentId: string): string {
	return agentId.normalize("NFC");
}

/** Compares agent IDs exactly after canonical Unicode normalization. */
export function agentIdMatches(left: string, right: string): boolean {
	return toAgentIdMatchKey(left) === toAgentIdMatchKey(right);
}
