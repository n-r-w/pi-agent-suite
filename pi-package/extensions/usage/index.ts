import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentRuntimeComposition } from "../../shared/agent-runtime-composition";
import { writeRuntimeDiagnostic } from "../../shared/agent-runtime-diagnostics";
import { getSuiteExtensionDir } from "../../shared/agent-suite-storage";
import { isChildAgentProcess } from "../../shared/child-agent-environment";
import { SUBAGENT_AGENT_ID_ENV } from "../../shared/subagent-environment";
import {
	isUsageEventRecordRequest,
	USAGE_EVENT_RECORD_CHANNEL,
} from "../../shared/usage-events";
import { readUsageConfig, type UsageConfigResult } from "./config";
import { readUsageProcessEnvironment } from "./environment";
import { createAssistantUsageEvent } from "./recorder";
import { UsageScreen } from "./screen";
import { type UsageEvent, UsageStore } from "./store";

const EXTENSION_NAME = "usage";
const DATABASE_FILE = "usage.sqlite";
const MILLISECONDS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const LONGEST_RANGE_DAYS = 90;
const DAYS_90_MS =
	LONGEST_RANGE_DAYS *
	HOURS_PER_DAY *
	MINUTES_PER_HOUR *
	SECONDS_PER_MINUTE *
	MILLISECONDS_PER_SECOND;
const PROCESS_STATE_KEY = Symbol.for("pi-agent-suite.usage.process-state.v1");

export interface UsageStorePort {
	insert(event: UsageEvent): void;
	queryRange(startMs: number, endMs: number): UsageEvent[];
	cleanupBefore(cutoffMs: number): void;
	reset(): void;
}

export interface UsageExtensionDependencies {
	readonly readConfig: () => UsageConfigResult;
	readonly openStore: () => UsageStorePort;
	readonly now: () => number;
	readonly createEventId: () => string;
	readonly environment: NodeJS.ProcessEnv;
	readonly lifetime: object;
	readonly databasePath: string;
	readonly recordDiagnostic: typeof writeRuntimeDiagnostic;
}

interface UsageProcessState {
	readonly config: UsageConfigResult;
	readonly store: UsageStorePort | undefined;
	invalidReported: boolean;
	cleanupAttempted: boolean;
}

/** Creates the usage extension with injectable process-lifetime boundaries. */
export function createUsageExtension(
	providedDependencies?: UsageExtensionDependencies,
): (pi: ExtensionAPI) => void {
	const dependencies = providedDependencies ?? defaultDependencies();
	return (pi) => {
		const processState = getProcessState(dependencies);
		if (processState.config.kind === "disabled") {
			return;
		}
		if (processState.config.kind === "invalid") {
			registerInvalidConfigNotification(pi, processState);
			return;
		}

		const store = processState.store;
		if (store === undefined) {
			return;
		}
		registerEnabledRuntime(pi, processState, dependencies);
	};
}

function defaultDependencies(): UsageExtensionDependencies {
	const databasePath = join(
		getSuiteExtensionDir(EXTENSION_NAME),
		"data",
		DATABASE_FILE,
	);
	return {
		readConfig: readUsageConfig,
		openStore: () => new UsageStore(databasePath),
		now: Date.now,
		createEventId: randomUUID,
		environment: readUsageProcessEnvironment(),
		lifetime: process,
		databasePath,
		recordDiagnostic: writeRuntimeDiagnostic,
	};
}

/** Keeps configuration and the SQLite connection stable across cache-free reloads. */
function getProcessState(
	dependencies: UsageExtensionDependencies,
): UsageProcessState {
	const lifetime = dependencies.lifetime as Record<PropertyKey, unknown>;
	const existing = lifetime[PROCESS_STATE_KEY];
	if (isUsageProcessState(existing)) {
		return existing;
	}

	const config = dependencies.readConfig();
	const state: UsageProcessState = {
		config,
		store: config.kind === "enabled" ? dependencies.openStore() : undefined,
		invalidReported: false,
		cleanupAttempted: false,
	};
	lifetime[PROCESS_STATE_KEY] = state;
	return state;
}

function isUsageProcessState(value: unknown): value is UsageProcessState {
	return (
		typeof value === "object" &&
		value !== null &&
		"config" in value &&
		"invalidReported" in value
	);
}

function registerInvalidConfigNotification(
	pi: ExtensionAPI,
	state: UsageProcessState,
): void {
	pi.on("session_start", (_event, ctx) => {
		if (
			state.invalidReported ||
			ctx.hasUI === false ||
			state.config.kind !== "invalid"
		) {
			return;
		}
		state.invalidReported = true;
		ctx.ui.notify(
			`[${EXTENSION_NAME}] ${state.config.issue}. Extension disabled.`,
			"error",
		);
	});
}

function registerEnabledRuntime(
	pi: ExtensionAPI,
	state: UsageProcessState,
	dependencies: UsageExtensionDependencies,
): void {
	const store = state.store;
	if (store === undefined) {
		return;
	}
	let activeSessionId: string | undefined;
	let activeContext: ExtensionContext | undefined;
	let commandRegistered = false;
	const childProcess = isChildAgentProcess(dependencies.environment);
	const resolveAgentId = () =>
		childProcess
			? readNonEmptyString(dependencies.environment[SUBAGENT_AGENT_ID_ENV])
			: resolveMainAgentId(pi);
	const recordResponse = (
		message: AssistantMessage,
		source: UsageEvent["source"],
		eventId: string,
		ctx: ExtensionContext,
	) => {
		const usageEvent = createAssistantUsageEvent(
			message,
			{ sessionId: activeSessionId, agentId: resolveAgentId(), source },
			(provider, model) => ctx.modelRegistry.find(provider, model),
			() => eventId,
		);
		if (usageEvent === undefined) {
			return;
		}
		try {
			store.insert(usageEvent);
		} catch (error) {
			// Usage persistence must not turn a completed model response into a failed run.
			dependencies.recordDiagnostic("usage.persistence.failed", {
				operation: "insert usage event",
				error: unsanitizedError(error),
			});
		}
	};

	pi.events.on(USAGE_EVENT_RECORD_CHANNEL, (value: unknown) => {
		if (!isUsageEventRecordRequest(value) || activeContext === undefined) {
			return;
		}
		// The listener preserves the publisher ID so SQLite can deduplicate delivery.
		recordResponse(value.message, value.source, value.eventId, activeContext);
	});
	pi.on("session_start", (_event, ctx) => {
		activeSessionId = readNonEmptyString(ctx.sessionManager.getSessionId());
		activeContext = ctx;
		if (!childProcess && !state.cleanupAttempted) {
			state.cleanupAttempted = true;
			runRetentionCleanup(store, dependencies, ctx);
		}
		if (!childProcess && ctx.mode === "tui" && !commandRegistered) {
			commandRegistered = true;
			registerUsageCommand(pi, store, dependencies);
		}
	});
	pi.on("session_shutdown", () => {
		activeSessionId = undefined;
		activeContext = undefined;
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") {
			return;
		}
		const eventId = dependencies.createEventId();
		recordResponse(
			event.message as AssistantMessage,
			"agent-turn",
			eventId,
			ctx,
		);
	});
}

function resolveMainAgentId(pi: ExtensionAPI): string | undefined {
	return readNonEmptyString(
		getAgentRuntimeComposition(pi).getMainAgentContribution()?.agent?.id,
	);
}

function registerUsageCommand(
	pi: ExtensionAPI,
	store: UsageStorePort,
	dependencies: UsageExtensionDependencies,
): void {
	pi.registerCommand("usage", {
		description: "Open usage history or reset recorded usage",
		getArgumentCompletions: (prefix) =>
			"reset".startsWith(prefix) ? [{ value: "reset", label: "reset" }] : null,
		handler: async (args, ctx) => {
			const argument = args.trim();
			if (argument === "reset") {
				const confirmed = await ctx.ui.confirm(
					"Reset usage history?",
					"This deletes all committed usage events.",
				);
				if (confirmed) {
					store.reset();
				}
				return;
			}
			if (argument.length > 0) {
				ctx.ui.notify("Usage: /usage [reset]", "error");
				return;
			}
			if (ctx.mode !== "tui") {
				return;
			}
			const openedAt = dependencies.now();
			const events = store.queryRange(openedAt - DAYS_90_MS, openedAt);
			await openUsageOverlay(ctx, events, openedAt);
		},
	});
}

async function openUsageOverlay(
	ctx: ExtensionContext,
	events: readonly UsageEvent[],
	openedAt: number,
): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) =>
			new UsageScreen(events, openedAt, () => done(undefined), {
				tui,
				theme,
				keybindings,
			}),
		{
			overlay: true,
			overlayOptions: {
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			},
		},
	);
}

function runRetentionCleanup(
	store: UsageStorePort,
	dependencies: UsageExtensionDependencies,
	ctx: ExtensionContext,
): void {
	if (ctx.hasUI !== false) {
		ctx.ui.notify("Usage cleanup started", "info");
	}
	try {
		store.cleanupBefore(dependencies.now() - DAYS_90_MS);
		if (ctx.hasUI !== false) {
			ctx.ui.notify("Usage cleanup completed", "info");
		}
	} catch (error) {
		const details = unsanitizedError(error);
		dependencies.recordDiagnostic("usage.cleanup.failed", {
			databasePath: dependencies.databasePath,
			operation: "delete usage events older than 90 days",
			error: details,
		});
		if (ctx.hasUI !== false) {
			ctx.ui.notify(
				`Usage cleanup failed\nDatabase: ${dependencies.databasePath}\nOperation: delete usage events older than 90 days\n${details}`,
				"error",
			);
		}
	}
}

/** Preserves the original stack or thrown value for runtime and cleanup diagnostics. */
function unsanitizedError(error: unknown): string {
	return error instanceof Error && error.stack !== undefined
		? error.stack
		: String(error);
}

function readNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

export default createUsageExtension();
