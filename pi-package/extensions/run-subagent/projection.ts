import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CONTEXT_PROJECTION_CUSTOM_TYPE } from "../../shared/context-projection.ts";
import type {
	InvocationMetadata,
	LogicalSession,
	OwnerIdentity,
	SessionKey,
} from "./domain.ts";
import { V2SessionStore } from "./persistence.ts";

/** Supplies one direct owner's durable journal to recursive hierarchy projection. */
export interface ProjectionJournal {
	readonly owner: OwnerIdentity;
	readonly entries: readonly SessionEntry[];
}

/** Supplies one logical session's current Pi branch to conversation projection. */
interface ProjectionConversationBranch {
	readonly sessionKey: SessionKey;
	readonly entries: readonly SessionEntry[];
}

/** Describes a complete durable and live input snapshot. */
interface ProjectionSources {
	readonly journals: readonly ProjectionJournal[];
	readonly catalogSessions?: readonly LogicalSession[];
	readonly conversations?: readonly ProjectionConversationBranch[];
}

/** Identifies one immutable hierarchy row by complete owner-local identity. */
export interface ProjectionNode {
	readonly stableKey: string;
	readonly key: Readonly<SessionKey>;
	readonly parentStableKey: string | null;
	readonly childPiSessionId: string;
	readonly agentId: string;
	readonly taskName: string;
	readonly creationOrder: number;
	readonly invocationMetadata?: InvocationMetadata;
	readonly state: LogicalSession["state"];
}

/** Lists session entries that can appear in a selected conversation. */
export type ConversationProjectionEntry = Extract<
	SessionEntry,
	{ readonly type: "message" | "custom_message" }
>;

/** Exposes one revision without mutable coordinator or persistence references. */
export interface ManagementProjectionView {
	readonly revision: number;
	readonly nodes: readonly ProjectionNode[];
	readonly selectedStableKey: string | null;
	readonly selectedConversation: readonly ConversationProjectionEntry[];
	readonly affectedStableKeys: readonly string[];
}

interface ConversationSnapshot {
	readonly entries: readonly ConversationProjectionEntry[];
	readonly signature: string;
}

/** Encodes complete owner-local identity without relying on a global numeric ID. */
export function projectionStableKey(key: SessionKey): string {
	return JSON.stringify([key.ownerPiSessionId, key.ownerLocalSessionId]);
}

/** Maintains immutable hierarchy and selected-conversation revisions from read-only facts. */
export class HierarchyConversationProjection {
	private readonly store = new V2SessionStore();
	private readonly durableSessions = new Map<string, LogicalSession>();
	private readonly catalogSessions = new Map<string, LogicalSession>();
	private readonly conversations = new Map<string, ConversationSnapshot>();
	private nodesByKey = new Map<string, ProjectionNode>();
	private selectedStableKey: string | null = null;
	private view: ManagementProjectionView = freezeView({
		revision: 0,
		nodes: [],
		selectedStableKey: null,
		selectedConversation: [],
		affectedStableKeys: [],
	});

	public constructor(private readonly rootOwnerPiSessionId: string) {}

	/** Replaces the complete recursive durable/live source set without mutating any source owner. */
	public replace(sources: ProjectionSources): ManagementProjectionView {
		this.durableSessions.clear();
		for (const journal of sources.journals) {
			for (const session of this.store.fold(journal.entries).sessions) {
				this.durableSessions.set(projectionStableKey(session.key), session);
			}
		}

		this.catalogSessions.clear();
		for (const session of sources.catalogSessions ?? []) {
			this.catalogSessions.set(projectionStableKey(session.key), session);
		}

		const priorConversations = new Map(this.conversations);
		const priorConversationKeys = new Set(priorConversations.keys());
		this.conversations.clear();
		const changedConversationKeys = new Set<string>();
		for (const branch of sources.conversations ?? []) {
			const key = projectionStableKey(branch.sessionKey);
			const next = createConversationSnapshot(branch.entries);
			const previous = priorConversations.get(key);
			this.conversations.set(key, next);
			priorConversationKeys.delete(key);
			if (previous?.signature !== next.signature) {
				changedConversationKeys.add(key);
			}
		}
		for (const removedKey of priorConversationKeys) {
			changedConversationKeys.add(removedKey);
		}

		return this.rebuild(changedConversationKeys);
	}

	/** Applies one catalog or coordinator session fact to its complete stable key. */
	public updateSession(session: LogicalSession): ManagementProjectionView {
		this.catalogSessions.set(projectionStableKey(session.key), session);
		return this.rebuild(new Set());
	}

	/** Replaces one logical session's active branch without exposing any unselected branch. */
	public updateConversation(
		sessionKey: SessionKey,
		entries: readonly SessionEntry[],
	): ManagementProjectionView {
		const key = projectionStableKey(sessionKey);
		const next = createConversationSnapshot(entries);
		if (this.conversations.get(key)?.signature === next.signature) {
			return this.view;
		}
		this.conversations.set(key, next);
		return this.rebuild(new Set([key]));
	}

	/** Selects the only active branch exposed by the current management view. */
	public select(sessionKey: SessionKey | null): ManagementProjectionView {
		const nextKey =
			sessionKey === null ? null : projectionStableKey(sessionKey);
		const validNextKey =
			nextKey !== null && this.nodesByKey.has(nextKey) ? nextKey : null;
		if (validNextKey === this.selectedStableKey) {
			return this.view;
		}
		const affected = [this.selectedStableKey, validNextKey].filter(
			(key): key is string => key !== null,
		);
		this.selectedStableKey = validNextKey;
		this.view = freezeView({
			revision: this.view.revision + 1,
			nodes: this.view.nodes,
			selectedStableKey: validNextKey,
			selectedConversation: this.getSelectedConversation(),
			affectedStableKeys: affected,
		});
		return this.view;
	}

	/** Returns the current immutable revision. */
	public getView(): ManagementProjectionView {
		return this.view;
	}

	/** Rebuilds only changed node objects and reports exactly the affected stable keys. */
	private rebuild(
		changedConversationKeys: ReadonlySet<string>,
	): ManagementProjectionView {
		const sessions = new Map(this.durableSessions);
		for (const [key, session] of this.catalogSessions) {
			sessions.set(key, session);
		}

		const orderedSessions = orderRecursiveSessions(
			this.rootOwnerPiSessionId,
			sessions,
		);
		const parentByOwner = new Map<string, string>();
		for (const session of sessions.values()) {
			parentByOwner.set(
				session.childPiSessionId,
				projectionStableKey(session.key),
			);
		}

		const nextNodesByKey = new Map<string, ProjectionNode>();
		const nextNodes: ProjectionNode[] = [];
		const affected = new Set(changedConversationKeys);
		for (const session of orderedSessions) {
			const key = projectionStableKey(session.key);
			const candidate = createNode(
				session,
				parentByOwner.get(session.key.ownerPiSessionId) ?? null,
			);
			const previous = this.nodesByKey.get(key);
			const node =
				previous !== undefined && nodesEqual(previous, candidate)
					? previous
					: candidate;
			if (node !== previous) {
				affected.add(key);
			}
			nextNodesByKey.set(key, node);
			nextNodes.push(node);
		}
		for (const key of this.nodesByKey.keys()) {
			if (!nextNodesByKey.has(key)) {
				affected.add(key);
			}
		}

		this.nodesByKey = nextNodesByKey;
		if (
			this.selectedStableKey !== null &&
			!nextNodesByKey.has(this.selectedStableKey)
		) {
			this.selectedStableKey = null;
		}
		if (affected.size === 0) {
			return this.view;
		}

		this.view = freezeView({
			revision: this.view.revision + 1,
			nodes: nextNodes,
			selectedStableKey: this.selectedStableKey,
			selectedConversation: this.getSelectedConversation(),
			affectedStableKeys: orderAffectedKeys(affected, nextNodes),
		});
		return this.view;
	}

	/** Returns a frozen branch only for the selected stable key. */
	private getSelectedConversation(): readonly ConversationProjectionEntry[] {
		if (this.selectedStableKey === null) {
			return Object.freeze([]);
		}
		return (
			this.conversations.get(this.selectedStableKey)?.entries ??
			Object.freeze([])
		);
	}
}

/** Folds caller edges recursively and orders each direct owner's children by creation order. */
function orderRecursiveSessions(
	rootOwnerPiSessionId: string,
	sessions: ReadonlyMap<string, LogicalSession>,
): readonly LogicalSession[] {
	const childrenByOwner = new Map<string, LogicalSession[]>();
	for (const session of sessions.values()) {
		const children = childrenByOwner.get(session.key.ownerPiSessionId) ?? [];
		children.push(session);
		childrenByOwner.set(session.key.ownerPiSessionId, children);
	}
	for (const children of childrenByOwner.values()) {
		children.sort(compareSessions);
	}

	const ordered: LogicalSession[] = [];
	const visited = new Set<string>();
	const visitOwner = (ownerPiSessionId: string): void => {
		for (const session of childrenByOwner.get(ownerPiSessionId) ?? []) {
			const key = projectionStableKey(session.key);
			if (visited.has(key)) {
				continue;
			}
			visited.add(key);
			ordered.push(session);
			visitOwner(session.childPiSessionId);
		}
	};
	visitOwner(rootOwnerPiSessionId);
	return ordered;
}

/** Preserves caller-local creation order with stable identity as a deterministic tie-break. */
function compareSessions(left: LogicalSession, right: LogicalSession): number {
	return (
		left.creationOrder - right.creationOrder ||
		projectionStableKey(left.key).localeCompare(projectionStableKey(right.key))
	);
}

/** Creates a frozen node detached from mutable catalog and journal objects. */
function createNode(
	session: LogicalSession,
	parentStableKey: string | null,
): ProjectionNode {
	const key = Object.freeze({ ...session.key });
	const invocationMetadata =
		session.invocationMetadata === undefined
			? undefined
			: Object.freeze({ ...session.invocationMetadata });
	return Object.freeze({
		stableKey: projectionStableKey(key),
		key,
		parentStableKey,
		childPiSessionId: session.childPiSessionId,
		agentId: session.agentId,
		taskName: session.taskName,
		creationOrder: session.creationOrder,
		...(invocationMetadata === undefined ? {} : { invocationMetadata }),
		state: session.state,
	});
}

/** Compares every visible node fact so unchanged keys retain object identity. */
function nodesEqual(left: ProjectionNode, right: ProjectionNode): boolean {
	return (
		left.stableKey === right.stableKey &&
		left.parentStableKey === right.parentStableKey &&
		left.childPiSessionId === right.childPiSessionId &&
		left.agentId === right.agentId &&
		left.taskName === right.taskName &&
		left.creationOrder === right.creationOrder &&
		invocationMetadataEqual(
			left.invocationMetadata,
			right.invocationMetadata,
		) &&
		left.state === right.state
	);
}

/** Compares current invocation metadata without sharing mutable source identity. */
function invocationMetadataEqual(
	left: InvocationMetadata | undefined,
	right: InvocationMetadata | undefined,
): boolean {
	if (left === undefined || right === undefined) {
		return left === right;
	}
	return (
		left.startedAtMs === right.startedAtMs &&
		left.elapsedMs === right.elapsedMs &&
		left.modelId === right.modelId &&
		left.thinking === right.thinking &&
		left.contextWindow === right.contextWindow &&
		left.contextTokens === right.contextTokens &&
		left.projectionSavedTokens === right.projectionSavedTokens
	);
}

/** Filters Pi's active branch to displayable conversation entries without side effects. */
function createConversationSnapshot(
	entries: readonly SessionEntry[],
): ConversationSnapshot {
	const conversationEntries = entries.filter(
		(entry): entry is ConversationProjectionEntry =>
			entry.type === "message" ||
			(entry.type === "custom_message" &&
				entry.display &&
				entry.customType !== CONTEXT_PROJECTION_CUSTOM_TYPE),
	);
	// Session branches are caller-owned. Clone before freezing so neither later
	// RPC updates nor a consumer can mutate an already emitted revision.
	const frozenEntries = Object.freeze(
		conversationEntries.map((entry) =>
			freezeRecursively(structuredClone(entry)),
		),
	);
	return Object.freeze({
		entries: frozenEntries,
		signature: JSON.stringify(frozenEntries),
	});
}

/** Deeply freezes one JSON-compatible Pi session value and returns its readonly identity. */
function freezeRecursively<T>(value: T): T {
	if (value === null || typeof value !== "object") {
		return value;
	}
	for (const key of Object.keys(value)) {
		freezeRecursively(value[key as keyof T]);
	}
	return Object.freeze(value);
}

/** Orders changed keys by visible hierarchy order and appends removed keys deterministically. */
function orderAffectedKeys(
	affected: ReadonlySet<string>,
	nodes: readonly ProjectionNode[],
): readonly string[] {
	const ordered = nodes
		.map((node) => node.stableKey)
		.filter((key) => affected.has(key));
	const visible = new Set(ordered);
	const removed = [...affected]
		.filter((key) => !visible.has(key))
		.sort((left, right) => left.localeCompare(right));
	return [...ordered, ...removed];
}

/** Freezes revision arrays so later updates cannot alter an earlier management view. */
function freezeView(view: ManagementProjectionView): ManagementProjectionView {
	return Object.freeze({
		...view,
		nodes: Object.freeze([...view.nodes]),
		selectedConversation: Object.freeze([...view.selectedConversation]),
		affectedStableKeys: Object.freeze([...view.affectedStableKeys]),
	});
}
