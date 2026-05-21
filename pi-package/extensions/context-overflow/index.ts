import type {
	CompactOptions,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getProjectionAwareContextUsage } from "../../shared/context-projection";
import { readContextOverflowConfig } from "./config";

/** Continuation message sent after successful preventive compaction. */
const CONTINUATION_MESSAGE =
	"System message: Context summarization complete, continue";

interface ContextOverflowSession {
	readonly sessionManager: ExtensionContext["sessionManager"];
	getContextUsage(): ExtensionContext["getContextUsage"] extends () => infer T
		? T
		: never;
	compact(options?: CompactOptions): void;
}

/** Extension entry point for proactive standard compaction near context overflow. */
export default function contextOverflow(pi: ExtensionAPI): void {
	let compactionInFlight = false;
	let thresholdExceeded = false;

	pi.on("turn_end", async (_event, ctx) => {
		if (ctx.hasUI === false) {
			return;
		}

		const config = await readContextOverflowConfig();
		if (config.kind === "invalid" || !config.config.enabled) {
			return;
		}

		const session = ctx as unknown as ContextOverflowSession;
		const usage = getProjectionAwareContextUsage(
			session.sessionManager.getSessionId(),
			session.getContextUsage(),
		);
		if (usage === undefined || usage.tokens === null) {
			return;
		}

		const remainingTokens = usage.contextWindow - usage.tokens;
		if (remainingTokens > config.config.compactRemainingTokens) {
			thresholdExceeded = false;
			return;
		}

		if (compactionInFlight || thresholdExceeded) {
			return;
		}

		thresholdExceeded = true;
		compactionInFlight = true;
		try {
			session.compact({
				onComplete: () => {
					compactionInFlight = false;
					pi.sendUserMessage(CONTINUATION_MESSAGE, {
						deliverAs: "followUp",
					});
				},
				onError: () => {
					compactionInFlight = false;
					thresholdExceeded = false;
				},
			});
		} catch (error) {
			compactionInFlight = false;
			thresholdExceeded = false;
			throw error;
		}
	});
}
