import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	createEventBus,
	type ExtensionAPI,
	type ExtensionContext,
	initTheme,
	SessionManager,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	KeybindingsManager,
	type Terminal,
	type TUI,
} from "@earendil-works/pi-tui";
import { Check } from "typebox/value";
import { createPersistedSession } from "../../../test/support/persisted-session";
import type { AgentDefinition } from "../../shared/agent-registry";
import { getAgentRuntimeComposition } from "../../shared/agent-runtime-composition";
import { getKnowledgeHierarchyClient } from "../../shared/knowledge-runtime";
import {
	SUBAGENT_OWNER_SESSION_ENV,
	SUBAGENT_RUNTIME_LEASE_ENV,
} from "../../shared/subagent-environment";
import {
	isAgentAvailableForCaller,
	resolveCallerSelectedAgentId,
} from "./agent-policy";
import {
	SubagentQueryParameters,
	SubagentStartParameters,
	SubagentSteerParameters,
	SubagentWaitParameters,
} from "./contracts";
import { SubagentCoordinator } from "./coordinator";
import type { JournalRecord, LogicalSession, OwnerIdentity } from "./domain";
import { readPrompt } from "./entry-config";
import subagents from "./index";
import type { InvocationAcceptance } from "./invocation-contracts";
import { InvocationSupervisor } from "./invocation-supervisor";
import type { ManagementScreen } from "./management-screen/screen";
import { SessionStore, SUBAGENT_JOURNAL_CUSTOM_TYPE } from "./persistence";
import { projectionStableKey } from "./projection";
import { RuntimeFailureRecoveryTracker } from "./runtime-recovery-tracker";
import { SessionCatalog } from "./session-catalog";
import { SessionSnapshotLoader } from "./session-snapshot-loader";
import { createToolPresentationRegistry } from "./tool-rendering";

const SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";
const DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const TOOL_PATTERNS_ENV = "PI_SUBAGENT_TOOL_PATTERNS";
const AGENT_ID_ENV = "PI_SUBAGENT_AGENT_ID";
const TEST_INVOCATION_METADATA = {
	startedAtMs: 1_700_000_000_000,
	elapsedMs: 1_000,
	modelId: "openai/test-model",
	contextWindow: 128_000,
} as const;
const TEST_MODEL: Model<Api> = {
	id: "test-model",
	name: "Test model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: true,
	thinkingLevelMap: { xhigh: "xhigh", max: "max" },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4_096,
};

interface RegisteredToolLike {
	readonly name: string;
	readonly description: string;
	readonly parameters: unknown;
	readonly renderCall?: ToolDefinition["renderCall"];
	readonly renderResult?: ToolDefinition["renderResult"];
	execute(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>>;
}

/** Captures one command registration for deterministic handler invocation. */
interface RegisteredCommandLike {
	readonly name: string;
	readonly handler: (
		args: string,
		ctx: ExtensionContext,
	) => Promise<void> | void;
}

/** Captures one shortcut registration for deterministic handler invocation. */
interface RegisteredShortcutLike {
	readonly shortcut: string;
	readonly handler: (ctx: ExtensionContext) => Promise<void> | void;
}

/** Builds the narrow public extension API surface needed by entry tests. */
function createPiFake(): ExtensionAPI & {
	readonly appendedEntries: unknown[];
	readonly commands: RegisteredCommandLike[];
	readonly messageRenderers: Array<{
		readonly customType: string;
		readonly renderer: (...args: unknown[]) => unknown;
	}>;
	readonly sentMessages: unknown[];
	readonly shortcuts: RegisteredShortcutLike[];
	readonly tools: RegisteredToolLike[];
	emit(eventName: string, event: unknown, ctx: unknown): Promise<unknown[]>;
} {
	const appendedEntries: unknown[] = [];
	const commands: RegisteredCommandLike[] = [];
	const messageRenderers: Array<{
		readonly customType: string;
		readonly renderer: (...args: unknown[]) => unknown;
	}> = [];
	const sentMessages: unknown[] = [];
	const shortcuts: RegisteredShortcutLike[] = [];
	const tools: RegisteredToolLike[] = [];
	const events = createEventBus();
	const handlers = new Map<
		string,
		Array<(event: unknown, ctx: unknown) => unknown>
	>();
	const pi = {
		appendedEntries,
		commands,
		messageRenderers,
		sentMessages,
		shortcuts,
		tools,
		events,
		emit: async (eventName: string, event: unknown, ctx: unknown) => {
			const results: unknown[] = [];
			for (const handler of handlers.get(eventName) ?? []) {
				results.push(await handler(event, ctx));
			}
			return results;
		},
		on: (
			eventName: string,
			handler: (event: unknown, ctx: unknown) => unknown,
		) => {
			const existing = handlers.get(eventName) ?? [];
			existing.push(handler);
			handlers.set(eventName, existing);
		},
		registerTool: (tool: RegisteredToolLike) => tools.push(tool),
		registerMessageRenderer: (
			customType: string,
			renderer: (...args: unknown[]) => unknown,
		) => messageRenderers.push({ customType, renderer }),
		registerCommand: (
			name: string,
			options: Omit<RegisteredCommandLike, "name">,
		) => commands.push({ name, ...options }),
		registerShortcut: (
			shortcut: string,
			options: Omit<RegisteredShortcutLike, "shortcut">,
		) => shortcuts.push({ shortcut, ...options }),
		appendEntry: (...args: unknown[]) => {
			appendedEntries.push(args);
		},
		sendMessage: (...args: unknown[]) => {
			sentMessages.push(args);
		},
		getActiveTools: () => tools.map((tool) => tool.name),
		getAllTools: () =>
			tools.map((tool) => ({
				name: tool.name,
				description: "test tool",
				parameters: tool.parameters,
				sourceInfo: { source: "test", path: "test" },
			})),
		setActiveTools: () => undefined,
		getThinkingLevel: () => "medium",
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }),
		},
	};
	return pi as unknown as ExtensionAPI & {
		readonly appendedEntries: unknown[];
		readonly commands: RegisteredCommandLike[];
		readonly messageRenderers: Array<{
			readonly customType: string;
			readonly renderer: (...args: unknown[]) => unknown;
		}>;
		readonly sentMessages: unknown[];
		readonly shortcuts: RegisteredShortcutLike[];
		readonly tools: RegisteredToolLike[];
		emit(eventName: string, event: unknown, ctx: unknown): Promise<unknown[]>;
	};
}

/** Creates one non-interactive tool context with a direct owner identity. */
function createContext(
	directory: string,
	entries: readonly unknown[] = [],
	options: {
		readonly authenticated?: boolean;
		readonly custom?: (...args: unknown[]) => Promise<unknown>;
		readonly mode?: ExtensionContext["mode"];
		readonly model?: Model<Api>;
		readonly onAuthRequest?: () => void;
		readonly setWidget?: (...args: unknown[]) => void;
	} = {},
): ExtensionContext {
	return {
		cwd: directory,
		mode: options.mode ?? "rpc",
		hasUI: options.mode === "tui",
		model: options.model,
		ui: {
			custom: options.custom ?? (async () => undefined),
			getToolsExpanded: () => false,
			notify: () => undefined,
			setStatus: () => undefined,
			setWidget: options.setWidget ?? (() => undefined),
		},
		modelRegistry: {
			find: () => options.model,
			hasConfiguredAuth: () => options.model !== undefined,
			getApiKeyAndHeaders: async () => {
				options.onAuthRequest?.();
				return options.authenticated === true
					? { ok: true as const, apiKey: "test-key" }
					: { ok: false as const, error: "missing" };
			},
		},
		sessionManager: {
			getSessionId: () => "owner-pi",
			getSessionFile: () => join(directory, "owner.jsonl"),
			getEntries: () => entries,
			getBranch: () => entries,
		},
	} as unknown as ExtensionContext;
}

/** Finds one registered tool without relying on registration order. */
function getTool(
	pi: ReturnType<typeof createPiFake>,
	name: string,
): RegisteredToolLike {
	const tool = pi.tools.find((candidate) => candidate.name === name);
	if (tool === undefined) {
		throw new Error(`tool ${name} was not registered`);
	}
	return tool;
}

let suiteDir = "";
let previousSuiteDir: string | undefined;
let previousDepth: string | undefined;
let previousToolPatterns: string | undefined;
let previousAgentId: string | undefined;

beforeEach(() => {
	// The suite directory isolates config and agent discovery without modifying HOME.
	suiteDir = mkdtempSync(join(tmpdir(), "subagents-entry-"));
	mkdirSync(join(suiteDir, "agent-selection", "agents"), { recursive: true });
	previousSuiteDir = process.env[SUITE_DIR_ENV];
	previousDepth = process.env[DEPTH_ENV];
	previousToolPatterns = process.env[TOOL_PATTERNS_ENV];
	previousAgentId = process.env[AGENT_ID_ENV];
	process.env[SUITE_DIR_ENV] = suiteDir;
	delete process.env[DEPTH_ENV];
	delete process.env[TOOL_PATTERNS_ENV];
	delete process.env[AGENT_ID_ENV];
});

afterEach(() => {
	// Environment restoration keeps entry tests independent from the invoking Pi runtime.
	restoreEnvironment(SUITE_DIR_ENV, previousSuiteDir);
	restoreEnvironment(DEPTH_ENV, previousDepth);
	restoreEnvironment(TOOL_PATTERNS_ENV, previousToolPatterns);
	restoreEnvironment(AGENT_ID_ENV, previousAgentId);
	rmSync(suiteDir, { recursive: true, force: true });
});

describe("subagents entry", () => {
	test("rejects invalid shared child startup configuration during extension loading", async () => {
		// Purpose: child launchers must fail before tool use when their shared recovery policy is invalid.
		// Input and expected output: an unsupported child-startup key rejects the extension factory.
		// Edge case: the ordinary subagents configuration and agent catalog remain valid.
		// Dependencies: the production extension entry and an isolated suite configuration file.
		const childStartupDirectory = join(suiteDir, "child-startup");
		mkdirSync(childStartupDirectory, { recursive: true });
		writeFileSync(
			join(childStartupDirectory, "config.json"),
			JSON.stringify({ unsupported: true }),
			"utf8",
		);

		await expect(subagents(createPiFake())).rejects.toThrow(
			"configuration contains unsupported keys",
		);
	});

	test("rejects structurally invalid subagent requests", async () => {
		// Purpose: structural request violations must fail before semantic agent checks.
		// Input and expected output: whitespace-only subagent_start.prompt fails with invalid_request and no normal outcome.
		// Edge case: the requested agent is also unavailable, but structural precedence still wins.
		// Dependencies: registered production entry tool and isolated config/agent state.
		const pi = createPiFake();
		await subagents(pi);
		let result: AgentToolResult<unknown> | undefined;
		try {
			result = await getTool(pi, "subagent_start").execute(
				"start-1",
				{
					agentId: "MissingAgent",
					taskName: "Trace runtime",
					prompt: " \n\t ",
				},
				undefined,
				undefined,
				createContext(suiteDir),
			);
		} catch (error) {
			result = {
				content: [],
				details: readFailureDetails(error),
			};
		}

		expect({ details: result?.details, outcome: readOutcome(result) }).toEqual({
			details: {
				code: "invalid_request",
				message: "subagent_start request fields are invalid",
			},
			outcome: undefined,
		});
	});

	test("queries a worker-owned branch while invoking the model only in the worker", async () => {
		// Purpose: a worker caller must retrieve saved branch data through process IPC and execute the auxiliary model locally.
		// Input and expected output: one query_branch response produces answer-only tool content from the worker completion fake.
		// Edge case: the IPC payload contains the session ID but excludes the question, model, credentials, prompt, answer, usage, and cost.
		// Dependencies: production worker bridge, process IPC fake, and caller-local completion fake.
		const previousRuntimeLease = process.env[SUBAGENT_RUNTIME_LEASE_ENV];
		const previousOwnerSession = process.env[SUBAGENT_OWNER_SESSION_ENV];
		const previousSend = process.send;
		const previousConnectedDescriptor = Object.getOwnPropertyDescriptor(
			process,
			"connected",
		);
		const initialMessageListeners = process.listeners("message");
		const ipcMessages: unknown[] = [];
		const modelContexts: Context[] = [];
		const pi = createPiFake();
		const ctx = createContext(suiteDir, [], {
			authenticated: true,
			model: TEST_MODEL,
		});
		process.env[SUBAGENT_RUNTIME_LEASE_ENV] = "worker-query-lease";
		process.env[SUBAGENT_OWNER_SESSION_ENV] = "owner-pi";
		Object.defineProperty(process, "connected", {
			configurable: true,
			enumerable: true,
			value: true,
			writable: true,
		});
		Reflect.set(
			process,
			"send",
			(message: unknown, callback?: (error: Error | null) => void): boolean => {
				ipcMessages.push(message);
				callback?.(null);
				return true;
			},
		);

		try {
			await subagents(pi, {
				completeSimple: async (_model, context) => {
					modelContexts.push(context);
					return {
						role: "assistant",
						content: [{ type: "text", text: "worker answer" }],
						api: TEST_MODEL.api,
						provider: TEST_MODEL.provider,
						model: TEST_MODEL.id,
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						},
						stopReason: "stop",
						timestamp: 1,
					};
				},
			});
			await pi.emit("session_start", { type: "session_start" }, ctx);
			expect(getKnowledgeHierarchyClient(pi)).toBeDefined();
			const pending = getTool(pi, "subagent_query").execute(
				"worker-query",
				{ sessionId: 4, question: "What happened?" },
				undefined,
				undefined,
				ctx,
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
			const requestMessage = ipcMessages.find(
				(value) =>
					typeof value === "object" &&
					value !== null &&
					Reflect.get(value, "kind") === "subagents-request" &&
					Reflect.get(Reflect.get(value, "request"), "operation") ===
						"query_branch",
			);
			if (typeof requestMessage !== "object" || requestMessage === null) {
				throw new Error("worker query did not send a branch request");
			}
			const request = Reflect.get(requestMessage, "request");
			process.emit("message", {
				kind: "subagents-response",
				source: "root",
				runtimeLeaseId: "worker-query-lease",
				requestId: Reflect.get(request, "requestId"),
				succeeded: true,
				result: {
					kind: "ok",
					branch: [
						{
							type: "message",
							id: "worker-entry",
							parentId: null,
							timestamp: "2026-07-29T00:00:00.000Z",
							message: {
								role: "user",
								content: "worker saved context",
								timestamp: 1,
							},
						},
					],
				},
			});
			const result = await pending;

			expect(result.content).toEqual([{ type: "text", text: "worker answer" }]);
			expect(Reflect.get(request, "payload")).toEqual({ sessionId: 4 });
			expect(JSON.stringify(modelContexts[0]?.messages)).toContain(
				"worker saved context",
			);
			expect(modelContexts[0]?.messages.at(-1)).toMatchObject({
				role: "user",
				content: "<question>\nWhat happened?\n</question>",
			});
		} finally {
			for (const listener of process.listeners("message")) {
				if (!initialMessageListeners.includes(listener)) {
					process.removeListener("message", listener);
				}
			}
			Reflect.set(process, "send", previousSend);
			if (previousConnectedDescriptor !== undefined) {
				Object.defineProperty(
					process,
					"connected",
					previousConnectedDescriptor,
				);
			}
			restoreEnvironment(SUBAGENT_RUNTIME_LEASE_ENV, previousRuntimeLease);
			restoreEnvironment(SUBAGENT_OWNER_SESSION_ENV, previousOwnerSession);
		}
	});

	test("rejects malformed worker persistence commands before writes", async () => {
		// Purpose: append_journal and append_history must validate complete nested payloads before active-writer access.
		// Input and expected output: extra record and feedback keys receive no worker response and produce zero Pi persistence calls.
		// Edge case: both root commands have exact outer IPC envelopes and target the active worker lease and owner.
		// Dependencies: production worker bridge, worker command handler, journal and feedback parsers, and active Pi writer.
		// Arrange.
		const previousRuntimeLease = process.env[SUBAGENT_RUNTIME_LEASE_ENV];
		const previousOwnerSession = process.env[SUBAGENT_OWNER_SESSION_ENV];
		const previousSend = process.send;
		const previousConnectedDescriptor = Object.getOwnPropertyDescriptor(
			process,
			"connected",
		);
		const initialMessageListeners = process.listeners("message");
		const ipcMessages: unknown[] = [];
		const pi = createPiFake();
		const ctx = createContext(suiteDir);
		const session = {
			key: { ownerPiSessionId: "owner-pi", ownerLocalSessionId: 1 },
			childPiSessionId: "child-pi",
			childSessionDir: suiteDir,
			childSessionFile: join(suiteDir, "child.jsonl"),
			agentId: "SubAgentCoder",
			taskName: "Trace worker command",
			creationOrder: 1,
			invocationId: "invocation-1",
			runtimeLeaseId: "child-lease",
			invocationMetadata: TEST_INVOCATION_METADATA,
			state: "active",
		} satisfies LogicalSession;
		const feedback = {
			feedbackId: "feedback-1",
			invocationId: session.invocationId,
			sessionKey: session.key,
			status: "success",
			output: "done",
		};
		process.env[SUBAGENT_RUNTIME_LEASE_ENV] = "worker-lease";
		process.env[SUBAGENT_OWNER_SESSION_ENV] = "owner-pi";
		Object.defineProperty(process, "connected", {
			configurable: true,
			enumerable: true,
			value: true,
			writable: true,
		});
		Reflect.set(
			process,
			"send",
			(message: unknown, callback?: (error: Error | null) => void): boolean => {
				ipcMessages.push(message);
				callback?.(null);
				return true;
			},
		);

		// Act.
		try {
			await subagents(pi);
			await pi.emit("session_start", { type: "session_start" }, ctx);
			for (const request of [
				{
					requestId: "append-journal",
					operation: "append_journal",
					payload: {
						kind: "session-accepted",
						session,
						extra: true,
					},
				},
				{
					requestId: "append-history",
					operation: "append_history",
					payload: { ...feedback, extra: true },
				},
			] as const) {
				process.emit("message", {
					kind: "subagents-request",
					source: "root",
					request: {
						requestId: request.requestId,
						runtimeLeaseId: "worker-lease",
						ownerPiSessionId: "owner-pi",
						operation: request.operation,
						payload: request.payload,
					},
				});
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			for (const listener of process.listeners("message")) {
				if (!initialMessageListeners.includes(listener)) {
					process.removeListener("message", listener);
				}
			}
			Reflect.set(process, "send", previousSend);
			if (previousConnectedDescriptor !== undefined) {
				Object.defineProperty(
					process,
					"connected",
					previousConnectedDescriptor,
				);
			}
			restoreEnvironment(SUBAGENT_RUNTIME_LEASE_ENV, previousRuntimeLease);
			restoreEnvironment(SUBAGENT_OWNER_SESSION_ENV, previousOwnerSession);
		}

		// Assert.
		const responses = ipcMessages
			.filter(
				(value): value is object =>
					typeof value === "object" &&
					value !== null &&
					Reflect.get(value, "kind") === "subagents-response",
			)
			.map((value) => ({
				requestId: Reflect.get(value, "requestId"),
				succeeded: Reflect.get(value, "succeeded"),
			}))
			.sort((left, right) =>
				String(left.requestId).localeCompare(String(right.requestId)),
			);
		expect({
			responses,
			journalWrites: pi.appendedEntries.length,
			historyWrites: pi.sentMessages.length,
		}).toEqual({
			responses: [],
			journalWrites: 0,
			historyWrites: 0,
		});
	});

	test("cancels registered nested waits through one correlated bridge request", async () => {
		// Purpose: Pi abort in a worker must cancel the root wait through the existing bridge before the nested tool rejects.
		// Input and expected output: abort emits one exact cancel_wait request; root responses clear both correlations and the tool rejects with the original Pi reason.
		// Edge case: the cancellation request targets the original request ID and tool call while using its own bridge correlation.
		// Dependencies: registered production worker tool, AbortController, process IPC fake, and exact runtime response parsing.
		const previousRuntimeLease = process.env[SUBAGENT_RUNTIME_LEASE_ENV];
		const previousOwnerSession = process.env[SUBAGENT_OWNER_SESSION_ENV];
		const previousSend = process.send;
		const previousConnectedDescriptor = Object.getOwnPropertyDescriptor(
			process,
			"connected",
		);
		const initialMessageListeners = process.listeners("message");
		const ipcMessages: unknown[] = [];
		const pi = createPiFake();
		const ctx = createContext(suiteDir);
		process.env[SUBAGENT_RUNTIME_LEASE_ENV] = "nested-abort-lease";
		process.env[SUBAGENT_OWNER_SESSION_ENV] = "owner-pi";
		Object.defineProperty(process, "connected", {
			configurable: true,
			enumerable: true,
			value: true,
			writable: true,
		});
		Reflect.set(
			process,
			"send",
			(message: unknown, callback?: (error: Error | null) => void): boolean => {
				ipcMessages.push(message);
				callback?.(null);
				return true;
			},
		);

		try {
			await subagents(pi);
			await pi.emit("session_start", { type: "session_start" }, ctx);
			const controller = new AbortController();
			const reason = new Error("cancel nested wait");
			const pending = getTool(pi, "subagent_wait")
				.execute(
					"nested-abort-tool",
					{ sessionIds: [1], timeout: 3600 },
					controller.signal,
					undefined,
					ctx,
				)
				.then(() => "normal")
				.catch((error: unknown) => error);
			await new Promise((resolve) => setTimeout(resolve, 0));
			const originalEnvelope = ipcMessages.find((message) => {
				const request =
					typeof message === "object" && message !== null
						? Reflect.get(message, "request")
						: undefined;
				return (
					typeof request === "object" &&
					request !== null &&
					Reflect.get(request, "operation") === "agent_operation"
				);
			});
			const originalRequest =
				typeof originalEnvelope === "object" && originalEnvelope !== null
					? Reflect.get(originalEnvelope, "request")
					: undefined;
			const originalRequestId =
				typeof originalRequest === "object" && originalRequest !== null
					? Reflect.get(originalRequest, "requestId")
					: undefined;
			if (typeof originalRequestId !== "string") {
				throw new Error("nested wait request correlation was not emitted");
			}

			controller.abort(reason);
			await new Promise((resolve) => setTimeout(resolve, 0));
			const cancelEnvelopes = ipcMessages.filter((message) => {
				const request =
					typeof message === "object" && message !== null
						? Reflect.get(message, "request")
						: undefined;
				return (
					typeof request === "object" &&
					request !== null &&
					Reflect.get(request, "operation") === "cancel_wait"
				);
			});
			const cancelEnvelope = cancelEnvelopes[0];
			const cancelRequest =
				typeof cancelEnvelope === "object" && cancelEnvelope !== null
					? Reflect.get(cancelEnvelope, "request")
					: undefined;
			const cancelRequestId =
				typeof cancelRequest === "object" && cancelRequest !== null
					? Reflect.get(cancelRequest, "requestId")
					: undefined;

			process.emit("message", {
				kind: "subagents-response",
				source: "root",
				runtimeLeaseId: "nested-abort-lease",
				requestId: originalRequestId,
				succeeded: false,
				error: "nested wait cancelled",
			});
			if (typeof cancelRequestId === "string") {
				process.emit("message", {
					kind: "subagents-response",
					source: "root",
					runtimeLeaseId: "nested-abort-lease",
					requestId: cancelRequestId,
					succeeded: true,
					result: { acknowledged: true },
				});
			}
			const outcome = await pending;
			await new Promise((resolve) => setTimeout(resolve, 0));
			const settledRequestIds = ipcMessages.flatMap((message) => {
				if (
					typeof message !== "object" ||
					message === null ||
					Reflect.get(message, "kind") !== "subagents-settled"
				) {
					return [];
				}
				return [Reflect.get(message, "requestId")];
			});

			expect({
				cancelCount: cancelEnvelopes.length,
				cancelPayload:
					typeof cancelRequest === "object" && cancelRequest !== null
						? Reflect.get(cancelRequest, "payload")
						: undefined,
				originalReason: outcome === reason,
				settlementCount: settledRequestIds.length,
				originalSettled: settledRequestIds.includes(originalRequestId),
				cancellationSettled:
					typeof cancelRequestId === "string" &&
					settledRequestIds.includes(cancelRequestId),
			}).toEqual({
				cancelCount: 1,
				cancelPayload: {
					waitRequestId: originalRequestId,
					waitToolCallId: "nested-abort-tool",
				},
				originalReason: true,
				settlementCount: 2,
				originalSettled: true,
				cancellationSettled: true,
			});
		} finally {
			for (const listener of process.listeners("message")) {
				if (!initialMessageListeners.includes(listener)) {
					process.removeListener("message", listener);
				}
			}
			Reflect.set(process, "send", previousSend);
			if (previousConnectedDescriptor !== undefined) {
				Object.defineProperty(
					process,
					"connected",
					previousConnectedDescriptor,
				);
			}
			restoreEnvironment(SUBAGENT_RUNTIME_LEASE_ENV, previousRuntimeLease);
			restoreEnvironment(SUBAGENT_OWNER_SESSION_ENV, previousOwnerSession);
		}
	});

	test("forwards nested start and steer cancellation through exact bridge correlations", async () => {
		// Purpose: nested cancellation must distinguish cancellation-winning work from an already dispatched active steer.
		// Input and expected output: start cancellation propagates its local reason, while dispatched steer awaits and returns the root acceptance.
		// Edge case: both outcomes settle the original and cancellation correlations exactly once.
		// Dependencies: registered production worker tools, process IPC fake, AbortController, and runtime wire parsing.
		const previousRuntimeLease = process.env[SUBAGENT_RUNTIME_LEASE_ENV];
		const previousOwnerSession = process.env[SUBAGENT_OWNER_SESSION_ENV];
		const previousSend = process.send;
		const previousConnectedDescriptor = Object.getOwnPropertyDescriptor(
			process,
			"connected",
		);
		const initialMessageListeners = process.listeners("message");
		const ipcMessages: unknown[] = [];
		process.env[SUBAGENT_RUNTIME_LEASE_ENV] = "nested-operation-lease";
		process.env[SUBAGENT_OWNER_SESSION_ENV] = "owner-pi";
		Object.defineProperty(process, "connected", {
			configurable: true,
			enumerable: true,
			value: true,
			writable: true,
		});
		Reflect.set(
			process,
			"send",
			(message: unknown, callback?: (error: Error | null) => void): boolean => {
				ipcMessages.push(message);
				callback?.(null);
				return true;
			},
		);
		const pi = createPiFake();
		const ctx = createContext(suiteDir);
		const scenarios = [
			{
				toolName: "subagent_start",
				params: {
					agentId: "SubAgentCoder",
					taskName: "Cancel nested start",
					prompt: "work",
				},
				cancellationWon: true,
				rootResult: {
					kind: "failed",
					failure: {
						code: "start_failed",
						message: "root operation cancelled",
					},
				},
			},
			{
				toolName: "subagent_steer",
				params: { sessionId: 1, prompt: "apply once" },
				cancellationWon: false,
				rootResult: {
					kind: "ok",
					result: { outcome: "accepted", sessionId: 1 },
				},
			},
		] as const;

		try {
			await subagents(pi);
			await pi.emit("session_start", { type: "session_start" }, ctx);
			const observations: Array<{
				readonly toolName: string;
				readonly cancelCount: number;
				readonly exactPayload: boolean;
				readonly originalReason: boolean;
				readonly accepted: boolean;
				readonly settlementCount: number;
			}> = [];
			for (const [index, scenario] of scenarios.entries()) {
				const messageStart = ipcMessages.length;
				const toolCallId = `nested-operation-${index}`;
				const controller = new AbortController();
				const reason = new Error(`cancel ${scenario.toolName}`);
				const pending = getTool(pi, scenario.toolName)
					.execute(
						toolCallId,
						scenario.params,
						controller.signal,
						undefined,
						ctx,
					)
					.catch((error: unknown) => error);
				await new Promise((resolve) => setTimeout(resolve, 0));
				const operationEnvelope = ipcMessages
					.slice(messageStart)
					.find((message) => {
						const request =
							typeof message === "object" && message !== null
								? Reflect.get(message, "request")
								: undefined;
						return (
							typeof request === "object" &&
							request !== null &&
							Reflect.get(request, "operation") === "agent_operation"
						);
					});
				const operationRequest =
					typeof operationEnvelope === "object" && operationEnvelope !== null
						? Reflect.get(operationEnvelope, "request")
						: undefined;
				const operationRequestId =
					typeof operationRequest === "object" && operationRequest !== null
						? Reflect.get(operationRequest, "requestId")
						: undefined;
				if (typeof operationRequestId !== "string") {
					throw new Error("nested operation correlation was not emitted");
				}

				controller.abort(reason);
				await new Promise((resolve) => setTimeout(resolve, 0));
				const cancellationEnvelopes = ipcMessages
					.slice(messageStart)
					.filter((message) => {
						const request =
							typeof message === "object" && message !== null
								? Reflect.get(message, "request")
								: undefined;
						return (
							typeof request === "object" &&
							request !== null &&
							Reflect.get(request, "operation") === "cancel_operation"
						);
					});
				const cancellationEnvelope = cancellationEnvelopes[0];
				const cancellationRequest =
					typeof cancellationEnvelope === "object" &&
					cancellationEnvelope !== null
						? Reflect.get(cancellationEnvelope, "request")
						: undefined;
				const cancellationRequestId =
					typeof cancellationRequest === "object" &&
					cancellationRequest !== null
						? Reflect.get(cancellationRequest, "requestId")
						: undefined;
				if (typeof cancellationRequestId === "string") {
					process.emit("message", {
						kind: "subagents-response",
						source: "root",
						runtimeLeaseId: "nested-operation-lease",
						requestId: cancellationRequestId,
						succeeded: true,
						result: {
							acknowledged: true,
							cancellationWon: scenario.cancellationWon,
						},
					});
				}
				process.emit("message", {
					kind: "subagents-response",
					source: "root",
					runtimeLeaseId: "nested-operation-lease",
					requestId: operationRequestId,
					succeeded: true,
					result: scenario.rootResult,
				});
				const outcome = await pending;
				await new Promise((resolve) => setTimeout(resolve, 0));
				const settledRequestIds = ipcMessages
					.slice(messageStart)
					.flatMap((message) =>
						typeof message === "object" &&
						message !== null &&
						Reflect.get(message, "kind") === "subagents-settled"
							? [Reflect.get(message, "requestId")]
							: [],
					);
				const payload =
					typeof cancellationRequest === "object" &&
					cancellationRequest !== null
						? Reflect.get(cancellationRequest, "payload")
						: undefined;
				observations.push({
					toolName: scenario.toolName,
					cancelCount: cancellationEnvelopes.length,
					exactPayload:
						typeof payload === "object" &&
						payload !== null &&
						Reflect.get(payload, "operationRequestId") === operationRequestId &&
						Reflect.get(payload, "operationToolCallId") === toolCallId,
					originalReason: outcome === reason,
					accepted:
						typeof outcome === "object" &&
						outcome !== null &&
						typeof Reflect.get(outcome, "details") === "object" &&
						Reflect.get(Reflect.get(outcome, "details"), "outcome") ===
							"accepted",
					settlementCount: settledRequestIds.length,
				});
			}

			expect(observations).toEqual([
				{
					toolName: "subagent_start",
					cancelCount: 1,
					exactPayload: true,
					originalReason: true,
					accepted: false,
					settlementCount: 2,
				},
				{
					toolName: "subagent_steer",
					cancelCount: 1,
					exactPayload: true,
					originalReason: false,
					accepted: true,
					settlementCount: 2,
				},
			]);
		} finally {
			for (const listener of process.listeners("message")) {
				if (!initialMessageListeners.includes(listener)) {
					process.removeListener("message", listener);
				}
			}
			Reflect.set(process, "send", previousSend);
			if (previousConnectedDescriptor !== undefined) {
				Object.defineProperty(
					process,
					"connected",
					previousConnectedDescriptor,
				);
			}
			restoreEnvironment(SUBAGENT_RUNTIME_LEASE_ENV, previousRuntimeLease);
			restoreEnvironment(SUBAGENT_OWNER_SESSION_ENV, previousOwnerSession);
		}
	});

	test("registers the permitted subagent tools and one semantic feedback renderer", async () => {
		// Purpose: normal rendering and management replay must use the exact approved subagent tool and feedback renderer references.
		// Input and expected output: start, steer, wait, query, and one subagents-feedback renderer register once; management resolves the same tool renderer functions.
		// Edge case: static management presentation remains available before any session starts.
		// Dependencies: production entry registration and shared event-bus presentation registry.
		const pi = createPiFake();
		await subagents(pi);
		const registry = createToolPresentationRegistry("/tmp", pi.events);

		expect({
			tools: pi.tools.map((tool) => tool.name).sort(),
			messageRenderers: pi.messageRenderers.map(
				(renderer) => renderer.customType,
			),
			sharedToolRenderers: pi.tools.map((tool) => {
				const resolved = registry.resolve(tool.name).definition;
				return {
					name: tool.name,
					call: resolved?.renderCall === tool.renderCall,
					result: resolved?.renderResult === tool.renderResult,
				};
			}),
		}).toEqual({
			tools: [
				"subagent_query",
				"subagent_start",
				"subagent_steer",
				"subagent_wait",
			],
			messageRenderers: ["subagents-feedback"],
			sharedToolRenderers: [
				{ name: "subagent_start", call: true, result: true },
				{ name: "subagent_steer", call: true, result: true },
				{ name: "subagent_wait", call: true, result: true },
				{ name: "subagent_query", call: true, result: true },
			],
		});
	});

	test("queries one root-owned saved child without invoking the child", async () => {
		// Purpose: a root caller must load one direct child's saved branch and run the auxiliary model in the calling Pi process.
		// Input and expected output: reconstructed ownership plus a saved child message produce answer-only tool content, elapsed presentation details, and caller cost attribution.
		// Edge case: the model receives no tools, while no invocation supervisor method is called.
		// Dependencies: public persisted SessionManager fixtures, production reconstruction, and one injected completion fake.
		const child = createPersistedSession(join(suiteDir, "query-child"), {
			id: "query-child-pi",
			text: "saved child context",
		});
		const childFile = child.getSessionFile();
		if (childFile === undefined) {
			throw new Error("query child SessionManager did not create a file");
		}
		const parent = createPersistedSession(join(suiteDir, "query-parent"), {
			id: "owner-pi",
			text: "parent context",
		});
		const session = {
			key: { ownerPiSessionId: parent.getSessionId(), ownerLocalSessionId: 1 },
			childPiSessionId: child.getSessionId(),
			childSessionDir: child.getSessionDir(),
			childSessionFile: childFile,
			agentId: "SubAgentCoder",
			taskName: "Saved query child",
			creationOrder: 1,
			invocationId: "query-invocation",
			runtimeLeaseId: "query-lease",
			invocationMetadata: TEST_INVOCATION_METADATA,
			state: "active" as const,
		};
		parent.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
			kind: "session-accepted",
			session,
		} satisfies JournalRecord);
		const calls: Array<{
			readonly context: Context;
			readonly options: SimpleStreamOptions | undefined;
		}> = [];
		const response: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "saved answer" }],
			api: TEST_MODEL.api,
			provider: TEST_MODEL.provider,
			model: TEST_MODEL.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0.2,
				},
			},
			stopReason: "stop",
			timestamp: 1,
		};
		const pi = createPiFake();
		const ctx = {
			...createContext(suiteDir, [], {
				authenticated: true,
				model: TEST_MODEL,
			}),
			sessionManager: parent,
		} as ExtensionContext;
		const startSpy = spyOn(InvocationSupervisor.prototype, "start");
		const continueSpy = spyOn(InvocationSupervisor.prototype, "continue");
		try {
			await subagents(pi, {
				completeSimple: async (_model, context, options) => {
					calls.push({ context, options });
					return response;
				},
			});
			await pi.emit("session_start", { type: "session_start" }, ctx);
			const result = await getTool(pi, "subagent_query").execute(
				"query-root",
				{ sessionId: 1, question: "What happened?" },
				undefined,
				undefined,
				ctx,
			);

			expect(result.content).toEqual([{ type: "text", text: "saved answer" }]);
			expect(result.details).toMatchObject({ answer: "saved answer" });
			const elapsedMs = Reflect.get(result.details as object, "elapsedMs");
			expect(typeof elapsedMs).toBe("number");
			expect(elapsedMs).toBeGreaterThanOrEqual(0);
			expect(JSON.stringify(calls[0]?.context.messages)).toContain(
				"saved child context",
			);
			expect(calls[0]?.context.tools).toEqual([]);
			expect(pi.appendedEntries).toContainEqual([
				"helper-api-cost",
				{ source: "subagent-query", cost: 0.2 },
			]);
			expect(startSpy).not.toHaveBeenCalled();
			expect(continueSpy).not.toHaveBeenCalled();
		} finally {
			startSpy.mockRestore();
			continueSpy.mockRestore();
			await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
		}
	});

	test("preserves unknown query diagnostics and Pi cancellation", async () => {
		// Purpose: the registered query boundary must preserve safe unknown diagnostics while leaving Pi cancellation outside failed-tool results.
		// Input and expected output: an unknown branch-load error returns query_failed with cleaned text, while a pre-aborted query rejects with the exact Pi reason.
		// Edge case: both calls use the same saved child and neither invokes the auxiliary model.
		// Dependencies: persisted root ownership, production query registration, a one-call snapshot-loader failure, and AbortController.
		const child = createPersistedSession(join(suiteDir, "query-error-child"), {
			id: "query-error-child-pi",
			text: "saved child context",
		});
		const childFile = child.getSessionFile();
		if (childFile === undefined) {
			throw new Error("query error child did not create a session file");
		}
		const parent = createPersistedSession(
			join(suiteDir, "query-error-parent"),
			{
				id: "owner-pi",
				text: "parent context",
			},
		);
		parent.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
			kind: "session-accepted",
			session: {
				key: {
					ownerPiSessionId: parent.getSessionId(),
					ownerLocalSessionId: 1,
				},
				childPiSessionId: child.getSessionId(),
				childSessionDir: child.getSessionDir(),
				childSessionFile: childFile,
				agentId: "SubAgentCoder",
				taskName: "Query error child",
				creationOrder: 1,
				invocationId: "query-error-invocation",
				runtimeLeaseId: "query-error-lease",
				invocationMetadata: TEST_INVOCATION_METADATA,
				state: "active",
			},
		} satisfies JournalRecord);
		const pi = createPiFake();
		const ctx = {
			...createContext(suiteDir, [], {
				authenticated: true,
				model: TEST_MODEL,
			}),
			sessionManager: parent,
		} as ExtensionContext;
		const snapshotLoad = spyOn(SessionSnapshotLoader.prototype, "load");
		snapshotLoad.mockImplementationOnce(async () => {
			throw new Error("query\u001b[31m failed\u001b[0m\n\u202e safely");
		});
		try {
			await subagents(pi, {
				completeSimple: async () => {
					throw new Error("query completion must not run");
				},
			});
			await pi.emit("session_start", { type: "session_start" }, ctx);
			const queryTool = getTool(pi, "subagent_query");
			const failure = await queryTool
				.execute(
					"query-failure",
					{ sessionId: 1, question: "What failed?" },
					undefined,
					undefined,
					ctx,
				)
				.then(
					() => undefined,
					(error: unknown) => readFailureDetails(error),
				);

			const controller = new AbortController();
			const cancellationReason = new Error("cancel registered query");
			controller.abort(cancellationReason);
			const cancellation = queryTool.execute(
				"query-cancelled",
				{ sessionId: 1, question: "Do not answer" },
				controller.signal,
				undefined,
				ctx,
			);

			expect(failure).toEqual({
				code: "query_failed",
				message: "query failed safely",
			});
			await expect(cancellation).rejects.toBe(cancellationReason);
		} finally {
			snapshotLoad.mockRestore();
			await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
		}
	});

	test("keeps accepted presentation evidence out of model-visible tool JSON", async () => {
		// Purpose: accepted root execution must persist replayable presentation details without changing the model result contract.
		// Input and expected output: one accepted start returns exact public JSON plus agent, task, model, and thinking in non-model-visible details.
		// Edge case: presentation evidence does not create an extra durable journal record.
		// Dependencies: production root registration, coordinator publication, and controlled invocation acceptance.
		writeFileSync(
			join(suiteDir, "agent-selection", "agents", "Allowed.md"),
			[
				"---",
				"description: Allowed",
				"type: subagent",
				"---",
				"Allowed prompt",
			].join("\n"),
		);
		const pi = createPiFake();
		const ctx = createContext(suiteDir, [], { model: TEST_MODEL });
		await subagents(pi);
		getAgentRuntimeComposition(pi).setMainAgentContribution({
			prompt: "Main prompt",
			tools: ["subagent_start", "subagent_steer", "subagent_wait"],
			agent: {
				id: "Main",
				tools: ["subagent_start", "subagent_steer", "subagent_wait"],
				agents: ["Allowed"],
			},
		});
		await pi.emit("session_start", { type: "session_start" }, ctx);
		const acceptance = {
			invocationId: "invocation-accepted",
			runtimeLeaseId: "lease-accepted",
			childPiSessionId: "child-accepted",
			childSessionDir: suiteDir,
			childSessionFile: join(suiteDir, "child.jsonl"),
			modelId: "openai/test-model",
			thinking: "high",
			contextWindow: 128_000,
		} as unknown as InvocationAcceptance;
		const startSpy = spyOn(
			InvocationSupervisor.prototype,
			"start",
		).mockResolvedValue(acceptance);
		try {
			const result = await getTool(pi, "subagent_start").execute(
				"accepted-start",
				{
					agentId: "Allowed",
					taskName: "Trace accepted evidence",
					prompt: "Inspect presentation evidence",
				},
				undefined,
				undefined,
				ctx,
			);

			expect({
				content: result.content,
				details: result.details,
				journalKinds: pi.appendedEntries.map((entry) => {
					const record = Array.isArray(entry) ? entry[1] : undefined;
					return typeof record === "object" && record !== null
						? Reflect.get(record, "kind")
						: undefined;
				}),
			}).toEqual({
				content: [
					{
						type: "text",
						text: '{"outcome":"accepted","sessionId":1}',
					},
				],
				details: {
					outcome: "accepted",
					sessionId: 1,
					presentationKind: "accepted",
					agentId: "Allowed",
					taskName: "Trace accepted evidence",
					modelId: "openai/test-model",
					thinking: "high",
				},
				journalKinds: ["session-accepted"],
			});
		} finally {
			startSpy.mockRestore();
		}
	});

	test("applies independent descriptions without leaking between runtimes", async () => {
		// Purpose: every subagent tool must resolve its configured description independently while omitted tools retain bundled text.
		// Input and expected output: one, two, and three absolute prompt files customize only their matching tools; a fresh default runtime restores all bundled descriptions.
		// Edge case: sequential extension instances share the process but must not share mutable registration state.
		// Dependencies: production entry registration, suite-owned config, and isolated prompt files.
		const configDir = join(suiteDir, "run-subagent");
		mkdirSync(configDir, { recursive: true });
		const promptFiles = {
			startDescriptionPromptFile: join(suiteDir, "start-custom.md"),
			steerDescriptionPromptFile: join(suiteDir, "steer-custom.md"),
			waitDescriptionPromptFile: join(suiteDir, "wait-custom.md"),
		};
		writeFileSync(promptFiles.startDescriptionPromptFile, " custom start ");
		writeFileSync(promptFiles.steerDescriptionPromptFile, " custom steer ");
		writeFileSync(promptFiles.waitDescriptionPromptFile, " custom wait ");
		const defaults = {
			start: readPrompt("start-description.md"),
			steer: readPrompt("steer-description.md"),
			wait: readPrompt("wait-description.md"),
		};
		const cases = [
			{
				config: {
					startDescriptionPromptFile: promptFiles.startDescriptionPromptFile,
				},
				expected: {
					start: "custom start",
					steer: defaults.steer,
					wait: defaults.wait,
				},
			},
			{
				config: {
					startDescriptionPromptFile: promptFiles.startDescriptionPromptFile,
					steerDescriptionPromptFile: promptFiles.steerDescriptionPromptFile,
				},
				expected: {
					start: "custom start",
					steer: "custom steer",
					wait: defaults.wait,
				},
			},
			{
				config: promptFiles,
				expected: {
					start: "custom start",
					steer: "custom steer",
					wait: "custom wait",
				},
			},
		] as const;

		for (const configCase of cases) {
			writeFileSync(
				join(configDir, "config.json"),
				JSON.stringify(configCase.config),
			);
			const pi = createPiFake();
			await subagents(pi);
			expect({
				start: getTool(pi, "subagent_start").description,
				steer: getTool(pi, "subagent_steer").description,
				wait: getTool(pi, "subagent_wait").description,
			}).toEqual(configCase.expected);
		}

		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify({ enabled: true }),
		);
		const defaultPi = createPiFake();
		await subagents(defaultPi);
		expect({
			start: getTool(defaultPi, "subagent_start").description,
			steer: getTool(defaultPi, "subagent_steer").description,
			wait: getTool(defaultPi, "subagent_wait").description,
		}).toEqual(defaults);
	});

	test("registers stable subagent tools before asynchronous runtime initialization", async () => {
		// Purpose: agent-core must snapshot all subagent extension tools before asynchronous configuration and session runtime initialization.
		// Input and expected output: a gated config read still exposes each tool once; repeated session and tree events do not register again.
		// Edge case: execution callbacks remain the same registrations while root runtime state is replaced by a later session_start.
		// Dependencies: production extension initialization, gated config reader, and public lifecycle handlers.
		const configDir = join(suiteDir, "run-subagent");
		mkdirSync(configDir, { recursive: true });
		const descriptionFiles = {
			startDescriptionPromptFile: join(suiteDir, "snapshot-start.md"),
			steerDescriptionPromptFile: join(suiteDir, "snapshot-steer.md"),
			waitDescriptionPromptFile: join(suiteDir, "snapshot-wait.md"),
		};
		writeFileSync(
			descriptionFiles.startDescriptionPromptFile,
			"snapshot start",
		);
		writeFileSync(
			descriptionFiles.steerDescriptionPromptFile,
			"snapshot steer",
		);
		writeFileSync(descriptionFiles.waitDescriptionPromptFile, "snapshot wait");
		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify(descriptionFiles),
		);
		const entryConfig = await import("./entry-config");
		const readConfig = entryConfig.readConfig;
		let releaseConfig = (): void => undefined;
		const configGate = new Promise<void>((resolve) => {
			releaseConfig = resolve;
		});
		const configSpy = spyOn(entryConfig, "readConfig").mockImplementation(
			async () => {
				await configGate;
				return readConfig();
			},
		);
		const pi = createPiFake();
		const ctx = createContext(suiteDir);
		try {
			const initialization = subagents(pi);
			const toolsBeforeConfig = pi.tools.map((tool) => tool.name).sort();
			releaseConfig();
			await initialization;
			await pi.emit("session_start", { type: "session_start" }, ctx);
			await pi.emit("session_tree", { type: "session_tree" }, ctx);
			await pi.emit("session_start", { type: "session_start" }, ctx);

			expect({
				toolsBeforeConfig,
				allRegistrations: pi.tools.map((tool) => tool.name).sort(),
				descriptions: {
					start: getTool(pi, "subagent_start").description,
					steer: getTool(pi, "subagent_steer").description,
					wait: getTool(pi, "subagent_wait").description,
					query: getTool(pi, "subagent_query").description,
				},
			}).toEqual({
				toolsBeforeConfig: [
					"subagent_query",
					"subagent_start",
					"subagent_steer",
					"subagent_wait",
				],
				allRegistrations: [
					"subagent_query",
					"subagent_start",
					"subagent_steer",
					"subagent_wait",
				],
				descriptions: {
					start: "snapshot start",
					steer: "snapshot steer",
					wait: "snapshot wait",
					query: readPrompt("query-description.md"),
				},
			});
		} finally {
			releaseConfig();
			configSpy.mockRestore();
		}
	});

	test("publishes exact subagent schemas", () => {
		// Purpose: all public request schemas must remain closed and machine-readable.
		// Input and expected output: one valid request per tool passes while an extra property, duplicate wait ID, and zero timeout fail.
		// Dependencies: exported production TypeBox schemas.
		expect({
			startValid: Check(SubagentStartParameters, {
				agentId: "SubAgentCoder",
				taskName: "Trace runtime",
				prompt: "Inspect runtime",
			}),
			startExtraRejected: Check(SubagentStartParameters, {
				agentId: "SubAgentCoder",
				taskName: "Trace runtime",
				prompt: "Inspect runtime",
				extra: true,
			}),
			steerValid: Check(SubagentSteerParameters, {
				sessionId: 1,
				prompt: "Change direction",
			}),
			queryValid: Check(SubagentQueryParameters, {
				sessionId: 1,
				question: "What changed?",
			}),
			queryExtraRejected: Check(SubagentQueryParameters, {
				sessionId: 1,
				question: "What changed?",
				extra: true,
			}),
			waitDuplicateRejected: Check(SubagentWaitParameters, {
				sessionIds: [1, 1],
				timeout: 1,
			}),
			waitZeroRejected: Check(SubagentWaitParameters, {
				sessionIds: [1],
				timeout: 0,
			}),
		}).toEqual({
			startValid: true,
			startExtraRejected: false,
			steerValid: true,
			queryValid: true,
			queryExtraRejected: false,
			waitDuplicateRejected: false,
			waitZeroRejected: false,
		});
	});

	test("runs root lifecycle and semantic failure boundaries", async () => {
		// Purpose: registered subagent tools must use one reconstructed root runtime across lifecycle events.
		// Input and expected output: an unavailable start and unknown steer/wait return their stable semantic codes without spawning Pi.
		// Edge case: message reconciliation and shutdown run with an empty owner journal and no UI.
		// Dependencies: production entry handlers, isolated empty agent registry, and public session-manager fake methods.
		writeFileSync(
			join(suiteDir, "agent-selection", "agents", "Helper.md"),
			[
				"---",
				"description: Helper",
				"type: subagent",
				"---",
				"Helper runtime prompt",
			].join("\n"),
		);
		const pi = createPiFake();
		const ctx = createContext(suiteDir);
		await subagents(pi);
		await pi.emit("session_start", { type: "session_start" }, ctx);
		const operations = [
			getTool(pi, "subagent_start").execute(
				"start-semantic",
				{
					agentId: "MissingAgent",
					taskName: "Trace runtime",
					prompt: "work",
				},
				undefined,
				undefined,
				ctx,
			),
			getTool(pi, "subagent_steer").execute(
				"steer-semantic",
				{ sessionId: 1, prompt: "change" },
				undefined,
				undefined,
				ctx,
			),
			getTool(pi, "subagent_wait").execute(
				"wait-semantic",
				{ sessionIds: [1], timeout: 1 },
				undefined,
				undefined,
				ctx,
			),
		];
		const failures = await Promise.all(
			operations.map((operation) =>
				operation
					.then(() => ({
						code: "unexpected_success",
						message: "operation unexpectedly succeeded",
					}))
					.catch((error: unknown) => readFailureDetails(error)),
			),
		);
		const promptResults = await pi.emit(
			"before_agent_start",
			{ systemPrompt: "Base" },
			ctx,
		);
		await pi.emit("message_end", { type: "message_end" }, ctx);
		await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);

		expect({ failures, promptResults }).toMatchObject({
			failures: [
				{
					code: "agent_unavailable",
					message: "Subagent MissingAgent is unavailable",
				},
				{ code: "unknown_session", message: "session 1 is unknown" },
				{ code: "unknown_session", message: "session 1 is unknown" },
			],
			promptResults: [
				{
					systemPrompt: expect.stringContaining(
						'<available_subagents note="List of available subagent IDs">',
					),
				},
			],
		});
	});

	test("cancels registered root waits before rejection and later history delivery", async () => {
		// Purpose: Pi abort must remove root wait admission before the registered tool rejects or later feedback is routed.
		// Input and expected output: two aborted calls settle promptly with their Pi reasons; the second is admissible and child feedback reaches history once.
		// Edge case: feedback arrives only after both aborted waits have removed their claims and timers.
		// Dependencies: registered production tool, AbortController, reconstructed active session, coordinator observation, and public Pi writer fakes.
		const session = {
			key: { ownerPiSessionId: "owner-pi", ownerLocalSessionId: 1 },
			childPiSessionId: "abort-child",
			childSessionDir: suiteDir,
			childSessionFile: join(suiteDir, "abort-child.jsonl"),
			agentId: "SubAgentCoder",
			taskName: "Abort wait",
			creationOrder: 1,
			invocationId: "abort-invocation",
			runtimeLeaseId: "abort-child-lease",
			invocationMetadata: TEST_INVOCATION_METADATA,
			state: "active" as const,
		} satisfies LogicalSession;
		const pi = createPiFake();
		const ctx = createContext(suiteDir);
		const registerOwner = SubagentCoordinator.prototype.registerOwner;
		let coordinator: SubagentCoordinator | undefined;
		const registerSpy = spyOn(
			SubagentCoordinator.prototype,
			"registerOwner",
		).mockImplementation(function (this: SubagentCoordinator, owner) {
			coordinator = this;
			return registerOwner.call(this, owner);
		});
		try {
			await subagents(pi);
			await pi.emit("session_start", { type: "session_start" }, ctx);
			if (coordinator === undefined) {
				throw new Error("root session did not expose its coordinator");
			}
			await coordinator.applyReconciledSessions([session]);
			const tool = getTool(pi, "subagent_wait");
			const firstController = new AbortController();
			const firstReason = new Error("cancel first root wait");
			const first = tool
				.execute(
					"root-abort-1",
					{ sessionIds: [1], timeout: 3600 },
					firstController.signal,
					undefined,
					ctx,
				)
				.then(() => "normal")
				.catch((error: unknown) => error);
			await Promise.resolve();
			firstController.abort(firstReason);
			const firstPromptOutcome = await Promise.race([
				first,
				new Promise<"pending">((resolve) =>
					setTimeout(() => resolve("pending"), 0),
				),
			]);

			const secondController = new AbortController();
			const secondReason = new Error("cancel second root wait");
			const second = tool
				.execute(
					"root-abort-2",
					{ sessionIds: [1], timeout: 3600 },
					secondController.signal,
					undefined,
					ctx,
				)
				.then(() => "normal")
				.catch((error: unknown) => error);
			await Promise.resolve();
			secondController.abort(secondReason);
			const secondPromptOutcome = await Promise.race([
				second,
				new Promise<"pending">((resolve) =>
					setTimeout(() => resolve("pending"), 0),
				),
			]);
			if (coordinator === undefined) {
				throw new Error("registered wait did not expose its coordinator");
			}
			await coordinator.observeInvocation({
				kind: "terminal",
				invocationId: session.invocationId,
				status: "success",
				text: "later root feedback",
			});
			const finalOutcomes = await Promise.all([first, second]);
			const waitClaims = pi.appendedEntries.filter((entry) => {
				const record = Array.isArray(entry) ? entry[1] : undefined;
				return (
					typeof record === "object" &&
					record !== null &&
					Reflect.get(record, "kind") === "wait-claimed"
				);
			}).length;

			expect({
				firstPromptUsedOriginalReason: firstPromptOutcome === firstReason,
				secondPromptUsedOriginalReason: secondPromptOutcome === secondReason,
				finalOutcomesUsedOriginalReasons:
					finalOutcomes[0] === firstReason && finalOutcomes[1] === secondReason,
				waitClaims,
				historyWrites: pi.sentMessages.length,
			}).toEqual({
				firstPromptUsedOriginalReason: true,
				secondPromptUsedOriginalReason: true,
				finalOutcomesUsedOriginalReasons: true,
				waitClaims: 0,
				historyWrites: 1,
			});
		} finally {
			registerSpy.mockRestore();
		}
	});

	test("awaits root recovery before writer unregister and runtime disposal", async () => {
		// Purpose: the registered root session_shutdown handler must retain runtime state and its active writer until non-empty closure recovery settles.
		// Input and expected output: one reconstructed lease enters a gated recovery; the handler stays pending, remains reconcilable, then unregisters and clears once.
		// Edge case: a second shutdown and later message reconciliation must not reuse the disposed root runtime.
		// Dependencies: registered lifecycle handler, production root recovery binding, coordinator closure, and session store lifecycle.
		const rootSession = {
			key: { ownerPiSessionId: "owner-pi", ownerLocalSessionId: 1 },
			childPiSessionId: "root-child",
			childSessionDir: suiteDir,
			childSessionFile: join(suiteDir, "missing-child.jsonl"),
			agentId: "SubAgentCoder",
			taskName: "Root shutdown",
			creationOrder: 1,
			invocationId: "root-shutdown-invocation",
			runtimeLeaseId: "root-shutdown-lease",
			invocationMetadata: TEST_INVOCATION_METADATA,
			state: "active" as const,
		} satisfies LogicalSession;
		const entries = [
			{
				type: "custom",
				id: "root-shutdown-accepted",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				customType: SUBAGENT_JOURNAL_CUSTOM_TYPE,
				data: {
					kind: "session-accepted",
					session: rootSession,
				} satisfies JournalRecord,
			},
		];
		const pi = createPiFake();
		const ctx = createContext(suiteDir, entries);
		await subagents(pi);
		await pi.emit("session_start", { type: "session_start" }, ctx);
		let releaseRecovery = (): void => undefined;
		const recoveryGate = new Promise<void>((resolve) => {
			releaseRecovery = resolve;
		});
		let markRecoveryStarted = (): void => undefined;
		const recoveryStarted = new Promise<void>((resolve) => {
			markRecoveryStarted = resolve;
		});
		let observedLeaseIds: readonly string[] = [];
		let writerUnregistered = false;
		let reconcileCalls = 0;
		const runtimeFailure = await import("./runtime-failure");
		const recoverySpy = spyOn(
			runtimeFailure,
			"recoverRootShutdown",
		).mockImplementation(async (options) => {
			if (!(options.store instanceof SessionStore)) {
				throw new Error("root recovery store is not SessionStore");
			}
			const store = options.store;
			const unregisterActive = store.unregisterActive.bind(store);
			spyOn(store, "unregisterActive").mockImplementation(
				(ownerPiSessionId) => {
					writerUnregistered = true;
					unregisterActive(ownerPiSessionId);
				},
			);
			const reconcileActive = store.reconcileActive.bind(store);
			spyOn(store, "reconcileActive").mockImplementation(async (writer) => {
				reconcileCalls += 1;
				return reconcileActive(writer);
			});
			observedLeaseIds = await options.coordinator.shutdown(options.owner);
			markRecoveryStarted();
			await recoveryGate;
		});
		try {
			let shutdownSettled = false;
			const shutdown = pi
				.emit("session_shutdown", { type: "session_shutdown" }, ctx)
				.then(() => {
					shutdownSettled = true;
				});
			await recoveryStarted;
			const shutdownSettledBeforeRelease = shutdownSettled;
			const writerUnregisteredBeforeRelease = writerUnregistered;
			await pi.emit("message_end", { type: "message_end" }, ctx);
			const reconcileCallsWhileRetained = reconcileCalls;
			releaseRecovery();
			await shutdown;
			await pi.emit("message_end", { type: "message_end" }, ctx);
			await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);

			expect({
				observedLeaseIds,
				shutdownSettledBeforeRelease,
				writerUnregisteredBeforeRelease,
				reconcileCallsWhileRetained,
				shutdownSettled,
				writerUnregistered,
				reconcileCallsAfterDisposal: reconcileCalls,
				recoveryCalls: recoverySpy.mock.calls.length,
			}).toEqual({
				observedLeaseIds: [rootSession.runtimeLeaseId],
				shutdownSettledBeforeRelease: false,
				writerUnregisteredBeforeRelease: false,
				reconcileCallsWhileRetained: 1,
				shutdownSettled: true,
				writerUnregistered: true,
				reconcileCallsAfterDisposal: 1,
				recoveryCalls: 1,
			});
		} finally {
			recoverySpy.mockRestore();
		}
	});

	test("joins in-flight runtime recovery before registered root disposal", async () => {
		// Purpose: registered root session_shutdown must join runtime-failure reconciliation that already owns a released writer.
		// Input and expected output: failure recovery blocks offline reconciliation; root closure completes, but writer unregister and runtime disposal wait for both.
		// Edge case: the earlier recovery has removed its remote writer, so standalone root closure cannot rediscover that owner.
		// Dependencies: registered lifecycle handler, recovery tracker, production recovery functions, and root store lifecycle.
		const pi = createPiFake();
		const ctx = createContext(suiteDir);
		await subagents(pi);
		await pi.emit("session_start", { type: "session_start" }, ctx);
		const runtimeFailure = await import("./runtime-failure");
		const recoverRootShutdown = runtimeFailure.recoverRootShutdown;
		let writerUnregistered = false;
		let reconcileCalls = 0;
		const rootRecoverySpy = spyOn(
			runtimeFailure,
			"recoverRootShutdown",
		).mockImplementation(async (options) => {
			if (!(options.store instanceof SessionStore)) {
				throw new Error("root recovery store is not SessionStore");
			}
			const store = options.store;
			const unregisterActive = store.unregisterActive.bind(store);
			spyOn(store, "unregisterActive").mockImplementation(
				(ownerPiSessionId) => {
					writerUnregistered = true;
					unregisterActive(ownerPiSessionId);
				},
			);
			const reconcileActive = store.reconcileActive.bind(store);
			spyOn(store, "reconcileActive").mockImplementation(async (writer) => {
				reconcileCalls += 1;
				return reconcileActive(writer);
			});
			await recoverRootShutdown(options);
		});
		let releaseReconciliation = (): void => undefined;
		const reconciliationGate = new Promise<void>((resolve) => {
			releaseReconciliation = resolve;
		});
		let markReconciliationStarted = (): void => undefined;
		const reconciliationStarted = new Promise<void>((resolve) => {
			markReconciliationStarted = resolve;
		});
		let writerReleased = false;
		let runtimeSettled = false;
		const failureOwner: OwnerIdentity = {
			ownerPiSessionId: "failure-owner",
			ownerSessionFile: join(suiteDir, "failure-owner.jsonl"),
		};
		const runtimeRecoveryFactory = () =>
			runtimeFailure
				.recoverRuntimeFailure(
					{
						observeRuntimeFailure: async () => ["failure-lease"],
						persistDeferredTerminals: async () => undefined,
						applyReconciledSessions: async () => undefined,
					},
					{
						releaseRemoteLease: () => {
							writerReleased = true;
							return [failureOwner];
						},
						reconcileOffline: async () => {
							markReconciliationStarted();
							await reconciliationGate;
							return [];
						},
					},
					{ runtimeLeaseId: "failure-lease", reason: "channel_disconnected" },
				)
				.then(() => {
					runtimeSettled = true;
				});
		const closeAndDrain = RuntimeFailureRecoveryTracker.prototype.closeAndDrain;
		const drainSpy = spyOn(
			RuntimeFailureRecoveryTracker.prototype,
			"closeAndDrain",
		).mockImplementation(function (
			this: RuntimeFailureRecoveryTracker,
			rootRecoveryFactory,
		) {
			this.start(runtimeRecoveryFactory);
			return closeAndDrain.call(this, rootRecoveryFactory);
		});
		try {
			let shutdownSettled = false;
			const shutdown = pi
				.emit("session_shutdown", { type: "session_shutdown" }, ctx)
				.then(() => {
					shutdownSettled = true;
				});
			await reconciliationStarted;
			const shutdownSettledBeforeRuntime = shutdownSettled;
			const writerUnregisteredBeforeRuntime = writerUnregistered;
			const runtimeSettledBeforeRelease = runtimeSettled;
			await pi.emit("message_end", { type: "message_end" }, ctx);
			const reconcileCallsWhilePending = reconcileCalls;
			releaseReconciliation();
			await shutdown;
			await pi.emit("message_end", { type: "message_end" }, ctx);

			expect({
				writerReleased,
				shutdownSettledBeforeRuntime,
				writerUnregisteredBeforeRuntime,
				runtimeSettledBeforeRelease,
				reconcileCallsWhilePending,
				runtimeSettled,
				shutdownSettled,
				writerUnregistered,
				reconcileCallsAfterDisposal: reconcileCalls,
				drainCalls: drainSpy.mock.calls.length,
			}).toEqual({
				writerReleased: true,
				shutdownSettledBeforeRuntime: false,
				writerUnregisteredBeforeRuntime: false,
				runtimeSettledBeforeRelease: false,
				reconcileCallsWhilePending: 1,
				runtimeSettled: true,
				shutdownSettled: true,
				writerUnregistered: true,
				reconcileCallsAfterDisposal: 1,
				drainCalls: 1,
			});
		} finally {
			drainSpy.mockRestore();
			rootRecoverySpy.mockRestore();
			releaseReconciliation();
		}
	});

	test("propagates undefined recovery rejection without root disposal", async () => {
		// Purpose: a joined runtime-failure rejection with any reason must reject registered root shutdown and preserve ownership.
		// Input and expected output: offline reconciliation rejects with undefined after root closure; shutdown returns an Error without unregister or disposal.
		// Edge case: undefined must remain a rejection instead of matching an empty failure sentinel.
		// Dependencies: registered lifecycle handler, recovery tracker rejection, and retained root store.
		const pi = createPiFake();
		const ctx = createContext(suiteDir);
		await subagents(pi);
		await pi.emit("session_start", { type: "session_start" }, ctx);
		const runtimeFailure = await import("./runtime-failure");
		const recoverRootShutdown = runtimeFailure.recoverRootShutdown;
		let writerUnregistered = false;
		let reconcileCalls = 0;
		const rootRecoverySpy = spyOn(
			runtimeFailure,
			"recoverRootShutdown",
		).mockImplementation(async (options) => {
			if (!(options.store instanceof SessionStore)) {
				throw new Error("root recovery store is not SessionStore");
			}
			const store = options.store;
			const unregisterActive = store.unregisterActive.bind(store);
			spyOn(store, "unregisterActive").mockImplementation(
				(ownerPiSessionId) => {
					writerUnregistered = true;
					unregisterActive(ownerPiSessionId);
				},
			);
			const reconcileActive = store.reconcileActive.bind(store);
			spyOn(store, "reconcileActive").mockImplementation(async (writer) => {
				reconcileCalls += 1;
				return reconcileActive(writer);
			});
			await recoverRootShutdown(options);
		});
		let rejectReconciliation = (): void => undefined;
		const rejectionGate = new Promise<void>((resolve) => {
			rejectReconciliation = resolve;
		});
		let markReconciliationStarted = (): void => undefined;
		const reconciliationStarted = new Promise<void>((resolve) => {
			markReconciliationStarted = resolve;
		});
		const failureOwner: OwnerIdentity = {
			ownerPiSessionId: "rejected-owner",
			ownerSessionFile: join(suiteDir, "rejected-owner.jsonl"),
		};
		const runtimeRecoveryFactory = () =>
			runtimeFailure.recoverRuntimeFailure(
				{
					observeRuntimeFailure: async () => ["rejected-lease"],
					persistDeferredTerminals: async () => undefined,
					applyReconciledSessions: async () => undefined,
				},
				{
					releaseRemoteLease: () => [failureOwner],
					reconcileOffline: async () => {
						markReconciliationStarted();
						await rejectionGate;
						return Promise.reject(undefined);
					},
				},
				{ runtimeLeaseId: "rejected-lease", reason: "channel_disconnected" },
			);
		const closeAndDrain = RuntimeFailureRecoveryTracker.prototype.closeAndDrain;
		const drainSpy = spyOn(
			RuntimeFailureRecoveryTracker.prototype,
			"closeAndDrain",
		).mockImplementation(function (
			this: RuntimeFailureRecoveryTracker,
			rootRecoveryFactory,
		) {
			this.start(runtimeRecoveryFactory);
			return closeAndDrain.call(this, rootRecoveryFactory);
		});
		try {
			let shutdownError = "";
			const shutdown = pi
				.emit("session_shutdown", { type: "session_shutdown" }, ctx)
				.catch((error: unknown) => {
					shutdownError =
						error instanceof Error ? error.message : String(error);
				});
			await reconciliationStarted;
			rejectReconciliation();
			await shutdown;
			await pi.emit("message_end", { type: "message_end" }, ctx);

			expect({
				shutdownError,
				writerUnregistered,
				reconcileCallsAfterRejection: reconcileCalls,
				drainCalls: drainSpy.mock.calls.length,
			}).toEqual({
				shutdownError: "undefined",
				writerUnregistered: false,
				reconcileCallsAfterRejection: 1,
				drainCalls: 1,
			});
		} finally {
			drainSpy.mockRestore();
			rootRecoverySpy.mockRestore();
			rejectReconciliation();
		}
	});

	test("enforces the prompt-visible callable-agent policy at runtime", async () => {
		// Purpose: prompt visibility and start authorization must share one effective allowlist.
		// Input and expected output: top-level and nested policies omit Blocked, reject its start as agent_unavailable, and still attempt Allowed.
		// Edge case: Blocked exists in the global callable registry, while nested policy must override the top-level main-agent policy.
		// Dependencies: production entry composition, isolated agent definitions, and an auth boundary that prevents process spawn.
		// Arrange.
		for (const [fileName, content] of [
			[
				"Allowed.md",
				[
					"---",
					"description: Allowed",
					"type: subagent",
					"---",
					"Allowed prompt",
				].join("\n"),
			],
			[
				"Blocked.md",
				[
					"---",
					"description: Blocked",
					"type: subagent",
					"---",
					"Blocked prompt",
				].join("\n"),
			],
			[
				"Parent.md",
				[
					"---",
					"description: Parent",
					"type: subagent",
					"agents:",
					"  - Allowed",
					"---",
					"Parent prompt",
				].join("\n"),
			],
		] as const) {
			writeFileSync(
				join(suiteDir, "agent-selection", "agents", fileName),
				content,
			);
		}
		const observations: Array<{
			readonly scope: string;
			readonly blockedCode: string;
			readonly allowedCode: string;
			readonly launchAttemptsAfterBlocked: number;
			readonly totalLaunchAttempts: number;
			readonly appendedAfterBlocked: number;
			readonly prompt: string;
		}> = [];

		// Act.
		for (const policyCase of [
			{
				scope: "top-level",
				selectedAgentId: undefined,
				mainAllowed: ["Allowed"],
			},
			{ scope: "nested", selectedAgentId: "Parent", mainAllowed: ["Blocked"] },
		] as const) {
			if (policyCase.selectedAgentId === undefined) {
				delete process.env[AGENT_ID_ENV];
			} else {
				process.env[AGENT_ID_ENV] = policyCase.selectedAgentId;
			}
			let launchAttempts = 0;
			const pi = createPiFake();
			const ctx = createContext(suiteDir, [], {
				model: TEST_MODEL,
				onAuthRequest: () => {
					launchAttempts += 1;
					throw new Error("controlled launch boundary");
				},
			});
			await subagents(pi);
			getAgentRuntimeComposition(pi).setMainAgentContribution({
				prompt: "Main prompt",
				tools: ["subagent_start", "subagent_steer", "subagent_wait"],
				agent: {
					id: "Main",
					tools: ["subagent_start", "subagent_steer", "subagent_wait"],
					agents: policyCase.mainAllowed,
				},
			});
			await pi.emit("session_start", { type: "session_start" }, ctx);
			const prompt = JSON.stringify(
				await pi.emit("before_agent_start", { systemPrompt: "Base" }, ctx),
			);
			const blockedCode = await getTool(pi, "subagent_start")
				.execute(
					`blocked-${policyCase.scope}`,
					{
						agentId: "Blocked",
						taskName: "Blocked task",
						prompt: "Do not start",
					},
					undefined,
					undefined,
					ctx,
				)
				.then(() => "unexpected_success")
				.catch((error: unknown) => readCode(readFailureDetails(error)));
			const launchAttemptsAfterBlocked = launchAttempts;
			const appendedAfterBlocked = pi.appendedEntries.length;
			const allowedCode = await getTool(pi, "subagent_start")
				.execute(
					`allowed-${policyCase.scope}`,
					{
						agentId: "Allowed",
						taskName: "Allowed task",
						prompt: "Attempt launch",
					},
					undefined,
					undefined,
					ctx,
				)
				.then(() => "unexpected_success")
				.catch((error: unknown) => readCode(readFailureDetails(error)));
			await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
			observations.push({
				scope: policyCase.scope,
				blockedCode,
				allowedCode,
				launchAttemptsAfterBlocked,
				totalLaunchAttempts: launchAttempts,
				appendedAfterBlocked,
				prompt,
			});
		}

		// Assert.
		expect(
			observations.map(
				({ scope, blockedCode, launchAttemptsAfterBlocked }) => ({
					scope,
					blockedCode,
					launchAttemptsAfterBlocked,
				}),
			),
		).toEqual([
			{
				scope: "top-level",
				blockedCode: "agent_unavailable",
				launchAttemptsAfterBlocked: 0,
			},
			{
				scope: "nested",
				blockedCode: "agent_unavailable",
				launchAttemptsAfterBlocked: 0,
			},
		]);
		expect(
			observations.map(
				({
					scope,
					allowedCode,
					totalLaunchAttempts,
					appendedAfterBlocked,
				}) => ({
					scope,
					allowedCode,
					totalLaunchAttempts,
					appendedAfterBlocked,
				}),
			),
		).toEqual([
			{
				scope: "top-level",
				allowedCode: "start_failed",
				totalLaunchAttempts: 1,
				appendedAfterBlocked: 0,
			},
			{
				scope: "nested",
				allowedCode: "start_failed",
				totalLaunchAttempts: 1,
				appendedAfterBlocked: 0,
			},
		]);
		for (const observation of observations) {
			expect(observation.prompt).toContain('<agent id=\\"Allowed\\">');
			expect(observation.prompt).not.toContain('<agent id=\\"Blocked\\">');
		}
	});

	test("reconstructs repeated owner-local IDs by complete stable key", async () => {
		// Purpose: recursive entry reconstruction must retain sessions whose numeric IDs repeat under different direct owners.
		// Input and expected output: root child 1 and nested child 1 are each added once, resolve for their direct owners, and select the nested policy for the grandchild owner.
		// Edge case: the root session is cataloged first, so numeric-only deduplication would discard the nested stable key.
		// Dependencies: production entry reconstruction, a public persisted child SessionManager, the production catalog, and callable-agent policy routing.
		// Arrange.
		const configDir = join(suiteDir, "run-subagent");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify({ enabled: true, maxDepth: 2 }),
		);
		const nestedOwnerManager = SessionManager.create(
			join(suiteDir, "nested-owner"),
			join(suiteDir, "nested-owner"),
			{ id: "nested-owner" },
		);
		const nestedOwnerSeed: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "nested owner seed" }],
			api: "openai-responses",
			provider: "openai",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "stop",
			timestamp: 1,
		};
		nestedOwnerManager.appendMessage(nestedOwnerSeed);
		const nestedSession = {
			key: {
				ownerPiSessionId: nestedOwnerManager.getSessionId(),
				ownerLocalSessionId: 1,
			},
			childPiSessionId: "grandchild-owner",
			childSessionDir: join(suiteDir, "grandchild-owner"),
			childSessionFile: join(suiteDir, "missing-grandchild.jsonl"),
			agentId: "NestedParent",
			taskName: "Nested task",
			creationOrder: 1,
			invocationId: "nested-invocation",
			runtimeLeaseId: "nested-lease",
			invocationMetadata: TEST_INVOCATION_METADATA,
			state: "terminal-success",
		} satisfies LogicalSession;
		nestedOwnerManager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
			kind: "session-accepted",
			session: nestedSession,
		} satisfies JournalRecord);
		const nestedOwnerFile = nestedOwnerManager.getSessionFile();
		if (nestedOwnerFile === undefined) {
			throw new Error(
				"nested owner SessionManager did not create a session file",
			);
		}
		const rootSession = {
			key: { ownerPiSessionId: "owner-pi", ownerLocalSessionId: 1 },
			childPiSessionId: nestedOwnerManager.getSessionId(),
			childSessionDir: nestedOwnerManager.getSessionDir(),
			childSessionFile: nestedOwnerFile,
			agentId: "Parent",
			taskName: "Root task",
			creationOrder: 1,
			invocationId: "root-invocation",
			runtimeLeaseId: "root-lease",
			invocationMetadata: TEST_INVOCATION_METADATA,
			state: "terminal-success",
		} satisfies LogicalSession;
		const entries = [
			{
				type: "custom",
				id: "root-journal",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				customType: SUBAGENT_JOURNAL_CUSTOM_TYPE,
				data: {
					kind: "session-accepted",
					session: rootSession,
				} satisfies JournalRecord,
			},
		];
		const rootOwner: OwnerIdentity = {
			ownerPiSessionId: rootSession.key.ownerPiSessionId,
			ownerSessionFile: join(suiteDir, "owner.jsonl"),
		};
		const nestedOwner: OwnerIdentity = {
			ownerPiSessionId: nestedSession.key.ownerPiSessionId,
			ownerSessionFile: nestedOwnerFile,
		};
		const grandchildOwner: OwnerIdentity = {
			ownerPiSessionId: nestedSession.childPiSessionId,
			ownerSessionFile: nestedSession.childSessionFile,
		};
		const agents: readonly AgentDefinition[] = [
			{
				id: "Allowed",
				description: "Allowed",
				type: "subagent",
				prompt: "Allowed prompt",
			},
			{
				id: "Blocked",
				description: "Blocked",
				type: "subagent",
				prompt: "Blocked prompt",
			},
			{
				id: "Parent",
				description: "Parent",
				type: "subagent",
				prompt: "Parent prompt",
				agents: ["Blocked"],
			},
			{
				id: "NestedParent",
				description: "Nested parent",
				type: "subagent",
				prompt: "Nested parent prompt",
				agents: ["Allowed"],
			},
		];
		const addedKeys: string[] = [];
		let reconstructedCatalog: SessionCatalog | undefined;
		const originalAdd = SessionCatalog.prototype.add;
		const addSpy = spyOn(SessionCatalog.prototype, "add").mockImplementation(
			function (this: SessionCatalog, session: LogicalSession): void {
				reconstructedCatalog = this;
				addedKeys.push(
					`${session.key.ownerPiSessionId}:${session.key.ownerLocalSessionId}`,
				);
				originalAdd.call(this, session);
			},
		);
		const pi = createPiFake();
		const ctx = createContext(suiteDir, entries);
		await subagents(pi);

		// Act.
		try {
			await pi.emit("session_start", { type: "session_start" }, ctx);
		} finally {
			addSpy.mockRestore();
		}
		if (reconstructedCatalog === undefined) {
			throw new Error("entry reconstruction did not create a session catalog");
		}
		const rootResolved = reconstructedCatalog.get(rootOwner, 1);
		const nestedResolved = reconstructedCatalog.get(nestedOwner, 1);
		const directNestedSelectedAgentId = resolveCallerSelectedAgentId(
			rootOwner,
			nestedOwner,
			reconstructedCatalog,
			undefined,
		);
		const grandchildSelectedAgentId = resolveCallerSelectedAgentId(
			rootOwner,
			grandchildOwner,
			reconstructedCatalog,
			undefined,
		);
		const grandchildAvailability = {
			allowed: isAgentAvailableForCaller({
				agents,
				mainAgent: { id: "Main", agents: ["Blocked"] },
				rootOwner,
				caller: grandchildOwner,
				catalog: reconstructedCatalog,
				rootSelectedAgentId: undefined,
				requestedAgentId: "Allowed",
			}),
			blocked: isAgentAvailableForCaller({
				agents,
				mainAgent: { id: "Main", agents: ["Blocked"] },
				rootOwner,
				caller: grandchildOwner,
				catalog: reconstructedCatalog,
				rootSelectedAgentId: undefined,
				requestedAgentId: "Blocked",
			}),
		};
		await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);

		// Assert.
		expect({
			addedKeys,
			rootStableKey: rootResolved?.key,
			nestedStableKey: nestedResolved?.key,
			directNestedSelectedAgentId,
			grandchildSelectedAgentId,
			grandchildAvailability,
		}).toEqual({
			addedKeys: ["owner-pi:1", "nested-owner:1"],
			rootStableKey: rootSession.key,
			nestedStableKey: nestedSession.key,
			directNestedSelectedAgentId: "Parent",
			grandchildSelectedAgentId: "NestedParent",
			grandchildAvailability: { allowed: true, blocked: false },
		});
	});

	test("returns no_active_sessions for a reconstructed terminal child", async () => {
		// Purpose: a retained terminal logical session must remain addressable without creating a worker process.
		// Input and expected output: reconstructed session 1 produces the exact no_active_sessions wait result.
		// Edge case: the child session file is absent because projection recursion is not needed for agent-facing wait.
		// Dependencies: production entry reconstruction, coordinator, and tool result serialization.
		const acceptedSession = {
			key: { ownerPiSessionId: "owner-pi", ownerLocalSessionId: 1 },
			childPiSessionId: "child-pi",
			childSessionDir: suiteDir,
			childSessionFile: join(suiteDir, "missing-child.jsonl"),
			agentId: "SubAgentCoder",
			taskName: "Trace runtime",
			creationOrder: 1,
			invocationId: "invocation-1",
			runtimeLeaseId: "lease-1",
			invocationMetadata: TEST_INVOCATION_METADATA,
			state: "terminal-success",
		};
		const entries = [
			{
				type: "custom",
				id: "journal-1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				customType: SUBAGENT_JOURNAL_CUSTOM_TYPE,
				data: { kind: "session-accepted", session: acceptedSession },
			},
		];
		const pi = createPiFake();
		const ctx = createContext(suiteDir, entries);
		await subagents(pi);
		await pi.emit("session_start", { type: "session_start" }, ctx);
		const result = await getTool(pi, "subagent_wait").execute(
			"wait-terminal",
			{ sessionIds: [1], timeout: 1 },
			undefined,
			undefined,
			ctx,
		);
		await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);

		expect({ outcome: readOutcome(result), content: result.content }).toEqual({
			outcome: "no_active_sessions",
			content: [{ type: "text", text: '{"outcome":"no_active_sessions"}' }],
		});
	});

	test("keeps malformed-config tool callbacks inert after early registration", async () => {
		// Purpose: exact configuration rejection must coexist with tool registration before asynchronous parsing.
		// Input and expected output: each malformed configuration registers four tools whose execution returns start_failed.
		// Edge case: every case uses a fresh extension runtime so one invalid parse cannot affect another result.
		// Dependencies: suite-owned config file, production parser, and stable registered execution callbacks.
		const configDir = join(suiteDir, "run-subagent");
		mkdirSync(configDir, { recursive: true });
		const invalidContents = [
			JSON.stringify({ enabled: true, unexpected: true }),
			"{",
			"[]",
			JSON.stringify({ enabled: "yes" }),
			JSON.stringify({ maxDepth: -1 }),
		];
		const observations: Array<{
			readonly count: number;
			readonly code: string;
		}> = [];
		for (const [index, content] of invalidContents.entries()) {
			writeFileSync(join(configDir, "config.json"), content);
			const pi = createPiFake();
			const ctx = createContext(suiteDir);
			await subagents(pi);
			const code = await getTool(pi, "subagent_start")
				.execute(
					`invalid-config-${index}`,
					{
						agentId: "SubAgentCoder",
						taskName: "Invalid config",
						prompt: "work",
					},
					undefined,
					undefined,
					ctx,
				)
				.then(() => "normal")
				.catch((error: unknown) => readCode(readFailureDetails(error)));
			observations.push({ count: pi.tools.length, code });
		}

		expect(observations).toEqual(
			invalidContents.map(() => ({ count: 4, code: "start_failed" })),
		);
	});

	test("keeps every bundled description when one configured file is invalid", async () => {
		// Purpose: one invalid description file must reject the complete config without exposing an otherwise valid customization.
		// Input and expected output: a readable start file plus whitespace-only steer file keeps all bundled descriptions and returns start_failed.
		// Edge case: tools remain registered before the failed file read is observed.
		// Dependencies: production config parsing, stable registrations, and inert execution callbacks.
		const configDir = join(suiteDir, "run-subagent");
		mkdirSync(configDir, { recursive: true });
		const startFile = join(suiteDir, "partial-start.md");
		const steerFile = join(suiteDir, "partial-steer.md");
		writeFileSync(startFile, "must not become visible");
		writeFileSync(steerFile, " \n\t ");
		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify({
				startDescriptionPromptFile: startFile,
				steerDescriptionPromptFile: steerFile,
			}),
		);
		const pi = createPiFake();
		const ctx = createContext(suiteDir);
		await subagents(pi);
		const code = await getTool(pi, "subagent_start")
			.execute(
				"invalid-description-config",
				{
					agentId: "SubAgentCoder",
					taskName: "Invalid description config",
					prompt: "work",
				},
				undefined,
				undefined,
				ctx,
			)
			.then(() => "normal")
			.catch((error: unknown) => readCode(readFailureDetails(error)));

		expect({
			code,
			start: getTool(pi, "subagent_start").description,
			steer: getTool(pi, "subagent_steer").description,
			wait: getTool(pi, "subagent_wait").description,
		}).toEqual({
			code: "start_failed",
			start: readPrompt("start-description.md"),
			steer: readPrompt("steer-description.md"),
			wait: readPrompt("wait-description.md"),
		});
	});

	test("shows saved children when maxDepth disables new delegation", async () => {
		// Purpose: lowering the delegation limit must not hide historical sessions from management.
		// Input and expected output: one terminal saved child under maxDepth zero remains selectable and continuable.
		// Edge case: persisted visibility is independent from prompt-time subagent_start availability.
		// Dependencies: production entry reconstruction, management screen factory, and a controlled supervisor continuation spy.
		const configDir = join(suiteDir, "run-subagent");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify({ enabled: true, maxDepth: 0 }),
		);
		const savedSession = {
			key: { ownerPiSessionId: "owner-pi", ownerLocalSessionId: 1 },
			childPiSessionId: "saved-child",
			childSessionDir: join(suiteDir, "saved-child"),
			childSessionFile: join(suiteDir, "saved-child.jsonl"),
			agentId: "SubAgentCoder",
			taskName: "Saved child",
			creationOrder: 1,
			invocationId: "saved-invocation",
			runtimeLeaseId: "saved-lease",
			invocationMetadata: TEST_INVOCATION_METADATA,
			state: "terminal-success",
		} satisfies LogicalSession;
		const entries = [
			{
				type: "custom",
				id: "saved-child-journal",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				customType: SUBAGENT_JOURNAL_CUSTOM_TYPE,
				data: {
					kind: "session-accepted",
					session: savedSession,
				} satisfies JournalRecord,
			},
		];
		let screen: ManagementScreen | undefined;
		const tui = {
			terminal: { rows: 18, columns: 80 } as Terminal,
			requestRender: () => undefined,
			setFocus: () => undefined,
		} as unknown as TUI;
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as Theme;
		const keybindings = new KeybindingsManager({
			"tui.input.submit": { defaultKeys: "enter" },
			"tui.select.up": { defaultKeys: "up" },
			"tui.select.down": { defaultKeys: "down" },
			"tui.select.pageUp": { defaultKeys: "pageUp" },
			"tui.select.pageDown": { defaultKeys: "pageDown" },
			"tui.select.confirm": { defaultKeys: "enter" },
			"app.tools.expand": { defaultKeys: "ctrl+o" },
		});
		const pi = createPiFake();
		const ctx = createContext(suiteDir, entries, {
			mode: "tui",
			custom: async (factory: unknown) => {
				screen = (
					factory as (
						tui: TUI,
						theme: Theme,
						keybindings: KeybindingsManager,
						done: () => void,
					) => ManagementScreen
				)(tui, theme, keybindings, () => undefined);
				return undefined;
			},
		});
		const continueSpy = spyOn(
			InvocationSupervisor.prototype,
			"continue",
		).mockResolvedValue({
			invocationId: "continued-invocation",
			runtimeLeaseId: "continued-lease",
			childPiSessionId: savedSession.childPiSessionId,
			childSessionDir: savedSession.childSessionDir,
			childSessionFile: savedSession.childSessionFile,
		});
		try {
			await subagents(pi);
			await pi.emit("session_start", { type: "session_start" }, ctx);
			const command = pi.commands.find(({ name }) => name === "subagents");
			await command?.handler("", ctx);
			if (screen === undefined) {
				throw new Error("management screen was not constructed");
			}
			screen.setEditorText("continue saved child");
			screen.handleInput("\t");
			screen.handleInput("\t");
			screen.handleInput("\r");
			await Promise.resolve();
			await Promise.resolve();

			expect({
				selectedStableKey: screen.getSelectedStableKey(),
				focus: screen.getFocusZone(),
				continueCalls: continueSpy.mock.calls.length,
			}).toEqual({
				selectedStableKey: projectionStableKey(savedSession.key),
				focus: "editor",
				continueCalls: 1,
			});
			await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
		} finally {
			continueSpy.mockRestore();
			screen?.dispose();
		}
	});

	test("reconciles and exposes saved descendants beyond maxDepth", async () => {
		// Purpose: management must expose B and C with reconciled C feedback after the delegation limit is lowered.
		// Input and expected output: public A→B→C persistence under maxDepth one keeps both saved nodes visible.
		// Edge case: root-owned steering of C still fails as not_owner without calling the continuation supervisor.
		// Dependencies: public persisted SessionManager instances, production reconstruction, and the management overlay.
		initTheme(undefined, false);
		const configDir = join(suiteDir, "run-subagent");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify({ enabled: true, maxDepth: 1 }),
		);
		const child = createPersistedSession(join(suiteDir, "B"), {
			id: "B-pi",
			text: "B seed",
		});
		const childFile = child.getSessionFile();
		if (childFile === undefined) {
			throw new Error("B SessionManager did not create a session file");
		}
		const hiddenSession = {
			key: { ownerPiSessionId: child.getSessionId(), ownerLocalSessionId: 2 },
			childPiSessionId: "C-pi",
			childSessionDir: join(suiteDir, "C"),
			childSessionFile: join(suiteDir, "C", "missing.jsonl"),
			agentId: "SubAgentCoder",
			taskName: "Hidden C",
			creationOrder: 1,
			invocationId: "C-invocation",
			runtimeLeaseId: "C-lease",
			invocationMetadata: TEST_INVOCATION_METADATA,
			state: "active" as const,
		};
		child.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
			kind: "session-accepted",
			session: hiddenSession,
		} satisfies JournalRecord);
		child.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
			kind: "terminal",
			sessionKey: hiddenSession.key,
			invocationId: hiddenSession.invocationId,
			state: "terminal-success",
			disposition: "pending",
			feedback: {
				feedbackId: "C-feedback",
				invocationId: hiddenSession.invocationId,
				sessionKey: hiddenSession.key,
				status: "success",
				output: "C completed",
				presentation: {
					agentId: hiddenSession.agentId,
					taskName: hiddenSession.taskName,
					invocationMetadata: hiddenSession.invocationMetadata,
				},
			},
		} satisfies JournalRecord);
		const parent = createPersistedSession(join(suiteDir, "A"), {
			id: "A-pi",
			text: "A seed",
		});
		const visibleSession = {
			key: { ownerPiSessionId: parent.getSessionId(), ownerLocalSessionId: 1 },
			childPiSessionId: child.getSessionId(),
			childSessionDir: child.getSessionDir(),
			childSessionFile: childFile,
			agentId: "SubAgentCoder",
			taskName: "Visible B",
			creationOrder: 1,
			invocationId: "B-invocation",
			runtimeLeaseId: "B-lease",
			invocationMetadata: TEST_INVOCATION_METADATA,
			state: "active" as const,
		};
		parent.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
			kind: "session-accepted",
			session: visibleSession,
		} satisfies JournalRecord);
		parent.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
			kind: "terminal",
			sessionKey: visibleSession.key,
			invocationId: visibleSession.invocationId,
			state: "terminal-aborted",
			disposition: "withheld-forced-abort",
		} satisfies JournalRecord);
		let screen: ManagementScreen | undefined;
		const tui = {
			terminal: { rows: 18, columns: 100 } as Terminal,
			requestRender: () => undefined,
			setFocus: () => undefined,
		} as unknown as TUI;
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as Theme;
		const keybindings = new KeybindingsManager({
			"tui.input.submit": { defaultKeys: "enter" },
			"tui.select.up": { defaultKeys: "up" },
			"tui.select.down": { defaultKeys: "down" },
			"tui.select.pageUp": { defaultKeys: "pageUp" },
			"tui.select.pageDown": { defaultKeys: "pageDown" },
			"tui.select.confirm": { defaultKeys: "enter" },
			"app.tools.expand": { defaultKeys: "ctrl+o" },
		});
		const pi = createPiFake();
		const baseContext = createContext(suiteDir, [], {
			mode: "tui",
			custom: async (factory: unknown) => {
				screen = (
					factory as (
						tui: TUI,
						theme: Theme,
						keybindings: KeybindingsManager,
						done: () => void,
					) => ManagementScreen
				)(tui, theme, keybindings, () => undefined);
				return undefined;
			},
		});
		const ctx = {
			...baseContext,
			sessionManager: parent,
		} as ExtensionContext;
		const continueSpy = spyOn(
			InvocationSupervisor.prototype,
			"continue",
		).mockResolvedValue({
			invocationId: "B-continuation",
			runtimeLeaseId: "B-continuation-lease",
			childPiSessionId: visibleSession.childPiSessionId,
			childSessionDir: visibleSession.childSessionDir,
			childSessionFile: visibleSession.childSessionFile,
		});
		try {
			await subagents(pi);
			await pi.emit("session_start", { type: "session_start" }, ctx);
			const command = pi.commands.find(({ name }) => name === "subagents");
			await command?.handler("", ctx);
			if (screen === undefined) {
				throw new Error("management screen was not constructed");
			}
			const selectedScreen = screen;
			await Promise.resolve();
			await Promise.resolve();
			screen.handleInput("\u001b[C");
			/** Waits for the public SessionManager snapshot without assuming storage latency. */
			const renderLoadedConversation = async (
				deadlineMs: number,
			): Promise<string> => {
				const renderedConversation = selectedScreen.render(100).join("\n");
				if (
					renderedConversation.includes("C completed") ||
					Date.now() >= deadlineMs
				) {
					return renderedConversation;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
				return renderLoadedConversation(deadlineMs);
			};
			const rendered = await renderLoadedConversation(Date.now() + 5_000);
			screen.setEditorText("message selected B");
			screen.handleInput("\t");
			screen.handleInput("\t");
			screen.handleInput("\r");
			await Promise.resolve();
			await Promise.resolve();
			const descendantRouteCode = await getTool(pi, "subagent_steer")
				.execute(
					"steer-hidden-C",
					{
						sessionId: hiddenSession.key.ownerLocalSessionId,
						prompt: "route C",
					},
					undefined,
					undefined,
					ctx,
				)
				.then(() => "unexpected_success")
				.catch((error: unknown) => readCode(readFailureDetails(error)));

			expect({
				selected: screen.getSelectedStableKey(),
				rendered,
				descendantRouteCode,
				continuedSessionKey: continueSpy.mock.calls[0]?.[0].key,
				continuedPrompt: continueSpy.mock.calls[0]?.[1],
				continueCalls: continueSpy.mock.calls.length,
			}).toEqual({
				selected: projectionStableKey(visibleSession.key),
				rendered: expect.stringContaining("C completed"),
				descendantRouteCode: "not_owner",
				continuedSessionKey: visibleSession.key,
				continuedPrompt: "message selected B",
				continueCalls: 1,
			});
			expect(rendered).toContain("Hidden C");
			await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
		} finally {
			continueSpy.mockRestore();
			screen?.dispose();
		}
	});

	test("opens one management screen from both TUI entries", async () => {
		// Purpose: the command and shortcut must share one full-terminal factory only in interactive TUI mode.
		// Inputs and expected output: /subagents and Ctrl+Shift+G pass the same component factory and exact overlay sizing while an empty Agents row stays hidden.
		// Edge case: a separate non-interactive runtime registers no management entry and constructs no custom screen.
		// Dependencies: public Pi command, shortcut, lifecycle, and ctx.ui.custom contracts.
		// ARRANGE: create separate interactive and RPC runtimes with observable UI entry points.
		const tuiCustomCalls: unknown[][] = [];
		const tuiWidgetCalls: unknown[][] = [];
		const tuiPi = createPiFake();
		const tuiContext = createContext(suiteDir, [], {
			mode: "tui",
			custom: async (...args: unknown[]) => {
				tuiCustomCalls.push(args);
				return undefined;
			},
			setWidget: (...args: unknown[]) => tuiWidgetCalls.push(args),
		});
		await subagents(tuiPi);
		await tuiPi.emit("session_start", { type: "session_start" }, tuiContext);

		// ACT: invoke both TUI registrations, then start a separate non-interactive runtime.
		const command = tuiPi.commands.find(({ name }) => name === "subagents");
		const shortcut = tuiPi.shortcuts.find(
			({ shortcut: key }) => key === "ctrl+shift+g",
		);
		await command?.handler("", tuiContext);
		await shortcut?.handler(tuiContext);
		const rpcCustomCalls: unknown[][] = [];
		const rpcPi = createPiFake();
		const rpcContext = createContext(suiteDir, [], {
			mode: "rpc",
			custom: async (...args: unknown[]) => {
				rpcCustomCalls.push(args);
				return undefined;
			},
		});
		await subagents(rpcPi);
		await rpcPi.emit("session_start", { type: "session_start" }, rpcContext);

		// ASSERT: both interactive paths share one factory and exact overlay options while normal and RPC modes remain isolated.
		expect({
			commandRegistered: command !== undefined,
			shortcutRegistered: shortcut !== undefined,
			customCallCount: tuiCustomCalls.length,
			sameFactory:
				tuiCustomCalls[0]?.[0] !== undefined &&
				tuiCustomCalls[0]?.[0] === tuiCustomCalls[1]?.[0],
			overlayOptions: tuiCustomCalls.map((call) => call[1]),
			widgetVisible: tuiWidgetCalls.some((call) => call[1] !== undefined),
			rpcCommands: rpcPi.commands.length,
			rpcShortcuts: rpcPi.shortcuts.length,
			rpcCustomCalls: rpcCustomCalls.length,
		}).toEqual({
			commandRegistered: true,
			shortcutRegistered: true,
			customCallCount: 2,
			sameFactory: true,
			overlayOptions: [
				{
					overlay: true,
					overlayOptions: {
						width: "100%",
						maxHeight: "100%",
						margin: 0,
					},
				},
				{
					overlay: true,
					overlayOptions: {
						width: "100%",
						maxHeight: "100%",
						margin: 0,
					},
				},
			],
			widgetVisible: false,
			rpcCommands: 0,
			rpcShortcuts: 0,
			rpcCustomCalls: 0,
		});
		await tuiPi.emit(
			"session_shutdown",
			{ type: "session_shutdown" },
			tuiContext,
		);
		await rpcPi.emit(
			"session_shutdown",
			{ type: "session_shutdown" },
			rpcContext,
		);
	});

	test("registers inert subagent tools when explicitly disabled", async () => {
		// Purpose: disabled configuration must keep early tool definitions stable without initializing runtime behavior.
		// Input and expected output: enabled false registers four tools and execution returns start_failed.
		// Edge case: maxDepth is omitted because disabled configuration cannot execute a runtime operation.
		// Dependencies: suite-owned Subagents config file and stable registered execution callbacks.
		const configDir = join(suiteDir, "run-subagent");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify({ enabled: false }),
		);
		const pi = createPiFake();
		const ctx = createContext(suiteDir);
		await subagents(pi);
		const code = await getTool(pi, "subagent_wait")
			.execute(
				"disabled-wait",
				{ sessionIds: [1], timeout: 1 },
				undefined,
				undefined,
				ctx,
			)
			.then(() => "normal")
			.catch((error: unknown) => readCode(readFailureDetails(error)));

		expect({ tools: pi.tools.map((tool) => tool.name).sort(), code }).toEqual({
			tools: [
				"subagent_query",
				"subagent_start",
				"subagent_steer",
				"subagent_wait",
			],
			code: "start_failed",
		});
	});
});

/** Restores one optional process environment value after a test. */
function restoreEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

/** Reads public failed-tool details from an execution error. */
function readFailureDetails(error: unknown): unknown {
	if (typeof error === "object" && error !== null && "details" in error) {
		return error.details;
	}
	return undefined;
}

/** Reads one stable code from untrusted failed-tool details. */
function readCode(value: unknown): string {
	if (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		typeof value.code === "string"
	) {
		return value.code;
	}
	return "unexpected_failure";
}

/** Reads a normal result outcome without casting unvalidated details. */
function readOutcome(result: AgentToolResult<unknown> | undefined): unknown {
	const details = result?.details;
	if (typeof details === "object" && details !== null && "outcome" in details) {
		return details.outcome;
	}
	return undefined;
}
