import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Lists every persisted Pi session entry discriminator accepted by conversation projection. */
const SESSION_ENTRY_TYPES = new Set([
	"message",
	"thinking_level_change",
	"model_change",
	"compaction",
	"branch_summary",
	"custom",
	"custom_message",
	"label",
	"session_info",
]);

/** Reports whether an untrusted value can be inspected by named fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates one conversation entry from an RPC response or persisted JSONL line. */
export function parseConversationSessionEntry(
	value: unknown,
	source: string,
): SessionEntry {
	if (!isRecord(value)) {
		throw new Error(`${source} returned a non-object conversation entry`);
	}
	const id = value["id"];
	const parentId = value["parentId"];
	const timestamp = value["timestamp"];
	const type = value["type"];
	if (
		typeof id !== "string" ||
		!(parentId === null || typeof parentId === "string") ||
		typeof timestamp !== "string" ||
		typeof type !== "string" ||
		!SESSION_ENTRY_TYPES.has(type)
	) {
		throw new Error(`${source} returned an invalid conversation entry`);
	}
	if (type === "message" && !isRecord(value["message"])) {
		throw new Error(`${source} returned an invalid conversation message`);
	}
	if (
		type === "custom_message" &&
		(typeof value["customType"] !== "string" ||
			typeof value["display"] !== "boolean" ||
			!(
				typeof value["content"] === "string" || Array.isArray(value["content"])
			))
	) {
		throw new Error(
			`${source} returned an invalid custom conversation message`,
		);
	}
	return value as unknown as SessionEntry;
}
