import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CONTEXT_PROJECTION_CUSTOM_TYPE } from "../../shared/context-projection.ts";
import type {
	InvocationMetadata,
	LogicalSession,
	OwnerIdentity,
	SessionKey,
} from "./domain.ts";
import type { InvocationNotification } from "./invocation-contracts.ts";
import type { LiveAgentStatus } from "./live-status.ts";
import { SessionStore } from "./persistence.ts";

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
	/** Distinguishes a complete branch from a selected suffix with unread ancestors. */
	readonly selectedConversationComplete: boolean;
	readonly selectedLiveStatus: LiveAgentStatus | undefined;
	readonly selectedProjectionSavedTokens: number | undefined;
	readonly selectedNotification: InvocationNotification | undefined;
	readonly affectedStableKeys: readonly string[];
}

interface ConversationSnapshot {
	readonly entries: readonly ConversationProjectionEntry[];
	readonly version: number;
	readonly complete: boolean;
	readonly liveStatus: LiveAgentStatus | undefined;
	readonly projectionSavedTokens: number | undefined;
	readonly notification: InvocationNotification | undefined;
}

/** Supplies one selected conversation revision without positional argument coupling. */
interface ConversationUpdate {
	readonly sessionKey: SessionKey;
	readonly entries: readonly SessionEntry[];
	readonly version: number;
	readonly complete: boolean;
	readonly liveStatus: LiveAgentStatus | undefined;
	readonly projectionSavedTokens: number | undefined;
	readonly notification: InvocationNotification | undefined;
}

/** Encodes complete owner-local identity without relying on a global numeric ID. */
export function projectionStableKey(key: SessionKey): string {
	return JSON.stringify([key.ownerPiSessionId, key.ownerLocalSessionId]);
}

/** Maintains immutable hierarchy and selected-conversation revisions from read-only facts. */
export class HierarchyConversationProjection {
	private readonly store = new SessionStore();
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
		selectedConversationComplete: true,
		selectedLiveStatus: undefined,
		selectedProjectionSavedTokens: undefined,
		selectedNotification: undefined,
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

		const changedConversationKeys = new Set(this.conversations.keys());
		this.conversations.clear();
		for (const branch of sources.conversations ?? []) {
			const key = projectionStableKey(branch.sessionKey);
			const next = createConversationSnapshot({
				entries: filterConversationEntries(branch.entries),
				version: 0,
				complete: true,
				liveStatus: undefined,
				projectionSavedTokens: undefined,
				notification: undefined,
			});
			this.conversations.set(key, next);
			changedConversationKeys.add(key);
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
		update: ConversationUpdate,
	): ManagementProjectionView {
		const key = projectionStableKey(update.sessionKey);
		if (this.conversations.get(key)?.version === update.version) {
			return this.view;
		}
		this.conversations.clear();
		this.conversations.set(
			key,
			createConversationSnapshot({
				entries: filterConversationEntries(update.entries),
				version: update.version,
				complete: update.complete,
				liveStatus: update.liveStatus,
				projectionSavedTokens: update.projectionSavedTokens,
				notification: update.notification,
			}),
		);
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
		const retainedConversation =
			validNextKey === null ? undefined : this.conversations.get(validNextKey);
		this.conversations.clear();
		if (validNextKey !== null && retainedConversation !== undefined) {
			this.conversations.set(validNextKey, retainedConversation);
		}
		this.selectedStableKey = validNextKey;
		this.view = freezeView({
			revision: this.view.revision + 1,
			nodes: this.view.nodes,
			selectedStableKey: validNextKey,
			selectedConversation: this.getSelectedConversation(),
			selectedConversationComplete: this.getSelectedConversationComplete(),
			selectedLiveStatus: this.getSelectedLiveStatus(),
			selectedProjectionSavedTokens: this.getSelectedProjectionSavedTokens(),
			selectedNotification: this.getSelectedNotification(),
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
			selectedConversationComplete: this.getSelectedConversationComplete(),
			selectedLiveStatus: this.getSelectedLiveStatus(),
			selectedProjectionSavedTokens: this.getSelectedProjectionSavedTokens(),
			selectedNotification: this.getSelectedNotification(),
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

	/** Reports completeness only for the conversation owned by the selected key. */
	private getSelectedConversationComplete(): boolean {
		return (
			this.selectedStableKey === null ||
			this.conversations.get(this.selectedStableKey)?.complete === true
		);
	}

	/** Returns transient runtime state only for the selected stable key. */
	private getSelectedLiveStatus(): LiveAgentStatus | undefined {
		return this.selectedStableKey === null
			? undefined
			: this.conversations.get(this.selectedStableKey)?.liveStatus;
	}

	/** Returns the selected active conversation's current projection savings. */
	private getSelectedProjectionSavedTokens(): number | undefined {
		return this.selectedStableKey === null
			? undefined
			: this.conversations.get(this.selectedStableKey)?.projectionSavedTokens;
	}

	/** Returns the transient notification owned by the selected invocation. */
	private getSelectedNotification(): InvocationNotification | undefined {
		return this.selectedStableKey === null
			? undefined
			: this.conversations.get(this.selectedStableKey)?.notification;
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

/** Selects only displayable conversation entries from one complete session branch. */
function filterConversationEntries(
	entries: readonly SessionEntry[],
): readonly ConversationProjectionEntry[] {
	return entries.filter(
		(entry): entry is ConversationProjectionEntry =>
			entry.type === "message" ||
			(entry.type === "custom_message" &&
				entry.display &&
				entry.customType !== CONTEXT_PROJECTION_CUSTOM_TYPE),
	);
}

/** Clones one selected branch so later source mutation cannot alter published revisions. */
function createConversationSnapshot(
	source: ConversationSnapshot,
): ConversationSnapshot {
	const frozenEntries = Object.freeze(
		source.entries.map((entry) => freezeRecursively(structuredClone(entry))),
	);
	const frozenLiveStatus =
		source.liveStatus === undefined
			? undefined
			: freezeRecursively(structuredClone(source.liveStatus));
	return Object.freeze({
		entries: frozenEntries,
		version: source.version,
		complete: source.complete,
		liveStatus: frozenLiveStatus,
		projectionSavedTokens: source.projectionSavedTokens,
		notification:
			source.notification === undefined
				? undefined
				: freezeRecursively(structuredClone(source.notification)),
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
