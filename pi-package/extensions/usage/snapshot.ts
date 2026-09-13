import { aggregateAllAgents, type UsageRow } from "./aggregation";
import type { UsageEvent } from "./store";

const MILLISECONDS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;
const DAYS_30 = 30;
const DAYS_90 = 90;
const DAY_MS =
	HOURS_PER_DAY *
	MINUTES_PER_HOUR *
	SECONDS_PER_MINUTE *
	MILLISECONDS_PER_SECOND;

export const USAGE_RANGES = ["24h", "7d", "30d", "90d"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

const RANGE_DURATION_MS: Readonly<Record<UsageRange, number>> = {
	"24h": DAY_MS,
	"7d": DAYS_PER_WEEK * DAY_MS,
	"30d": DAYS_30 * DAY_MS,
	"90d": DAYS_90 * DAY_MS,
};

export interface PreparedUsageRange {
	readonly agentIds: readonly string[];
	readonly rows: readonly UsageRow[];
	readonly agentRows: ReadonlyMap<string, readonly UsageRow[]>;
}

export type PreparedUsageSnapshot = Readonly<
	Record<UsageRange, PreparedUsageRange>
>;

/** Prepares every selectable range and agent view from one opening event scan. */
export function prepareUsageSnapshot(
	events: readonly UsageEvent[],
	openedAt: number,
): PreparedUsageSnapshot {
	const rangeEvents: Record<UsageRange, UsageEvent[]> = {
		"24h": [],
		"7d": [],
		"30d": [],
		"90d": [],
	};
	for (const event of events) {
		if (event.timestampMs > openedAt) {
			continue;
		}
		for (const range of USAGE_RANGES) {
			if (event.timestampMs >= openedAt - RANGE_DURATION_MS[range]) {
				rangeEvents[range].push(event);
			}
		}
	}

	return {
		"24h": prepareRange(rangeEvents["24h"]),
		"7d": prepareRange(rangeEvents["7d"]),
		"30d": prepareRange(rangeEvents["30d"]),
		"90d": prepareRange(rangeEvents["90d"]),
	};
}

function prepareRange(events: readonly UsageEvent[]): PreparedUsageRange {
	const eventsByAgent = new Map<string, UsageEvent[]>();
	for (const event of events) {
		const agentEvents = eventsByAgent.get(event.agentId) ?? [];
		agentEvents.push(event);
		eventsByAgent.set(event.agentId, agentEvents);
	}
	const agentIds = [...eventsByAgent.keys()].sort((left, right) =>
		left.localeCompare(right),
	);
	return {
		agentIds,
		rows: aggregateAllAgents(events),
		agentRows: new Map(
			agentIds.map((agentId) => [
				agentId,
				aggregateAllAgents(eventsByAgent.get(agentId) ?? []),
			]),
		),
	};
}
