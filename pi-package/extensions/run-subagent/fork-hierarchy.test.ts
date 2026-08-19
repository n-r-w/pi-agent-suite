import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createPersistedSession } from "../../../test/support/persisted-session.ts";
import type { JournalRecord, LogicalSession } from "./domain";
import { materializeForkHierarchy } from "./fork-hierarchy";
import { SUBAGENT_JOURNAL_CUSTOM_TYPE } from "./persistence";

const metadata = {
	startedAtMs: 1,
	elapsedMs: 1_000,
	modelId: "openai/test-model",
	thinking: "high",
	contextWindow: 128_000,
	contextTokens: 2_000,
	projectionSavedTokens: 300,
} as const;

function session(
	ownerPiSessionId: string,
	ownerSessionDir: string,
	ownerLocalSessionId: number,
	state: LogicalSession["state"],
): LogicalSession {
	return {
		key: { ownerPiSessionId, ownerLocalSessionId },
		childPiSessionId: `child-${ownerLocalSessionId}`,
		childSessionDir: ownerSessionDir,
		childSessionFile: join(
			ownerSessionDir,
			`child-${ownerLocalSessionId}.jsonl`,
		),
		agentId: "SubAgentCoder",
		taskName: `task-${ownerLocalSessionId}`,
		creationOrder: ownerLocalSessionId,
		invocationId: `invocation-${ownerLocalSessionId}`,
		runtimeLeaseId: `lease-${ownerLocalSessionId}`,
		invocationMetadata: metadata,
		state,
	};
}

function appendLifecycle(manager: SessionManager, child: LogicalSession): void {
	manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
		kind: "session-accepted",
		session: { ...child, state: "active" },
	} satisfies JournalRecord);
	if (child.state === "starting" || child.state === "active") {
		return;
	}
	manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
		kind: "terminal",
		sessionKey: child.key,
		invocationId: child.invocationId,
		state:
			child.state === "terminal-success" ? "terminal-success" : child.state,
		disposition: "pending",
	} satisfies JournalRecord);
}

describe("materializeForkHierarchy", () => {
	test("copies current successful branches recursively and rebases snapshots", () => {
		// Purpose: materialization must recursively copy current terminal-success branches through public Pi APIs.
		// Inputs and expected outputs: a forked root references successful, active, failed, and aborted children; the callback receives only rebased successful sessions with copied nested history.
		// Edge cases: nested descendants, history appended after the root fork, and writes after materialization must remain isolated.
		// Dependencies: public SessionManager persistence and the persisted-session fixture helper.
		const directory = mkdtempSync(join(tmpdir(), "fork-hierarchy-"));
		try {
			const root = createPersistedSession(join(directory, "root"), {
				id: "root",
				text: "root seed",
			});
			const child = createPersistedSession(join(directory, "child"), {
				id: "child",
				text: "child seed",
			});
			const grandchild = createPersistedSession(join(directory, "grandchild"), {
				id: "grandchild",
				text: "grandchild seed",
			});
			const childFile = child.getSessionFile();
			const grandchildFile = grandchild.getSessionFile();
			if (childFile === undefined || grandchildFile === undefined) {
				throw new Error("fixture sessions must be persisted");
			}
			const nested = {
				...session(
					child.getSessionId(),
					child.getSessionDir(),
					1,
					"terminal-success",
				),
				childPiSessionId: grandchild.getSessionId(),
				childSessionFile: grandchildFile,
			};
			appendLifecycle(child, nested);
			const selected = {
				...session(
					root.getSessionId(),
					root.getSessionDir(),
					1,
					"terminal-success",
				),
				childPiSessionId: child.getSessionId(),
				childSessionDir: child.getSessionDir(),
				childSessionFile: childFile,
			};
			appendLifecycle(root, selected);
			for (const [state, localId] of [
				["active", 2],
				["terminal-failure", 3],
				["terminal-aborted", 4],
			] as const) {
				appendLifecycle(
					root,
					session(root.getSessionId(), root.getSessionDir(), localId, state),
				);
			}
			const forkFile = root.createBranchedSession(root.getLeafId() as string);
			if (forkFile === undefined) {
				throw new Error("root fork must persist");
			}
			child.appendMessage({
				role: "user",
				content: [{ type: "text", text: "child current history" }],
				timestamp: 2,
			});
			const fork = SessionManager.open(forkFile, root.getSessionDir());
			let snapshot:
				| Extract<JournalRecord, { kind: "owner-snapshot" }>
				| undefined;
			materializeForkHierarchy(fork, (value) => {
				snapshot = value;
			});
			expect(snapshot).toBeDefined();
			if (snapshot === undefined) {
				return;
			}
			const selectedSnapshot = snapshot.sessions[0];
			if (selectedSnapshot === undefined) {
				throw new Error("selected snapshot session was not delivered");
			}
			expect(snapshot.ownerPiSessionId).toBe(fork.getSessionId());
			expect(snapshot.sessions).toHaveLength(1);
			expect(selectedSnapshot.key.ownerLocalSessionId).toBe(1);
			expect(selectedSnapshot.childPiSessionId).not.toBe(child.getSessionId());
			expect(selectedSnapshot.childSessionFile).not.toBe(childFile);
			expect(selectedSnapshot.ownerRuntimeLeaseId).toBeUndefined();
			expect(selectedSnapshot.agentId).toBe(selected.agentId);
			expect(selectedSnapshot.taskName).toBe(selected.taskName);
			expect(selectedSnapshot.invocationId).toBe(selected.invocationId);
			expect(selectedSnapshot.runtimeLeaseId).toBe(selected.runtimeLeaseId);
			expect(selectedSnapshot.invocationMetadata).toEqual(
				selected.invocationMetadata,
			);
			const clonedChild = SessionManager.open(
				selectedSnapshot.childSessionFile,
				selectedSnapshot.childSessionDir,
			);
			const clonedChildEntries = clonedChild.getBranch();
			expect(
				clonedChildEntries.some(
					(entry) =>
						entry.type === "message" &&
						JSON.stringify(entry.message).includes("child current history"),
				),
			).toBe(true);
			const childSnapshot = clonedChildEntries.at(-1);
			expect(childSnapshot?.type).toBe("custom");
			const nestedSnapshot =
				childSnapshot?.type === "custom"
					? (childSnapshot.data as Extract<
							JournalRecord,
							{ kind: "owner-snapshot" }
						>)
					: undefined;
			expect(nestedSnapshot?.ownerPiSessionId).toBe(
				selectedSnapshot.childPiSessionId,
			);
			expect(nestedSnapshot?.sessions).toHaveLength(1);
			const nestedRetained = nestedSnapshot?.sessions[0];
			expect(nestedRetained?.key.ownerLocalSessionId).toBe(1);
			expect(nestedRetained?.childPiSessionId).not.toBe(
				grandchild.getSessionId(),
			);
			expect(nestedRetained?.childSessionFile).not.toBe(grandchildFile);
			expect(nestedRetained?.ownerRuntimeLeaseId).toBeUndefined();
			expect(nestedRetained?.agentId).toBe(nested.agentId);
			expect(nestedRetained?.taskName).toBe(nested.taskName);
			expect(nestedRetained?.invocationId).toBe(nested.invocationId);
			expect(nestedRetained?.runtimeLeaseId).toBe(nested.runtimeLeaseId);
			expect(nestedRetained?.invocationMetadata).toEqual(
				nested.invocationMetadata,
			);
			child.appendMessage({
				role: "user",
				content: [{ type: "text", text: "source only" }],
				timestamp: 3,
			});
			expect(
				clonedChild
					.getBranch()
					.some(
						(entry) =>
							entry.type === "message" &&
							JSON.stringify(entry.message).includes("source only"),
					),
			).toBe(false);
			clonedChild.appendMessage({
				role: "user",
				content: [{ type: "text", text: "clone only" }],
				timestamp: 4,
			});
			const reopenedSourceChild = SessionManager.open(
				childFile,
				child.getSessionDir(),
			);
			expect(
				reopenedSourceChild
					.getBranch()
					.some(
						(entry) =>
							entry.type === "message" &&
							JSON.stringify(entry.message).includes("clone only"),
					),
			).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
