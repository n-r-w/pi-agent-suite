import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";

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
	return branch.map((sourceEntry, index) => ({
		sourceEntry,
		messages: index > boundary ? [{}] : [],
	})) as ProjectedSessionEntry[];
}
