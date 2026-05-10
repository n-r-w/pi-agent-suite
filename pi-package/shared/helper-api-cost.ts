import type {
	ExtensionAPI,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

/** Session custom entry type used to persist extension helper API cost. */
export const HELPER_API_COST_CUSTOM_TYPE = "helper-api-cost";

/** Extension helper sources whose model calls are included in custom footer API cost. */
export const HELPER_API_COST_SOURCES = [
	"consult-advisor",
	"context-projection",
	"convene-council",
	"custom-compaction",
	"run-subagent",
] as const;

export type HelperApiCostSource = (typeof HELPER_API_COST_SOURCES)[number];

interface HelperApiCostEntryData {
	readonly source: HelperApiCostSource;
	cost: number;
}

const HELPER_API_COST_SOURCE_SET = new Set<string>(HELPER_API_COST_SOURCES);

/** Records one helper model response cost as a session custom entry. */
export function recordHelperApiCost(
	pi: Pick<ExtensionAPI, "appendEntry">,
	source: HelperApiCostSource,
	message: { readonly usage?: unknown },
): void {
	const cost = readUsageCostTotal(message);
	if (!isPositiveFiniteCost(cost)) {
		return;
	}

	const data: HelperApiCostEntryData = { source, cost };
	try {
		pi.appendEntry(HELPER_API_COST_CUSTOM_TYPE, data);
	} catch {
		data.cost = 0;
	}
}

/** Sums valid helper API cost custom entries from session history. */
export function sumHelperApiCost(entries: readonly SessionEntry[]): number {
	let totalCost = 0;
	for (const entry of entries) {
		if (
			entry.type !== "custom" ||
			entry.customType !== HELPER_API_COST_CUSTOM_TYPE ||
			!isHelperApiCostEntryData(entry.data)
		) {
			continue;
		}

		totalCost += entry.data.cost;
	}

	return totalCost;
}

function readUsageCostTotal(message: { readonly usage?: unknown }): unknown {
	if (!isRecord(message.usage)) {
		return undefined;
	}
	const { cost } = message.usage;
	if (!isRecord(cost)) {
		return undefined;
	}

	return cost["total"];
}

function isHelperApiCostEntryData(
	data: unknown,
): data is HelperApiCostEntryData {
	if (!isRecord(data)) {
		return false;
	}

	return (
		typeof data["source"] === "string" &&
		HELPER_API_COST_SOURCE_SET.has(data["source"]) &&
		isPositiveFiniteCost(data["cost"])
	);
}

function isPositiveFiniteCost(cost: unknown): cost is number {
	return typeof cost === "number" && Number.isFinite(cost) && cost > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
