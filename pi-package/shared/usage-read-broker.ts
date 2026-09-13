import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Shared channel for synchronous current-root usage cost reads. */
export const USAGE_ROOT_COST_REQUEST_CHANNEL =
	"pi-agent-suite.usage.root-cost.request.v1";

export const USAGE_ROOT_COST_REQUEST_VERSION = 1 as const;

/** Mutable request slot filled synchronously by the process-local usage broker. */
export interface UsageRootCostRequest {
	readonly version: typeof USAGE_ROOT_COST_REQUEST_VERSION;
	readonly rootSessionId: string;
	cost?: number;
}

interface UsageReadRequester {
	readonly events?: Pick<ExtensionAPI["events"], "emit">;
}

/** Requests the complete stored cost for one root session family. */
export function requestUsageRootCost(
	pi: UsageReadRequester,
	rootSessionId: string,
): number | undefined {
	if (rootSessionId.trim().length === 0) {
		return undefined;
	}
	const request: UsageRootCostRequest = {
		version: USAGE_ROOT_COST_REQUEST_VERSION,
		rootSessionId,
	};
	try {
		pi.events?.emit(USAGE_ROOT_COST_REQUEST_CHANNEL, request);
	} catch {
		return undefined;
	}
	return typeof request.cost === "number" &&
		Number.isFinite(request.cost) &&
		request.cost >= 0
		? request.cost
		: undefined;
}

/** Rejects malformed cross-extension usage read requests. */
export function isUsageRootCostRequest(
	value: unknown,
): value is UsageRootCostRequest {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const request = value as Record<string, unknown>;
	return (
		request["version"] === USAGE_ROOT_COST_REQUEST_VERSION &&
		typeof request["rootSessionId"] === "string" &&
		request["rootSessionId"].trim().length > 0
	);
}
