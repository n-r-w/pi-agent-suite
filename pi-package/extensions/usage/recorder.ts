import type {
	Api,
	AssistantMessage,
	Model,
	Usage,
} from "@earendil-works/pi-ai";
import type { PiUsageEntry } from "../../shared/usage-events";
import type { UsageEvent, UsageEventSource } from "./store";

const TOKENS_PER_MILLION = 1_000_000;

/** Cannot collide with agent IDs sourced from file names because paths cannot contain NUL. */
export const NO_AGENT_ID = "\u0000";

export interface UsageAttribution {
	readonly sessionId: string | undefined;
	readonly rootSessionId: string | undefined;
	readonly agentId: string | undefined;
	readonly source?: UsageEventSource;
}

interface UsageEventInput {
	readonly provider: string;
	readonly model: string;
	readonly timestampMs: number;
	readonly usage: Usage;
}

/** Validates and normalizes one finalized regular assistant response. */
export function createAssistantUsageEvent(
	message: AssistantMessage,
	attribution: UsageAttribution,
	findModel: (provider: string, model: string) => Model<Api> | undefined,
	createEventId: () => string,
): UsageEvent | undefined {
	return createUsageEvent(
		{
			provider: message.provider,
			model: message.model,
			timestampMs: message.timestamp,
			usage: message.usage,
		},
		attribution,
		findModel,
		createEventId,
	);
}

/** Converts one Pi usage entry into the existing persisted event contract. */
export function createUsageEntryEvent(
	entry: PiUsageEntry,
	attribution: Omit<UsageAttribution, "source">,
	findModel: (provider: string, model: string) => Model<Api> | undefined,
): UsageEvent | undefined {
	return createUsageEvent(
		{
			provider: entry.provider,
			model: entry.model,
			timestampMs: Date.parse(entry.timestamp),
			usage: entry.usage,
		},
		{ ...attribution, source: "pi-usage" },
		findModel,
		() => `pi-usage:${attribution.sessionId}:${entry.id}`,
	);
}

function createUsageEvent(
	input: UsageEventInput,
	attribution: UsageAttribution,
	findModel: (provider: string, model: string) => Model<Api> | undefined,
	createEventId: () => string,
): UsageEvent | undefined {
	if (
		!isNonEmptyString(attribution.sessionId) ||
		!isNonEmptyString(attribution.rootSessionId) ||
		!isNonEmptyString(input.provider) ||
		!isNonEmptyString(input.model) ||
		!isFiniteNonNegative(input.timestampMs)
	) {
		return undefined;
	}

	const usage = input.usage;
	if (
		!isTokenCount(usage?.input) ||
		!isTokenCount(usage.output) ||
		!isTokenCount(usage.cacheRead) ||
		!isTokenCount(usage.cacheWrite) ||
		!isFiniteNonNegative(usage.cost?.total)
	) {
		return undefined;
	}

	const pricedModel = findModel(input.provider, input.model);
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
		timestampMs: input.timestampMs,
		sessionId: attribution.sessionId,
		rootSessionId: attribution.rootSessionId,
		agentId: isNonEmptyString(attribution.agentId)
			? attribution.agentId
			: NO_AGENT_ID,
		source: attribution.source ?? "agent-turn",
		provider: input.provider,
		model: input.model,
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
