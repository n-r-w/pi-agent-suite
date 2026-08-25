import type {
	AgentSettledEvent,
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { buildActiveToolDefinitions } from "../../shared/active-tool-definitions";
import { estimateSerializedInputTokens } from "../../shared/context-size";
import { readNativeCompactionSettings } from "../../shared/native-compaction-settings";

const CONTINUATION_TYPE = "compaction-trigger-continuation";
const DIAGNOSTIC_TYPE = "compaction-trigger-diagnostic";
const CONTINUATION_MESSAGE =
	"Continue the interrupted task from the compacted context and preserved tool results.";
const FAILURE_MESSAGE =
	"Compaction failed or did not reduce the request below the context threshold. The next model request was blocked.";

/** Closed lifecycle states that prevent overlapping compaction and continuation. */
type TriggerState =
	| "idle"
	| "interrupting"
	| "compacting"
	| "resuming"
	| "failed";

/** Mutable state shared by the extension's event handlers and compact callbacks. */
interface TriggerLifecycle {
	state: TriggerState;
}

/** Blocks an active provider request while leaving settled callbacks untouched. */
function blockRequest(ctx: ExtensionContext): { messages: [] } {
	if (ctx.signal !== undefined && !ctx.signal.aborted) {
		ctx.abort();
	}
	return { messages: [] };
}

/** Interrupts a threshold crossing even when Pi omits its current signal. */
function interruptRequest(ctx: ExtensionContext): { messages: [] } {
	ctx.abort();
	return { messages: [] };
}

/** Reports a terminal trigger failure without starting another model turn. */
function reportFailure(pi: ExtensionAPI): void {
	pi.sendMessage(
		{
			customType: DIAGNOSTIC_TYPE,
			content: FAILURE_MESSAGE,
			display: true,
		},
		{ triggerTurn: false },
	);
}

/** Evaluates the final projected request and advances interruption state. */
function handleContext(
	pi: ExtensionAPI,
	event: ContextEvent,
	ctx: ExtensionContext,
	lifecycle: TriggerLifecycle,
): { messages: [] } | undefined {
	if (
		lifecycle.state === "failed" ||
		lifecycle.state === "interrupting" ||
		lifecycle.state === "compacting"
	) {
		return blockRequest(ctx);
	}

	const model = ctx.model;
	if (model === undefined || model.contextWindow <= 0) {
		return undefined;
	}

	const settings = readNativeCompactionSettings(ctx.cwd);
	if (settings.status === "disabled") {
		return undefined;
	}
	if (settings.status === "invalid") {
		lifecycle.state = "failed";
		reportFailure(pi);
		return blockRequest(ctx);
	}

	const estimatedTokens = estimateSerializedInputTokens({
		systemPrompt: ctx.getSystemPrompt(),
		messages: convertToLlm(event.messages),
		tools: buildActiveToolDefinitions(pi),
	});
	const threshold = model.contextWindow - settings.reserveTokens;
	if (estimatedTokens < threshold) {
		if (lifecycle.state === "resuming") {
			lifecycle.state = "idle";
		}
		return undefined;
	}

	if (lifecycle.state === "resuming") {
		// One failed resumed estimate ends the cycle instead of compacting forever.
		lifecycle.state = "failed";
		reportFailure(pi);
		return blockRequest(ctx);
	}

	// Set interruption first because abort can synchronously advance run settlement.
	lifecycle.state = "interrupting";
	return interruptRequest(ctx);
}

/** Starts one deferred compaction and owns its terminal callbacks. */
function handleAgentSettled(
	pi: ExtensionAPI,
	_event: AgentSettledEvent,
	ctx: ExtensionContext,
	lifecycle: TriggerLifecycle,
): void {
	if (lifecycle.state !== "interrupting") {
		return;
	}

	// Compaction starts only after the aborted agent run has fully settled.
	lifecycle.state = "compacting";
	try {
		ctx.compact({
			onComplete: () => {
				// Ignore stale or duplicate callbacks so continuation is sent once.
				if (lifecycle.state !== "compacting") {
					return;
				}
				lifecycle.state = "resuming";
				pi.sendMessage(
					{
						customType: CONTINUATION_TYPE,
						content: CONTINUATION_MESSAGE,
						display: false,
					},
					{ triggerTurn: true },
				);
			},
			onError: () => {
				if (lifecycle.state !== "compacting") {
					return;
				}
				lifecycle.state = "failed";
				reportFailure(pi);
			},
		});
	} catch {
		lifecycle.state = "failed";
		reportFailure(pi);
	}
}

/** Registers threshold detection, deferred compaction, and one-shot continuation. */
export default function compactionTrigger(pi: ExtensionAPI): void {
	const lifecycle: TriggerLifecycle = { state: "idle" };

	pi.on("session_start", () => {
		// Session replacement clears terminal state but never rewinds active compaction work.
		if (
			lifecycle.state === "idle" ||
			lifecycle.state === "resuming" ||
			lifecycle.state === "failed"
		) {
			lifecycle.state = "idle";
		}
	});
	pi.on("context", (event, ctx) => handleContext(pi, event, ctx, lifecycle));
	pi.on("agent_settled", (event, ctx) =>
		handleAgentSettled(pi, event, ctx, lifecycle),
	);
}
