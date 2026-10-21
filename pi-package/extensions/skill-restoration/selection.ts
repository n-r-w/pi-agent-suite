import { dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { buildContextEntryMapping } from "../../shared/context-projection";
import {
	getReadToolCallPath,
	isPathInsideOrEqual,
	resolveReadInputPath,
} from "../../shared/skill-paths";
import type { RestorationRecord } from "./restoration";

/** Identifies skill commands expanded into effective user messages. */
const SKILL_LOCATION =
	/<skill\b[^>]*\blocation\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/g;

/** Supplies branch boundaries and declared ownership for candidate selection. */
export interface SkillSelection {
	readonly branch: readonly SessionEntry[];
	readonly firstKeptEntryId: string | null;
	readonly roots: readonly string[];
	readonly cwd: string;
	readonly previous: RestorationRecord | undefined;
}

/** Returns skill directories declared by Pi's command catalog. */
export function collectSkillRoots(
	pi: Pick<ExtensionAPI, "getCommands">,
	cwd: string,
): string[] {
	return pi
		.getCommands()
		.flatMap((command) =>
			command.source === "skill" && command.sourceInfo.path
				? [dirname(resolveReadInputPath(command.sourceInfo.path, cwd))]
				: [],
		);
}

/** Selects effective summarized loads in recency order, excluding retained successful loads. */
export function collectSkillCandidates({
	branch,
	firstKeptEntryId,
	roots,
	cwd,
	previous,
}: SkillSelection): string[] {
	const keptIndex =
		firstKeptEntryId === null
			? branch.length
			: branch.findIndex((entry) => entry.id === firstKeptEntryId);
	const entryIndices = new Map(branch.map((entry, index) => [entry.id, index]));
	const candidates = new Set([...(previous?.candidates ?? [])].reverse());
	// Preserve tracked paths when Pi omits their skill from its catalog.
	const isSkill = (path: string): boolean =>
		candidates.has(path) ||
		roots.some((root) => isPathInsideOrEqual(path, root));
	const retained = new Set<string>();
	const calls = new Map<string, string>();
	for (const { entry, message } of buildContextEntryMapping(branch)) {
		const inSuffix =
			keptIndex >= 0 && (entryIndices.get(entry.id) ?? -1) >= keptIndex;
		for (const path of collectLoadedPaths(message, calls, cwd).filter(
			isSkill,
		)) {
			if (inSuffix) {
				retained.add(path);
			} else {
				candidates.delete(path);
				candidates.add(path);
			}
		}
	}
	return [...candidates].reverse().filter((path) => !retained.has(path));
}

/** Extracts successful read results and skill-command locations from effective messages. */
function collectLoadedPaths(
	message: AgentMessage,
	calls: Map<string, string>,
	cwd: string,
): string[] {
	if (message.role === "assistant") {
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.name !== "read") {
				continue;
			}
			const path = getReadToolCallPath(block.arguments);
			if (path !== undefined) {
				calls.set(block.id, resolveReadInputPath(path, cwd));
			}
		}
		return [];
	}
	if (
		message.role === "toolResult" &&
		message.toolName === "read" &&
		!message.isError
	) {
		const path = calls.get(message.toolCallId);
		return path === undefined ? [] : [path];
	}
	return message.role === "user"
		? collectCommandPaths(message.content, cwd)
		: [];
}

/** Resolves skill locations carried by effective user-message text blocks. */
function collectCommandPaths(
	content: Extract<AgentMessage, { role: "user" }>["content"],
	cwd: string,
): string[] {
	const text =
		typeof content === "string"
			? content
			: content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
	return [...text.matchAll(SKILL_LOCATION)].flatMap((match) => {
		const path = match[1] ?? match[2];
		return path ? [resolveReadInputPath(path, cwd)] : [];
	});
}
