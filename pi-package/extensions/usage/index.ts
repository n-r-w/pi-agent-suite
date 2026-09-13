import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentRuntimeComposition } from "../../shared/agent-runtime-composition";
import { writeRuntimeDiagnostic } from "../../shared/agent-runtime-diagnostics";
import { getSuiteExtensionDir } from "../../shared/agent-suite-storage";
import { isChildAgentProcess } from "../../shared/child-agent-environment";
import {
	SUBAGENT_AGENT_ID_ENV,
	SUBAGENT_ROOT_SESSION_ID_ENV,
} from "../../shared/subagent-environment";
import {
	isUsageEventRecordRequest,
	USAGE_EVENT_RECORD_CHANNEL,
} from "../../shared/usage-events";
import {
	isUsageRootCostRequest,
	isUsageSessionTotalsRequest,
	USAGE_ROOT_COST_REQUEST_CHANNEL,
	USAGE_SESSION_TOTALS_REQUEST_CHANNEL,
	type UsageSessionTotals,
} from "../../shared/usage-read-broker";
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
	queryRootCost(rootSessionId: string): number;
	querySessionTotals(sessionId: string): UsageSessionTotals;
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

interface RecordResponseOptions {
	readonly message: AssistantMessage;
	readonly source: UsageEvent["source"];
	readonly eventId: string;
	readonly ctx: ExtensionContext;
	readonly sessionId: string | undefined;
	readonly rootSessionId: string | undefined;
	readonly agentId: string | undefined;
	readonly store: UsageStorePort;
	readonly recordDiagnostic: typeof writeRuntimeDiagnostic;
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
		registerUsageReadBroker(pi, store);
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

/** Exposes the process-owned store through the shared synchronous Pi event bus. */
function registerUsageReadBroker(
	pi: ExtensionAPI,
	store: UsageStorePort,
): void {
	pi.events.on(USAGE_ROOT_COST_REQUEST_CHANNEL, (value: unknown) => {
		if (!isUsageRootCostRequest(value)) {
			return;
		}
		try {
			value.cost = store.queryRootCost(value.rootSessionId);
		} catch {
			// An unavailable aggregate must remain distinguishable from a zero total.
		}
	});
	pi.events.on(USAGE_SESSION_TOTALS_REQUEST_CHANNEL, (value: unknown) => {
		if (!isUsageSessionTotalsRequest(value)) {
			return;
		}
		try {
			value.totals = store.querySessionTotals(value.sessionId);
		} catch {
			// An unavailable aggregate must remain distinguishable from zero totals.
		}
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
	let activeRootSessionId: string | undefined;
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
	) =>
		persistResponse({
			message,
			source,
			eventId,
			ctx,
			sessionId: activeSessionId,
			rootSessionId: activeRootSessionId,
			agentId: resolveAgentId(),
			store,
			recordDiagnostic: dependencies.recordDiagnostic,
		});
	const recordAggregate = createAggregateRecorder(dependencies, recordResponse);
	pi.events.on(USAGE_EVENT_RECORD_CHANNEL, (value: unknown) => {
		if (!isUsageEventRecordRequest(value) || activeContext === undefined) {
			return;
		}
		// The listener preserves the publisher ID so SQLite can deduplicate delivery.
		recordResponse(value.message, value.source, value.eventId, activeContext);
	});
	pi.on("session_start", (_event, ctx) => {
		activeSessionId = readNonEmptyString(ctx.sessionManager.getSessionId());
		activeRootSessionId = resolveRootSessionId(
			activeSessionId,
			childProcess,
			dependencies.environment,
		);
		activeContext = ctx;
		if (!childProcess && !state.cleanupAttempted) {
			state.cleanupAttempted = true;
			runRetentionCleanup(store, dependencies, ctx);
		}
		if (!childProcess && ctx.mode === "tui" && !commandRegistered) {
			commandRegistered = true;
			registerUsageCommand(pi, store, dependencies, () => activeRootSessionId);
		}
	});
	pi.on("session_shutdown", () => {
		activeSessionId = undefined;
		activeRootSessionId = undefined;
		activeContext = undefined;
	});
	registerRegularUsageHandler(pi, dependencies, recordResponse);
	registerAggregateUsageHandlers(pi, recordAggregate);
}

/** Pi-completed summary source that exposes aggregate usage instead of a message. */
type AggregateSource = "native-compaction" | "branch-summary";
type AggregateRecorder = (
	usage: Usage | undefined,
	timestamp: string,
	source: AggregateSource,
	ctx: ExtensionContext,
) => void;
type ResponseRecorder = (
	message: AssistantMessage,
	source: UsageEvent["source"],
	eventId: string,
	ctx: ExtensionContext,
) => void;

/** Records finalized regular assistant messages at Pi's message completion event. */
function registerRegularUsageHandler(
	pi: ExtensionAPI,
	dependencies: UsageExtensionDependencies,
	recordResponse: ResponseRecorder,
): void {
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") {
			return;
		}
		recordResponse(
			event.message as AssistantMessage,
			"agent-turn",
			dependencies.createEventId(),
			ctx,
		);
	});
}

/** Records summary aggregates only at Pi's completed lifecycle events. */
function registerAggregateUsageHandlers(
	pi: ExtensionAPI,
	recordAggregate: AggregateRecorder,
): void {
	pi.on("session_compact", (event, ctx) => {
		if (!event.fromExtension) {
			recordAggregate(
				event.compactionEntry.usage,
				event.compactionEntry.timestamp,
				"native-compaction",
				ctx,
			);
		}
	});
	pi.on("session_tree", (event, ctx) => {
		if (event.summaryEntry !== undefined) {
			recordAggregate(
				event.summaryEntry.usage,
				event.summaryEntry.timestamp,
				"branch-summary",
				ctx,
			);
		}
	});
}

/** Adapts one final Pi usage aggregate to the common validated response path. */
function createAggregateRecorder(
	dependencies: UsageExtensionDependencies,
	recordResponse: ResponseRecorder,
): AggregateRecorder {
	return (usage, timestamp, source, ctx) => {
		if (usage === undefined || ctx.model === undefined) {
			return;
		}
		recordResponse(
			{
				role: "assistant",
				content: [],
				api: ctx.model.api,
				provider: ctx.model.provider,
				model: ctx.model.id,
				usage,
				stopReason: "stop",
				timestamp: Date.parse(timestamp),
			},
			source,
			dependencies.createEventId(),
			ctx,
		);
	};
}

function persistResponse(options: RecordResponseOptions): void {
	const usageEvent = createAssistantUsageEvent(
		options.message,
		{
			sessionId: options.sessionId,
			rootSessionId: options.rootSessionId,
			agentId: options.agentId,
			source: options.source,
		},
		(provider, model) => options.ctx.modelRegistry.find(provider, model),
		() => options.eventId,
	);
	if (usageEvent === undefined) {
		return;
	}
	try {
		options.store.insert(usageEvent);
	} catch (error) {
		// Usage persistence must not turn a completed model response into a failed run.
		options.recordDiagnostic("usage.persistence.failed", {
			operation: "insert usage event",
			error: unsanitizedError(error),
		});
	}
}

function resolveRootSessionId(
	activeSessionId: string | undefined,
	childProcess: boolean,
	environment: NodeJS.ProcessEnv,
): string | undefined {
	return childProcess
		? readNonEmptyString(environment[SUBAGENT_ROOT_SESSION_ID_ENV])
		: activeSessionId;
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
	getActiveRootSessionId: () => string | undefined,
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
			const currentRootSessionId = getActiveRootSessionId();
			if (currentRootSessionId === undefined) {
				return;
			}
			const openedAt = dependencies.now();
			const events = store.queryRange(openedAt - DAYS_90_MS, openedAt);
			await openUsageOverlay(ctx, events, openedAt, currentRootSessionId);
		},
	});
}

async function openUsageOverlay(
	ctx: ExtensionContext,
	events: readonly UsageEvent[],
	openedAt: number,
	currentRootSessionId: string,
): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) =>
			new UsageScreen(
				events,
				{ openedAt, currentRootSessionId },
				() => done(undefined),
				{
					tui,
					theme,
					keybindings,
				},
			),
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
