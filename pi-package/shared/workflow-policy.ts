import { isSingleLineText } from "./text-contracts";

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

/** Cross-extension catalog carrier.
 *
 * Pi 0.84.0 loads each extension via jiti with `moduleCache: false`,
 * giving every extension its own copy of shared modules. Only
 * `globalThis` is truly shared across all extension instances.
 */
const CATALOG_KEY = "__piHarnessWorkflowCatalogPolicy";

interface CatalogCarrier {
	[CATALOG_KEY]?: WorkflowCatalogPolicy;
}

/** Publishes canonical catalog identity after rejecting NFC-equivalent collisions. */
export function publishWorkflowCatalogPolicy(
	catalog: WorkflowCatalogPolicy,
): WorkflowCatalogPolicy {
	const collision = findWorkflowDuplicate(catalog.ids);
	const publication: WorkflowCatalogPolicy =
		collision === undefined
			? {
					ids: [...catalog.ids],
					...(catalog.error === undefined ? {} : { error: catalog.error }),
				}
			: {
					ids: [],
					error: new Error(
						`workflow catalog IDs collide after NFC normalization: ${collision}`,
					),
				};
	(globalThis as unknown as CatalogCarrier)[CATALOG_KEY] = publication;
	return publication;
}

/** Resolves optional workflow names through the currently published canonical catalog. */
export function resolveWorkflowPolicy(
	names: readonly string[] | undefined,
): WorkflowPolicyResolution {
	if (names === undefined) {
		return { kind: "resolved", policy: undefined };
	}
	if (names.length === 0) {
		return { kind: "resolved", policy: [] };
	}
	if (names.some((name) => !isSingleLineText(name))) {
		return {
			kind: "error",
			issue: "workflow policy names must be single-line strings",
		};
	}
	const duplicate = findWorkflowDuplicate(names);
	if (duplicate !== undefined) {
		return {
			kind: "error",
			issue: `workflow policy contains an NFC-equivalent duplicate: ${duplicate}`,
		};
	}
	const catalog = readWorkflowCatalogPolicy();
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
	if (!Array.isArray(value) || value.some((item) => !isSingleLineText(item))) {
		return {
			kind: "error",
			issue: "child workflow policy must be an array of single-line strings",
		};
	}
	return resolveWorkflowPolicy(value);
}

/** Applies canonical explicit membership while unrestricted policy admits every ID. */
export function isWorkflowAllowed(
	policy: ResolvedWorkflowPolicy,
	id: string,
): boolean {
	if (policy === undefined) {
		return true;
	}
	const idKey = toWorkflowMatchKey(id);
	return policy.some((allowedId) => toWorkflowMatchKey(allowedId) === idKey);
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
function readWorkflowCatalogPolicy(): WorkflowCatalogPolicy {
	return (
		(globalThis as unknown as CatalogCarrier)[CATALOG_KEY] ?? {
			ids: [],
			error: new Error("workflow catalog policy is unavailable"),
		}
	);
}

/** Returns the first duplicate under exact NFC workflow identity. */
export function findWorkflowDuplicate(
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

/** Normalizes workflow identity without folding case. */
export function toWorkflowMatchKey(name: string): string {
	return name.normalize("NFC");
}
