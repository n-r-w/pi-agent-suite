import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import type { ParticipantId } from "./types";

const SESSION_ENTRY_ID_BYTES = 4;

/** Owns the temporary session files created for one council run. */
export interface ParticipantSessionSeed {
	readonly rootDir: string;
	readonly sessions: Record<ParticipantId, ParticipantSessionFile>;
	cleanup(): Promise<void>;
}

/** Identifies one seeded participant session file. */
export interface ParticipantSessionFile {
	readonly participantId: ParticipantId;
	readonly sessionDir: string;
	readonly sessionFile: string;
}

/** Creates persisted participant sessions from the parent context snapshot. */
export async function seedParticipantSessions(options: {
	readonly cwd: string;
	readonly messages: readonly Message[];
}): Promise<ParticipantSessionSeed> {
	const rootDir = await mkdtemp(join(tmpdir(), "pi-convene-council-"));
	try {
		const sessions = {
			llm1: await writeParticipantSession(rootDir, "llm1", options),
			llm2: await writeParticipantSession(rootDir, "llm2", options),
		};
		return {
			rootDir,
			sessions,
			async cleanup(): Promise<void> {
				await rm(rootDir, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await rm(rootDir, { recursive: true, force: true });
		throw error;
	}
}

/** Writes one JSONL session file that Pi can open through --session. */
async function writeParticipantSession(
	rootDir: string,
	participantId: ParticipantId,
	options: {
		readonly cwd: string;
		readonly messages: readonly Message[];
	},
): Promise<ParticipantSessionFile> {
	const sessionDir = join(rootDir, participantId);
	await mkdir(sessionDir, { recursive: true });
	const sessionFile = join(sessionDir, `${Date.now()}_${randomUUID()}.jsonl`);
	const lines = [
		JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			cwd: options.cwd,
		}),
		...options.messages.map((message, index) =>
			JSON.stringify({
				type: "message",
				id: createEntryId(),
				parentId: index === 0 ? null : undefined,
				timestamp: new Date(message.timestamp ?? Date.now()).toISOString(),
				message,
			}),
		),
	];

	let previousId: string | null = null;
	const entries = lines.map((line, index) => {
		if (index === 0) {
			return line;
		}
		const entry = JSON.parse(line) as {
			id: string;
			parentId: string | null | undefined;
		};
		entry.parentId = previousId;
		previousId = entry.id;
		return JSON.stringify(entry);
	});
	await writeFile(sessionFile, `${entries.join("\n")}\n`, "utf8");
	return { participantId, sessionDir, sessionFile };
}

/** Creates the compact entry IDs used by Pi session files. */
function createEntryId(): string {
	return randomBytes(SESSION_ENTRY_ID_BYTES).toString("hex");
}
