import {
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { JournalRecord, LogicalSession } from "./domain";
import { SessionStore, SUBAGENT_JOURNAL_CUSTOM_TYPE } from "./persistence";

type ReadonlySessionManager = ExtensionContext["sessionManager"];
type OwnerSnapshot = Extract<JournalRecord, { kind: "owner-snapshot" }>;
type AppendRootSnapshot = (snapshot: OwnerSnapshot) => void;

/** Copies retained terminal-success owner branches into independent Pi sessions. */
export function materializeForkHierarchy(
	root: ReadonlySessionManager,
	appendRootSnapshot: AppendRootSnapshot,
): void {
	const store = new SessionStore();
	const sessions = materializeOwner(store, root);
	appendRootSnapshot({
		kind: "owner-snapshot",
		ownerPiSessionId: root.getSessionId(),
		sessions,
	});
}

/** Copies one owner's retained direct children and persists its snapshot after descendants. */
function materializeOwner(
	store: SessionStore,
	owner: ReadonlySessionManager,
): LogicalSession[] {
	const folded = store.fold(owner.getBranch());
	const retained: LogicalSession[] = [];
	for (const sourceSession of folded.sessions) {
		if (sourceSession.state !== "terminal-success") {
			continue;
		}
		const sourceChild = SessionManager.open(
			sourceSession.childSessionFile,
			sourceSession.childSessionDir,
		);
		const leafId = sourceChild.getLeafId();
		if (leafId === null) {
			throw new Error(
				`cannot materialize ${sourceSession.key.ownerPiSessionId}:${sourceSession.key.ownerLocalSessionId}: source child has no current leaf`,
			);
		}
		const branchedFile = sourceChild.createBranchedSession(leafId);
		if (branchedFile === undefined) {
			throw new Error(
				`cannot materialize ${sourceSession.key.ownerPiSessionId}:${sourceSession.key.ownerLocalSessionId}: branch was not persisted`,
			);
		}
		const clonedChild = sourceChild;
		const descendants = materializeOwner(store, clonedChild);
		clonedChild.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
			kind: "owner-snapshot",
			ownerPiSessionId: clonedChild.getSessionId(),
			sessions: descendants,
		});
		retained.push(rebaseSession(sourceSession, owner, clonedChild));
	}
	return retained;
}

/** Replaces physical hierarchy identity while retaining logical invocation metadata. */
function rebaseSession(
	source: LogicalSession,
	owner: ReadonlySessionManager,
	clonedChild: ReadonlySessionManager,
): LogicalSession {
	const { ownerRuntimeLeaseId: _ownerRuntimeLeaseId, ...withoutOwnerLease } =
		source;
	const childSessionFile = clonedChild.getSessionFile();
	if (childSessionFile === undefined) {
		throw new Error(
			`cannot materialize ${source.key.ownerPiSessionId}:${source.key.ownerLocalSessionId}: cloned child has no persisted path`,
		);
	}
	return {
		...withoutOwnerLease,
		key: {
			...source.key,
			ownerPiSessionId: owner.getSessionId(),
		},
		childPiSessionId: clonedChild.getSessionId(),
		childSessionDir: clonedChild.getSessionDir(),
		childSessionFile,
	};
}
