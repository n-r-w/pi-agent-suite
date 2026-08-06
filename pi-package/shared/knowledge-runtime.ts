import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Identifies one exact project and branch knowledge read scope across a root hierarchy. */
export interface KnowledgeScope {
	readonly projectDirectoryName: string;
	readonly branchName: string | null;
}

/** Carries the last-completed global and active-local knowledge for one scope. */
export interface KnowledgeSnapshots {
	readonly global: string | null;
	readonly local: string | null;
}

/** Grants one mutation owner the root FIFO slot and its pre-mutation snapshots. */
export interface KnowledgeMutationLease {
	readonly leaseId: string;
	readonly snapshots: KnowledgeSnapshots;
}

/** Process-local knowledge context source consumed by explicit model-request builders. */
export interface KnowledgeContextRuntime {
	readBlock(ctx: ExtensionContext): Promise<string | null>;
}

/** Root-owned hierarchy boundary used by the run-subagent transport. */
export interface KnowledgeRootRuntime {
	read(scope: KnowledgeScope): Promise<KnowledgeSnapshots>;
	acquire(
		ownerId: string,
		scope: KnowledgeScope,
		signal?: AbortSignal,
	): Promise<KnowledgeMutationLease>;
	release(ownerId: string, leaseId: string): Promise<void>;
	cancel(ownerId: string, requestId?: string): void;
}

/** Child-process hierarchy client provided by the run-subagent extension. */
export interface KnowledgeHierarchyClient {
	read(scope: KnowledgeScope): Promise<KnowledgeSnapshots>;
	acquire(
		scope: KnowledgeScope,
		signal?: AbortSignal,
	): Promise<KnowledgeMutationLease>;
	release(leaseId: string): Promise<void>;
}

/** Event bus channel for synchronous cross-extension holder lookup. */
const HOLDER_REQUEST_CHANNEL = "pi-harness:knowledge-runtime:request";

/** Mutable slot passed through the event bus for request-reply. */
interface HolderSlot {
	holder: KnowledgeRuntimeHolder | undefined;
}

/** Per-pi cache so each extension and each test fake keeps its own reference. */
const holderByPi = new WeakMap<ExtensionAPI, KnowledgeRuntimeHolder>();

/** Registers a process-local context source. */
export function registerKnowledgeContextRuntime(
	pi: ExtensionAPI,
	runtime: KnowledgeContextRuntime,
): () => void {
	return registerRole(pi, "context", runtime);
}

/** Reads applicable rendered knowledge from the process-local source. */
export async function readKnowledgeBlock(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<string | null> {
	return getHolder(pi).context?.readBlock(ctx) ?? null;
}

/** Adds one already-rendered knowledge block without changing an absent context. */
export function appendKnowledgeBlock(
	systemPrompt: string,
	block: string | null,
): string {
	return block === null ? systemPrompt : `${systemPrompt}\n\n${block}`;
}

/** Registers the root knowledge coordinator for hierarchy transport requests. */
export function registerKnowledgeRootRuntime(
	pi: ExtensionAPI,
	runtime: KnowledgeRootRuntime,
): () => void {
	return registerRole(pi, "root", runtime);
}

/** Reads the root knowledge coordinator registered in this process. */
export function getKnowledgeRootRuntime(
	pi: ExtensionAPI,
): KnowledgeRootRuntime | undefined {
	return getHolder(pi).root;
}

/** Registers the child hierarchy client supplied by run-subagent. */
export function registerKnowledgeHierarchyClient(
	pi: ExtensionAPI,
	client: KnowledgeHierarchyClient,
): () => void {
	return registerRole(pi, "hierarchy", client);
}

/** Reads the child hierarchy client registered in this process. */
export function getKnowledgeHierarchyClient(
	pi: ExtensionAPI,
): KnowledgeHierarchyClient | undefined {
	return getHolder(pi).hierarchy;
}

/** Registers one narrow role and prevents stale disposal from clearing its replacement. */
function registerRole<role extends keyof KnowledgeRuntimeHolder>(
	pi: ExtensionAPI,
	key: role,
	value: NonNullable<KnowledgeRuntimeHolder[role]>,
): () => void {
	const holder = getHolder(pi);
	holder[key] = value;
	return () => {
		if (holder[key] === value) {
			holder[key] = undefined;
		}
	};
}

/** Creates or looks up one stable holder for the lifetime of the extension runtime.
 *
 * Pi 0.84.0 loads each extension via jiti with `moduleCache: false`. The event
 * bus is the only channel shared across extension instances, so the holder is
 * exchanged through a synchronous emit/on request-reply with a mutable slot.
 * A WeakMap keyed by pi provides per-instance caching and test isolation.
 */
function getHolder(pi: ExtensionAPI): KnowledgeRuntimeHolder {
	const cached = holderByPi.get(pi);
	if (cached !== undefined) {
		return cached;
	}

	/** Asks whether another extension already created the holder. */
	const slot: HolderSlot = { holder: undefined };
	if (typeof pi.events?.emit === "function") {
		pi.events.emit(HOLDER_REQUEST_CHANNEL, slot);
	}
	if (slot.holder !== undefined) {
		holderByPi.set(pi, slot.holder);
		return slot.holder;
	}

	const holder: KnowledgeRuntimeHolder = {
		context: undefined,
		root: undefined,
		hierarchy: undefined,
	};
	holderByPi.set(pi, holder);

	/** Replies to future requests from other extensions with this holder. */
	if (typeof pi.events?.on === "function") {
		pi.events.on(HOLDER_REQUEST_CHANNEL, (s: HolderSlot) => {
			s.holder = holder;
		});
	}

	return holder;
}
