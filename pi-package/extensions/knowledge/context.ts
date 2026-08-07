import type { KnowledgeSnapshots } from "../../shared/knowledge-runtime";

/** Renders one applicable knowledge block or null when both files are absent. */
export function renderKnowledgeBlock(
	snapshots: KnowledgeSnapshots,
): string | null {
	if (snapshots.global === null && snapshots.local === null) {
		return null;
	}
	const sections = [
		...(snapshots.global === null
			? []
			: ["<global>", snapshots.global, "</global>"]),
		...(snapshots.local === null
			? []
			: ["<local>", snapshots.local, "</local>"]),
	];
	return ["<knowledge>", ...sections, "</knowledge>"].join("\n");
}
