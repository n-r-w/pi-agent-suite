import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "../../shared/agent-registry";
import {
	SUBAGENT_OWNER_SESSION_ENV,
	SUBAGENT_RUNTIME_LEASE_ENV,
	SUBAGENT_WORKFLOW_IDS_ENV,
} from "../../shared/subagent-environment";
import { publishWorkflowCatalogPolicy } from "../../shared/workflow-policy";
import { resolveLaunchConfiguration } from "./agent-policy";
import { SubagentCoordinator } from "./coordinator";
import type {
	JournalRecord,
	LogicalSession,
	OwnerIdentity,
	SessionKey,
	SubagentFeedback,
} from "./domain";
import {
	type InvocationAcceptance,
	type InvocationEvent,
	InvocationStartError,
	type InvocationSupervisorOptions,
} from "./invocation-contracts";
import { InvocationSupervisor } from "./invocation-supervisor";
import {
	type OwnerSessionStore,
	SessionStore,
	SUBAGENT_HISTORY_CUSTOM_TYPE,
	SUBAGENT_JOURNAL_CUSTOM_TYPE,
} from "./persistence";
import { RootRuntimeBridge } from "./runtime-bridge";
import {
	recoverOwnerShutdown,
	recoverRootShutdown,
	recoverRuntimeFailure,
} from "./runtime-failure";
import { SessionCatalog } from "./session-catalog";
import { WaitCoordinator } from "./wait-coordinator";

type RuntimeRequestSink = NonNullable<
	InvocationSupervisorOptions["onRuntimeRequest"]
>;

type ControlledChild = ChildProcess & {
	readonly stdinWrites: string[];
	readonly signals: NodeJS.Signals[];
	readonly sentMessages: unknown[];
	emitClose(code?: number, signal?: NodeJS.Signals | null): void;
};

/** Creates a controlled child process whose RPC and IPC events are emitted by the test. */
function createChildProcess(
	options: {
		readonly closeOnStdinEnd?: boolean;
		readonly closeOnSignal?: NodeJS.Signals;
		readonly stdinEndError?: Error;
	} = {},
): ControlledChild {
	const process = new EventEmitter();
	const stdin = new EventEmitter();
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const stdinWrites: string[] = [];
	const signals: NodeJS.Signals[] = [];
	const sentMessages: unknown[] = [];
	const emitClose = (code = 0, signal: NodeJS.Signals | null = null): void => {
		Object.assign(process, { exitCode: code, signalCode: signal });
		process.emit("close", code, signal);
	};
	Object.assign(stdin, {
		writable: true,
		write: (value: string) => {
			stdinWrites.push(value);
			return true;
		},
		end: (value?: string) => {
			if (value !== undefined) {
				stdinWrites.push(value);
			}
			if (options.stdinEndError !== undefined) {
				throw options.stdinEndError;
			}
			if (options.closeOnStdinEnd !== false) {
				queueMicrotask(emitClose);
			}
		},
	});
	Object.assign(process, {
		stdin,
		stdout,
		stderr,
		stdinWrites,
		signals,
		sentMessages,
		emitClose,
		connected: true,
		exitCode: null,
		signalCode: null,
		send: (message: unknown, callback?: (error: Error | null) => void) => {
			sentMessages.push(message);
			callback?.(null);
			return true;
		},
		kill: (signal: NodeJS.Signals) => {
			signals.push(signal);
			if (signal === options.closeOnSignal) {
				queueMicrotask(() => emitClose(0, signal));
			}
			return true;
		},
	});
	return process as ControlledChild;
}

interface SupervisorHarness {
	readonly supervisor: InvocationSupervisor;
	spawnCount(): number;
}

/** Stores coordinator journal and history evidence without external I/O. */
class CoordinatorStoreFake implements OwnerSessionStore {
	public readonly records: JournalRecord[] = [];
	public readonly historyFeedback: SubagentFeedback[] = [];
	public readonly historyFeedbackIds = new Set<string>();
	public readonly remoteOwners = new Map<
		string,
		{ readonly owner: OwnerIdentity; readonly runtimeLeaseId: string }
	>();
	public readonly closureLeaseIds = new Set<string>();
	public readonly releasedLeases: string[] = [];
	public readonly releasedAfterProcessStop: boolean[] = [];
	public readonly reconciledOwners: string[] = [];
	public readonly reconciledAfterCompleteRelease: boolean[] = [];
	public processesStopped = (): boolean => true;

	/** Appends one durable coordinator record. */
	public async append(
		_owner: OwnerIdentity,
		record: JournalRecord,
	): Promise<void> {
		this.records.push(record);
	}

	/** Records one delivered history feedback identity. */
	public async appendHistory(
		_owner: OwnerIdentity,
		feedback: SubagentFeedback,
	): Promise<void> {
		this.historyFeedback.push(feedback);
		this.historyFeedbackIds.add(feedback.feedbackId);
	}

	/** Reports no ambiguous acceptance in this deterministic path. */
	public async hasAcceptedInvocationEvidence(
		_owner: OwnerIdentity,
		_sessionKey: SessionKey,
		_invocationId: string,
	): Promise<boolean> {
		return false;
	}

	/** Reports no wait destination evidence. */
	public async hasWaitEvidence(
		_owner: OwnerIdentity,
		_feedbackId: string,
	): Promise<boolean> {
		return false;
	}

	/** Reports history delivery evidence recorded by the history port. */
	public async hasHistoryEvidence(
		_owner: OwnerIdentity,
		feedbackId: string,
	): Promise<boolean> {
		return this.historyFeedbackIds.has(feedbackId);
	}

	/** Registers one controlled remote writer by owner and current runtime lease. */
	public registerRemote(owner: OwnerIdentity, runtimeLeaseId: string): void {
		this.remoteOwners.set(owner.ownerPiSessionId, { owner, runtimeLeaseId });
	}

	/** Removes one stopping owner's writer after its descendant closure recovers. */
	public unregisterRemote(ownerPiSessionId: string): void {
		this.remoteOwners.delete(ownerPiSessionId);
	}

	/** Releases writers for one stopped closure lease after process cessation. */
	public releaseRemoteLease(runtimeLeaseId: string): readonly OwnerIdentity[] {
		this.releasedLeases.push(runtimeLeaseId);
		this.releasedAfterProcessStop.push(this.processesStopped());
		const released: OwnerIdentity[] = [];
		for (const [ownerPiSessionId, registration] of this.remoteOwners) {
			if (registration.runtimeLeaseId === runtimeLeaseId) {
				this.remoteOwners.delete(ownerPiSessionId);
				released.push(registration.owner);
			}
		}
		return released;
	}

	/** Records offline reconciliation after every configured closure writer release. */
	public async reconcileOffline(
		owner: OwnerIdentity,
	): Promise<readonly LogicalSession[]> {
		this.reconciledOwners.push(owner.ownerPiSessionId);
		this.reconciledAfterCompleteRelease.push(
			[...this.closureLeaseIds].every((runtimeLeaseId) =>
				[...this.remoteOwners.values()].every(
					(registration) => registration.runtimeLeaseId !== runtimeLeaseId,
				),
			),
		);
		return [];
	}
}

/** Creates one supervisor with deterministic launch facts and worker readiness. */
function createSupervisor(
	child: ControlledChild,
	events: InvocationEvent[],
): InvocationSupervisor {
	return createSupervisorHarness([child], events).supervisor;
}

interface SupervisorHarnessOptions {
	readonly resolveLaunch?: InvocationSupervisorOptions["resolveLaunch"];
	readonly onSpawnEnvironment?: (environment: NodeJS.ProcessEnv) => void;
}

/** Creates one supervisor whose successive launches consume controlled child processes. */
function createSupervisorHarness(
	children: readonly ControlledChild[],
	events: InvocationEvent[],
	eventSink?: (event: InvocationEvent) => Promise<void> | void,
	runtimeRequestSink?: RuntimeRequestSink,
	emitReady = true,
	options: SupervisorHarnessOptions = {},
): SupervisorHarness {
	let spawnCount = 0;
	const supervisor = new InvocationSupervisor({
		bridge: new RootRuntimeBridge(),
		onEvent: (event) => {
			events.push(event);
			return eventSink?.(event);
		},
		...(runtimeRequestSink === undefined
			? {}
			: { onRuntimeRequest: runtimeRequestSink }),
		resolveLaunch:
			options.resolveLaunch ??
			(async () => ({
				cwd: "/tmp",
				modelId: "openai/test-model",
				provider: "openai",
				thinking: "off",
				depth: 1,
				parentAuthVerified: true,
				runtimeFacts: {
					modelProvider: "openai",
					modelId: "test-model",
					contextWindow: 128_000,
				},
			})),
		sessionsDir: "/tmp",
		spawnProcess: (_command, _args, spawnOptions) => {
			options.onSpawnEnvironment?.(spawnOptions.env);
			const child = children[spawnCount];
			if (child === undefined) {
				throw new Error("controlled child process queue is exhausted");
			}
			spawnCount += 1;
			if (emitReady) {
				queueMicrotask(() => {
					child.emit("message", {
						kind: "subagents-ready",
						runtimeLeaseId: spawnOptions.env[SUBAGENT_RUNTIME_LEASE_ENV],
						ownerPiSessionId: spawnOptions.env[SUBAGENT_OWNER_SESSION_ENV],
						ownerSessionFile: "/tmp/child-session.jsonl",
					});
				});
			}
			return child;
		},
	});
	return { supervisor, spawnCount: () => spawnCount };
}

/** Starts one controlled invocation and emits its authoritative prompt acceptance. */
async function acceptStart(
	supervisor: InvocationSupervisor,
	child: ControlledChild,
	options: {
		readonly ownerPiSessionId?: string;
		readonly ownerLocalSessionId?: number;
		readonly ownerRuntimeLeaseId?: string;
	} = {},
): Promise<InvocationAcceptance> {
	const ownerPiSessionId = options.ownerPiSessionId ?? "owner-1";
	const pending = supervisor.start({
		owner: {
			ownerPiSessionId,
			ownerSessionFile: `/tmp/${ownerPiSessionId}.jsonl`,
		},
		sessionKey: {
			ownerPiSessionId,
			ownerLocalSessionId: options.ownerLocalSessionId ?? 1,
		},
		agentId: "SubAgentCoder",
		taskName: "Trace runtime",
		prompt: "Inspect runtime",
		...(options.ownerRuntimeLeaseId === undefined
			? {}
			: { ownerRuntimeLeaseId: options.ownerRuntimeLeaseId }),
	});
	await waitForWriteCount(child, 1);
	child.stdout?.emit(
		"data",
		Buffer.from(
			'{"id":"prompt","type":"response","command":"prompt","success":true}\n',
		),
	);
	return pending;
}

/** Creates complete durable metadata from one controlled accepted launch. */
function invocationMetadataFor(acceptance: InvocationAcceptance) {
	return {
		startedAtMs: 1_700_000_000_000,
		elapsedMs: 1_000,
		...(acceptance.modelId === undefined
			? {}
			: { modelId: acceptance.modelId }),
		...(acceptance.contextWindow === undefined
			? {}
			: { contextWindow: acceptance.contextWindow }),
	};
}

/** Reconstructs the accepted invocation as one saved terminal logical session. */
function terminalSession(acceptance: InvocationAcceptance): LogicalSession {
	return {
		key: { ownerPiSessionId: "owner-1", ownerLocalSessionId: 1 },
		childPiSessionId: acceptance.childPiSessionId,
		childSessionDir: acceptance.childSessionDir,
		childSessionFile: acceptance.childSessionFile,
		agentId: "SubAgentCoder",
		taskName: "Trace runtime",
		creationOrder: 1,
		invocationId: acceptance.invocationId,
		runtimeLeaseId: acceptance.runtimeLeaseId,
		invocationMetadata: invocationMetadataFor(acceptance),
		state: "terminal-success",
	};
}

/** Waits until the controlled stdin captured the expected command count. */
async function waitForWriteCount(
	child: ControlledChild,
	count: number,
): Promise<void> {
	while (child.stdinWrites.length < count) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

/** Emits one successful assistant completion through Pi's complete settled RPC lifecycle. */
function emitSuccessfulCompletion(child: ControlledChild, text: string): void {
	child.stdout?.emit(
		"data",
		Buffer.from(
			`${JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text }],
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
				},
			})}\n${JSON.stringify({ type: "agent_end", messages: [], willRetry: false })}\n${JSON.stringify({ type: "agent_settled" })}\n`,
		),
	);
}

/** Emits one context projection status update through the child RPC stream. */
function emitProjectionStatus(
	child: ControlledChild,
	statusText: string | undefined,
): void {
	child.stdout?.emit(
		"data",
		Buffer.from(
			`${JSON.stringify({
				type: "extension_ui_request",
				method: "setStatus",
				statusKey: "context-projection",
				...(statusText === undefined ? {} : { statusText }),
			})}\n`,
		),
	);
}

/** Creates one public owner session for graceful writer-handoff recovery. */
function createGracefulOwnerManager(
	directory: string,
	ownerPiSessionId: string,
): SessionManager {
	const manager = SessionManager.create(directory, directory, {
		id: ownerPiSessionId,
	});
	const seed: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "graceful owner seed" }],
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
	manager.appendMessage(seed);
	return manager;
}

/** Reads durable normal-terminal and feedback facts after graceful recovery. */
function readGracefulOwnerFacts(manager: SessionManager): {
	readonly state: LogicalSession["state"] | undefined;
	readonly terminalStates: readonly unknown[];
	readonly historyContents: readonly string[];
	readonly historyStatuses: readonly unknown[];
	readonly historyCommitCount: number;
} {
	const branch = manager.getBranch();
	const journalRecords = branch.flatMap((entry) =>
		entry.type === "custom" &&
		entry.customType === SUBAGENT_JOURNAL_CUSTOM_TYPE &&
		typeof entry.data === "object" &&
		entry.data !== null
			? [entry.data]
			: [],
	);
	const historyEntries = branch.flatMap((entry) =>
		entry.type === "custom_message" &&
		entry.customType === SUBAGENT_HISTORY_CUSTOM_TYPE
			? [entry]
			: [],
	);
	return {
		state: new SessionStore().fold(branch).sessions[0]?.state,
		terminalStates: journalRecords.flatMap((record) =>
			Reflect.get(record, "kind") === "terminal"
				? [Reflect.get(record, "state")]
				: [],
		),
		historyContents: historyEntries.flatMap((entry) =>
			typeof entry.content === "string" ? [entry.content] : [],
		),
		historyStatuses: historyEntries.map((entry) =>
			typeof entry.details === "object" && entry.details !== null
				? Reflect.get(entry.details, "status")
				: undefined,
		),
		historyCommitCount: journalRecords.filter(
			(record) => Reflect.get(record, "kind") === "history-committed",
		).length,
	};
}

describe("InvocationSupervisor", () => {
	test.each([
		[undefined, undefined],
		[[], "[]"],
		[["rEvIeW"], '["Review"]'],
	] as const)("connects workflow resolver policy %j to the child environment", async (configuredWorkflows, expectedEnvironment) => {
		// Purpose: one accepted launch must carry the resolver result through the supervisor instead of testing either seam in isolation.
		// Input and expected output: absent, empty, and mixed-case Review become absent, [], and the catalog's exact Review ID.
		// Edge case: inherited workflow transport is stripped before launch-owned policy is applied.
		// Dependencies: production resolver, workflow catalog boundary, supervisor spawn environment, and a controlled child without provider requests.
		const previous = process.env[SUBAGENT_WORKFLOW_IDS_ENV];
		process.env[SUBAGENT_WORKFLOW_IDS_ENV] = '["stale"]';
		const child = createChildProcess();
		const environments: NodeJS.ProcessEnv[] = [];
		const model = {
			provider: "openai",
			id: "test-model",
			contextWindow: 128_000,
		} as NonNullable<ExtensionContext["model"]>;
		const pi = {
			events: new EventEmitter(),
			getThinkingLevel: () => "off",
		} as unknown as ExtensionAPI;
		publishWorkflowCatalogPolicy(pi, { ids: ["Review"] });
		let authCalls = 0;
		const ctx = {
			cwd: "/tmp",
			model,
			modelRegistry: {
				getApiKeyAndHeaders: async () => {
					authCalls += 1;
					return { ok: true };
				},
			},
		} as unknown as ExtensionContext;
		const agent: AgentDefinition = {
			id: "SubAgentCoder",
			description: "Codes",
			type: "subagent",
			prompt: "Code",
			...(configuredWorkflows === undefined
				? {}
				: { workflows: configuredWorkflows }),
		};
		const harness = createSupervisorHarness(
			[child],
			[],
			undefined,
			undefined,
			true,
			{
				resolveLaunch: (request) =>
					resolveLaunchConfiguration({
						pi,
						ctx,
						agents: [agent],
						supervisor: undefined,
						request,
					}),
				onSpawnEnvironment: (environment) => environments.push(environment),
			},
		);
		try {
			await acceptStart(harness.supervisor, child);
			expect(authCalls).toBe(1);
			expect(environments[0]?.[SUBAGENT_WORKFLOW_IDS_ENV]).toBe(
				expectedEnvironment,
			);
		} finally {
			child.emitClose();
			if (previous === undefined) {
				delete process.env[SUBAGENT_WORKFLOW_IDS_ENV];
			} else {
				process.env[SUBAGENT_WORKFLOW_IDS_ENV] = previous;
			}
		}
	});

	test("rejects pre-aborted start before spawning a child", async () => {
		// Purpose: cancellation already owned by Pi must prevent all process and runtime-lease creation.
		// Input and expected output: a pre-aborted signal rejects with its original reason and spawn count stays zero.
		// Edge case: launch configuration resolution still runs before the startup gate observes cancellation.
		// Dependencies: production supervisor, startup gate, and controlled spawn queue.
		const child = createChildProcess();
		const harness = createSupervisorHarness([child], []);
		const controller = new AbortController();
		const reason = new Error("cancel before spawn");
		controller.abort(reason);
		const outcome = await harness.supervisor
			.start({
				owner: {
					ownerPiSessionId: "owner-1",
					ownerSessionFile: "/tmp/owner.jsonl",
				},
				sessionKey: { ownerPiSessionId: "owner-1", ownerLocalSessionId: 1 },
				agentId: "SubAgentCoder",
				taskName: "Pre-aborted start",
				prompt: "work",
				signal: controller.signal,
			})
			.catch((error: unknown) => error);

		expect({
			originalReason: outcome === reason,
			spawnCount: harness.spawnCount(),
			childStarted: child.exitCode !== null || child.stdinWrites.length > 0,
		}).toEqual({
			originalReason: true,
			spawnCount: 0,
			childStarted: false,
		});
	});

	test("cancels start during IPC readiness and stops the spawned child", async () => {
		// Purpose: cancellation while waiting for the worker lease must not wait for the readiness timeout or leave a process.
		// Input and expected output: abort settles with the original reason before the observation interval and closes the spawned child.
		// Edge case: the controlled child never emits the runtime-ready message.
		// Dependencies: production supervisor, root runtime bridge, controlled child process, and AbortController.
		const child = createChildProcess();
		const harness = createSupervisorHarness(
			[child],
			[],
			undefined,
			undefined,
			false,
		);
		const controller = new AbortController();
		const reason = new Error("cancel during IPC readiness");
		const pending = harness.supervisor
			.start({
				owner: {
					ownerPiSessionId: "owner-1",
					ownerSessionFile: "/tmp/owner.jsonl",
				},
				sessionKey: { ownerPiSessionId: "owner-1", ownerLocalSessionId: 1 },
				agentId: "SubAgentCoder",
				taskName: "Readiness cancellation",
				prompt: "work",
				signal: controller.signal,
			})
			.catch((error: unknown) => error);
		await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort(reason);
		const observed = await Promise.race([
			pending,
			new Promise<"pending">((resolve) =>
				setTimeout(() => resolve("pending"), 10),
			),
		]);
		if (observed === "pending") {
			child.emit("disconnect");
			await pending;
		}

		expect({
			originalReason: observed === reason,
			spawnCount: harness.spawnCount(),
			childStopped: child.exitCode !== null,
		}).toEqual({
			originalReason: true,
			spawnCount: 1,
			childStopped: true,
		});
	});

	test("returns child stderr when startup exits before IPC readiness", async () => {
		// Purpose: a child startup failure must reach the existing Error field instead of becoming a generic readiness timeout.
		// Input and expected output: exit code 1 with one stderr diagnostic rejects immediately with both facts in one message.
		// Edge case: no prompt RPC exists yet, so pending-command rejection cannot carry the failure.
		// Dependencies: production supervisor readiness, bounded child stderr parser, and controlled process close.
		const child = createChildProcess();
		const harness = createSupervisorHarness(
			[child],
			[],
			undefined,
			undefined,
			false,
		);
		const controller = new AbortController();
		const pending = harness.supervisor
			.start({
				owner: {
					ownerPiSessionId: "owner-1",
					ownerSessionFile: "/tmp/owner.jsonl",
				},
				sessionKey: { ownerPiSessionId: "owner-1", ownerLocalSessionId: 1 },
				agentId: "SubAgentAnalystMiddle",
				taskName: "Startup diagnostic",
				prompt: "return OK",
				signal: controller.signal,
			})
			.then(
				() => "accepted",
				(error: unknown) =>
					error instanceof Error ? error.message : String(error),
			);
		await new Promise((resolve) => setTimeout(resolve, 0));
		child.stderr?.emit(
			"data",
			Buffer.from('Failed to load extension "run-subagent"'),
		);
		child.emitClose(1);
		const outcome = await Promise.race([
			pending,
			new Promise<"still pending">((resolve) =>
				setTimeout(() => resolve("still pending"), 20),
			),
		]);
		if (outcome === "still pending") {
			controller.abort(new Error("test cleanup"));
			await pending;
		}

		expect({ outcome, spawnCount: harness.spawnCount() }).toEqual({
			outcome: 'exit code 1: Failed to load extension "run-subagent"',
			spawnCount: 1,
		});
	});

	test("returns a child extension error before IPC readiness", async () => {
		// Purpose: Pi startup errors emitted through RPC stdout must reach the existing Error field without waiting for the readiness timeout.
		// Input and expected output: the obsolete run_subagent tool pattern rejects with Pi's exact extension error text.
		// Edge case: the child process remains alive after reporting the extension error.
		// Dependencies: bounded RPC parsing, startup failure ownership, and controlled process teardown.
		const child = createChildProcess();
		const harness = createSupervisorHarness(
			[child],
			[],
			undefined,
			undefined,
			false,
		);
		const pending = harness.supervisor
			.start({
				owner: {
					ownerPiSessionId: "owner-1",
					ownerSessionFile: "/tmp/owner.jsonl",
				},
				sessionKey: { ownerPiSessionId: "owner-1", ownerLocalSessionId: 1 },
				agentId: "SubAgentAnalystMiddle",
				taskName: "Startup extension error",
				prompt: "return OK",
			})
			.then(
				() => "accepted",
				(error: unknown) =>
					error instanceof Error ? error.message : String(error),
			);
		await new Promise((resolve) => setTimeout(resolve, 0));
		child.stdout?.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					type: "extension_error",
					extensionPath: "/tmp/run-subagent/index.ts",
					event: "session_start",
					error: "tool pattern run_subagent did not match any available tool",
				})}\n`,
			),
		);
		const outcome = await Promise.race([
			pending,
			new Promise<"still pending">((resolve) =>
				setTimeout(() => resolve("still pending"), 20),
			),
		]);
		if (outcome === "still pending") {
			child.emit("disconnect");
			await pending;
		}

		expect({ outcome, childStopped: child.exitCode !== null }).toEqual({
			outcome: "tool pattern run_subagent did not match any available tool",
			childStopped: true,
		});
	});

	test("stops a child when cancellation follows prompt acceptance before publication", async () => {
		// Purpose: a prompt accepted by child Pi must not become an orphan when cancellation wins before coordinator publication.
		// Input and expected output: prompt response followed immediately by abort rejects with the Pi reason and closes the accepted handle.
		// Edge case: the child response resolves before the retry wrapper performs its post-attempt signal check.
		// Dependencies: production supervisor, child RPC response parsing, retry boundary, and controlled process teardown.
		const child = createChildProcess();
		const harness = createSupervisorHarness([child], []);
		const controller = new AbortController();
		const reason = new Error("cancel after child prompt acceptance");
		const pending = harness.supervisor
			.start({
				owner: {
					ownerPiSessionId: "owner-1",
					ownerSessionFile: "/tmp/owner.jsonl",
				},
				sessionKey: { ownerPiSessionId: "owner-1", ownerLocalSessionId: 1 },
				agentId: "SubAgentCoder",
				taskName: "Post-acceptance cancellation",
				prompt: "work",
				signal: controller.signal,
			})
			.catch((error: unknown) => error);
		await waitForWriteCount(child, 1);
		child.stdout?.emit(
			"data",
			Buffer.from(
				'{"id":"prompt","type":"response","command":"prompt","success":true}\n',
			),
		);
		controller.abort(reason);
		const outcome = await pending;
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect({
			originalReason: outcome === reason,
			childStopped: child.exitCode !== null,
			spawnCount: harness.spawnCount(),
		}).toEqual({
			originalReason: true,
			childStopped: true,
			spawnCount: 1,
		});
	});

	test("reads active conversation pages through documented get_entries RPC", async () => {
		// Purpose: management projection must read live child entries without opening its active session file.
		// Input and expected output: get_entries returns validated entries, leaf identity, and current projection savings for caller-owned branch caching.
		// Edge case: a later non-positive projection status clears savings while preserving unrelated live activity.
		// Dependencies: documented Pi RPC response shape and controlled child JSONL transport.
		// ARRANGE: accept one live invocation and subscribe to its session activity.
		const child = createChildProcess();
		const supervisor = createSupervisor(child, []);
		const acceptance = await acceptStart(supervisor, child);
		const activity: string[] = [];
		const unsubscribe = supervisor.subscribeActivity((invocationId) =>
			activity.push(invocationId),
		);
		const retryObservedAfterMs = Date.now();
		child.stdout?.emit(
			"data",
			Buffer.from(
				'{"type":"auto_retry_start","attempt":8,"maxAttempts":10,"delayMs":96000}\n',
			),
		);
		emitProjectionStatus(child, "~139k");

		// ACT: request one complete page whose selected leaf excludes one sibling.
		const pending = supervisor.readActiveEntries(acceptance.invocationId);
		await waitForWriteCount(child, 2);
		const request = JSON.parse(child.stdinWrites[1] ?? "{}") as {
			readonly id?: string;
		};
		child.stdout?.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: request.id,
					type: "response",
					command: "get_entries",
					success: true,
					data: {
						entries: [
							{
								type: "message",
								id: "user-1",
								parentId: null,
								timestamp: new Date(1).toISOString(),
								message: {
									role: "user",
									content: "Inspect",
									timestamp: 1,
								},
							},
							{
								type: "message",
								id: "assistant-1",
								parentId: "user-1",
								timestamp: new Date(2).toISOString(),
								message: {
									role: "assistant",
									content: [],
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
									timestamp: 2,
								},
							},
							{
								type: "custom",
								id: "abandoned-1",
								parentId: "user-1",
								timestamp: new Date(3).toISOString(),
								customType: "abandoned",
								data: {},
							},
						],
						leafId: "assistant-1",
					},
				})}\n`,
			),
		);
		const page = await pending;
		emitProjectionStatus(child, "~0");
		const incremental = supervisor.readActiveEntries(
			acceptance.invocationId,
			"abandoned-1",
		);
		await waitForWriteCount(child, 3);
		const incrementalRequest = JSON.parse(child.stdinWrites[2] ?? "{}") as {
			readonly id?: string;
		};
		child.stdout?.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					id: incrementalRequest.id,
					type: "response",
					command: "get_entries",
					success: true,
					data: { entries: [], leafId: "assistant-1" },
				})}\n`,
			),
		);
		const incrementalPage = await incremental;
		unsubscribe();

		// ASSERT: append-order data and the retained live status share one current active snapshot.
		expect({
			command: JSON.parse(child.stdinWrites[1] ?? "{}"),
			incrementalCommand: JSON.parse(child.stdinWrites[2] ?? "{}"),
			entryIds: page.entries.map((entry) => entry.id),
			leafId: page.leafId,
			liveStatus: page.liveStatus,
			projectionSavedTokens: page.projectionSavedTokens,
			deadlineValid:
				page.liveStatus?.kind === "retrying" &&
				page.liveStatus.deadlineAtMs >= retryObservedAfterMs + 96_000,
			incrementalPage,
			activity,
		}).toEqual({
			command: { id: request.id, type: "get_entries" },
			incrementalCommand: {
				id: incrementalRequest.id,
				type: "get_entries",
				since: "abandoned-1",
			},
			entryIds: ["user-1", "assistant-1", "abandoned-1"],
			leafId: "assistant-1",
			liveStatus: page.liveStatus,
			projectionSavedTokens: 139_000,
			deadlineValid: true,
			incrementalPage: {
				entries: [],
				leafId: "assistant-1",
				liveStatus: page.liveStatus,
				projectionSavedTokens: undefined,
			},
			activity: [
				acceptance.invocationId,
				acceptance.invocationId,
				acceptance.invocationId,
			],
		});
	});

	test("keeps an accepted invocation supervised until terminal", async () => {
		// Purpose: Pi RPC prompt acceptance must resolve start without releasing process supervision.
		// Input and expected output: one successful prompt response resolves acceptance before a later terminal event.
		// Edge case: no terminal event exists at the acceptance boundary.
		// Dependencies: controlled child-process RPC streams and production runtime bridge.
		const child = createChildProcess();
		const events: InvocationEvent[] = [];
		const supervisor = createSupervisor(child, events);
		const acceptance = await acceptStart(supervisor, child);

		expect({
			accepted: acceptance.childSessionFile,
			modelId: acceptance.modelId,
			thinking: Reflect.get(acceptance, "thinking"),
			contextWindow: acceptance.contextWindow,
			terminalEvents: events.length,
		}).toEqual({
			accepted: "/tmp/child-session.jsonl",
			modelId: "openai/test-model",
			thinking: "off",
			contextWindow: 128_000,
			terminalEvents: 0,
		});
	});

	test("accepts active steering and emits one shared completion decision", async () => {
		// Purpose: active steering must reuse the process and shared completion state must emit one terminal result.
		// Input and expected output: steer acceptance precedes a successful assistant message and agent_settled terminal event.
		// Edge case: process teardown happens only after the terminal event sink resolves.
		// Dependencies: controlled RPC stream, shared child completion state, and production supervisor.
		const child = createChildProcess();
		const events: InvocationEvent[] = [];
		const supervisor = createSupervisor(child, events);
		const acceptance = await acceptStart(supervisor, child);
		const steering = supervisor.steer(
			acceptance.invocationId,
			"Change direction",
		);
		await waitForWriteCount(child, 2);
		const steerId = readCommandId(child.stdinWrites[1]);
		if (steerId === undefined) {
			throw new Error("steer RPC command ID was not captured");
		}
		child.stdout?.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({ id: steerId, type: "response", command: "steer", success: true })}\n`,
			),
		);
		await steering;
		emitProjectionStatus(child, "~20k");
		emitSuccessfulCompletion(child, "done");
		while (events.length === 0) {
			await Promise.resolve();
		}

		expect(events).toEqual([
			{
				kind: "terminal",
				invocationId: acceptance.invocationId,
				status: "success",
				text: "done",
				contextTokens: 0,
				projectionSavedTokens: 20_000,
			},
		]);
	});

	test("clears unavailable projection savings before terminal", async () => {
		// Purpose: a cleared child projection status must omit only the savings prefix from finalized terminal metadata.
		// Input and expected output: positive savings followed by an explicit clear produces one terminal event without projectionSavedTokens.
		// Edge case: final context usage remains available after the savings status clears.
		// Dependencies: controlled child RPC status and completion events.
		const child = createChildProcess();
		const events: InvocationEvent[] = [];
		const supervisor = createSupervisor(child, events);
		const acceptance = await acceptStart(supervisor, child);
		emitProjectionStatus(child, "~20k");
		emitProjectionStatus(child, undefined);
		emitSuccessfulCompletion(child, "done after clear");
		while (events.length === 0) {
			await Promise.resolve();
		}

		expect(events).toEqual([
			{
				kind: "terminal",
				invocationId: acceptance.invocationId,
				status: "success",
				text: "done after clear",
				contextTokens: 0,
			},
		]);
	});

	test("keeps dispatched active steering authoritative when cancellation precedes its response", async () => {
		// Purpose: Pi queue mutation must remain authoritative when its success response is delayed behind parent cancellation.
		// Input and expected output: one dispatched steer later succeeds, returns accepted, and emits no Pi abort command.
		// Edge case: the signal fires after command dispatch but before the controlled response reaches the supervisor.
		// Dependencies: production supervisor RPC correlations, controlled child transport, and AbortController.
		const child = createChildProcess();
		const supervisor = createSupervisor(child, []);
		const acceptance = await acceptStart(supervisor, child);
		const controller = new AbortController();
		const pending = supervisor
			.steer(acceptance.invocationId, "apply exactly once", {
				signal: controller.signal,
			})
			.then(() => "accepted" as const)
			.catch((error: unknown) => error);
		await waitForWriteCount(child, 2);
		const steerId = readCommandId(child.stdinWrites[1]);
		if (steerId === undefined) {
			throw new Error("steer RPC command ID was not captured");
		}
		controller.abort(new Error("late active-steer cancellation"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const possibleAbortId = readCommandId(child.stdinWrites[2]);
		if (possibleAbortId !== undefined) {
			child.stdout?.emit(
				"data",
				Buffer.from(
					`${JSON.stringify({ id: possibleAbortId, type: "response", command: "abort", success: true })}\n`,
				),
			);
		}
		child.stdout?.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({ id: steerId, type: "response", command: "steer", success: true })}\n`,
			),
		);
		const outcome = await pending;
		const commands = child.stdinWrites.map((value) => {
			const parsed = JSON.parse(value) as { readonly type?: string };
			return parsed.type;
		});

		expect({
			outcome,
			steerCommands: commands.filter((command) => command === "steer").length,
			abortCommands: commands.filter((command) => command === "abort").length,
			trackedLease: supervisor.findRuntimeLeaseForOwner(
				acceptance.childPiSessionId,
			),
		}).toEqual({
			outcome: "accepted",
			steerCommands: 1,
			abortCommands: 0,
			trackedLease: acceptance.runtimeLeaseId,
		});
		await supervisor.terminateLease(acceptance.runtimeLeaseId);
	});

	test("preserves child steer rejection after dispatch despite later cancellation", async () => {
		// Purpose: a real Pi rejection remains the operation outcome after dispatch authority has excluded cancellation.
		// Input and expected output: signal abort followed by one failed steer response returns message_rejected and sends no abort RPC.
		// Edge case: the invocation remains tracked after the rejected message.
		// Dependencies: production supervisor RPC rejection mapping, controlled transport, and AbortController.
		const child = createChildProcess();
		const supervisor = createSupervisor(child, []);
		const acceptance = await acceptStart(supervisor, child);
		const controller = new AbortController();
		const pending = supervisor
			.steer(acceptance.invocationId, "reject this", {
				signal: controller.signal,
			})
			.catch((error: unknown) => error);
		await waitForWriteCount(child, 2);
		const steerId = readCommandId(child.stdinWrites[1]);
		if (steerId === undefined) {
			throw new Error("steer RPC command ID was not captured");
		}
		controller.abort(new Error("late cancellation after rejected dispatch"));
		child.stdout?.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({ id: steerId, type: "response", command: "steer", success: false, error: "child rejected steer" })}\n`,
			),
		);
		const outcome = await pending;
		const commands = child.stdinWrites.map((value) => {
			const parsed = JSON.parse(value) as { readonly type?: string };
			return parsed.type;
		});

		expect({
			code: outcome instanceof InvocationStartError ? outcome.code : undefined,
			message: outcome instanceof Error ? outcome.message : undefined,
			abortCommands: commands.filter((command) => command === "abort").length,
			trackedLease: supervisor.findRuntimeLeaseForOwner(
				acceptance.childPiSessionId,
			),
		}).toEqual({
			code: "message_rejected",
			message: "child rejected steer",
			abortCommands: 0,
			trackedLease: acceptance.runtimeLeaseId,
		});
		await supervisor.terminateLease(acceptance.runtimeLeaseId);
	});

	test("rejects pre-aborted active steering before command dispatch", async () => {
		// Purpose: cancellation must remain authoritative while no steer command can have mutated Pi's queue.
		// Input and expected output: a pre-aborted signal preserves its Error identity and writes no steer or abort RPC.
		// Edge case: the invocation remains active and tracked for a later valid steer.
		// Dependencies: production supervisor dispatch boundary and AbortController.
		const child = createChildProcess();
		const supervisor = createSupervisor(child, []);
		const acceptance = await acceptStart(supervisor, child);
		const controller = new AbortController();
		const reason = new Error("cancel before active-steer dispatch");
		controller.abort(reason);
		const pending = supervisor
			.steer(acceptance.invocationId, "do not dispatch", {
				signal: controller.signal,
			})
			.catch((error: unknown) => error);
		await new Promise((resolve) => setTimeout(resolve, 0));
		for (const value of child.stdinWrites.slice(1)) {
			const command = JSON.parse(value) as {
				readonly id?: string;
				readonly type?: string;
			};
			if (command.id !== undefined && command.type !== undefined) {
				child.stdout?.emit(
					"data",
					Buffer.from(
						`${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true })}\n`,
					),
				);
			}
		}
		const outcome = await pending;
		const commandTypes = child.stdinWrites.slice(1).map((value) => {
			const parsed = JSON.parse(value) as { readonly type?: string };
			return parsed.type;
		});

		expect({
			originalReason: outcome === reason,
			commandTypes,
			trackedLease: supervisor.findRuntimeLeaseForOwner(
				acceptance.childPiSessionId,
			),
		}).toEqual({
			originalReason: true,
			commandTypes: [],
			trackedLease: acceptance.runtimeLeaseId,
		});
		await supervisor.terminateLease(acceptance.runtimeLeaseId);
	});

	test("waits for prior same-session teardown before continuation", async () => {
		// Purpose: terminal continuation must hand off one saved session only after the prior process fully closes.
		// Input and expected output: normal completion reaches the event sink, continuation remains unspawned until close, then one new prompt accepts on the same session reference.
		// Edge case: prior abort has started and its close is deliberately held while continuation is requested.
		// Dependencies: production completion callback, joinable supervisor teardown, controlled process queue, and Pi RPC prompt acceptance.
		// Arrange.
		const priorChild = createChildProcess({ closeOnStdinEnd: false });
		const continuationChild = createChildProcess();
		const events: InvocationEvent[] = [];
		const harness = createSupervisorHarness(
			[priorChild, continuationChild],
			events,
		);
		const priorAcceptance = await acceptStart(harness.supervisor, priorChild);
		emitSuccessfulCompletion(priorChild, "done");
		await waitForWriteCount(priorChild, 2);
		let continuationSettled = false;

		// Act.
		const pendingContinuation = harness.supervisor
			.continue(terminalSession(priorAcceptance), "Continue saved work")
			.then((acceptance) => {
				continuationSettled = true;
				return acceptance;
			});
		await new Promise((resolve) => setTimeout(resolve, 0));
		const beforeClose = {
			spawnCount: harness.spawnCount(),
			continuationWrites: continuationChild.stdinWrites.length,
			continuationSettled,
			priorStillOpen:
				priorChild.exitCode === null && priorChild.signalCode === null,
		};
		priorChild.emitClose();
		await waitForWriteCount(continuationChild, 1);
		const settledBeforePromptAcceptance = continuationSettled;
		continuationChild.stdout?.emit(
			"data",
			Buffer.from(
				'{"id":"prompt","type":"response","command":"prompt","success":true}\n',
			),
		);
		const continuationAcceptance = await pendingContinuation;
		const continuationWriteCount = continuationChild.stdinWrites.length;
		await harness.supervisor.terminateLease(
			continuationAcceptance.runtimeLeaseId,
		);

		// Assert.
		expect({
			eventCount: events.filter((event) => event.kind === "terminal").length,
			beforeClose,
			settledBeforePromptAcceptance,
			continuationSettled,
			spawnCount: harness.spawnCount(),
			continuationWriteCount,
			sameChildPiSession:
				continuationAcceptance.childPiSessionId ===
				priorAcceptance.childPiSessionId,
			sameSessionFile:
				continuationAcceptance.childSessionFile ===
				priorAcceptance.childSessionFile,
		}).toEqual({
			eventCount: 1,
			beforeClose: {
				spawnCount: 1,
				continuationWrites: 0,
				continuationSettled: false,
				priorStillOpen: true,
			},
			settledBeforePromptAcceptance: false,
			continuationSettled: true,
			spawnCount: 2,
			continuationWriteCount: 1,
			sameChildPiSession: true,
			sameSessionFile: true,
		});
	});

	test("coordinates feedback completion before same-session handoff", async () => {
		// Purpose: the real terminal-feedback transition and terminal steer must preserve one-writer handoff ordering.
		// Input and expected output: coordinator completes one history destination, terminal steer remains unspawned until prior close, then one saved-session continuation accepts after prompt response.
		// Edge case: the coordinator transition queue awaits the supervisor's held teardown promise without polling.
		// Dependencies: production coordinator, supervisor, catalog, wait runtime, journal ports, and controlled process queue.
		// Arrange.
		const owner: OwnerIdentity = {
			ownerPiSessionId: "owner-1",
			ownerSessionFile: "/tmp/owner.jsonl",
		};
		const priorChild = createChildProcess({ closeOnStdinEnd: false });
		const continuationChild = createChildProcess();
		const events: InvocationEvent[] = [];
		let coordinator: SubagentCoordinator | undefined;
		const harness = createSupervisorHarness(
			[priorChild, continuationChild],
			events,
			(event) => {
				if (coordinator === undefined) {
					throw new Error("coordinator event sink is unavailable");
				}
				return coordinator.observeInvocation(event);
			},
		);
		const priorAcceptance = await acceptStart(harness.supervisor, priorChild);
		const session: LogicalSession = {
			...terminalSession(priorAcceptance),
			state: "active",
		};
		const catalog = new SessionCatalog();
		catalog.add(session);
		const store = new CoordinatorStoreFake();
		coordinator = new SubagentCoordinator({
			catalog,
			invocations: harness.supervisor,
			waits: new WaitCoordinator(),
			store,
			clock: { monotonicNow: () => 1, wallNow: () => 1 },
			isAgentAvailable: () => true,
		});
		coordinator.registerOwner(owner);
		emitSuccessfulCompletion(priorChild, "done");
		await waitForWriteCount(priorChild, 2);
		let steerSettled = false;

		// Act.
		const pendingSteer = coordinator
			.steer(owner, { sessionId: 1, prompt: "Continue saved work" })
			.then((result) => {
				steerSettled = true;
				return result;
			});
		await new Promise((resolve) => setTimeout(resolve, 0));
		const beforeClose = {
			state: catalog.get(owner, 1)?.state,
			historyDeliveries: store.historyFeedback.length,
			spawnCount: harness.spawnCount(),
			continuationWrites: continuationChild.stdinWrites.length,
			steerSettled,
		};
		priorChild.emitClose();
		await waitForWriteCount(continuationChild, 1);
		const settledBeforePromptAcceptance = steerSettled;
		continuationChild.stdout?.emit(
			"data",
			Buffer.from(
				'{"id":"prompt","type":"response","command":"prompt","success":true}\n',
			),
		);
		const result = await pendingSteer;
		const continuedSession = catalog.get(owner, 1);

		// Assert.
		expect({
			beforeClose,
			settledBeforePromptAcceptance,
			result,
			steerSettled,
			spawnCount: harness.spawnCount(),
			continuationWrites: continuationChild.stdinWrites.length,
			historyDeliveries: store.historyFeedback.length,
			eventCount: events.filter((event) => event.kind === "terminal").length,
			sameChildPiSession:
				continuedSession?.childPiSessionId === session.childPiSessionId,
			sameSessionFile:
				continuedSession?.childSessionFile === session.childSessionFile,
			continuedState: continuedSession?.state,
		}).toEqual({
			beforeClose: {
				state: "terminal-success",
				historyDeliveries: 1,
				spawnCount: 1,
				continuationWrites: 0,
				steerSettled: false,
			},
			settledBeforePromptAcceptance: false,
			result: { outcome: "accepted", sessionId: 1 },
			steerSettled: true,
			spawnCount: 2,
			continuationWrites: 1,
			historyDeliveries: 1,
			eventCount: 1,
			sameChildPiSession: true,
			sameSessionFile: true,
			continuedState: "active",
		});
	});

	test("rejects continuation when prior same-session teardown rejects", async () => {
		// Purpose: failed prior cessation must retain sole writer ownership and block a replacement process.
		// Input and expected output: terminal completion starts teardown, abort rejects, and continuation returns the same failure with one total spawn and no second prompt.
		// Edge case: continuation arrives after the retained teardown promise has already rejected.
		// Dependencies: production retained teardown promise and same-session invocation lookup.
		// Arrange.
		const priorChild = createChildProcess({
			closeOnStdinEnd: false,
			stdinEndError: new Error("controlled prior teardown failure"),
		});
		const continuationChild = createChildProcess();
		const events: InvocationEvent[] = [];
		const harness = createSupervisorHarness(
			[priorChild, continuationChild],
			events,
		);
		const priorAcceptance = await acceptStart(harness.supervisor, priorChild);
		emitSuccessfulCompletion(priorChild, "done");
		await waitForWriteCount(priorChild, 2);
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Act.
		let continuationError = "";
		let continuationAccepted = false;
		const continuation = harness.supervisor
			.continue(terminalSession(priorAcceptance), "Continue saved work")
			.then((acceptance) => {
				continuationAccepted = true;
				return acceptance;
			})
			.catch((error: unknown) => {
				continuationError =
					error instanceof Error ? error.message : String(error);
				return undefined;
			});
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (continuationChild.stdinWrites.length > 0) {
			continuationChild.stdout?.emit(
				"data",
				Buffer.from(
					'{"id":"prompt","type":"response","command":"prompt","success":true}\n',
				),
			);
		}
		const continuationAcceptance = await continuation;
		if (continuationAcceptance !== undefined) {
			await harness.supervisor.terminateLease(
				continuationAcceptance.runtimeLeaseId,
			);
		}

		// Assert.
		expect({
			eventCount: events.filter((event) => event.kind === "terminal").length,
			continuationError,
			continuationAccepted,
			spawnCount: harness.spawnCount(),
			continuationWrites: continuationChild.stdinWrites.length,
			priorStillOpen:
				priorChild.exitCode === null && priorChild.signalCode === null,
		}).toEqual({
			eventCount: 1,
			continuationError: "controlled prior teardown failure",
			continuationAccepted: false,
			spawnCount: 1,
			continuationWrites: 0,
			priorStillOpen: true,
		});
	});

	test("stops the transitive handle closure after intermediate signal escalation", async () => {
		// Purpose: fail-stop must not depend on an intermediate worker sending owner_stopping before signal escalation.
		// Input and expected output: A owns B, B owns C, and terminating A stops all handles while B exits only after SIGTERM.
		// Edge case: C is two ownership edges below A and receives no independent channel-failure observation.
		// Dependencies: supervisor current-parent handle ownership, retained teardown promises, and production process escalation.
		// Arrange.
		const childA = createChildProcess();
		const childB = createChildProcess({
			closeOnStdinEnd: false,
			closeOnSignal: "SIGTERM",
		});
		const childC = createChildProcess();
		const events: InvocationEvent[] = [];
		const harness = createSupervisorHarness([childA, childB, childC], events);
		const acceptanceA = await acceptStart(harness.supervisor, childA);
		const acceptanceB = await acceptStart(harness.supervisor, childB, {
			ownerPiSessionId: acceptanceA.childPiSessionId,
			ownerRuntimeLeaseId: acceptanceA.runtimeLeaseId,
		});
		const acceptanceC = await acceptStart(harness.supervisor, childC, {
			ownerPiSessionId: acceptanceB.childPiSessionId,
			ownerRuntimeLeaseId: acceptanceB.runtimeLeaseId,
		});

		// Act.
		await harness.supervisor.terminateLease(acceptanceA.runtimeLeaseId);
		const facts = {
			bSignals: childB.signals,
			abortWrites: [childA, childB, childC].map(
				(child) => child.stdinWrites.length,
			),
			activeDepths: [acceptanceA, acceptanceB, acceptanceC].map((acceptance) =>
				harness.supervisor.findRuntimeDepth(acceptance.runtimeLeaseId),
			),
		};
		if (childC.exitCode === null && childC.signalCode === null) {
			childC.emitClose();
		}

		// Assert.
		expect(facts).toEqual({
			bSignals: ["SIGTERM"],
			abortWrites: [2, 2, 2],
			activeDepths: [undefined, undefined, undefined],
		});
	}, 15_000);

	test("graceful owner stop closes transitive state and resources", async () => {
		// Purpose: graceful owner_stopping must close descendant state and resources without intermediate owner_stopping messages.
		// Input and expected output: A stops; B owns a pending wait and writer; B reaches SIGTERM; B and C terminalize, stop, release, and reconcile.
		// Edge case: C emits no failure event, so graceful closure is the only state and resource authority for C.
		// Dependencies: coordinator closure snapshot, supervisor escalation, wait cancellation, writer release, and offline reconciliation.
		// Arrange.
		const childA = createChildProcess({ closeOnStdinEnd: false });
		const childB = createChildProcess({
			closeOnStdinEnd: false,
			closeOnSignal: "SIGTERM",
		});
		const childC = createChildProcess();
		const events: InvocationEvent[] = [];
		const harness = createSupervisorHarness([childA, childB, childC], events);
		const acceptanceA = await acceptStart(harness.supervisor, childA);
		const acceptanceB = await acceptStart(harness.supervisor, childB, {
			ownerPiSessionId: acceptanceA.childPiSessionId,
			ownerRuntimeLeaseId: acceptanceA.runtimeLeaseId,
		});
		const acceptanceC = await acceptStart(harness.supervisor, childC, {
			ownerPiSessionId: acceptanceB.childPiSessionId,
			ownerRuntimeLeaseId: acceptanceB.runtimeLeaseId,
		});
		const rootOwner: OwnerIdentity = {
			ownerPiSessionId: "owner-1",
			ownerSessionFile: "/tmp/owner-1.jsonl",
		};
		const ownerA: OwnerIdentity = {
			ownerPiSessionId: acceptanceA.childPiSessionId,
			ownerSessionFile: acceptanceA.childSessionFile,
		};
		const ownerB: OwnerIdentity = {
			ownerPiSessionId: acceptanceB.childPiSessionId,
			ownerSessionFile: acceptanceB.childSessionFile,
		};
		const ownerC: OwnerIdentity = {
			ownerPiSessionId: acceptanceC.childPiSessionId,
			ownerSessionFile: acceptanceC.childSessionFile,
		};
		const sessionA: LogicalSession = {
			key: {
				ownerPiSessionId: rootOwner.ownerPiSessionId,
				ownerLocalSessionId: 1,
			},
			childPiSessionId: ownerA.ownerPiSessionId,
			childSessionDir: acceptanceA.childSessionDir,
			childSessionFile: acceptanceA.childSessionFile,
			agentId: "SubAgentCoder",
			taskName: "A",
			creationOrder: 1,
			invocationId: acceptanceA.invocationId,
			runtimeLeaseId: acceptanceA.runtimeLeaseId,
			invocationMetadata: invocationMetadataFor(acceptanceA),
			state: "active",
		};
		const sessionB: LogicalSession = {
			...sessionA,
			key: {
				ownerPiSessionId: ownerA.ownerPiSessionId,
				ownerLocalSessionId: 1,
			},
			childPiSessionId: ownerB.ownerPiSessionId,
			childSessionDir: acceptanceB.childSessionDir,
			childSessionFile: acceptanceB.childSessionFile,
			taskName: "B",
			invocationId: acceptanceB.invocationId,
			runtimeLeaseId: acceptanceB.runtimeLeaseId,
			ownerRuntimeLeaseId: acceptanceA.runtimeLeaseId,
		};
		const sessionC: LogicalSession = {
			...sessionA,
			key: {
				ownerPiSessionId: ownerB.ownerPiSessionId,
				ownerLocalSessionId: 1,
			},
			childPiSessionId: ownerC.ownerPiSessionId,
			childSessionDir: acceptanceC.childSessionDir,
			childSessionFile: acceptanceC.childSessionFile,
			taskName: "C",
			invocationId: acceptanceC.invocationId,
			runtimeLeaseId: acceptanceC.runtimeLeaseId,
			ownerRuntimeLeaseId: acceptanceB.runtimeLeaseId,
		};
		const catalog = new SessionCatalog();
		for (const session of [sessionA, sessionB, sessionC]) {
			catalog.add(session);
		}
		const waits = new WaitCoordinator();
		const store = new CoordinatorStoreFake();
		let coordinator: SubagentCoordinator | undefined;
		coordinator = new SubagentCoordinator({
			catalog,
			invocations: harness.supervisor,
			waits,
			store,
			clock: {
				monotonicNow: () => performance.now(),
				wallNow: () => Date.now(),
			},
			isAgentAvailable: () => true,
		});
		for (const owner of [rootOwner, ownerA, ownerB]) {
			coordinator.registerOwner(owner);
		}
		for (const [owner, runtimeLeaseId] of [
			[ownerA, acceptanceA.runtimeLeaseId],
			[ownerB, acceptanceB.runtimeLeaseId],
			[ownerC, acceptanceC.runtimeLeaseId],
		] as const) {
			store.registerRemote(owner, runtimeLeaseId);
		}
		store.closureLeaseIds.add(acceptanceB.runtimeLeaseId);
		store.closureLeaseIds.add(acceptanceC.runtimeLeaseId);
		store.closureLeaseIds.add(acceptanceA.runtimeLeaseId);
		store.processesStopped = () =>
			[childB, childC].every(
				(child) => child.exitCode !== null || child.signalCode !== null,
			);
		let waitCeased = false;
		const pendingWait = coordinator
			.wait(
				ownerB,
				{ sessionIds: [1], timeoutMs: 30_000 },
				{
					toolCallId: "b-pending-wait",
					requestId: "b-pending-wait",
					runtimeLeaseId: acceptanceB.runtimeLeaseId,
				},
			)
			.catch(() => {
				waitCeased = true;
			});
		await Promise.resolve();

		// Act.
		await recoverOwnerShutdown({
			coordinator,
			store,
			owner: ownerA,
			stoppingRuntimeLeaseId: acceptanceA.runtimeLeaseId,
		});
		await Promise.resolve();
		const facts = {
			states: [catalog.get(ownerA, 1)?.state, catalog.get(ownerB, 1)?.state],
			terminalInvocations: store.records.flatMap((record) =>
				record.kind === "terminal" ? [record.invocationId] : [],
			),
			waitCeased,
			bSignals: childB.signals,
			abortWrites: [childB, childC].map((child) => child.stdinWrites.length),
			processesClosed: [childB, childC].map(
				(child) => child.exitCode !== null || child.signalCode !== null,
			),
			cFailureEvents: events.filter(
				(event) =>
					event.kind === "accepted-exit" &&
					event.invocationId === acceptanceC.invocationId,
			).length,
			releasedLeases: store.releasedLeases,
			releasedAfterProcessStop: store.releasedAfterProcessStop,
			reconciledOwners: store.reconciledOwners,
			reconciledAfterCompleteRelease: store.reconciledAfterCompleteRelease,
			remainingWriters: [...store.remoteOwners.keys()],
		};
		if (!waitCeased) {
			await coordinator.shutdown(ownerB);
		}
		await pendingWait;
		childA.emitClose();

		// Assert.
		expect(facts).toEqual({
			states: ["terminal-aborted", "terminal-aborted"],
			terminalInvocations: [acceptanceB.invocationId, acceptanceC.invocationId],
			waitCeased: true,
			bSignals: ["SIGTERM"],
			abortWrites: [2, 2],
			processesClosed: [true, true],
			cFailureEvents: 0,
			releasedLeases: [
				acceptanceB.runtimeLeaseId,
				acceptanceC.runtimeLeaseId,
				acceptanceA.runtimeLeaseId,
			],
			releasedAfterProcessStop: [true, true, true],
			reconciledOwners: [
				ownerA.ownerPiSessionId,
				ownerB.ownerPiSessionId,
				ownerC.ownerPiSessionId,
			],
			reconciledAfterCompleteRelease: [true, true, true],
			remainingWriters: [],
		});
	}, 15_000);

	test("hands off a stopping owner's deferred normal terminal", async () => {
		// Purpose: owner_stopping must move deferred normal-first state from the rejected remote writer to one offline public-session writer.
		// Input and expected output: B succeeds under A, remote append rejects while A stays connected, B escalates during shutdown, and reopen keeps one success history.
		// Edge case: repeated reconciliation must not replace success with unmatched-active abort or duplicate terminal, history, or disposition records.
		// Dependencies: production coordinator and supervisor, graceful recovery, public SessionManager persistence, and idempotent reconciliation.
		const directory = mkdtempSync(
			join(tmpdir(), "subagents-graceful-handoff-"),
		);
		try {
			const childA = createChildProcess({ closeOnStdinEnd: false });
			const childB = createChildProcess({
				closeOnStdinEnd: false,
				closeOnSignal: "SIGTERM",
			});
			const childC = createChildProcess();
			const events: InvocationEvent[] = [];
			let runtimeRequestSink: RuntimeRequestSink | undefined;
			const harness = createSupervisorHarness(
				[childA, childB, childC],
				events,
				undefined,
				(owner, request) => {
					if (runtimeRequestSink === undefined) {
						throw new Error("runtime request sink is not configured");
					}
					return runtimeRequestSink(owner, request);
				},
			);
			const acceptanceA = await acceptStart(harness.supervisor, childA);
			const acceptanceB = await acceptStart(harness.supervisor, childB, {
				ownerPiSessionId: acceptanceA.childPiSessionId,
				ownerRuntimeLeaseId: acceptanceA.runtimeLeaseId,
			});
			const acceptanceC = await acceptStart(harness.supervisor, childC, {
				ownerPiSessionId: acceptanceB.childPiSessionId,
				ownerRuntimeLeaseId: acceptanceB.runtimeLeaseId,
			});
			const managerA = createGracefulOwnerManager(
				directory,
				acceptanceA.childPiSessionId,
			);
			const managerB = createGracefulOwnerManager(
				directory,
				acceptanceB.childPiSessionId,
			);
			const ownerASessionFile = managerA.getSessionFile();
			const ownerBSessionFile = managerB.getSessionFile();
			if (ownerASessionFile === undefined || ownerBSessionFile === undefined) {
				throw new Error("graceful owner session file was not created");
			}
			const rootOwner: OwnerIdentity = {
				ownerPiSessionId: "graceful-handoff-root",
				ownerSessionFile: join(directory, "root.jsonl"),
			};
			const ownerA: OwnerIdentity = {
				ownerPiSessionId: acceptanceA.childPiSessionId,
				ownerSessionFile: ownerASessionFile,
			};
			const ownerB: OwnerIdentity = {
				ownerPiSessionId: acceptanceB.childPiSessionId,
				ownerSessionFile: ownerBSessionFile,
			};
			const sessionA: LogicalSession = {
				key: {
					ownerPiSessionId: rootOwner.ownerPiSessionId,
					ownerLocalSessionId: 1,
				},
				childPiSessionId: ownerA.ownerPiSessionId,
				childSessionDir: directory,
				childSessionFile: ownerASessionFile,
				agentId: "SubAgentCoder",
				taskName: "A",
				creationOrder: 1,
				invocationId: acceptanceA.invocationId,
				runtimeLeaseId: acceptanceA.runtimeLeaseId,
				invocationMetadata: invocationMetadataFor(acceptanceA),
				state: "active",
			};
			const sessionB: LogicalSession = {
				...sessionA,
				key: {
					ownerPiSessionId: ownerA.ownerPiSessionId,
					ownerLocalSessionId: 1,
				},
				childPiSessionId: ownerB.ownerPiSessionId,
				childSessionFile: ownerBSessionFile,
				taskName: "B",
				invocationId: acceptanceB.invocationId,
				runtimeLeaseId: acceptanceB.runtimeLeaseId,
				ownerRuntimeLeaseId: acceptanceA.runtimeLeaseId,
				invocationMetadata: invocationMetadataFor(acceptanceB),
			};
			const sessionC: LogicalSession = {
				...sessionA,
				key: {
					ownerPiSessionId: ownerB.ownerPiSessionId,
					ownerLocalSessionId: 1,
				},
				childPiSessionId: acceptanceC.childPiSessionId,
				childSessionFile: join(directory, "missing-c.jsonl"),
				taskName: "C",
				invocationId: acceptanceC.invocationId,
				runtimeLeaseId: acceptanceC.runtimeLeaseId,
				ownerRuntimeLeaseId: acceptanceB.runtimeLeaseId,
				invocationMetadata: invocationMetadataFor(acceptanceC),
			};
			managerA.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
				kind: "session-accepted",
				session: sessionB,
			});
			managerB.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
				kind: "session-accepted",
				session: sessionC,
			});
			let rejectedRemoteAppends = 0;
			const store = new SessionStore({
				append: async (remoteOwner, record) => {
					if (
						remoteOwner.ownerPiSessionId === ownerA.ownerPiSessionId &&
						record.kind === "terminal" &&
						record.invocationId === sessionB.invocationId
					) {
						rejectedRemoteAppends += 1;
						throw new Error("controlled application append rejection");
					}
					const manager =
						remoteOwner.ownerPiSessionId === ownerB.ownerPiSessionId
							? managerB
							: managerA;
					manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, record);
				},
				appendHistory: async () => {
					throw new Error("remote history must not run during writer handoff");
				},
			});
			store.registerRemote(ownerA, acceptanceA.runtimeLeaseId);
			store.registerRemote(ownerB, acceptanceB.runtimeLeaseId);
			const catalog = new SessionCatalog();
			for (const session of [sessionA, sessionB, sessionC]) {
				catalog.add(session);
			}
			const waits = new WaitCoordinator();
			const coordinator = new SubagentCoordinator({
				catalog,
				invocations: harness.supervisor,
				waits,
				store,
				clock: {
					monotonicNow: () => performance.now(),
					wallNow: () => Date.now(),
				},
				isAgentAvailable: () => true,
			});
			for (const owner of [rootOwner, ownerA, ownerB]) {
				coordinator.registerOwner(owner);
			}
			let waitCeased = false;
			const pendingWait = coordinator
				.wait(
					ownerB,
					{ sessionIds: [1], timeoutMs: 30_000 },
					{
						toolCallId: "handoff-wait",
						requestId: "handoff-wait",
						runtimeLeaseId: acceptanceB.runtimeLeaseId,
					},
				)
				.catch(() => {
					waitCeased = true;
				});
			await Promise.resolve();
			let terminalRejected = false;
			try {
				await coordinator.observeInvocation({
					kind: "terminal",
					invocationId: sessionB.invocationId,
					status: "success",
					text: "graceful normal output",
				});
			} catch {
				terminalRejected = true;
			}
			const releasedLeases: string[] = [];
			const releasedAfterDescendantStop: boolean[] = [];
			const reconciledOwners: string[] = [];
			const reconciledAfterCompleteRelease: boolean[] = [];
			const expectedReleases = [
				acceptanceB.runtimeLeaseId,
				acceptanceC.runtimeLeaseId,
				acceptanceA.runtimeLeaseId,
			];

			let ownerStoppingRequestLease = "";
			runtimeRequestSink = async (requestOwner, request) => {
				if (
					requestOwner.ownerPiSessionId !== ownerA.ownerPiSessionId ||
					request.operation !== "owner_stopping"
				) {
					throw new Error("unexpected graceful runtime request");
				}
				ownerStoppingRequestLease = request.runtimeLeaseId;
				await recoverOwnerShutdown({
					coordinator,
					store: {
						releaseRemoteLease: (runtimeLeaseId) => {
							releasedLeases.push(runtimeLeaseId);
							releasedAfterDescendantStop.push(
								[childB, childC].every(
									(child) =>
										child.exitCode !== null || child.signalCode !== null,
								),
							);
							return store.releaseRemoteLease(runtimeLeaseId);
						},
						reconcileOffline: async (releasedOwner) => {
							reconciledOwners.push(releasedOwner.ownerPiSessionId);
							reconciledAfterCompleteRelease.push(
								expectedReleases.every((runtimeLeaseId) =>
									releasedLeases.includes(runtimeLeaseId),
								),
							);
							return store.reconcileOffline(releasedOwner);
						},
					},
					owner: ownerA,
					stoppingRuntimeLeaseId: request.runtimeLeaseId,
				});
				return { acknowledged: true };
			};

			// Act.
			const ownerStoppingRequestId = "graceful-owner-stopping";
			childA.emit("message", {
				kind: "subagents-request",
				source: "worker",
				request: {
					requestId: ownerStoppingRequestId,
					runtimeLeaseId: acceptanceA.runtimeLeaseId,
					ownerPiSessionId: ownerA.ownerPiSessionId,
					operation: "owner_stopping",
					payload: {},
				},
			});
			let ownerStoppingResponse: unknown;
			while (ownerStoppingResponse === undefined) {
				ownerStoppingResponse = childA.sentMessages.find(
					(message) =>
						typeof message === "object" &&
						message !== null &&
						Reflect.get(message, "kind") === "subagents-response" &&
						Reflect.get(message, "requestId") === ownerStoppingRequestId,
				);
				if (ownerStoppingResponse === undefined) {
					await new Promise((resolve) => setTimeout(resolve, 0));
				}
			}
			const responseResult =
				typeof ownerStoppingResponse === "object" &&
				ownerStoppingResponse !== null
					? Reflect.get(ownerStoppingResponse, "result")
					: undefined;
			const ownerStoppingAcknowledged =
				typeof ownerStoppingResponse === "object" &&
				ownerStoppingResponse !== null &&
				Reflect.get(ownerStoppingResponse, "succeeded") === true &&
				typeof responseResult === "object" &&
				responseResult !== null &&
				Reflect.get(responseResult, "acknowledged") === true;
			const acknowledgmentAfterOwnerReconciliation =
				reconciledOwners.includes(ownerA.ownerPiSessionId) &&
				readGracefulOwnerFacts(
					SessionManager.open(ownerASessionFile, directory, directory),
				).state === "terminal-success";
			childA.emit("message", {
				kind: "subagents-settled",
				runtimeLeaseId: acceptanceA.runtimeLeaseId,
				requestId: ownerStoppingRequestId,
			});
			const firstFacts = readGracefulOwnerFacts(
				SessionManager.open(ownerASessionFile, directory, directory),
			);
			const repeatedSessions = await store.reconcileOffline(ownerA);
			await coordinator.applyReconciledSessions(repeatedSessions);
			const repeatedFacts = readGracefulOwnerFacts(
				SessionManager.open(ownerASessionFile, directory, directory),
			);
			const connectedBeforeAcknowledgment =
				childA.exitCode === null && childA.signalCode === null;
			childA.emitClose();
			await pendingWait;

			// Assert.
			expect({
				terminalRejected,
				rejectedRemoteAppends,
				ownerStoppingRequestLease,
				ownerStoppingAcknowledged,
				acknowledgmentAfterOwnerReconciliation,
				connectedBeforeAcknowledgment,
				liveState: catalog.get(ownerA, 1)?.state,
				waitCeased,
				bSignals: childB.signals,
				cFailureEvents: events.filter(
					(event) =>
						event.kind === "accepted-exit" &&
						event.invocationId === acceptanceC.invocationId,
				).length,
				releasedLeases,
				releasedAfterDescendantStop,
				reconciledOwners: [...reconciledOwners].sort(),
				reconciledAfterCompleteRelease,
				firstFacts,
				repeatedFacts,
			}).toEqual({
				terminalRejected: true,
				rejectedRemoteAppends: 1,
				ownerStoppingRequestLease: acceptanceA.runtimeLeaseId,
				ownerStoppingAcknowledged: true,
				acknowledgmentAfterOwnerReconciliation: true,
				connectedBeforeAcknowledgment: true,
				liveState: "terminal-success",
				waitCeased: true,
				bSignals: ["SIGTERM"],
				cFailureEvents: 0,
				releasedLeases: expectedReleases,
				releasedAfterDescendantStop: [true, true, true],
				reconciledOwners: [
					ownerA.ownerPiSessionId,
					ownerB.ownerPiSessionId,
				].sort(),
				reconciledAfterCompleteRelease: [true, true],
				firstFacts: {
					state: "terminal-success",
					terminalStates: ["terminal-success"],
					historyContents: [
						"Subagent 1 completed successfully:\nDuration: 1 seconds\ngraceful normal output",
					],
					historyStatuses: ["success"],
					historyCommitCount: 1,
				},
				repeatedFacts: {
					state: "terminal-success",
					terminalStates: ["terminal-success"],
					historyContents: [
						"Subagent 1 completed successfully:\nDuration: 1 seconds\ngraceful normal output",
					],
					historyStatuses: ["success"],
					historyCommitCount: 1,
				},
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 15_000);

	test("root session shutdown recovers descendant deferred terminals", async () => {
		// Purpose: top-level session_shutdown must await closure writer handoff before root runtime disposal.
		// Input and expected output: B succeeds under A, remote append rejects while connected, A reaches SIGTERM, and root shutdown persists one success history.
		// Edge case: A sends no completed owner_stopping, so the root handler is the only recovery authority before public reopen.
		// Dependencies: production coordinator and supervisor, root active writer, public SessionManager persistence, and repeated reconciliation.
		const directory = mkdtempSync(join(tmpdir(), "subagents-root-shutdown-"));
		try {
			const childA = createChildProcess({
				closeOnStdinEnd: false,
				closeOnSignal: "SIGTERM",
			});
			const childB = createChildProcess();
			const events: InvocationEvent[] = [];
			const harness = createSupervisorHarness([childA, childB], events);
			const acceptanceA = await acceptStart(harness.supervisor, childA);
			const acceptanceB = await acceptStart(harness.supervisor, childB, {
				ownerPiSessionId: acceptanceA.childPiSessionId,
				ownerRuntimeLeaseId: acceptanceA.runtimeLeaseId,
			});
			const rootManager = createGracefulOwnerManager(
				directory,
				"root-shutdown-owner",
			);
			const managerA = createGracefulOwnerManager(
				directory,
				acceptanceA.childPiSessionId,
			);
			const rootSessionFile = rootManager.getSessionFile();
			const ownerASessionFile = managerA.getSessionFile();
			if (rootSessionFile === undefined || ownerASessionFile === undefined) {
				throw new Error("root shutdown session file was not created");
			}
			const rootOwner: OwnerIdentity = {
				ownerPiSessionId: rootManager.getSessionId(),
				ownerSessionFile: rootSessionFile,
			};
			const ownerA: OwnerIdentity = {
				ownerPiSessionId: acceptanceA.childPiSessionId,
				ownerSessionFile: ownerASessionFile,
			};
			const sessionA: LogicalSession = {
				key: {
					ownerPiSessionId: rootOwner.ownerPiSessionId,
					ownerLocalSessionId: 1,
				},
				childPiSessionId: ownerA.ownerPiSessionId,
				childSessionDir: directory,
				childSessionFile: ownerASessionFile,
				agentId: "SubAgentCoder",
				taskName: "A",
				creationOrder: 1,
				invocationId: acceptanceA.invocationId,
				runtimeLeaseId: acceptanceA.runtimeLeaseId,
				invocationMetadata: invocationMetadataFor(acceptanceA),
				state: "active",
			};
			const sessionB: LogicalSession = {
				...sessionA,
				key: {
					ownerPiSessionId: ownerA.ownerPiSessionId,
					ownerLocalSessionId: 1,
				},
				childPiSessionId: acceptanceB.childPiSessionId,
				childSessionFile: join(directory, "missing-b.jsonl"),
				taskName: "B",
				invocationId: acceptanceB.invocationId,
				runtimeLeaseId: acceptanceB.runtimeLeaseId,
				ownerRuntimeLeaseId: acceptanceA.runtimeLeaseId,
				invocationMetadata: invocationMetadataFor(acceptanceB),
			};
			rootManager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
				kind: "session-accepted",
				session: {
					...sessionA,
					invocationMetadata: invocationMetadataFor(acceptanceA),
				},
			});
			managerA.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, {
				kind: "session-accepted",
				session: sessionB,
			});
			let rejectedRemoteAppends = 0;
			const store = new SessionStore({
				append: async (_remoteOwner, record) => {
					if (
						record.kind === "terminal" &&
						record.invocationId === sessionB.invocationId
					) {
						rejectedRemoteAppends += 1;
						throw new Error("controlled root-shutdown append rejection");
					}
					managerA.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, record);
				},
				appendHistory: async () => {
					throw new Error("remote history must not run during root shutdown");
				},
			});
			store.registerActive({
				owner: rootOwner,
				sessionManager: rootManager,
				appendJournal: (record) => {
					rootManager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, record);
				},
				appendHistory: () => {
					throw new Error("root history was not expected");
				},
			});
			store.registerRemote(ownerA, acceptanceA.runtimeLeaseId);
			const catalog = new SessionCatalog();
			catalog.add(sessionA);
			catalog.add(sessionB);
			const coordinator = new SubagentCoordinator({
				catalog,
				invocations: harness.supervisor,
				waits: new WaitCoordinator(),
				store,
				clock: {
					monotonicNow: () => performance.now(),
					wallNow: () => Date.now(),
				},
				isAgentAvailable: () => true,
			});
			coordinator.registerOwner(rootOwner);
			coordinator.registerOwner(ownerA);
			let terminalRejected = false;
			try {
				await coordinator.observeInvocation({
					kind: "terminal",
					invocationId: sessionB.invocationId,
					status: "success",
					text: "root shutdown normal output",
				});
			} catch {
				terminalRejected = true;
			}
			const releasedLeases: string[] = [];
			const releasedAfterProcessStop: boolean[] = [];
			const reconciledOwners: string[] = [];
			const reconciledAfterCompleteRelease: boolean[] = [];
			const expectedReleases = [
				acceptanceA.runtimeLeaseId,
				acceptanceB.runtimeLeaseId,
			];

			// Act: the root handler awaits recovery before active-writer disposal.
			await recoverRootShutdown({
				coordinator,
				store: {
					releaseRemoteLease: (runtimeLeaseId) => {
						releasedLeases.push(runtimeLeaseId);
						releasedAfterProcessStop.push(
							[childA, childB].every(
								(child) => child.exitCode !== null || child.signalCode !== null,
							),
						);
						return store.releaseRemoteLease(runtimeLeaseId);
					},
					reconcileOffline: async (releasedOwner) => {
						reconciledOwners.push(releasedOwner.ownerPiSessionId);
						reconciledAfterCompleteRelease.push(
							expectedReleases.every((runtimeLeaseId) =>
								releasedLeases.includes(runtimeLeaseId),
							),
						);
						return store.reconcileOffline(releasedOwner);
					},
				},
				owner: rootOwner,
			});
			store.unregisterActive(rootOwner.ownerPiSessionId);
			const recoveredClosure = [...releasedLeases];
			const rootHandlerReturnedAfterRecovery =
				reconciledOwners.includes(ownerA.ownerPiSessionId) &&
				readGracefulOwnerFacts(
					SessionManager.open(ownerASessionFile, directory, directory),
				).state === "terminal-success";
			const writerStillRegistered =
				store.releaseRemoteLease(acceptanceA.runtimeLeaseId).length > 0;
			const firstFacts = readGracefulOwnerFacts(
				SessionManager.open(ownerASessionFile, directory, directory),
			);
			const repeatedSessions = await store.reconcileOffline(ownerA);
			await coordinator.applyReconciledSessions(repeatedSessions);
			const repeatedFacts = readGracefulOwnerFacts(
				SessionManager.open(ownerASessionFile, directory, directory),
			);

			// Assert.
			expect({
				terminalRejected,
				rejectedRemoteAppends,
				recoveredClosure,
				rootHandlerReturnedAfterRecovery,
				writerStillRegistered,
				liveState: catalog.get(ownerA, 1)?.state,
				aSignals: childA.signals,
				bFailureEvents: events.filter(
					(event) =>
						event.kind === "accepted-exit" &&
						event.invocationId === acceptanceB.invocationId,
				).length,
				releasedLeases,
				releasedAfterProcessStop,
				reconciledOwners,
				reconciledAfterCompleteRelease,
				firstFacts,
				repeatedFacts,
			}).toEqual({
				terminalRejected: true,
				rejectedRemoteAppends: 1,
				recoveredClosure: expectedReleases,
				rootHandlerReturnedAfterRecovery: true,
				writerStillRegistered: false,
				liveState: "terminal-success",
				aSignals: ["SIGTERM"],
				bFailureEvents: 0,
				releasedLeases: expectedReleases,
				releasedAfterProcessStop: [true, true],
				reconciledOwners: [ownerA.ownerPiSessionId],
				reconciledAfterCompleteRelease: [true],
				firstFacts: {
					state: "terminal-success",
					terminalStates: ["terminal-success"],
					historyContents: [
						"Subagent 1 completed successfully:\nDuration: 1 seconds\nroot shutdown normal output",
					],
					historyStatuses: ["success"],
					historyCommitCount: 1,
				},
				repeatedFacts: {
					state: "terminal-success",
					terminalStates: ["terminal-success"],
					historyContents: [
						"Subagent 1 completed successfully:\nDuration: 1 seconds\nroot shutdown normal output",
					],
					historyStatuses: ["success"],
					historyCommitCount: 1,
				},
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 15_000);

	test("joins transitive fail-stop to a descendant normal teardown", async () => {
		// Purpose: normal-first teardown must remain the only teardown for a descendant later reached by transitive fail-stop.
		// Input and expected output: C completes normally before A fails; fail-stop joins C's retained teardown without another abort or terminal event.
		// Edge case: C remains process-active at the fail-stop boundary because its normal teardown is waiting for close.
		// Dependencies: completion ordering, transitive handle traversal, and idempotent stopHandle joining.
		const childA = createChildProcess({ closeOnStdinEnd: false });
		const childB = createChildProcess({ closeOnStdinEnd: false });
		const childC = createChildProcess({ closeOnStdinEnd: false });
		const events: InvocationEvent[] = [];
		const harness = createSupervisorHarness([childA, childB, childC], events);
		const acceptanceA = await acceptStart(harness.supervisor, childA);
		const acceptanceB = await acceptStart(harness.supervisor, childB, {
			ownerPiSessionId: acceptanceA.childPiSessionId,
			ownerRuntimeLeaseId: acceptanceA.runtimeLeaseId,
		});
		const acceptanceC = await acceptStart(harness.supervisor, childC, {
			ownerPiSessionId: acceptanceB.childPiSessionId,
			ownerRuntimeLeaseId: acceptanceB.runtimeLeaseId,
		});
		emitSuccessfulCompletion(childC, "C completed normally");
		await waitForWriteCount(childC, 2);

		const failStop = harness.supervisor.terminateLease(
			acceptanceA.runtimeLeaseId,
		);
		await Promise.all([
			waitForWriteCount(childA, 2),
			waitForWriteCount(childB, 2),
		]);
		const writesBeforeClose = childC.stdinWrites.length;
		for (const child of [childA, childB, childC]) {
			child.emitClose();
		}
		await failStop;

		expect({
			writesBeforeClose,
			writesAfterClose: childC.stdinWrites.length,
			terminalEvents: events.filter(
				(event) =>
					event.kind === "terminal" &&
					event.invocationId === acceptanceC.invocationId,
			).length,
			signals: [childA, childB, childC].flatMap((child) => child.signals),
			activeDepths: [acceptanceA, acceptanceB, acceptanceC].map((acceptance) =>
				harness.supervisor.findRuntimeDepth(acceptance.runtimeLeaseId),
			),
		}).toEqual({
			writesBeforeClose: 2,
			writesAfterClose: 2,
			terminalEvents: 1,
			signals: [],
			activeDepths: [undefined, undefined, undefined],
		});
	});

	test("waits for every transitive teardown before reporting one failure", async () => {
		// Purpose: one rejected teardown must not let fail-stop settle while another descendant still owns a process timer.
		// Input and expected output: A teardown rejects immediately, B remains pending, and the shared failure is reported only after B closes.
		// Edge case: writer recovery must remain blocked even though the first affected handle has already failed.
		// Dependencies: transitive handle selection, retained teardown promises, and wait-for-all rejection ordering.
		const childA = createChildProcess({
			stdinEndError: new Error("controlled A teardown failure"),
		});
		const childB = createChildProcess({ closeOnStdinEnd: false });
		const events: InvocationEvent[] = [];
		const harness = createSupervisorHarness([childA, childB], events);
		const acceptanceA = await acceptStart(harness.supervisor, childA);
		const acceptanceB = await acceptStart(harness.supervisor, childB, {
			ownerPiSessionId: acceptanceA.childPiSessionId,
			ownerRuntimeLeaseId: acceptanceA.runtimeLeaseId,
		});
		let rejection = "";

		const termination = harness.supervisor
			.terminateLease(acceptanceA.runtimeLeaseId)
			.catch((error: unknown) => {
				rejection = error instanceof Error ? error.message : String(error);
			});
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rejectionBeforeBClosed = rejection;
		const bActiveBeforeClose =
			childB.exitCode === null && childB.signalCode === null;
		childB.emitClose();
		await termination;

		expect({
			rejectionBeforeBClosed,
			bActiveBeforeClose,
			rejection,
			bRuntimeDepth: harness.supervisor.findRuntimeDepth(
				acceptanceB.runtimeLeaseId,
			),
		}).toEqual({
			rejectionBeforeBClosed: "",
			bActiveBeforeClose: true,
			rejection: "controlled A teardown failure",
			bRuntimeDepth: undefined,
		});
	});

	test("joins fail-stop recovery to normal process teardown", async () => {
		// Purpose: every overlapping teardown caller must await one process-close boundary before writer release or offline reconciliation.
		// Input and expected output: normal terminal cleanup starts first; direct and runtime-failure joins remain pending until controlled close, then release and reconciliation observe cessation.
		// Edge case: both later callers arrive after abort begins while exitCode and signalCode remain null.
		// Dependencies: production supervisor teardown, production runtime-failure ordering, controlled RPC completion, and controlled process close.
		// Arrange.
		const child = createChildProcess({ closeOnStdinEnd: false });
		const events: InvocationEvent[] = [];
		const supervisor = createSupervisor(child, events);
		const acceptance = await acceptStart(supervisor, child);
		emitSuccessfulCompletion(child, "done");
		await waitForWriteCount(child, 2);
		let directJoinSettled = false;
		let recoverySettled = false;
		const releasedAfterClose: boolean[] = [];
		const reconciledAfterClose: boolean[] = [];

		// Act.
		const directJoin = supervisor
			.terminateLease(acceptance.runtimeLeaseId)
			.then(() => {
				directJoinSettled = true;
			});
		const recovery = recoverRuntimeFailure(
			{
				observeRuntimeFailure: async () => {
					await supervisor.terminateLease(acceptance.runtimeLeaseId);
					return [acceptance.runtimeLeaseId];
				},
				persistDeferredTerminals: async () => undefined,
				applyReconciledSessions: async () => undefined,
			},
			{
				releaseRemoteLease: () => {
					releasedAfterClose.push(child.exitCode !== null);
					return [
						{
							ownerPiSessionId: "child-owner",
							ownerSessionFile: "/tmp/child-owner.jsonl",
						},
					];
				},
				reconcileOffline: async () => {
					reconciledAfterClose.push(child.exitCode !== null);
					return [];
				},
			},
			{
				runtimeLeaseId: acceptance.runtimeLeaseId,
				reason: "channel_disconnected",
			},
		).then(() => {
			recoverySettled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		const beforeClose = {
			directJoinSettled,
			recoverySettled,
			releaseCount: releasedAfterClose.length,
			reconciliationCount: reconciledAfterClose.length,
		};
		child.emitClose();
		await Promise.all([directJoin, recovery]);

		// Assert.
		expect({
			beforeClose,
			directJoinSettled,
			recoverySettled,
			releasedAfterClose,
			reconciledAfterClose,
		}).toEqual({
			beforeClose: {
				directJoinSettled: false,
				recoverySettled: false,
				releaseCount: 0,
				reconciliationCount: 0,
			},
			directJoinSettled: true,
			recoverySettled: true,
			releasedAfterClose: [true],
			reconciledAfterClose: [true],
		});
	});

	test("retains failed teardown for repeated runtime recovery", async () => {
		// Purpose: a teardown that cannot observe process close must remain joinable so later recovery cannot release the writer.
		// Input and expected output: normal terminal cleanup rejects during abort, then two channel-loss recoveries reject with zero release or reconciliation calls.
		// Edge case: the process remains active and the first internal teardown rejection has already settled before either recovery begins.
		// Dependencies: production supervisor teardown retention and production runtime-failure release ordering.
		// Arrange.
		const child = createChildProcess({
			closeOnStdinEnd: false,
			stdinEndError: new Error("controlled teardown failure"),
		});
		const events: InvocationEvent[] = [];
		const supervisor = createSupervisor(child, events);
		const acceptance = await acceptStart(supervisor, child);
		emitSuccessfulCompletion(child, "done");
		await waitForWriteCount(child, 2);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const recoveryErrors: string[] = [];
		let releases = 0;
		let reconciliations = 0;
		const coordinator = {
			observeRuntimeFailure: async () => {
				await supervisor.terminateLease(acceptance.runtimeLeaseId);
				return [acceptance.runtimeLeaseId];
			},
			persistDeferredTerminals: async () => undefined,
			applyReconciledSessions: async () => undefined,
		};
		const store = {
			releaseRemoteLease: () => {
				releases += 1;
				return [
					{
						ownerPiSessionId: "child-owner",
						ownerSessionFile: "/tmp/child-owner.jsonl",
					},
				];
			},
			reconcileOffline: async () => {
				reconciliations += 1;
				return [];
			},
		};

		// Act.
		for (const reason of [
			"channel_disconnected",
			"response_delivery_unknown",
		] as const) {
			try {
				await recoverRuntimeFailure(coordinator, store, {
					runtimeLeaseId: acceptance.runtimeLeaseId,
					reason,
				});
			} catch (error) {
				recoveryErrors.push(
					error instanceof Error ? error.message : String(error),
				);
			}
		}

		// Assert.
		expect({
			recoveryErrors,
			releases,
			reconciliations,
			processActive: child.exitCode === null && child.signalCode === null,
		}).toEqual({
			recoveryErrors: [
				"controlled teardown failure",
				"controlled teardown failure",
			],
			releases: 0,
			reconciliations: 0,
			processActive: true,
		});
	});

	test("maps a post-acceptance process exit before terminal", async () => {
		// Purpose: accepted process exit must remain an observation for coordinator first-event ordering.
		// Input and expected output: exit code 9 with no agent terminal event emits one accepted-exit event.
		// Edge case: every pending RPC command is already settled when the process exits.
		// Dependencies: controlled process close event and production parser flush.
		const child = createChildProcess();
		const events: InvocationEvent[] = [];
		const supervisor = createSupervisor(child, events);
		const acceptance = await acceptStart(supervisor, child);
		Object.assign(child, { exitCode: 9 });
		child.emit("close", 9, null);
		while (events.length === 0) {
			await Promise.resolve();
		}

		expect(events).toEqual([
			{
				kind: "accepted-exit",
				invocationId: acceptance.invocationId,
				exitCode: 9,
				signal: null,
			},
		]);
	});
});

/** Reads a captured RPC command ID without casting parsed data. */
function readCommandId(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const parsed: unknown = JSON.parse(value);
	const id =
		typeof parsed === "object" && parsed !== null
			? Reflect.get(parsed, "id")
			: undefined;
	return typeof id === "string" ? id : undefined;
}
