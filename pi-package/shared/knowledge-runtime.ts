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

const RUNTIME_PROPERTY = "__piHarnessKnowledgeRuntime";

/** Holds independent knowledge roles without exposing a generic handler registry. */
interface KnowledgeRuntimeHolder {
	context: KnowledgeContextRuntime | undefined;
	root: KnowledgeRootRuntime | undefined;
	hierarchy: KnowledgeHierarchyClient | undefined;
}

/** Event-bus carrier shared by separately loaded package extensions. */
interface KnowledgeRuntimeCarrier {
	[RUNTIME_PROPERTY]?: KnowledgeRuntimeHolder;
}

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

/** Creates one stable holder for the lifetime of the process-local event bus. */
function getHolder(pi: ExtensionAPI): KnowledgeRuntimeHolder {
	const carrier = pi.events as unknown as KnowledgeRuntimeCarrier;
	if (carrier[RUNTIME_PROPERTY] !== undefined) {
		return carrier[RUNTIME_PROPERTY];
	}
	const holder: KnowledgeRuntimeHolder = {
		context: undefined,
		root: undefined,
		hierarchy: undefined,
	};
	Object.defineProperty(carrier, RUNTIME_PROPERTY, {
		configurable: false,
		enumerable: false,
		value: holder,
		writable: false,
	});
	return holder;
}
