import type {
	AgentSettledEvent,
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	COMPACTION_TRIGGER_CONTINUATION_TYPE,
	COMPACTION_TRIGGER_INTERRUPTION_TYPE,
} from "../../shared/compaction-trigger-protocol";
import { getProjectionAwareContextUsage } from "../../shared/context-projection";
import { readNativeCompactionSettings } from "../../shared/native-compaction-settings";
import {
	type CompactionTriggerConfig,
	readCompactionTriggerConfig,
} from "./config";

const DIAGNOSTIC_TYPE = "compaction-trigger-diagnostic";
const PERCENT_SCALE = 100;
const CONTINUATION_MESSAGE =
	"Continue the interrupted task from the compacted context and preserved tool results.";
const FAILURE_MESSAGE =
	"Compaction failed or did not reduce the request below the context threshold. The next model request was blocked.";
const CONFIG_FAILURE_MESSAGE =
	"compaction-trigger config is invalid. The next model request was blocked.";

/** Closed lifecycle states that prevent overlapping compaction and continuation. */
type TriggerState =
	| "idle"
	| "interrupting"
	| "compacted"
	| "compacting"
	| "resuming"
	| "failed";

/** Mutable state shared by the extension's event handlers and compact callbacks. */
interface TriggerLifecycle {
	state: TriggerState;
	readonly config: CompactionTriggerConfig;
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

/** Announces that the interrupted child run will continue after compaction. */
function announceInterruption(pi: ExtensionAPI): void {
	pi.sendMessage(
		{
			customType: COMPACTION_TRIGGER_INTERRUPTION_TYPE,
			content: "",
			display: false,
		},
		{ triggerTurn: false },
	);
}

/** Reports a terminal trigger failure without starting another model turn. */
function reportFailure(
	pi: ExtensionAPI,
	content: string = FAILURE_MESSAGE,
): void {
	pi.sendMessage(
		{
			customType: DIAGNOSTIC_TYPE,
			content,
			display: true,
		},
		{ triggerTurn: false },
	);
}

/** Evaluates the final projected request and advances interruption state. */
function handleContext(
	pi: ExtensionAPI,
	_event: ContextEvent,
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
	if (settings.status === "invalid") {
		lifecycle.state = "failed";
		reportFailure(pi);
		return blockRequest(ctx);
	}

	// The trigger and footer share this projection-aware source so visible usage matches threshold behavior.
	const usage = getProjectionAwareContextUsage(
		ctx.sessionManager.getSessionId(),
		ctx.getContextUsage(),
	);
	// The user owns real provider capacity, so tolerance is not capped at the declared window.
	const threshold =
		model.contextWindow -
		settings.reserveTokens +
		(model.contextWindow * lifecycle.config.tolerancePercent) / PERCENT_SCALE;
	if (
		usage === undefined ||
		usage.tokens === null ||
		usage.tokens < threshold
	) {
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

	// Publish the child-lifecycle marker before abort can advance run settlement.
	lifecycle.state = "interrupting";
	announceInterruption(pi);
	return interruptRequest(ctx);
}

/** Sends one hidden continuation after a successful compaction. */
function resumeInterruptedRun(
	pi: ExtensionAPI,
	lifecycle: TriggerLifecycle,
): void {
	lifecycle.state = "resuming";
	pi.sendMessage(
		{
			customType: COMPACTION_TRIGGER_CONTINUATION_TYPE,
			content: CONTINUATION_MESSAGE,
			display: false,
		},
		{ triggerTurn: true },
	);
}

/** Starts manual compaction only when native post-run compaction did not finish. */
function handleAgentSettled(
	pi: ExtensionAPI,
	_event: AgentSettledEvent,
	ctx: ExtensionContext,
	lifecycle: TriggerLifecycle,
): void {
	if (lifecycle.state === "compacted") {
		// Pi rebuilt the context through native post-run compaction before settlement.
		resumeInterruptedRun(pi, lifecycle);
		return;
	}
	if (lifecycle.state !== "interrupting") {
		return;
	}

	// Start manual compaction only when Pi did not compact during post-run handling.
	lifecycle.state = "compacting";
	try {
		ctx.compact({
			onComplete: () => {
				// Ignore stale or duplicate callbacks so continuation is sent once.
				if (lifecycle.state !== "compacting") {
					return;
				}
				resumeInterruptedRun(pi, lifecycle);
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
	const configResult = readCompactionTriggerConfig();
	if (configResult.kind === "disabled") {
		return;
	}
	if (configResult.kind === "invalid") {
		let reported = false;
		pi.on("context", (_event, ctx) => {
			if (!reported) {
				reported = true;
				reportFailure(pi, CONFIG_FAILURE_MESSAGE);
			}
			return blockRequest(ctx);
		});
		return;
	}

	const lifecycle: TriggerLifecycle = {
		state: "idle",
		config: configResult.config,
	};

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
	pi.on("session_compact", () => {
		if (lifecycle.state === "interrupting") {
			// Native post-run compaction completes before Pi emits agent_settled.
			lifecycle.state = "compacted";
		}
	});
	pi.on("agent_settled", (event, ctx) =>
		handleAgentSettled(pi, event, ctx, lifecycle),
	);
}
