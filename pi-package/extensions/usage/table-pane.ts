import type { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import {
	calculateScrollThumb,
	isScrollThumbRow,
	type ScrollMetrics,
} from "../../shared/tui/scroll-indicator";
import { padToWidth } from "./agent-pane";
import type { UsageRow } from "./aggregation";

const MODEL_WIDTH = 24;
const TOKENS_WIDTH = 8;
const TOKEN_DETAIL_WIDTH = 9;
const PERCENT_WIDTH = 8;
const HIT_PERCENT_WIDTH = 8;
const MONEY_WIDTH = 7;
const PERCENT_PRECISION = 1;
const MAX_MONEY_PRECISION = 4;
const TOKENS_PER_THOUSAND = 1_000;
const THOUSANDS_PER_MILLION = 1_000;
const DECIMAL_FACTOR = 10;
const TOKENS_PER_MILLION_TENTH = 100_000;
const TOKENS_PER_BILLION_TENTH = 100_000_000;
const MILLION_TENTHS_PER_BILLION = 10_000;
const MONEY_PER_THOUSAND = 1_000;
const MONEY_PER_MILLION = 1_000_000;
const MONEY_PER_BILLION = 1_000_000_000;

export interface TablePaneOptions {
	readonly width: number;
	readonly height: number;
	readonly verticalOffset: number;
	readonly horizontalOffset: number;
	readonly focused: boolean;
	readonly theme: Theme;
}

export interface TablePaneRender {
	readonly lines: readonly string[];
	readonly scroll: readonly string[];
	readonly verticalOffset: number;
	readonly horizontalOffset: number;
	readonly verticalViewport: number;
	readonly maximumHorizontalOffset: number;
}

/** Renders a vertically and horizontally scrollable model table. */
export function renderTablePane(
	rows: readonly UsageRow[],
	options: TablePaneOptions,
): TablePaneRender {
	const { focused, height, horizontalOffset, theme, verticalOffset } = options;
	const contentWidth = Math.max(0, options.width);
	if (rows.length === 0) {
		return renderEmptyTable(contentWidth, height, focused, theme);
	}

	const modelWidth = modelColumnWidth(rows);
	const fullLines = [
		tableHeader(focused, theme, modelWidth),
		...rows.map((row) => formatRow(row, modelWidth)),
	];
	const fullWidth = Math.max(...fullLines.map(visibleWidth));
	const maximumHorizontalOffset = Math.max(0, fullWidth - contentWidth);
	const boundedHorizontalOffset = Math.max(
		0,
		Math.min(Math.floor(horizontalOffset), maximumHorizontalOffset),
	);
	const horizontalOverflow = maximumHorizontalOffset > 0;
	const dataViewport = Math.max(0, height - 1 - (horizontalOverflow ? 1 : 0));
	const maximumVerticalOffset = Math.max(0, rows.length - dataViewport);
	const boundedVerticalOffset = Math.max(
		0,
		Math.min(Math.floor(verticalOffset), maximumVerticalOffset),
	);
	const visibleLines = fullLines.slice(
		boundedVerticalOffset + 1,
		boundedVerticalOffset + dataViewport + 1,
	);
	const lines = [
		sliceLine(fullLines[0] ?? "", boundedHorizontalOffset, contentWidth),
		...visibleLines.map((line) =>
			sliceLine(line, boundedHorizontalOffset, contentWidth),
		),
	];
	if (horizontalOverflow) {
		lines.push(
			renderHorizontalTrack(
				{
					offset: boundedHorizontalOffset,
					total: fullWidth,
					viewport: contentWidth,
				},
				contentWidth,
				theme,
				focused,
			),
		);
	}
	return {
		lines,
		scroll: renderVerticalTrack(
			{
				offset: boundedVerticalOffset,
				total: rows.length,
				viewport: dataViewport,
			},
			height,
			theme,
			focused,
		),
		verticalOffset: boundedVerticalOffset,
		horizontalOffset: boundedHorizontalOffset,
		verticalViewport: dataViewport,
		maximumHorizontalOffset,
	};
}

function renderVerticalTrack(
	metrics: ScrollMetrics,
	height: number,
	theme: Theme,
	focused: boolean,
): string[] {
	const thumb = calculateScrollThumb(metrics, metrics.viewport);
	return Array.from({ length: height }, (_, row) => {
		if (row === 0 || row > metrics.viewport || thumb === undefined) {
			return " ";
		}
		if (!isScrollThumbRow(thumb, row - 1)) {
			return theme.fg("muted", "░");
		}
		return theme.fg(focused ? "border" : "borderMuted", "█");
	});
}

function modelColumnWidth(rows: readonly UsageRow[]): number {
	return Math.max(MODEL_WIDTH, ...rows.map((row) => visibleWidth(row.label)));
}

function renderEmptyTable(
	width: number,
	height: number,
	focused: boolean,
	theme: Theme,
): TablePaneRender {
	const label = theme.bold("No usage in selected range");
	const title = theme.fg(focused ? "borderAccent" : "accent", label);
	return {
		lines: [padToWidth(title, width)],
		scroll: Array.from({ length: height }, () => " "),
		verticalOffset: 0,
		horizontalOffset: 0,
		verticalViewport: Math.max(0, height - 1),
		maximumHorizontalOffset: 0,
	};
}

function renderHorizontalTrack(
	metrics: ScrollMetrics,
	width: number,
	theme: Theme,
	focused: boolean,
): string {
	const thumb = calculateScrollThumb(metrics, width);
	return Array.from({ length: width }, (_, column) => {
		if (!isScrollThumbRow(thumb, column)) {
			return theme.fg("muted", "░");
		}
		return theme.fg(focused ? "border" : "borderMuted", "█");
	}).join("");
}

function sliceLine(line: string, offset: number, width: number): string {
	const sliced = sliceByColumn(line, offset, width, true);
	return `${sliced}${" ".repeat(Math.max(0, width - visibleWidth(sliced)))}`;
}

function tableHeader(
	focused: boolean,
	theme: Theme,
	modelWidth: number,
): string {
	const color = focused ? "borderAccent" : "accent";
	const header = (label: string) => theme.fg(color, theme.bold(label));
	return [
		padColumn(header("Model"), modelWidth),
		padColumnStart(header("Cost%"), PERCENT_WIDTH),
		padColumnStart(header("Tokens"), TOKENS_WIDTH),
		padColumnStart(header("CacheR"), TOKEN_DETAIL_WIDTH),
		padColumnStart(header("CacheW"), TOKEN_DETAIL_WIDTH),
		padColumnStart(header("Hit%"), HIT_PERCENT_WIDTH),
		padColumnStart(header("Cost"), MONEY_WIDTH),
		padColumnStart(header("Saved"), MONEY_WIDTH),
	].join(" ");
}

function formatRow(row: UsageRow, modelWidth: number): string {
	return [
		padColumn(row.label, modelWidth),
		row.costPercent.toFixed(PERCENT_PRECISION).padStart(PERCENT_WIDTH),
		formatTokenCount(row.tokens).padStart(TOKENS_WIDTH),
		formatTokenCount(row.cacheRead).padStart(TOKEN_DETAIL_WIDTH),
		formatTokenCount(row.cacheWrite).padStart(TOKEN_DETAIL_WIDTH),
		row.hitPercent.toFixed(PERCENT_PRECISION).padStart(HIT_PERCENT_WIDTH),
		formatMoney(row.cost).padStart(MONEY_WIDTH),
		formatMoney(row.saved).padStart(MONEY_WIDTH),
	].join(" ");
}

function padColumn(value: string, width: number): string {
	return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

function padColumnStart(value: string, width: number): string {
	return `${" ".repeat(Math.max(0, width - visibleWidth(value)))}${value}`;
}

function formatTokenCount(value: number): string {
	if (value < TOKENS_PER_THOUSAND) {
		return Math.round(value).toString();
	}
	const thousands = Math.ceil(value / TOKENS_PER_THOUSAND);
	if (thousands < THOUSANDS_PER_MILLION) {
		return `${thousands}K`;
	}
	const millionTenths = Math.ceil(value / TOKENS_PER_MILLION_TENTH);
	if (millionTenths < MILLION_TENTHS_PER_BILLION) {
		return `${(millionTenths / DECIMAL_FACTOR).toFixed(1)}M`;
	}
	const billionTenths = Math.ceil(value / TOKENS_PER_BILLION_TENTH);
	return `${(billionTenths / DECIMAL_FACTOR).toFixed(1)}B`;
}

function formatMoney(value: number): string {
	const unscaled = formatMoneyWithSuffix(value, "", MONEY_WIDTH);
	if (unscaled !== undefined) {
		return unscaled;
	}
	let divisor = MONEY_PER_THOUSAND;
	let suffix = "K";
	if (value >= MONEY_PER_BILLION) {
		divisor = MONEY_PER_BILLION;
		suffix = "B";
	} else if (value >= MONEY_PER_MILLION) {
		divisor = MONEY_PER_MILLION;
		suffix = "M";
	}
	return (
		formatMoneyWithSuffix(value / divisor, suffix, MONEY_WIDTH) ??
		`${Math.round(value / divisor)}${suffix}`
	);
}

function formatMoneyWithSuffix(
	value: number,
	suffix: string,
	maximumWidth: number,
): string | undefined {
	for (let precision = MAX_MONEY_PRECISION; precision >= 0; precision -= 1) {
		const formatted = `${value.toFixed(precision)}${suffix}`;
		if (formatted.length <= maximumWidth) {
			return formatted;
		}
	}
	return undefined;
}
