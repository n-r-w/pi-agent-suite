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
const HIT_PERCENT_WIDTH = 8;
const MONEY_WIDTH = 10;
const HIT_PERCENT_PRECISION = 1;
const MONEY_PRECISION = 4;

export interface TablePaneOptions {
	readonly width: number;
	readonly height: number;
	readonly verticalOffset: number;
	readonly horizontalOffset: number;
	readonly focused: boolean;
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
	const { focused, height, horizontalOffset, verticalOffset } = options;
	const contentWidth = Math.max(0, options.width);
	if (rows.length === 0) {
		return renderEmptyTable(contentWidth, height, focused);
	}

	const fullLines = [tableHeader(focused), ...rows.map(formatRow)];
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
	const visibleRows = rows.slice(
		boundedVerticalOffset,
		boundedVerticalOffset + dataViewport,
	);
	const lines = [
		sliceLine(fullLines[0] ?? "", boundedHorizontalOffset, contentWidth),
		...visibleRows.map((row) =>
			sliceLine(formatRow(row), boundedHorizontalOffset, contentWidth),
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
			),
		);
	}
	const verticalThumb = calculateScrollThumb(
		{
			offset: boundedVerticalOffset,
			total: rows.length,
			viewport: dataViewport,
		},
		dataViewport,
	);
	return {
		lines,
		scroll: Array.from({ length: height }, (_, row) => {
			if (row === 0 || row > dataViewport || verticalThumb === undefined) {
				return " ";
			}
			return isScrollThumbRow(verticalThumb, row - 1) ? "█" : "░";
		}),
		verticalOffset: boundedVerticalOffset,
		horizontalOffset: boundedHorizontalOffset,
		verticalViewport: dataViewport,
		maximumHorizontalOffset,
	};
}

function renderEmptyTable(
	width: number,
	height: number,
	focused: boolean,
): TablePaneRender {
	return {
		lines: [
			padToWidth(`${focused ? "›" : " "} No usage in selected range`, width),
		],
		scroll: Array.from({ length: height }, () => " "),
		verticalOffset: 0,
		horizontalOffset: 0,
		verticalViewport: Math.max(0, height - 1),
		maximumHorizontalOffset: 0,
	};
}

function renderHorizontalTrack(metrics: ScrollMetrics, width: number): string {
	const thumb = calculateScrollThumb(metrics, width);
	return Array.from({ length: width }, (_, column) =>
		isScrollThumbRow(thumb, column) ? "█" : "░",
	).join("");
}

function sliceLine(line: string, offset: number, width: number): string {
	const sliced = sliceByColumn(line, offset, width, true);
	return `${sliced}${" ".repeat(Math.max(0, width - visibleWidth(sliced)))}`;
}

function tableHeader(focused: boolean): string {
	return [
		`${focused ? "›" : " "} Model`.padEnd(MODEL_WIDTH),
		"Tokens".padStart(TOKENS_WIDTH),
		"Read".padStart(TOKEN_DETAIL_WIDTH),
		"Write".padStart(TOKEN_DETAIL_WIDTH),
		"Hit%".padStart(HIT_PERCENT_WIDTH),
		"Cost".padStart(MONEY_WIDTH),
		"Saved".padStart(MONEY_WIDTH),
	].join(" ");
}

function formatRow(row: UsageRow): string {
	return [
		row.label.padEnd(MODEL_WIDTH),
		formatInteger(row.tokens).padStart(TOKENS_WIDTH),
		formatInteger(row.cacheRead).padStart(TOKEN_DETAIL_WIDTH),
		formatInteger(row.cacheWrite).padStart(TOKEN_DETAIL_WIDTH),
		`${row.hitPercent.toFixed(HIT_PERCENT_PRECISION)}%`.padStart(
			HIT_PERCENT_WIDTH,
		),
		formatMoney(row.cost).padStart(MONEY_WIDTH),
		formatMoney(row.saved).padStart(MONEY_WIDTH),
	].join(" ");
}

function formatInteger(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

function formatMoney(value: number): string {
	return `$${value.toFixed(MONEY_PRECISION)}`;
}
