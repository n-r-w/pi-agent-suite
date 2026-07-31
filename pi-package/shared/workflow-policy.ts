import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Canonical workflow IDs, with undefined preserving unrestricted policy. */
export type ResolvedWorkflowPolicy = readonly string[] | undefined;

/** Catalog information published once by the workflow extension factory. */
export interface WorkflowCatalogPolicy {
	readonly ids: readonly string[];
	readonly error?: Error;
}

/** Closed result for configured or transported workflow policy resolution. */
export type WorkflowPolicyResolution =
	| { readonly kind: "resolved"; readonly policy: ResolvedWorkflowPolicy }
	| { readonly kind: "error"; readonly issue: string };

/** Cross-module property shared through Pi's event carrier. */
const WORKFLOW_CATALOG_POLICY_PROPERTY = "__piAgentSuiteWorkflowCatalogPolicy";

interface WorkflowCatalogPolicyCarrier {
	[WORKFLOW_CATALOG_POLICY_PROPERTY]?: WorkflowCatalogPolicy;
}

/** Publishes canonical catalog identity after rejecting case-insensitive collisions. */
export function publishWorkflowCatalogPolicy(
	pi: Pick<ExtensionAPI, "events">,
	catalog: WorkflowCatalogPolicy,
): WorkflowCatalogPolicy {
	const collision = findCaseInsensitiveWorkflowDuplicate(catalog.ids);
	const publication: WorkflowCatalogPolicy =
		collision === undefined
			? {
					ids: [...catalog.ids],
					...(catalog.error === undefined ? {} : { error: catalog.error }),
				}
			: {
					ids: [],
					error: new Error(
						`workflow catalog IDs collide case-insensitively: ${collision}`,
					),
				};
	const carrier = pi.events as unknown as WorkflowCatalogPolicyCarrier;
	carrier[WORKFLOW_CATALOG_POLICY_PROPERTY] = publication;
	return publication;
}

/** Resolves optional agent names through the currently published canonical catalog. */
export function resolveWorkflowPolicy(
	pi: Pick<ExtensionAPI, "events">,
	names: readonly string[] | undefined,
): WorkflowPolicyResolution {
	if (names === undefined) {
		return { kind: "resolved", policy: undefined };
	}
	if (names.length === 0) {
		return { kind: "resolved", policy: [] };
	}
	const duplicate = findCaseInsensitiveWorkflowDuplicate(names);
	if (duplicate !== undefined) {
		return {
			kind: "error",
			issue: `workflow policy contains a case-insensitive duplicate: ${duplicate}`,
		};
	}
	const catalog = readWorkflowCatalogPolicy(pi);
	if (catalog.error !== undefined) {
		return { kind: "error", issue: catalog.error.message };
	}
	const idsByMatchKey = new Map(
		catalog.ids.map((id) => [toWorkflowMatchKey(id), id]),
	);
	const resolved: string[] = [];
	for (const name of names) {
		const id = idsByMatchKey.get(toWorkflowMatchKey(name));
		if (id === undefined) {
			return { kind: "error", issue: `unknown workflow name: ${name}` };
		}
		resolved.push(id);
	}
	return { kind: "resolved", policy: resolved };
}

/** Parses the child-owned JSON boundary and resolves its names canonically. */
export function parseChildWorkflowPolicy(
	pi: Pick<ExtensionAPI, "events">,
	raw: string | undefined,
): WorkflowPolicyResolution {
	if (raw === undefined) {
		return { kind: "resolved", policy: undefined };
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { kind: "error", issue: "child workflow policy must be valid JSON" };
	}
	if (
		!Array.isArray(value) ||
		value.some(
			(item) =>
				typeof item !== "string" || item.length === 0 || item.trim() !== item,
		)
	) {
		return {
			kind: "error",
			issue: "child workflow policy must be an array of non-empty strings",
		};
	}
	return resolveWorkflowPolicy(pi, value);
}

/** Applies canonical explicit membership while unrestricted policy admits every ID. */
export function isWorkflowAllowed(
	policy: ResolvedWorkflowPolicy,
	id: string,
): boolean {
	return policy === undefined || policy.includes(id);
}

/** Requires at least one allowed current or saved workflow source for projection. */
export function hasAllowedWorkflowSource(
	policy: ResolvedWorkflowPolicy,
	currentIds: readonly string[],
	savedId: string | undefined,
): boolean {
	return (
		currentIds.some((id) => isWorkflowAllowed(policy, id)) ||
		(savedId !== undefined && isWorkflowAllowed(policy, savedId))
	);
}

/** Reads the publication and fails explicit resolution when initialization is absent. */
function readWorkflowCatalogPolicy(
	pi: Pick<ExtensionAPI, "events">,
): WorkflowCatalogPolicy {
	const carrier = pi.events as unknown as WorkflowCatalogPolicyCarrier;
	return (
		carrier[WORKFLOW_CATALOG_POLICY_PROPERTY] ?? {
			ids: [],
			error: new Error("workflow catalog policy is unavailable"),
		}
	);
}

/** Returns the first colliding spelling under workflow identity matching. */
export function findCaseInsensitiveWorkflowDuplicate(
	names: readonly string[],
): string | undefined {
	const seen = new Set<string>();
	for (const name of names) {
		const matchKey = toWorkflowMatchKey(name);
		if (seen.has(matchKey)) {
			return name;
		}
		seen.add(matchKey);
	}
	return undefined;
}

/** Normalizes workflow identity without changing the published canonical spelling. */
export function toWorkflowMatchKey(name: string): string {
	return name.toLowerCase();
}
