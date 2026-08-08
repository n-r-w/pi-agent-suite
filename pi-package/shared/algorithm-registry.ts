import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** One manually runnable algorithm registered by its owning extension. */
export interface TriggerAlgorithm {
	readonly type: string;
	readonly description: string;
	run(
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
	): Promise<TriggerAlgorithmRunResult>;
}

/** Result reported after one manual algorithm run. */
export type TriggerAlgorithmRunResult =
	| { readonly ok: true }
	| { readonly ok: false };

/** Event bus channel for synchronous cross-extension registry lookup. */
const REGISTRY_REQUEST_CHANNEL = "pi-harness:algorithm-registry:request";

/** Mutable slot passed through the event bus for request-reply. */
interface RegistrySlot {
	registry: Map<string, TriggerAlgorithm> | undefined;
}

/** Per-pi cache so each extension and each test fake keeps its own reference. */
const registryByPi = new WeakMap<ExtensionAPI, Map<string, TriggerAlgorithm>>();

/** Registers one algorithm by type, replacing any previous entry with the same type. */
export function registerTriggerAlgorithm(
	pi: ExtensionAPI,
	algorithm: TriggerAlgorithm,
): () => void {
	const registry = getRegistry(pi);
	registry.set(algorithm.type, algorithm);

	return () => {
		if (registry.get(algorithm.type) === algorithm) {
			registry.delete(algorithm.type);
		}
	};
}

/** Reads one algorithm by its exact type from the shared registry. */
export function getTriggerAlgorithm(
	pi: ExtensionAPI,
	type: string,
): TriggerAlgorithm | undefined {
	return getRegistry(pi).get(type);
}

/** Lists all registered algorithms in registration order. */
export function getTriggerAlgorithms(
	pi: ExtensionAPI,
): readonly TriggerAlgorithm[] {
	return [...getRegistry(pi).values()];
}

/** Creates or looks up one stable registry for the lifetime of the extension runtime.
 *
 * The event bus is the only channel shared across extension instances, so the
 * registry is exchanged through a synchronous emit/on request-reply with a
 * mutable slot. A WeakMap keyed by pi provides per-instance caching and test
 * isolation.
 */
function getRegistry(pi: ExtensionAPI): Map<string, TriggerAlgorithm> {
	const cached = registryByPi.get(pi);
	if (cached !== undefined) {
		return cached;
	}

	/** Asks whether another extension already created the registry. */
	const slot: RegistrySlot = { registry: undefined };
	if (typeof pi.events?.emit === "function") {
		pi.events.emit(REGISTRY_REQUEST_CHANNEL, slot);
	}
	if (slot.registry !== undefined) {
		registryByPi.set(pi, slot.registry);
		return slot.registry;
	}

	const registry = new Map<string, TriggerAlgorithm>();
	registryByPi.set(pi, registry);

	/** Replies to future requests from other extensions with this registry. */
	if (typeof pi.events?.on === "function") {
		pi.events.on(REGISTRY_REQUEST_CHANNEL, (data: unknown) => {
			(data as RegistrySlot).registry = registry;
		});
	}

	return registry;
}
