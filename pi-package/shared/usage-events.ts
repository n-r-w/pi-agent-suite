import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

/** Shared channel for usage records owned by the current process. */
export const USAGE_EVENT_RECORD_CHANNEL = "pi-agent-suite.usage.record.v1";
export const USAGE_EVENT_RECORD_VERSION = 1 as const;

export const AUXILIARY_USAGE_SOURCES = [
	"consult-advisor",
	"context-projection",
	"convene-council",
	"custom-compaction",
	"subagent-query",
	"ask-llm",
	"vision",
	"knowledge",
	"native-compaction",
	"branch-summary",
] as const;

export type AuxiliaryUsageSource = (typeof AUXILIARY_USAGE_SOURCES)[number];
export type PiUsageEntry = Extract<SessionEntry, { readonly type: "usage" }>;

export interface UsageEventRecordRequest {
	readonly version: typeof USAGE_EVENT_RECORD_VERSION;
	readonly eventId: string;
	readonly source: AuxiliaryUsageSource;
	readonly message: AssistantMessage;
}

/** Carries one supervised child usage entry with its durable attribution. */
export interface UsageEntryRecordRequest {
	readonly version: typeof USAGE_EVENT_RECORD_VERSION;
	readonly entry: PiUsageEntry;
	readonly sessionId: string;
	readonly rootSessionId: string;
	readonly agentId: string;
}

interface UsageEventPublisher {
	readonly events?: Pick<ExtensionAPI["events"], "emit">;
}

/** Publishes one response with an ID created once at the initiating helper boundary. */
export function publishUsageEvent(
	pi: UsageEventPublisher,
	source: AuxiliaryUsageSource,
	message: AssistantMessage,
	createEventId: () => string = randomUUID,
): string {
	const eventId = createEventId();
	const request: UsageEventRecordRequest = {
		version: USAGE_EVENT_RECORD_VERSION,
		eventId,
		source,
		message,
	};
	try {
		pi.events?.emit(USAGE_EVENT_RECORD_CHANNEL, request);
	} catch {
		// Usage publication must not turn a completed helper response into a failure.
	}
	return eventId;
}

/** Publishes one already-attributed child usage entry to the process-owned recorder. */
export function publishUsageEntry(
	pi: UsageEventPublisher,
	usage: Omit<UsageEntryRecordRequest, "version">,
): void {
	try {
		pi.events?.emit(USAGE_EVENT_RECORD_CHANNEL, {
			version: USAGE_EVENT_RECORD_VERSION,
			...usage,
		} satisfies UsageEntryRecordRequest);
	} catch {
		// Usage publication must not change child supervision behavior.
	}
}

/** Rejects malformed or incompatible auxiliary requests as one unit. */
export function isUsageEventRecordRequest(
	value: unknown,
): value is UsageEventRecordRequest {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const request = value as Record<string, unknown>;
	const message = request["message"];
	return (
		request["version"] === USAGE_EVENT_RECORD_VERSION &&
		typeof request["eventId"] === "string" &&
		request["eventId"].trim().length > 0 &&
		typeof request["source"] === "string" &&
		(AUXILIARY_USAGE_SOURCES as readonly string[]).includes(
			request["source"],
		) &&
		typeof message === "object" &&
		message !== null &&
		(message as Record<string, unknown>)["role"] === "assistant"
	);
}

/** Returns true for a complete Pi usage entry, including unknown usage kinds. */
export function isPiUsageEntry(value: unknown): value is PiUsageEntry {
	if (!isRecord(value) || value["type"] !== "usage") {
		return false;
	}
	const usage = value["usage"];
	if (!isRecord(usage) || !isRecord(usage["cost"])) {
		return false;
	}
	return (
		isNonEmptyString(value["id"]) &&
		(value["parentId"] === null || typeof value["parentId"] === "string") &&
		typeof value["timestamp"] === "string" &&
		Number.isFinite(Date.parse(value["timestamp"])) &&
		typeof value["kind"] === "string" &&
		isNonEmptyString(value["provider"]) &&
		isNonEmptyString(value["model"]) &&
		isTokenCount(usage["input"]) &&
		isTokenCount(usage["output"]) &&
		isTokenCount(usage["cacheRead"]) &&
		isTokenCount(usage["cacheWrite"]) &&
		isTokenCount(usage["totalTokens"]) &&
		isNonNegativeNumber(usage["cost"]["input"]) &&
		isNonNegativeNumber(usage["cost"]["output"]) &&
		isNonNegativeNumber(usage["cost"]["cacheRead"]) &&
		isNonNegativeNumber(usage["cost"]["cacheWrite"]) &&
		isNonNegativeNumber(usage["cost"]["total"])
	);
}

/** Rejects malformed or unattributed child usage requests as one unit. */
export function isUsageEntryRecordRequest(
	value: unknown,
): value is UsageEntryRecordRequest {
	if (!isRecord(value)) {
		return false;
	}
	return (
		value["version"] === USAGE_EVENT_RECORD_VERSION &&
		isPiUsageEntry(value["entry"]) &&
		isNonEmptyString(value["sessionId"]) &&
		isNonEmptyString(value["rootSessionId"]) &&
		isNonEmptyString(value["agentId"])
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isTokenCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
