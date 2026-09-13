import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentRuntimeComposition } from "../../shared/agent-runtime-composition";
import {
	CHILD_AGENT_PROCESS_ENV,
	CHILD_AGENT_PROCESS_ENV_VALUE,
} from "../../shared/child-agent-environment";
import { SUBAGENT_AGENT_ID_ENV } from "../../shared/subagent-environment";
import {
	USAGE_EVENT_RECORD_CHANNEL,
	USAGE_EVENT_RECORD_VERSION,
} from "../../shared/usage-events";
import { readUsageConfig } from "./config";
import {
	createUsageExtension,
	type UsageExtensionDependencies,
	type UsageStorePort,
} from "./index";
import type { UsageEvent } from "./store";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (
	args: string,
	ctx: ExtensionContext,
) => Promise<void> | void;

interface RegisteredCommand {
	readonly description?: string;
	readonly handler: CommandHandler;
	readonly getArgumentCompletions?: (
		prefix: string,
	) => Array<{ value: string; label: string }> | null;
}

interface Harness {
	readonly pi: ExtensionAPI;
	readonly handlers: Map<string, EventHandler[]>;
	readonly commands: Map<string, RegisteredCommand>;
}

function createHarness(): Harness {
	const handlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, RegisteredCommand>();
	const emitter = new EventEmitter();
	const pi = {
		events: {
			on: (name: string, listener: (...args: unknown[]) => void) => {
				emitter.on(name, listener);
				return () => emitter.off(name, listener);
			},
			emit: (name: string, payload: unknown) => emitter.emit(name, payload),
		},
		on: (name: string, handler: EventHandler) => {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		registerCommand: (name: string, command: RegisteredCommand) =>
			commands.set(name, command),
		getActiveTools: () => [],
		setActiveTools: () => {},
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands };
}

function pricedModel(): Model<Api> {
	return {
		id: "model-a",
		name: "Model A",
		api: "test",
		provider: "provider-a",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 10, output: 20, cacheRead: 2, cacheWrite: 12 },
		contextWindow: 100_000,
		maxTokens: 10_000,
	};
}

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "test",
		provider: "provider-a",
		model: "model-a",
		usage: {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0.75,
			},
		},
		stopReason: "stop",
		timestamp: 10_000,
	};
}

function context(overrides: Record<string, unknown> = {}): ExtensionContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: "/tmp",
		ui: {
			notify: () => {},
			custom: async () => undefined,
		},
		sessionManager: { getSessionId: () => "session-a" },
		modelRegistry: { find: () => pricedModel() },
		...overrides,
	} as unknown as ExtensionContext;
}

function dependencies(
	store: Pick<UsageStorePort, "insert" | "queryRange"> &
		Partial<UsageStorePort>,
	overrides: Partial<UsageExtensionDependencies> = {},
): UsageExtensionDependencies {
	const completeStore: UsageStorePort = {
		cleanupBefore: () => {},
		reset: () => {},
		...store,
	};
	return {
		readConfig: () => ({ kind: "enabled", config: { enabled: true } }),
		openStore: () => completeStore,
		now: () => 200_000_000,
		createEventId: () => "event-a",
		environment: {},
		lifetime: {},
		databasePath: "/tmp/usage.sqlite",
		recordDiagnostic: () => {},
		...overrides,
	};
}

async function emit(
	harness: Harness,
	name: string,
	event: unknown,
	ctx: ExtensionContext,
): Promise<void> {
	for (const handler of harness.handlers.get(name) ?? []) {
		await handler(event, ctx);
	}
}

describe("usage extension lifecycle", () => {
	test("reuses configuration and storage for the process lifetime", () => {
		// Purpose: keep reload-compatible ownership from rereading configuration or reopening SQLite.
		// Inputs and expected output: two extension instances with one lifetime object read and open exactly once.
		// Edge case: each instance receives a different Pi API while process-owned state stays shared.
		// Dependencies: the injected lifetime object and store factory only.
		const lifetime = {};
		let configReads = 0;
		let storeOpens = 0;
		const store: UsageStorePort = {
			insert: () => {},
			queryRange: () => [],
			cleanupBefore: () => {},
			reset: () => {},
		};
		const extension = createUsageExtension(
			dependencies(store, {
				lifetime,
				readConfig: () => {
					configReads += 1;
					return { kind: "enabled", config: { enabled: true } };
				},
				openStore: () => {
					storeOpens += 1;
					return store;
				},
			}),
		);

		extension(createHarness().pi);
		extension(createHarness().pi);

		expect(configReads).toBe(1);
		expect(storeOpens).toBe(1);
	});

	test("does not open storage or register runtime behavior when disabled or invalid", async () => {
		// Purpose: prove fail-closed startup and one interactive invalid-config error.
		// Inputs and expected output: explicit disablement and a found empty object make no store calls or commands; the empty object reports once.
		// Edge case: repeated interactive session_start events do not duplicate the error.
		// Dependencies: the production config parser, injected store factory, and Pi lifecycle fakes.
		for (const config of [
			{ kind: "disabled" } as const,
			readUsageConfig(() => ({ kind: "found", file: { content: "{}" } })),
		]) {
			const harness = createHarness();
			let opens = 0;
			const notifications: string[] = [];
			createUsageExtension(
				dependencies(
					{ insert: () => {}, queryRange: () => [] },
					{
						readConfig: () => config,
						openStore: () => {
							opens += 1;
							return {
								insert: () => {},
								queryRange: () => [],
								cleanupBefore: () => {},
								reset: () => {},
							};
						},
					},
				),
			)(harness.pi);
			const ctx = context({
				ui: { notify: (text: string) => notifications.push(text) },
			});
			await emit(
				harness,
				"session_start",
				{ type: "session_start", reason: "startup" },
				ctx,
			);
			await emit(
				harness,
				"session_start",
				{ type: "session_start", reason: "reload" },
				ctx,
			);

			expect(opens).toBe(0);
			expect(harness.commands.size).toBe(0);
			expect(notifications.length).toBe(config.kind === "invalid" ? 1 : 0);
		}
	});

	test("records one complete attributable regular assistant response", async () => {
		// Purpose: prove the enabled runtime connects finalized regular responses to storage.
		// Inputs and expected output: one session start, selected main agent, and complete assistant message insert one normalized event.
		// Edge case: a non-assistant message and a response before session start are ignored.
		// Dependencies: runtime composition identity, model registry pricing, and an injected store.
		const inserted: UsageEvent[] = [];
		const harness = createHarness();
		createUsageExtension(
			dependencies({
				insert: (value) => inserted.push(value),
				queryRange: () => [],
			}),
		)(harness.pi);
		getAgentRuntimeComposition(harness.pi).setMainAgentContribution({
			prompt: "main",
			tools: [],
			agent: { id: "agent-a" },
		});
		const ctx = context();
		await emit(
			harness,
			"message_end",
			{ type: "message_end", message: assistantMessage() },
			ctx,
		);
		await emit(
			harness,
			"session_start",
			{ type: "session_start", reason: "startup" },
			ctx,
		);
		await emit(
			harness,
			"message_end",
			{
				type: "message_end",
				message: { role: "user", content: "hello", timestamp: 1 },
			},
			ctx,
		);
		await emit(
			harness,
			"message_end",
			{ type: "message_end", message: assistantMessage() },
			ctx,
		);

		expect(inserted).toHaveLength(1);
		expect(inserted[0]).toMatchObject({
			eventId: "event-a",
			sessionId: "session-a",
			agentId: "agent-a",
			source: "agent-turn",
		});
	});

	test("attributes marked child regular responses only with a stable child agent ID", async () => {
		// Purpose: child regular responses must use the explicit stable subagent identity and ignore unattributable marked children.
		// Inputs and expected output: marked children with and without PI_SUBAGENT_AGENT_ID produce one event attributed to child-agent.
		// Edge case: root runtime composition is not used as a fallback for a marked child without the ID.
		// Dependencies: shared child environment markers, lifecycle fakes, model pricing, and an injected store.
		const inserted: UsageEvent[] = [];
		for (const agentId of ["child-agent", undefined]) {
			const harness = createHarness();
			createUsageExtension(
				dependencies(
					{
						insert: (value) => inserted.push(value),
						queryRange: () => [],
					},
					{
						environment: {
							[CHILD_AGENT_PROCESS_ENV]: CHILD_AGENT_PROCESS_ENV_VALUE,
							[SUBAGENT_AGENT_ID_ENV]: agentId,
						},
						createEventId: () => `event-${agentId ?? "missing"}`,
					},
				),
			)(harness.pi);
			getAgentRuntimeComposition(harness.pi).setMainAgentContribution({
				prompt: "must-not-be-used",
				tools: [],
				agent: { id: "root-agent" },
			});
			const ctx = context();
			await emit(
				harness,
				"session_start",
				{ type: "session_start", reason: "startup" },
				ctx,
			);
			await emit(
				harness,
				"message_end",
				{ type: "message_end", message: assistantMessage() },
				ctx,
			);
		}

		expect(inserted).toHaveLength(1);
		expect(inserted[0]).toMatchObject({
			eventId: "event-child-agent",
			agentId: "child-agent",
			sessionId: "session-a",
			source: "agent-turn",
		});
	});

	test("records auxiliary requests with publisher IDs and active attribution", async () => {
		// Purpose: the usage listener must preserve auxiliary publisher identity and record valid zero-cost complete responses.
		// Inputs and expected output: duplicate delivery of one zero-cost advisor request reaches persistence twice with the same ID, session, and initiating agent.
		// Edge case: storage idempotency can collapse repeated handling because the listener never replaces the event ID.
		// Dependencies: shared versioned event bus, root runtime identity, active session, pricing, and an injected store.
		const inserted: UsageEvent[] = [];
		const harness = createHarness();
		createUsageExtension(
			dependencies({
				insert: (value) => inserted.push(value),
				queryRange: () => [],
			}),
		)(harness.pi);
		getAgentRuntimeComposition(harness.pi).setMainAgentContribution({
			prompt: "main",
			tools: [],
			agent: { id: "agent-a" },
		});
		const ctx = context();
		await emit(
			harness,
			"session_start",
			{ type: "session_start", reason: "startup" },
			ctx,
		);
		const message = assistantMessage();
		message.usage.cost.total = 0;
		const request = {
			version: USAGE_EVENT_RECORD_VERSION,
			eventId: "publisher-event",
			source: "consult-advisor" as const,
			message,
		};

		harness.pi.events.emit(USAGE_EVENT_RECORD_CHANNEL, request);
		harness.pi.events.emit(USAGE_EVENT_RECORD_CHANNEL, request);

		expect(inserted).toHaveLength(2);
		expect(inserted[0]).toMatchObject({
			eventId: "publisher-event",
			sessionId: "session-a",
			agentId: "agent-a",
			source: "consult-advisor",
			cost: 0,
		});
		expect(inserted[1]?.eventId).toBe("publisher-event");
	});

	test("reports insertion failures through runtime diagnostics without failing responses", async () => {
		// Purpose: persistence failures must retain the original database error while completed responses stay successful.
		// Inputs and expected output: one insert throws an Error with a stack and message_end resolves with one matching diagnostic.
		// Edge case: diagnostic recording is isolated from model response completion.
		// Dependencies: injected store failure, lifecycle event routing, and the existing runtime diagnostic boundary.
		const original = new Error("database is locked: raw detail");
		original.stack = "ORIGINAL STACK\nraw database detail";
		const diagnostics: Array<{ event: string; fields: unknown }> = [];
		const harness = createHarness();
		createUsageExtension(
			dependencies(
				{
					insert: () => {
						throw original;
					},
					queryRange: () => [],
				},
				{
					recordDiagnostic: (event: string, fields: unknown) =>
						diagnostics.push({ event, fields }),
				} as unknown as Partial<UsageExtensionDependencies>,
			),
		)(harness.pi);
		getAgentRuntimeComposition(harness.pi).setMainAgentContribution({
			prompt: "main",
			tools: [],
			agent: { id: "agent-a" },
		});
		const ctx = context();
		await emit(
			harness,
			"session_start",
			{ type: "session_start", reason: "startup" },
			ctx,
		);

		await expect(
			emit(
				harness,
				"message_end",
				{ type: "message_end", message: assistantMessage() },
				ctx,
			),
		).resolves.toBeUndefined();
		expect(diagnostics).toEqual([
			{
				event: "usage.persistence.failed",
				fields: {
					operation: "insert usage event",
					error: "ORIGINAL STACK\nraw database detail",
				},
			},
		]);
	});

	test("runs root retention once across reloads and keeps recording after failure", async () => {
		// Purpose: one operating-system process must attempt root cleanup only on its first session start and remain usable after failure.
		// Inputs and expected output: two extension instances share one lifetime, cleanup throws once, and a later response is still inserted.
		// Edge case: failure UI includes the database path, failed operation, and original unsanitized stack; reload does not repeat notifications.
		// Dependencies: injected process lifetime, root environment, lifecycle contexts, and store operations.
		const cleanupError = new Error("raw cleanup failure");
		cleanupError.stack = "RAW CLEANUP STACK\nunsanitized detail";
		const cleanupCutoffs: number[] = [];
		const inserted: UsageEvent[] = [];
		const lifetime = {};
		const store = {
			insert: (value: UsageEvent) => inserted.push(value),
			queryRange: () => [],
			cleanupBefore: (cutoffMs: number) => {
				cleanupCutoffs.push(cutoffMs);
				throw cleanupError;
			},
			reset: () => {},
		};
		const extension = createUsageExtension(
			dependencies(store, {
				lifetime,
				now: () => 500_000_000,
				databasePath: "/raw/path/usage.sqlite",
			} as unknown as Partial<UsageExtensionDependencies>),
		);
		const first = createHarness();
		const second = createHarness();
		extension(first.pi);
		extension(second.pi);
		getAgentRuntimeComposition(first.pi).setMainAgentContribution({
			prompt: "main",
			tools: [],
			agent: { id: "agent-a" },
		});
		const notifications: Array<{ text: string; level: string }> = [];
		const ctx = context({
			ui: {
				notify: (text: string, level: string) =>
					notifications.push({ text, level }),
				custom: async () => undefined,
			},
		});

		await emit(first, "session_start", { type: "session_start" }, ctx);
		await emit(second, "session_start", { type: "session_start" }, ctx);
		await emit(
			first,
			"message_end",
			{ type: "message_end", message: assistantMessage() },
			ctx,
		);

		expect(cleanupCutoffs).toEqual([500_000_000 - 90 * 24 * 60 * 60 * 1_000]);
		expect(notifications[0]).toEqual({
			text: "Usage cleanup started",
			level: "info",
		});
		expect(notifications[1]?.level).toBe("error");
		expect(notifications[1]?.text).toContain("/raw/path/usage.sqlite");
		expect(notifications[1]?.text).toContain(
			"delete usage events older than 90 days",
		);
		expect(notifications[1]?.text).toContain(
			"RAW CLEANUP STACK\nunsanitized detail",
		);
		expect(notifications).toHaveLength(2);
		expect(inserted).toHaveLength(1);
	});

	test("never gives child processes command or cleanup ownership", async () => {
		// Purpose: child recording must not acquire root-only command, cleanup, or cleanup-notification behavior.
		// Inputs and expected output: a marked child session starts with no command, cleanup call, or notification.
		// Edge case: the child remains enabled for attributable event recording.
		// Dependencies: shared child marker, lifecycle context, and injected store.
		let cleanupCalls = 0;
		const notifications: string[] = [];
		const harness = createHarness();
		const store = {
			insert: () => {},
			queryRange: () => [],
			cleanupBefore: () => {
				cleanupCalls += 1;
			},
			reset: () => {},
		};
		createUsageExtension(
			dependencies(store, {
				environment: {
					[CHILD_AGENT_PROCESS_ENV]: CHILD_AGENT_PROCESS_ENV_VALUE,
					[SUBAGENT_AGENT_ID_ENV]: "child-agent",
				},
			} as unknown as Partial<UsageExtensionDependencies>),
		)(harness.pi);
		await emit(
			harness,
			"session_start",
			{ type: "session_start" },
			context({ ui: { notify: (text: string) => notifications.push(text) } }),
		);

		expect(cleanupCalls).toBe(0);
		expect(harness.commands.size).toBe(0);
		expect(notifications).toEqual([]);
	});

	test("validates command arguments, autocompletes reset, and confirms mutation", async () => {
		// Purpose: the root command must expose only the approved view and confirmed complete-reset operations.
		// Inputs and expected output: unsupported input reports usage; matching prefixes suggest reset; cancellation does not mutate and confirmation resets once.
		// Edge case: non-matching completion prefixes return no suggestions.
		// Dependencies: command registration, UI confirmation, notifications, and injected transactional store reset.
		let resetCalls = 0;
		const store = {
			insert: () => {},
			queryRange: () => [],
			cleanupBefore: () => {},
			reset: () => {
				resetCalls += 1;
			},
		};
		const harness = createHarness();
		createUsageExtension(dependencies(store))(harness.pi);
		const notifications: Array<{ text: string; level: string }> = [];
		let confirmed = false;
		const ctx = context({
			ui: {
				notify: (text: string, level: string) =>
					notifications.push({ text, level }),
				confirm: async () => confirmed,
				custom: async () => undefined,
			},
		});
		await emit(harness, "session_start", { type: "session_start" }, ctx);
		const command = harness.commands.get("usage");

		expect(command?.description).toContain("reset");
		expect(command?.getArgumentCompletions?.("")).toEqual([
			{ value: "reset", label: "reset" },
		]);
		expect(command?.getArgumentCompletions?.("re")).toEqual([
			{ value: "reset", label: "reset" },
		]);
		expect(command?.getArgumentCompletions?.("other")).toBeNull();
		await command?.handler("unsupported", ctx);
		expect(notifications.at(-1)).toEqual({
			text: "Usage: /usage [reset]",
			level: "error",
		});
		await command?.handler("reset", ctx);
		expect(resetCalls).toBe(0);
		confirmed = true;
		await command?.handler("reset", ctx);
		expect(resetCalls).toBe(1);
	});

	test("opens one root 90-day snapshot and queries storage once", async () => {
		// Purpose: prove the root TUI reads one immutable 90-day database snapshot for all selectable ranges.
		// Inputs and expected output: command open queries once and renders All agents, Total, and sorted provider/model rows.
		// Edge case: rendering the component more than once does not query storage again.
		// Dependencies: public command and custom-overlay contracts plus pure aggregation and screen rendering.
		let queryCalls = 0;
		let queryBounds: readonly [number, number] | undefined;
		const events: UsageEvent[] = [
			{
				eventId: "b",
				timestampMs: 199_999_000,
				sessionId: "s",
				agentId: "a",
				source: "agent-turn",
				provider: "zeta",
				model: "m",
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				cost: 1,
				saved: 2,
			},
			{
				eventId: "a",
				timestampMs: 199_999_000,
				sessionId: "s",
				agentId: "b",
				source: "agent-turn",
				provider: "alpha",
				model: "m",
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				cost: 1,
				saved: 2,
			},
		];
		const harness = createHarness();
		createUsageExtension(
			dependencies({
				insert: () => {},
				queryRange: (startMs, endMs) => {
					queryCalls += 1;
					queryBounds = [startMs, endMs];
					return events;
				},
			}),
		)(harness.pi);
		let factory: Parameters<ExtensionContext["ui"]["custom"]>[0] | undefined;
		const ctx = context({
			ui: {
				notify: () => {},
				custom: async (
					candidate: Parameters<ExtensionContext["ui"]["custom"]>[0],
				) => {
					factory = candidate;
				},
			},
		});
		await emit(
			harness,
			"session_start",
			{ type: "session_start", reason: "startup" },
			ctx,
		);
		await harness.commands.get("usage")?.handler("", ctx);
		if (factory === undefined) {
			throw new Error("usage screen factory was not opened");
		}
		const component = await factory(
			{} as never,
			{} as never,
			{} as never,
			() => {},
		);
		const first = component.render(100).join("\n");
		const second = component.render(100).join("\n");

		expect(queryCalls).toBe(1);
		expect(queryBounds).toEqual([
			200_000_000 - 90 * 24 * 60 * 60 * 1_000,
			200_000_000,
		]);
		expect(first).toContain("24h");
		expect(first).toContain("All agents");
		expect(first.indexOf("Total")).toBeLessThan(first.indexOf("alpha/m"));
		expect(first.indexOf("alpha/m")).toBeLessThan(first.indexOf("zeta/m"));
		expect(second).toBe(first);
	});
});
