import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import {
	type CompactionEntry,
	convertToLlm,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	estimateSerializedInputTokens,
	estimateTextTokens,
} from "../../shared/context-size";

/** Identifies persisted path records and request-only restoration messages. */
export const RESTORATION_TYPE = "skill-restoration";

/** Associates ordered candidate paths with one branch compaction. */
export interface RestorationRecord {
	readonly compactionId: string;
	readonly candidates: readonly string[];
}

/** Supplies prepared paths, absent paths, and a token estimate for the latest prepared request. */
export interface RestorationDelivery {
	readonly compactionId: string;
	readonly restoredPaths: readonly string[];
	readonly absentPaths: readonly string[];
	readonly estimatedTokens: number;
}

/** Supplies the actual request and selected-model headroom for fresh disk-backed delivery. */
export interface RestorationRequest {
	readonly record: RestorationRecord;
	readonly messages: AgentMessage[];
	readonly timestamp: number;
	readonly systemHead: SystemMessage | undefined;
	readonly contextWindow: number;
	readonly reserveTokens: number;
	readonly keepRecentTokens: number;
}

/** Holds disk content only while preparing one request. */
interface SkillFile {
	readonly path: string;
	readonly content: string;
}

/** Reads disk files and inserts whole files within the complete-request estimate limit. */
export async function insertRestoration(options: RestorationRequest): Promise<{
	messages: AgentMessage[];
	delivery: RestorationDelivery | undefined;
}> {
	const clean = options.messages.filter(
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
	if (summaryIndex < 0) {
		return { messages: clean, delivery: undefined };
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
	const fits = (messages: AgentMessage[]): boolean =>
		estimateSerializedInputTokens({
			messages: convertToLlm(
				options.systemHead ? [options.systemHead, ...messages] : messages,
			),
		}) <= limit;
	const complete = buildDelivery(options, clean, summaryIndex, {
		files: readable,
		absent: [],
	});
	// An empty absent list removes its instruction, so the complete set can fit before an intermediate subset does.
	if (fits(complete.messages)) {
		return complete;
	}
	let files: SkillFile[] = [];
	let absent = readable.map((file) => file.path);
	for (const file of readable) {
		const trialFiles = [...files, file];
		const trialAbsent = absent.filter((path) => path !== file.path);
		const trial = buildDelivery(options, clean, summaryIndex, {
			files: trialFiles,
			absent: trialAbsent,
		});
		if (fits(trial.messages)) {
			files = trialFiles;
			absent = trialAbsent;
		}
	}
	return buildDelivery(options, clean, summaryIndex, { files, absent });
}

/** Prepares request-only insertion and in-memory delivery metadata. */
function buildDelivery(
	options: RestorationRequest,
	clean: AgentMessage[],
	summaryIndex: number,
	{ files, absent }: { files: readonly SkillFile[]; absent: readonly string[] },
): { messages: AgentMessage[]; delivery: RestorationDelivery } {
	const content = formatRestoration(files, absent);
	const delivery = {
		compactionId: options.record.compactionId,
		restoredPaths: files.map((file) => file.path),
		absentPaths: absent,
		estimatedTokens:
			files.length + absent.length === 0 ? 0 : estimateTextTokens(content),
	};
	if (files.length + absent.length === 0) {
		return { messages: clean, delivery };
	}
	const message: AgentMessage = {
		role: "custom",
		customType: RESTORATION_TYPE,
		content,
		display: false,
		details: delivery,
		timestamp: options.timestamp,
	};
	return {
		messages: [
			...clean.slice(0, summaryIndex + 1),
			message,
			...clean.slice(summaryIndex + 1),
		],
		delivery,
	};
}

/** Frames whole disk files and explicitly identifies readable files that do not fit. */
function formatRestoration(
	files: readonly SkillFile[],
	absent: readonly string[],
): string {
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

/** Returns the latest branch compaction and its validated associated path record. */
export function findBranchRestoration(
	branch: readonly SessionEntry[],
):
	| { compaction: CompactionEntry; record: RestorationRecord | undefined }
	| undefined {
	const compaction = [...branch]
		.reverse()
		.find((entry) => entry.type === "compaction");
	if (compaction?.type !== "compaction") {
		return undefined;
	}
	const entry = branch
		.slice(branch.indexOf(compaction) + 1)
		.reverse()
		.find(
			(entry) =>
				entry.type === "custom" && entry.customType === RESTORATION_TYPE,
		);
	const record =
		entry?.type === "custom" ? parseRestorationRecord(entry.data) : undefined;
	return {
		compaction,
		record: record?.compactionId === compaction.id ? record : undefined,
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
