import type { UsageEvent } from "./store";

const PERCENT_SCALE = 100;

export interface UsageRow {
	readonly label: string;
	readonly costPercent: number;
	readonly tokens: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly hitPercent: number;
	readonly cost: number;
	readonly saved: number;
}

interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	saved: number;
}

/** Builds the All agents total and cost-ranked provider/model breakdown. */
export function aggregateAllAgents(events: readonly UsageEvent[]): UsageRow[] {
	if (events.length === 0) {
		return [];
	}

	const total = emptyTotals();
	const byModel = new Map<string, Totals>();
	for (const event of events) {
		addEvent(total, event);
		const label = `${event.provider}/${event.model}`;
		const modelTotals = byModel.get(label) ?? emptyTotals();
		addEvent(modelTotals, event);
		byModel.set(label, modelTotals);
	}

	const costPercent = (cost: number): number =>
		total.cost === 0 ? 0 : (cost / total.cost) * PERCENT_SCALE;
	return [
		toRow("Total", total, total.cost === 0 ? 0 : PERCENT_SCALE),
		...[...byModel.entries()]
			.sort(
				([leftLabel, left], [rightLabel, right]) =>
					right.cost - left.cost || leftLabel.localeCompare(rightLabel),
			)
			.map(([label, totals]) => toRow(label, totals, costPercent(totals.cost))),
	];
}

function emptyTotals(): Totals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		saved: 0,
	};
}

function addEvent(totals: Totals, event: UsageEvent): void {
	totals.input += event.input;
	totals.output += event.output;
	totals.cacheRead += event.cacheRead;
	totals.cacheWrite += event.cacheWrite;
	totals.cost += event.cost;
	totals.saved += event.saved;
}

function toRow(label: string, totals: Totals, costPercent: number): UsageRow {
	const cacheDenominator = totals.input + totals.cacheRead + totals.cacheWrite;
	return {
		label,
		costPercent,
		tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
		cacheRead: totals.cacheRead,
		cacheWrite: totals.cacheWrite,
		hitPercent:
			cacheDenominator === 0
				? 0
				: (totals.cacheRead / cacheDenominator) * PERCENT_SCALE,
		cost: totals.cost,
		saved: totals.saved,
	};
}
