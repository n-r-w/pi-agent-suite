import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import type { ParticipantId } from "./types";

/** Owns the temporary session files created for one council run. */
export interface ParticipantSessionSet {
	readonly rootDir: string;
	readonly sessions: Record<ParticipantId, ParticipantSessionFile>;
	cleanup(): Promise<void>;
}

/** Identifies one participant-owned session file. */
export interface ParticipantSessionFile {
	readonly participantId: ParticipantId;
	readonly sessionDir: string;
	readonly sessionFile: string;
}

/** Creates persisted participant-owned sessions without parent transcript messages. */
export async function createParticipantSessions(options: {
	readonly cwd: string;
}): Promise<ParticipantSessionSet> {
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
	},
): Promise<ParticipantSessionFile> {
	const sessionDir = join(rootDir, participantId);
	await mkdir(sessionDir, { recursive: true });
	const sessionFile = join(sessionDir, `${Date.now()}_${randomUUID()}.jsonl`);
	const header = JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: randomUUID(),
		timestamp: new Date().toISOString(),
		cwd: options.cwd,
	});
	await writeFile(sessionFile, `${header}\n`, "utf8");
	return { participantId, sessionDir, sessionFile };
}
