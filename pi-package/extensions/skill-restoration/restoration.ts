import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import {
	type CompactionEntry,
	convertToLlm,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { estimateSerializedInputTokens } from "../../shared/context-size";

/** Identifies persisted path records and request-only restoration messages. */
export const RESTORATION_TYPE = "skill-restoration";

/** Identifies persisted records of the files selected for one compaction. */
export const SELECTION_TYPE = "skill-restoration-selection";

/** Associates ordered candidate paths with one branch compaction. */
export interface RestorationRecord {
	readonly compactionId: string;
	readonly candidates: readonly string[];
}

/** Holds one whole skill file as it was read for a selection. */
interface SkillFile {
	readonly path: string;
	readonly content: string;
}

/** Holds the files that every request after one compaction restores, and the readable paths that did not fit. */
export interface RestorationSelection {
	readonly compactionId: string;
	readonly files: readonly SkillFile[];
	readonly absent: readonly string[];
}

/** Describes the paths of one inserted restoration message. */
export interface RestorationDelivery {
	readonly compactionId: string;
	readonly restoredPaths: readonly string[];
	readonly absentPaths: readonly string[];
}

/** Supplies the first request after a compaction and the selected-model headroom. */
export interface SelectionRequest {
	readonly record: RestorationRecord;
	readonly messages: AgentMessage[];
	readonly timestamp: number;
	readonly systemHead: SystemMessage | undefined;
	readonly contextWindow: number;
	readonly reserveTokens: number;
	readonly keepRecentTokens: number;
}

/** Reads candidate files from disk and selects whole files within the complete-request estimate limit, or returns undefined for a request without a summary. */
export async function selectRestoration(
	options: SelectionRequest,
): Promise<RestorationSelection | undefined> {
	if (
		!options.messages.some((message) => message.role === "compactionSummary")
	) {
		return undefined;
	}
	const reads = await Promise.allSettled(
		options.record.candidates.map(async (path) => ({
			path,
			content: await readFile(path, "utf8"),
		})),
	);
	const readable = reads.flatMap((result) =>
		result.status === "fulfilled" ? [result.value] : [],
	);
	const limit =
		options.contextWindow - options.reserveTokens - options.keepRecentTokens;
	const compactionId = options.record.compactionId;
	const fits = (selection: RestorationSelection): boolean => {
		const messages = insertSelection(
			options.messages,
			selection,
			options.timestamp,
		);
		return (
			estimateSerializedInputTokens({
				messages: convertToLlm(
					options.systemHead ? [options.systemHead, ...messages] : messages,
				),
			}) <= limit
		);
	};
	const complete = { compactionId, files: readable, absent: [] };
	// An empty absent list removes its instruction, so the complete set can fit before an intermediate subset does.
	if (fits(complete)) {
		return complete;
	}
	let selection: RestorationSelection = {
		compactionId,
		files: [],
		absent: readable.map((file) => file.path),
	};
	for (const file of readable) {
		const trial = {
			compactionId,
			files: [...selection.files, file],
			absent: selection.absent.filter((path) => path !== file.path),
		};
		if (fits(trial)) {
			selection = trial;
		}
	}
	return selection;
}

/** Inserts the selection right after the latest compaction summary, regardless of request size. */
export function insertSelection(
	messages: AgentMessage[],
	selection: RestorationSelection,
	timestamp: number,
): AgentMessage[] {
	const clean = messages.filter(
		(message) =>
			message.role !== "custom" || message.customType !== RESTORATION_TYPE,
	);
	let summaryIndex = -1;
	for (let index = clean.length - 1; index >= 0; index -= 1) {
		if (clean[index]?.role === "compactionSummary") {
			summaryIndex = index;
			break;
		}
	}
	if (
		summaryIndex < 0 ||
		selection.files.length + selection.absent.length === 0
	) {
		return clean;
	}
	const details: RestorationDelivery = {
		compactionId: selection.compactionId,
		restoredPaths: selection.files.map((file) => file.path),
		absentPaths: selection.absent,
	};
	const message: AgentMessage = {
		role: "custom",
		customType: RESTORATION_TYPE,
		content: formatRestoration(selection),
		display: false,
		details,
		timestamp,
	};
	return [
		...clean.slice(0, summaryIndex + 1),
		message,
		...clean.slice(summaryIndex + 1),
	];
}

/** Frames whole files and explicitly identifies readable files that do not fit. */
export function formatRestoration({
	files,
	absent,
}: RestorationSelection): string {
	return [
		"Skill files restored after compaction:",
		...files.map(
			(file) =>
				`\n<skill-file path=${JSON.stringify(file.path)}>\n${file.content}\n</skill-file>`,
		),
		...(absent.length
			? [
					"\nThe following skill files are absent from context. Read each file before work to which it applies:",
					...absent.map((path) => JSON.stringify(path)),
				]
			: []),
	].join("\n");
}

/** Returns the latest branch compaction with its validated path record and selection. */
export function findBranchRestoration(branch: readonly SessionEntry[]):
	| {
			compaction: CompactionEntry;
			record: RestorationRecord | undefined;
			selection: RestorationSelection | undefined;
	  }
	| undefined {
	const compaction = [...branch]
		.reverse()
		.find((entry) => entry.type === "compaction");
	if (compaction?.type !== "compaction") {
		return undefined;
	}
	const following = branch.slice(branch.indexOf(compaction) + 1);
	const findLatest = (type: string): unknown =>
		following
			.filter((entry) => entry.type === "custom" && entry.customType === type)
			.map((entry) => (entry.type === "custom" ? entry.data : undefined))
			.at(-1);
	const record = parseRestorationRecord(findLatest(RESTORATION_TYPE));
	const selection = parseSelectionRecord(findLatest(SELECTION_TYPE));
	return {
		compaction,
		record: record?.compactionId === compaction.id ? record : undefined,
		selection:
			selection?.compactionId === compaction.id ? selection : undefined,
	};
}

/** Returns a validated path record, or undefined for invalid data. */
export function parseRestorationRecord(
	value: unknown,
): RestorationRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const data = value as Record<string, unknown>;
	if (
		Object.keys(data).length !== 2 ||
		typeof data["compactionId"] !== "string" ||
		data["compactionId"].length === 0 ||
		!Array.isArray(data["candidates"])
	) {
		return undefined;
	}
	const candidates: unknown[] = data["candidates"];
	if (
		!candidates.every(
			(path): path is string => typeof path === "string" && isAbsolute(path),
		) ||
		new Set(candidates).size !== candidates.length
	) {
		return undefined;
	}
	return { compactionId: data["compactionId"], candidates };
}

/** Lists the fields of a persisted selection record in sorted order. */
const SELECTION_FIELDS = ["absent", "compactionId", "files"];

/** Returns a validated selection record, or undefined for invalid data. */
export function parseSelectionRecord(
	value: unknown,
): RestorationSelection | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const data = value as Record<string, unknown>;
	const files = data["files"];
	const absent = data["absent"];
	if (
		Object.keys(data).sort().join() !== SELECTION_FIELDS.join() ||
		typeof data["compactionId"] !== "string" ||
		data["compactionId"].length === 0 ||
		!Array.isArray(files) ||
		!Array.isArray(absent) ||
		!files.every(isSkillFile) ||
		!absent.every(isAbsolutePath)
	) {
		return undefined;
	}
	const paths = [...files.map((file) => file.path), ...absent];
	if (new Set(paths).size !== paths.length) {
		return undefined;
	}
	return { compactionId: data["compactionId"], files, absent };
}

/** Returns true for a persisted whole file with an absolute path. */
function isSkillFile(value: unknown): value is SkillFile {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const file = value as Record<string, unknown>;
	return (
		Object.keys(file).length === 2 &&
		isAbsolutePath(file["path"]) &&
		typeof file["content"] === "string"
	);
}

/** Returns true for an absolute path string. */
function isAbsolutePath(value: unknown): value is string {
	return typeof value === "string" && isAbsolute(value);
}
