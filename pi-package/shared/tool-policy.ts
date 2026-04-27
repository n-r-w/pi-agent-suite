interface ToolPolicyResult {
	readonly tools: readonly string[];
}

interface ToolPolicyIssue {
	readonly issue: string;
}

/** Resolves exact and wildcard tool patterns against the configured tool list. */
export function resolveToolPolicy(
	patterns: readonly string[],
	availableTools: readonly string[],
): ToolPolicyResult | ToolPolicyIssue {
	const resolved: string[] = [];
	const seen = new Set<string>();

	for (const pattern of patterns) {
		if (isFullWildcard(pattern)) {
			return { issue: "full wildcard * is not allowed" };
		}

		const matches = resolvePatternMatches(pattern, availableTools);
		if (matches.length === 0) {
			return {
				issue: `tool pattern ${pattern} did not match any available tool`,
			};
		}

		for (const tool of matches) {
			if (!seen.has(tool)) {
				seen.add(tool);
				resolved.push(tool);
			}
		}
	}

	return { tools: resolved };
}

/** Resolves one exact or narrow wildcard tool pattern. */
function resolvePatternMatches(
	pattern: string,
	availableTools: readonly string[],
): string[] {
	if (pattern.includes("*")) {
		return matchWildcard(pattern, availableTools);
	}

	return availableTools.includes(pattern) ? [pattern] : [];
}

/** Converts a narrow wildcard pattern into exact tool matches. */
function matchWildcard(
	pattern: string,
	availableTools: readonly string[],
): string[] {
	const expression = new RegExp(
		`^${pattern.split("*").map(escapeRegexSegment).join(".*")}$`,
	);
	return availableTools.filter((tool) => expression.test(tool));
}

/** Escapes one non-wildcard pattern segment for regular-expression matching. */
function escapeRegexSegment(segment: string): string {
	return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns true when a wildcard pattern has no literal tool-name constraint. */
function isFullWildcard(pattern: string): boolean {
	return pattern.includes("*") && pattern.replaceAll("*", "").length === 0;
}
