import {
	type ProjectedSessionEntry,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

/** Test fixture: projects a branch as Pi does when a compaction keeps no entry, so that each entry before the latest compaction or branch summary is hidden from the model. */
export function projectBranch(
	branch: readonly unknown[],
): ProjectedSessionEntry[] {
	const boundary = branch.reduce<number>(
		(last, entry, index) =>
			typeof entry === "object" &&
			entry !== null &&
			"type" in entry &&
			(entry.type === "compaction" || entry.type === "branch_summary")
				? index
				: last,
		-1,
	);
	return branch.map((sourceEntry, index) =>
		index > boundary
			? projectVisibleEntry(sourceEntry)
			: ({ sourceEntry, messages: [] } as unknown as ProjectedSessionEntry),
	);
}

/** Test fixture: projects one model-visible entry, with the message that Pi builds from a custom message entry and a placeholder message for any other entry. */
export function projectVisibleEntry(
	sourceEntry: unknown,
): ProjectedSessionEntry {
	const isCustomMessage =
		typeof sourceEntry === "object" &&
		sourceEntry !== null &&
		"type" in sourceEntry &&
		sourceEntry.type === "custom_message";
	return {
		sourceEntry,
		messages: isCustomMessage
			? sessionEntryToContextMessages(sourceEntry as SessionEntry)
			: [{}],
	} as unknown as ProjectedSessionEntry;
}

/** Test fixture: projects published workflow records as Pi does after it saves each of them. */
export function projectRecords(
	records: readonly object[],
): ProjectedSessionEntry[] {
	return projectBranch(
		records.map((record) => ({ type: "custom_message", ...record })),
	);
}
