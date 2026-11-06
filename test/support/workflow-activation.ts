/** Names the form of a workflow activation record from its metadata: `full` when it shows the rules and graph with their key, `reuse` when it refers to an earlier record, and `invalid` otherwise. */
export function describeActivationForm(
	details: Readonly<Record<string, unknown>>,
): "full" | "reuse" | "invalid" {
	const keys = details["definitionKeys"];
	const reuses = details["workflowGuidelines"] === "reuse";
	if (reuses) {
		return keys === undefined ? "reuse" : "invalid";
	}
	return Array.isArray(keys) && keys.length === 1 ? "full" : "invalid";
}
