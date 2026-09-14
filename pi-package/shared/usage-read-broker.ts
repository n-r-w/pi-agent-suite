import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Shared channel for synchronous current-root usage cost reads. */
export const USAGE_ROOT_COST_REQUEST_CHANNEL =
	"pi-agent-suite.usage.root-cost.request.v1";

export const USAGE_ROOT_COST_REQUEST_VERSION = 1 as const;

export const USAGE_SESSION_TOTALS_REQUEST_CHANNEL =
	"pi-agent-suite.usage.session-totals.request.v1";

export const USAGE_SESSION_TOTALS_REQUEST_VERSION = 1 as const;

/** Complete stored consumption for one Pi session. */
export interface UsageSessionTotals {
	readonly cost: number;
	readonly tokens: number;
}

/** Mutable request slot filled synchronously by the process-local usage broker. */
export interface UsageRootCostRequest {
	readonly version: typeof USAGE_ROOT_COST_REQUEST_VERSION;
	readonly rootSessionId: string;
	cost?: number;
	tokens?: number;
}

interface UsageReadRequester {
	readonly events?: Pick<ExtensionAPI["events"], "emit">;
}

/** Mutable request slot filled synchronously by the process-local usage broker. */
export interface UsageSessionTotalsRequest {
	readonly version: typeof USAGE_SESSION_TOTALS_REQUEST_VERSION;
	readonly sessionId: string;
	totals?: UsageSessionTotals;
}

/** Requests complete stored consumption for one Pi session. */
export function requestUsageSessionTotals(
	pi: UsageReadRequester,
	sessionId: string,
): UsageSessionTotals | undefined {
	if (sessionId.trim().length === 0) {
		return undefined;
	}
	const request: UsageSessionTotalsRequest = {
		version: USAGE_SESSION_TOTALS_REQUEST_VERSION,
		sessionId,
	};
	try {
		pi.events?.emit(USAGE_SESSION_TOTALS_REQUEST_CHANNEL, request);
	} catch {
		return undefined;
	}
	const totals = request.totals;
	return totals === undefined
		? undefined
		: validUsageTotals(totals.cost, totals.tokens);
}

/** Requests complete stored consumption for one root session family. */
export function requestUsageRootTotals(
	pi: UsageReadRequester,
	rootSessionId: string,
): UsageSessionTotals | undefined {
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
	return validUsageTotals(request.cost, request.tokens);
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

function validUsageTotals(
	cost: number | undefined,
	tokens: number | undefined,
): UsageSessionTotals | undefined {
	return typeof cost === "number" &&
		Number.isFinite(cost) &&
		cost >= 0 &&
		typeof tokens === "number" &&
		Number.isSafeInteger(tokens) &&
		tokens >= 0
		? { cost, tokens }
		: undefined;
}

/** Rejects malformed cross-extension session usage requests. */
export function isUsageSessionTotalsRequest(
	value: unknown,
): value is UsageSessionTotalsRequest {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const request = value as Record<string, unknown>;
	return (
		request["version"] === USAGE_SESSION_TOTALS_REQUEST_VERSION &&
		typeof request["sessionId"] === "string" &&
		request["sessionId"].trim().length > 0
	);
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
