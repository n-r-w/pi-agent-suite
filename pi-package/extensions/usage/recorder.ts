import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { UsageEvent, UsageEventSource } from "./store";

const TOKENS_PER_MILLION = 1_000_000;

export interface UsageAttribution {
	readonly sessionId: string | undefined;
	readonly agentId: string | undefined;
	readonly source?: UsageEventSource;
}

/** Validates and normalizes one finalized regular assistant response. */
export function createAssistantUsageEvent(
	message: AssistantMessage,
	attribution: UsageAttribution,
	findModel: (provider: string, model: string) => Model<Api> | undefined,
	createEventId: () => string,
): UsageEvent | undefined {
	if (
		!isNonEmptyString(attribution.sessionId) ||
		!isNonEmptyString(attribution.agentId) ||
		!isNonEmptyString(message.provider) ||
		!isNonEmptyString(message.model) ||
		!isFiniteNonNegative(message.timestamp)
	) {
		return undefined;
	}

	const usage = message.usage;
	if (
		!isTokenCount(usage?.input) ||
		!isTokenCount(usage.output) ||
		!isTokenCount(usage.cacheRead) ||
		!isTokenCount(usage.cacheWrite) ||
		!isFiniteNonNegative(usage.cost?.total)
	) {
		return undefined;
	}

	const pricedModel = findModel(message.provider, message.model);
	if (pricedModel === undefined) {
		return undefined;
	}
	const rates = resolveRates(
		pricedModel,
		usage.input + usage.cacheRead + usage.cacheWrite,
	);
	if (rates === undefined) {
		return undefined;
	}

	const ordinaryInputCost =
		(rates.input / TOKENS_PER_MILLION) * usage.cacheRead;
	const cacheReadCost =
		(rates.cacheRead / TOKENS_PER_MILLION) * usage.cacheRead;

	return {
		eventId: createEventId(),
		timestampMs: message.timestamp,
		sessionId: attribution.sessionId,
		agentId: attribution.agentId,
		source: attribution.source ?? "agent-turn",
		provider: message.provider,
		model: message.model,
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		cost: usage.cost.total,
		saved: Math.max(0, ordinaryInputCost - cacheReadCost),
	};
}

interface SavingsRates {
	readonly input: number;
	readonly cacheRead: number;
}

/** Selects the highest complete request-wide pricing tier needed for savings. */
function resolveRates(
	model: Model<Api>,
	completeInput: number,
): SavingsRates | undefined {
	const cost: unknown = model.cost;
	if (!hasSavingsRates(cost)) {
		return undefined;
	}
	const tiers = cost["tiers"];
	if (tiers !== undefined && !Array.isArray(tiers)) {
		return undefined;
	}

	let rates: SavingsRates = cost;
	let matchedThreshold = -1;
	for (const tier of tiers ?? []) {
		if (
			!hasSavingsRates(tier) ||
			!isFiniteNonNegative(tier["inputTokensAbove"])
		) {
			return undefined;
		}
		if (
			completeInput > tier["inputTokensAbove"] &&
			tier["inputTokensAbove"] > matchedThreshold
		) {
			rates = tier;
			matchedThreshold = tier["inputTokensAbove"];
		}
	}
	return rates;
}

function hasSavingsRates(
	value: unknown,
): value is Record<string, unknown> & SavingsRates {
	return (
		typeof value === "object" &&
		value !== null &&
		isFiniteNonNegative((value as Record<string, unknown>)["input"]) &&
		isFiniteNonNegative((value as Record<string, unknown>)["cacheRead"])
	);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTokenCount(value: unknown): value is number {
	return isFiniteNonNegative(value) && Number.isSafeInteger(value);
}
