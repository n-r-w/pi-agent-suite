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
				throw new Error("saved Pi session file is unavailable", {
					cause: error,
				});
			}
			throw new Error("failed to inspect saved Pi session file", {
				cause: error,
			});
		}
		if (!metadata.isFile()) {
			throw new Error("saved Pi session file is unavailable");
		}
		if (metadata.size === 0) {
			throw new Error("saved Pi session file is empty");
		}
		try {
			return Object.freeze([...SessionManager.open(sessionFile).getBranch()]);
		} catch (error) {
			throw new Error("failed to load saved Pi session", { cause: error });
		}
	}
}
