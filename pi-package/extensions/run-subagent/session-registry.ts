import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Custom session entry that persists child session references outside LLM context. */
export const SUBAGENT_SESSION_CUSTOM_TYPE = "run-subagent-session";

/** Identifies one child Pi session within its owning main-agent session. */
export interface SubagentSessionReference {
	readonly sessionId: number;
	readonly childSessionId: string;
	readonly childSessionDir: string;
	readonly agentId: string;
	readonly cwd: string;
}

interface NewSubagentSessionReference {
	readonly childSessionId: string;
	readonly childSessionDir: string;
	readonly agentId: string;
	readonly cwd: string;
}

/** Owns short session allocation, persisted reference restoration, and active-run exclusion. */
export class SubagentSessionRegistry {
	private readonly references = new Map<number, SubagentSessionReference>();
	private readonly conflictedSessionIds = new Set<number>();
	private readonly activeSessionIds = new Set<number>();
	private nextSessionId = 1;

	/** Restores references recorded in the current main-agent session. */
	public restore(entries: readonly SessionEntry[]): void {
		this.references.clear();
		this.conflictedSessionIds.clear();
		this.activeSessionIds.clear();
		this.nextSessionId = 1;

		for (const entry of entries) {
			const reference = parseSubagentSessionReference(entry);
			if (reference === undefined) {
				continue;
			}

			const existing = this.references.get(reference.sessionId);
			// Once conflicted, later duplicates cannot make an alias trustworthy again.
			if (!this.conflictedSessionIds.has(reference.sessionId)) {
				if (existing === undefined) {
					this.references.set(reference.sessionId, reference);
				} else if (!sameSubagentSessionReference(existing, reference)) {
					// Conflicting aliases must never resolve to an arbitrary child session.
					this.references.delete(reference.sessionId);
					this.conflictedSessionIds.add(reference.sessionId);
				}
			}
			this.nextSessionId = Math.max(
				this.nextSessionId,
				reference.sessionId + 1,
			);
		}
	}

	/** Allocates the next collision-free alias in the current main-agent session. */
	public create(
		reference: NewSubagentSessionReference,
	): SubagentSessionReference {
		const stored = { sessionId: this.nextSessionId, ...reference };
		this.references.set(stored.sessionId, stored);
		this.nextSessionId += 1;
		return stored;
	}

	/** Resolves a public numeric alias to its internal child session reference. */
	public get(sessionId: number): SubagentSessionReference | undefined {
		return this.references.get(sessionId);
	}

	/** Acquires exclusive execution ownership for one child session. */
	public acquire(sessionId: number): boolean {
		if (this.activeSessionIds.has(sessionId)) {
			return false;
		}
		this.activeSessionIds.add(sessionId);
		return true;
	}

	/** Releases execution ownership after the child process finishes. */
	public release(sessionId: number): void {
		this.activeSessionIds.delete(sessionId);
	}
}

/** Parses only valid references owned by this extension from session storage. */
function parseSubagentSessionReference(
	entry: SessionEntry,
): SubagentSessionReference | undefined {
	if (
		entry.type !== "custom" ||
		entry.customType !== SUBAGENT_SESSION_CUSTOM_TYPE ||
		!isRecord(entry.data)
	) {
		return undefined;
	}

	const { sessionId, childSessionId, childSessionDir, agentId, cwd } =
		entry.data;
	if (
		!Number.isSafeInteger(sessionId) ||
		typeof sessionId !== "number" ||
		sessionId < 1 ||
		typeof childSessionId !== "string" ||
		childSessionId.length === 0 ||
		typeof childSessionDir !== "string" ||
		childSessionDir.length === 0 ||
		typeof agentId !== "string" ||
		agentId.length === 0 ||
		typeof cwd !== "string" ||
		cwd.length === 0
	) {
		return undefined;
	}

	return { sessionId, childSessionId, childSessionDir, agentId, cwd };
}

/** Compares persisted references before accepting duplicate aliases. */
function sameSubagentSessionReference(
	left: SubagentSessionReference,
	right: SubagentSessionReference,
): boolean {
	return (
		left.sessionId === right.sessionId &&
		left.childSessionId === right.childSessionId &&
		left.childSessionDir === right.childSessionDir &&
		left.agentId === right.agentId &&
		left.cwd === right.cwd
	);
}

/** Narrows untrusted custom-entry data to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
