import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { normalizeTerminalDisplayText } from "./terminal-display-text";

/** Separates the workflow chain from the current stage description. */
const STAGE_SEPARATOR = " · ";

/** Removes one optional sentence-ending period from the compact status. */
const TRAILING_PERIOD_PATTERN = /\.$/u;

/** Bounds a workflow row by hiding outer parents before its stage or current name. */
export function renderWorkflowStatusText(
	workflowPath: string,
	stageDescription: string,
	width: number,
): string {
	if (width <= 0) {
		return "";
	}
	const ids = normalizeTerminalDisplayText(workflowPath).split("➡");
	const description = normalizeTerminalDisplayText(stageDescription).replace(
		TRAILING_PERIOD_PATTERN,
		"",
	);
	for (let start = 0; start < ids.length; start++) {
		const path = `${start === 0 ? "" : "…➡"}${ids.slice(start).join("➡")}`;
		const row = `Workflow: ${path}${STAGE_SEPARATOR}${description}`;
		if (visibleWidth(row) <= width) {
			return row;
		}
	}
	const current = ids.at(-1) ?? "";
	const markedName = `Workflow: …➡${current}`;
	const name =
		ids.length > 1 && visibleWidth(markedName) <= width
			? markedName
			: `Workflow: ${current}`;
	const nameWidth = visibleWidth(name);
	if (nameWidth > width) {
		return truncateToWidth(name, width, "…");
	}
	const stageWidth = width - nameWidth - visibleWidth(STAGE_SEPARATOR);
	return stageWidth > 0
		? `${name}${STAGE_SEPARATOR}${truncateToWidth(description, stageWidth, "…")}`
		: name;
}
