import { basename } from "node:path";
import { toAgentIdMatchKey } from "./agent-id";

const AGENT_FILE_EXTENSION = ".md";

export type AgentFileSource = "global" | "project";

export interface SelectedAgentFile {
	readonly source: AgentFileSource;
	readonly entry: string;
}

/** Selects deterministic agent files while giving every unambiguous project ID priority over global content. */
export function selectAgentFiles(
	globalEntries: readonly string[] = [],
	projectEntries: readonly string[] = [],
): SelectedAgentFile[] {
	const projectGroups = groupProjectEntries(projectEntries);
	const projectKeys = new Set(projectGroups.keys());
	const globalFiles = toAgentEntries(globalEntries)
		.filter(
			(entry) =>
				!projectKeys.has(toAgentIdMatchKey(toAgentIdFromFileName(entry))),
		)
		.map((entry) => ({ source: "global" as const, entry }));
	const projectFiles = [...projectGroups.values()].flatMap((entries) => {
		const [entry, duplicate] = entries;
		return entry === undefined || duplicate !== undefined
			? []
			: [{ source: "project" as const, entry }];
	});

	return [...globalFiles, ...projectFiles].sort((left, right) =>
		left.entry.localeCompare(right.entry),
	);
}

/** Groups project entries before parsing so ambiguous IDs suppress every candidate with that ID. */
function groupProjectEntries(
	entries: readonly string[],
): Map<string, string[]> {
	const groups = new Map<string, string[]>();
	for (const entry of toAgentEntries(entries)) {
		const matchKey = toAgentIdMatchKey(toAgentIdFromFileName(entry));
		const matchingEntries = groups.get(matchKey) ?? [];
		matchingEntries.push(entry);
		groups.set(matchKey, matchingEntries);
	}
	return groups;
}

/** Returns sorted Markdown entries and ignores unrelated project resources. */
function toAgentEntries(entries: readonly string[]): string[] {
	return [...entries]
		.sort()
		.filter((entry) => entry.endsWith(AGENT_FILE_EXTENSION));
}

/** Derives the logical agent ID from one Markdown file name. */
function toAgentIdFromFileName(fileName: string): string {
	return basename(fileName, AGENT_FILE_EXTENSION);
}
