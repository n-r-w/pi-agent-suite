import { describe, expect, test } from "bun:test";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { JournalRecord, LogicalSession, OwnerIdentity } from "./domain.ts";
import {
	SUBAGENT_HISTORY_CUSTOM_TYPE,
	SUBAGENT_JOURNAL_CUSTOM_TYPE,
} from "./persistence.ts";
import {
	HierarchyConversationProjection,
	type ProjectionJournal,
	projectionStableKey as stableKey,
} from "./projection.ts";

const ROOT_OWNER: OwnerIdentity = {
	ownerPiSessionId: "root-owner",
	ownerSessionFile: "/tmp/root-owner.jsonl",
};
const NESTED_OWNER: OwnerIdentity = {
	ownerPiSessionId: "child-pi-1",
	ownerSessionFile: "/tmp/child-pi-1.jsonl",
};

/** Creates one accepted logical session fixture with complete stable identity. */
function createSession(options: {
	readonly ownerPiSessionId: string;
	readonly ownerLocalSessionId: number;
	readonly childPiSessionId: string;
	readonly creationOrder: number;
	readonly state?: LogicalSession["state"];
}): LogicalSession {
	const suffix = `${options.ownerPiSessionId}-${options.ownerLocalSessionId}`;
	return {
		key: {
			ownerPiSessionId: options.ownerPiSessionId,
			ownerLocalSessionId: options.ownerLocalSessionId,
		},
		childPiSessionId: options.childPiSessionId,
		childSessionDir: `/tmp/${suffix}`,
		childSessionFile: `/tmp/${suffix}.jsonl`,
		agentId: `agent-${suffix}`,
		taskName: `Task ${suffix}`,
		creationOrder: options.creationOrder,
		invocationId: `invocation-${suffix}`,
		runtimeLeaseId: `lease-${suffix}`,
		invocationMetadata: {
			startedAtMs: 1_700_000_000_000 + options.creationOrder,
			elapsedMs: 1_000,
			modelId: "openai/test-model",
			contextWindow: 128_000,
		},
		state: options.state ?? "active",
	};
}

/** Wraps one durable record in the public Pi custom-entry shape. */
function createJournalEntry(
	record: JournalRecord,
	index: number,
): SessionEntry {
	return {
		type: "custom",
		id: `journal-${index}`,
		parentId: index === 0 ? null : `journal-${index - 1}`,
		timestamp: new Date(index).toISOString(),
		customType: SUBAGENT_JOURNAL_CUSTOM_TYPE,
		data: record,
	};
}

/** Creates one direct-owner journal from accepted session records. */
function createJournal(
	owner: OwnerIdentity,
	sessions: readonly LogicalSession[],
): ProjectionJournal {
	return {
		owner,
		entries: sessions.map((session, index) =>
			createJournalEntry({ kind: "session-accepted", session }, index),
		),
	};
}

/** Creates one visible user-message branch entry. */
function createUserEntry(id: string, text: string): SessionEntry {
	const message: UserMessage = {
		role: "user",
		content: text,
		timestamp: 1,
	};
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message,
	};
}

/** Creates one displayable or context-projection custom conversation entry. */
function createCustomMessageEntry(
	id: string,
	customType: string,
	content: string,
): SessionEntry {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: new Date(1).toISOString(),
		customType,
		content,
		display: true,
	};
}

describe("HierarchyConversationProjection", () => {
	test("keeps repeated local ids distinct in the hierarchy", () => {
		// Purpose: recursive owner journals must preserve complete stable identity when local numeric IDs repeat.
		// Input and expected output: root session 1 and its child's session 1 retain distinct stable keys before the next root sibling.
		// Edge case: equal sibling creation order uses stable identity without breaking the nested caller edge.
		// Dependencies: durable journal records only; no coordinator, process, timer, or session writer.
		const rootSession = createSession({
			ownerPiSessionId: ROOT_OWNER.ownerPiSessionId,
			ownerLocalSessionId: 1,
			childPiSessionId: NESTED_OWNER.ownerPiSessionId,
			creationOrder: 1,
		});
		const rootSibling = createSession({
			ownerPiSessionId: ROOT_OWNER.ownerPiSessionId,
			ownerLocalSessionId: 2,
			childPiSessionId: "child-pi-2",
			creationOrder: 1,
		});
		const nestedSession = createSession({
			ownerPiSessionId: NESTED_OWNER.ownerPiSessionId,
			ownerLocalSessionId: 1,
			childPiSessionId: "grandchild-pi-1",
			creationOrder: 1,
		});
		const projection = new HierarchyConversationProjection(
			ROOT_OWNER.ownerPiSessionId,
		);

		// ARRANGE and ACT: fold both direct-owner journals as one recursive source graph.
		const view = projection.replace({
			journals: [
				createJournal(ROOT_OWNER, [rootSibling, rootSession]),
				createJournal(NESTED_OWNER, [nestedSession]),
			],
		});

		// ASSERT: owner identity remains part of each key and recursive order retains the caller edge.
		expect(
			view.nodes.map((node) => ({
				stableKey: node.stableKey,
				parentStableKey: node.parentStableKey,
			})),
		).toEqual([
			{
				stableKey: stableKey(rootSession.key),
				parentStableKey: null,
			},
			{
				stableKey: stableKey(nestedSession.key),
				parentStableKey: stableKey(rootSession.key),
			},
			{
				stableKey: stableKey(rootSibling.key),
				parentStableKey: null,
			},
		]);
	});

	test("projects only the selected active branch and updates affected keys", () => {
		// Purpose: conversation selection and live catalog updates must stay immutable and side-effect free.
		// Input and expected output: selecting the nested session exposes only its visible branch; updating the root marks only the root key.
		// Edge case: context-projection state is excluded while package feedback remains a displayable conversation message.
		// Dependencies: in-memory journal, catalog, and active-branch facts with no process, journal, feedback, wait, or coordinator command port.
		const rootSession = createSession({
			ownerPiSessionId: ROOT_OWNER.ownerPiSessionId,
			ownerLocalSessionId: 1,
			childPiSessionId: NESTED_OWNER.ownerPiSessionId,
			creationOrder: 1,
		});
		const nestedSession = createSession({
			ownerPiSessionId: NESTED_OWNER.ownerPiSessionId,
			ownerLocalSessionId: 1,
			childPiSessionId: "grandchild-pi-1",
			creationOrder: 1,
		});
		const rootBranch = [createUserEntry("root-user", "root only")];
		const nestedBranch = [
			createUserEntry("nested-user", "nested active branch"),
			createCustomMessageEntry(
				"projection-state",
				"context-projection",
				"hidden projection state",
			),
			createCustomMessageEntry(
				"feedback",
				SUBAGENT_HISTORY_CUSTOM_TYPE,
				"child feedback",
			),
		];
		const projection = new HierarchyConversationProjection(
			ROOT_OWNER.ownerPiSessionId,
		);
		projection.replace({
			journals: [
				createJournal(ROOT_OWNER, [rootSession]),
				createJournal(NESTED_OWNER, [nestedSession]),
			],
			conversations: [
				{ sessionKey: rootSession.key, entries: rootBranch },
				{ sessionKey: nestedSession.key, entries: nestedBranch },
			],
		});

		// ACT: select one branch, then update an unrelated catalog key.
		const selected = projection.select(nestedSession.key);
		const selectedNestedNode = selected.nodes[1];
		const updatedRoot: LogicalSession = {
			...rootSession,
			state: "terminal-success",
		};
		const updated = projection.updateSession(updatedRoot);
		expect(projection.getView()).toBe(updated);
		const nextNestedBranch = [
			...nestedBranch,
			createUserEntry("nested-live", "live RPC message"),
		];
		const conversationUpdated = projection.updateConversation(
			nestedSession.key,
			nextNestedBranch,
		);
		const repeatedConversation = projection.updateConversation(
			nestedSession.key,
			nextNestedBranch,
		);

		// ASSERT: only selected conversation entries are exposed and prior revisions remain unchanged.
		expect({
			conversationIds: selected.selectedConversation.map((entry) => entry.id),
			selectedKey: updated.selectedStableKey,
			affected: updated.affectedStableKeys,
			unchangedNestedIdentity: updated.nodes[1] === selectedNestedNode,
			previousRootState: selected.nodes[0]?.state,
			currentRootState: updated.nodes[0]?.state,
			frozenView: Object.isFrozen(updated),
			frozenNodes: Object.isFrozen(updated.nodes),
			liveAffected: conversationUpdated.affectedStableKeys,
			liveConversationIds: conversationUpdated.selectedConversation.map(
				(entry) => entry.id,
			),
			priorConversationIds: updated.selectedConversation.map(
				(entry) => entry.id,
			),
			repeatedRevisionIdentity: repeatedConversation === conversationUpdated,
		}).toEqual({
			conversationIds: ["nested-user", "feedback"],
			selectedKey: stableKey(nestedSession.key),
			affected: [stableKey(rootSession.key)],
			unchangedNestedIdentity: true,
			previousRootState: "active",
			currentRootState: "terminal-success",
			frozenView: true,
			frozenNodes: true,
			liveAffected: [stableKey(nestedSession.key)],
			liveConversationIds: ["nested-user", "feedback", "nested-live"],
			priorConversationIds: ["nested-user", "feedback"],
			repeatedRevisionIdentity: true,
		});
	});

	test("detaches immutable conversation revisions from source entries", () => {
		// Purpose: an emitted conversation revision must not retain mutable objects owned by Pi or a live event source.
		// Input and expected output: mutating the source message after selection leaves projected content unchanged and deeply frozen.
		// Edge case: nested message content is isolated in addition to the top-level branch array.
		// Dependencies: one in-memory active branch; no persistence, coordinator, process, feedback, or wait mutation.
		const session = createSession({
			ownerPiSessionId: ROOT_OWNER.ownerPiSessionId,
			ownerLocalSessionId: 1,
			childPiSessionId: "child-pi-immutable",
			creationOrder: 1,
		});
		const sourceEntry = createUserEntry("source-user", "original content");
		const projection = new HierarchyConversationProjection(
			ROOT_OWNER.ownerPiSessionId,
		);
		projection.replace({
			journals: [createJournal(ROOT_OWNER, [session])],
			conversations: [{ sessionKey: session.key, entries: [sourceEntry] }],
		});
		const selected = projection.select(session.key);

		// ACT: mutate the caller-owned source only after the immutable revision exists.
		if (sourceEntry.type !== "message" || sourceEntry.message.role !== "user") {
			throw new Error("source fixture is not a user message");
		}
		sourceEntry.message.content = "mutated source content";
		const projectedEntry = selected.selectedConversation[0];

		// ASSERT: neither source mutation nor returned nested mutation can alter the revision.
		expect({
			content:
				projectedEntry?.type === "message" &&
				projectedEntry.message.role === "user"
					? projectedEntry.message.content
					: undefined,
			entryFrozen: Object.isFrozen(projectedEntry),
			messageFrozen:
				projectedEntry?.type === "message" &&
				Object.isFrozen(projectedEntry.message),
		}).toEqual({
			content: "original content",
			entryFrozen: true,
			messageFrozen: true,
		});
	});
});
