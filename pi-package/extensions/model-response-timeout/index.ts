import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	MILLISECONDS_PER_SECOND,
	type ModelResponseTimeoutConfig,
	readModelResponseTimeoutConfig,
} from "./config";

const EXTENSION_NAME = "model-response-timeout";

export interface ResponseTimerDependencies {
	readonly setTimeout: (
		callback: () => void,
		delayMilliseconds: number,
	) => ReturnType<typeof setTimeout>;
	readonly clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

interface ActiveResponse {
	readonly generation: number;
	readonly timer: ReturnType<typeof setTimeout>;
	timedOut: boolean;
}

interface ResponseTimeoutState {
	generation: number;
	activeResponse: ActiveResponse | undefined;
}

/** Creates the extension entry point with replaceable timer functions for deterministic tests. */
export function createModelResponseTimeoutExtension(
	dependencies: ResponseTimerDependencies,
): (pi: ExtensionAPI) => void {
	return (pi) => {
		const configResult = readModelResponseTimeoutConfig();
		if (configResult.kind === "disabled") {
			return;
		}
		if (configResult.kind === "invalid") {
			registerConfigError(pi, configResult.issue);
			return;
		}

		registerTimeoutLifecycle(pi, configResult.config, dependencies);
	};
}

function registerConfigError(pi: ExtensionAPI, issue: string): void {
	let reported = false;
	pi.on("session_start", (_event, ctx) => {
		if (reported || ctx.hasUI === false) {
			return;
		}
		reported = true;
		ctx.ui.notify(`[${EXTENSION_NAME}] ${issue}. Extension disabled.`, "error");
	});
}

function registerTimeoutLifecycle(
	pi: ExtensionAPI,
	config: ModelResponseTimeoutConfig,
	dependencies: ResponseTimerDependencies,
): void {
	const state: ResponseTimeoutState = {
		generation: 0,
		activeResponse: undefined,
	};

	pi.on("before_provider_request", (_event, ctx) => {
		startResponseTimer(state, config, dependencies, () => ctx.abort());
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") {
			return undefined;
		}
		return finishAssistantResponse(state, config, dependencies, event.message);
	});

	const reset = () => resetResponseState(state, dependencies);
	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);
}

function startResponseTimer(
	state: ResponseTimeoutState,
	config: ModelResponseTimeoutConfig,
	dependencies: ResponseTimerDependencies,
	abort: () => void,
): void {
	clearActiveTimer(state, dependencies);
	state.generation += 1;
	const generation = state.generation;
	const timer = dependencies.setTimeout(() => {
		const activeResponse = state.activeResponse;
		if (activeResponse?.generation !== generation || activeResponse.timedOut) {
			return;
		}

		activeResponse.timedOut = true;
		abort();
	}, config.timeoutSeconds * MILLISECONDS_PER_SECOND);

	state.activeResponse = {
		generation,
		timer,
		timedOut: false,
	};
}

function finishAssistantResponse(
	state: ResponseTimeoutState,
	config: ModelResponseTimeoutConfig,
	dependencies: ResponseTimerDependencies,
	message: AssistantMessage,
) {
	const activeResponse = state.activeResponse;
	if (activeResponse === undefined) {
		return undefined;
	}

	dependencies.clearTimeout(activeResponse.timer);
	state.activeResponse = undefined;
	if (!activeResponse.timedOut) {
		return undefined;
	}

	// Pi recognizes this package-owned error as transient and applies its configured retry policy.
	return {
		message: {
			...message,
			content: [],
			stopReason: "error" as const,
			errorMessage: `Model response timed out after ${config.timeoutSeconds} seconds.`,
		},
	};
}

function clearActiveTimer(
	state: ResponseTimeoutState,
	dependencies: ResponseTimerDependencies,
): void {
	if (state.activeResponse !== undefined) {
		dependencies.clearTimeout(state.activeResponse.timer);
		state.activeResponse = undefined;
	}
}

function resetResponseState(
	state: ResponseTimeoutState,
	dependencies: ResponseTimerDependencies,
): void {
	clearActiveTimer(state, dependencies);
	// The generation invalidates callbacks retained by the runtime after cancellation.
	state.generation += 1;
}

const defaultDependencies: ResponseTimerDependencies = {
	setTimeout: globalThis.setTimeout,
	clearTimeout: globalThis.clearTimeout,
};

export default createModelResponseTimeoutExtension(defaultDependencies);
