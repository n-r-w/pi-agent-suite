import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Context,
	contentText,
	getCurrentSystemMessage,
	type Tool,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RESTORATION_TYPE } from "../../pi-package/extensions/skill-restoration/restoration";
import {
	estimateSerializedInputTokens,
	estimateTextTokens,
} from "../../pi-package/shared/context-size";

/** Captures structured restoration state and the fake provider's final input estimates. */
export interface RestorationSnapshot {
	readonly roles: string[];
	readonly records: unknown[];
	readonly requestTokens: number;
	readonly withoutRestorationTokens: number;
	readonly headContentTokens: number;
	readonly headSectionCount: number;
	readonly headTools: string[];
	readonly nativeTools: string[];
	readonly headToolTokens: number;
	readonly nativeToolTokens: number;
}

/** Associates request-local restoration metadata with the next provider dispatch. */
interface PendingRestoration {
	readonly roles: string[];
	readonly records: unknown[];
	readonly restorationIndex: number;
	readonly nativeTools: string[];
	readonly nativeToolTokens: number;
}

/** Measures system-inclusive provider inputs after all Pi prompt transformations. */
export class RestorationObserver {
	/** Holds only structured metadata until the matching provider dispatch. */
	private pending: PendingRestoration | undefined;

	/** Associates delivery metadata and native tool estimates with the next provider dispatch. */
	constructor(pi: ExtensionAPI) {
		pi.on("context_with_system", (event, ctx) => {
			const visible = event.messages.filter(
				(message) => message.role !== "system",
			);
			const native = getCurrentSystemMessage(
				ctx.sessionManager.buildSessionProjection().messages,
			);
			this.pending = {
				roles: visible.map((message) => message.role),
				records: visible.flatMap((message) =>
					isRestoration(message) ? [message.details] : [],
				),
				restorationIndex: visible.findIndex(isRestoration),
				nativeTools: native?.toolsAdded?.map((tool) => tool.name) ?? [],
				nativeToolTokens: countToolTokens(native?.toolsAdded ?? []),
			};
		});
	}

	/** Returns request estimates for a provider dispatch with pending restoration metadata. */
	capture(context: Context): RestorationSnapshot | undefined {
		const pending = this.pending;
		this.pending = undefined;
		if (!pending) {
			return undefined;
		}
		let ordinaryIndex = -1;
		const withoutRestoration = context.messages.filter(
			(message) =>
				message.role === "system" ||
				++ordinaryIndex !== pending.restorationIndex,
		);
		const head = getCurrentSystemMessage(context.messages);
		return {
			roles: pending.roles,
			records: pending.records,
			requestTokens: estimateSerializedInputTokens(context),
			withoutRestorationTokens: estimateSerializedInputTokens({
				...context,
				messages: withoutRestoration,
			}),
			headContentTokens: estimateTextTokens(contentText(head?.content ?? "")),
			headSectionCount: Object.keys(head?.sections ?? {}).length,
			headTools: head?.toolsAdded?.map((tool) => tool.name) ?? [],
			nativeTools: pending.nativeTools,
			headToolTokens: countToolTokens(head?.toolsAdded ?? []),
			nativeToolTokens: pending.nativeToolTokens,
		};
	}
}

/** Recognizes the request-local delivery message by its structured type. */
function isRestoration(
	message: AgentMessage,
): message is Extract<AgentMessage, { role: "custom" }> {
	return message.role === "custom" && message.customType === RESTORATION_TYPE;
}

/** Estimates a system head containing only tool declarations. */
function countToolTokens(tools: Tool[]): number {
	return estimateSerializedInputTokens({
		messages: [
			{ role: "system", content: "", toolsAdded: tools, timestamp: 0 },
		],
	});
}
