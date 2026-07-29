import { stat } from "node:fs/promises";
import {
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

/** Reports whether an unknown value has string-keyed fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Reports whether a filesystem error represents an unavailable path. */
function isUnavailableFile(error: unknown): boolean {
	return (
		isRecord(error) &&
		(error["code"] === "ENOENT" || error["code"] === "ENOTDIR")
	);
}

export type SessionSnapshotFailureKind =
	| "unavailable"
	| "empty"
	| "invalid"
	| "read_failed";

/** Classifies saved-session failures without exposing storage wording to callers. */
export class SessionSnapshotError extends Error {
	public constructor(
		public readonly kind: SessionSnapshotFailureKind,
		message: string,
		cause?: unknown,
	) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "SessionSnapshotError";
	}
}

/** Loads saved Pi branches through the public SessionManager API. */
export class SessionSnapshotLoader {
	private readonly inFlight = new Map<
		string,
		Promise<readonly SessionEntry[]>
	>();

	/** Returns the current root-to-leaf branch for one persisted session file. */
	public load(sessionFile: string): Promise<readonly SessionEntry[]> {
		const existing = this.inFlight.get(sessionFile);
		if (existing !== undefined) {
			return existing;
		}
		const pending = this.loadOnce(sessionFile).finally(() => {
			this.inFlight.delete(sessionFile);
		});
		this.inFlight.set(sessionFile, pending);
		return pending;
	}

	/** Rejects paths that SessionManager would create or initialize. */
	private async loadOnce(
		sessionFile: string,
	): Promise<readonly SessionEntry[]> {
		let metadata: Awaited<ReturnType<typeof stat>>;
		try {
			metadata = await stat(sessionFile);
		} catch (error) {
			if (isUnavailableFile(error)) {
				throw new SessionSnapshotError(
					"unavailable",
					"saved Pi session file is unavailable",
					error,
				);
			}
			throw new SessionSnapshotError(
				"read_failed",
				"failed to inspect saved Pi session file",
				error,
			);
		}
		if (!metadata.isFile()) {
			throw new SessionSnapshotError(
				"unavailable",
				"saved Pi session file is unavailable",
			);
		}
		if (metadata.size === 0) {
			throw new SessionSnapshotError("empty", "saved Pi session file is empty");
		}
		try {
			return Object.freeze([...SessionManager.open(sessionFile).getBranch()]);
		} catch (error) {
			throw new SessionSnapshotError(
				"invalid",
				"failed to load saved Pi session",
				error,
			);
		}
	}
}
