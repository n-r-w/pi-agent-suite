import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Shared channel for complete auxiliary assistant responses. */
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

export interface UsageEventRecordRequest {
	readonly version: typeof USAGE_EVENT_RECORD_VERSION;
	readonly eventId: string;
	readonly source: AuxiliaryUsageSource;
	readonly message: AssistantMessage;
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

/** Rejects malformed or incompatible cross-extension requests as one unit. */
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
