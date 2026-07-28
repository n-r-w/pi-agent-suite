import { expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type SubagentNormalResult,
	SubagentToolError,
} from "../../pi-package/extensions/run-subagent/contracts";
import { SubagentCoordinator } from "../../pi-package/extensions/run-subagent/coordinator";
import type {
	LogicalSession,
	OwnerIdentity,
} from "../../pi-package/extensions/run-subagent/domain";
import { InvocationSupervisor } from "../../pi-package/extensions/run-subagent/invocation-supervisor";
import { V2SessionStore } from "../../pi-package/extensions/run-subagent/persistence";
import {
	RootRuntimeBridge,
	type RuntimeChannelFailure,
} from "../../pi-package/extensions/run-subagent/runtime-bridge";
import type { RuntimeRequest } from "../../pi-package/extensions/run-subagent/runtime-wire";
import { SessionCatalog } from "../../pi-package/extensions/run-subagent/session-catalog";
import {
	type WaitAdmission,
	WaitCoordinator,
} from "../../pi-package/extensions/run-subagent/wait-coordinator";

/** Records the first production wait admission without replacing resolver behavior. */
class ObservableWaitCoordinator extends WaitCoordinator {
	public readonly admitted: Promise<void>;
	private markAdmitted = (): void => undefined;

	/** Creates one admission gate around production wait mechanics. */
	public constructor() {
		super();
		this.admitted = new Promise((resolve) => {
			this.markAdmitted = resolve;
		});
	}

	/** Opens the observation gate before delegating to production admission. */
	public override admit(
		admission: WaitAdmission,
		onTimeout: () => void,
	): Promise<SubagentNormalResult> {
		this.markAdmitted();
		return super.admit(admission, onTimeout);
	}
}

/** Parses newline-delimited Pi RPC output and resolves the first matching object. */
function observeRpcMessage(
	process: ChildProcess,
	matches: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		let buffer = "";
		process.stdout?.on("data", (chunk: Buffer | string) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch {
					continue;
				}
				if (
					typeof value === "object" &&
					value !== null &&
					matches(value as Record<string, unknown>)
				) {
					resolve(value as Record<string, unknown>);
				}
			}
		});
	});
}

/** Resolves one command response from production Pi RPC output. */
function observeRpcResponse(
	process: ChildProcess,
	command: string,
): Promise<Record<string, unknown>> {
	return observeRpcMessage(
		process,
		(value) => value["type"] === "response" && value["command"] === command,
	);
}

/** Resolves after one bounded observation interval without affecting the child process. */
function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Starts one local model stream that invokes all registered V2 tools in one turn. */
async function startAbortProbeServer(): Promise<{
	readonly server: Server;
	readonly baseUrl: string;
	readonly toolNames: () => readonly string[];
}> {
	let toolNames: string[] = [];
	const server = createServer((request, response) => {
		let requestBody = "";
		request.on("data", (chunk: Buffer | string) => {
			requestBody += chunk.toString();
		});
		request.on("end", () => {
			try {
				const value: unknown = JSON.parse(requestBody);
				const tools =
					typeof value === "object" && value !== null
						? Reflect.get(value, "tools")
						: undefined;
				toolNames = Array.isArray(tools)
					? tools.flatMap((tool) => {
							if (typeof tool !== "object" || tool === null) {
								return [];
							}
							const definition = Reflect.get(tool, "function");
							const name =
								typeof definition === "object" && definition !== null
									? Reflect.get(definition, "name")
									: Reflect.get(tool, "name");
							return typeof name === "string" ? [name] : [];
						})
					: [];
			} catch {
				toolNames = [];
			}
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			const toolCalls = [
				{
					index: 0,
					id: "rpc-start",
					type: "function",
					function: {
						name: "subagent_start",
						arguments: JSON.stringify({
							agentId: "MissingAgent",
							taskName: "RPC registration",
							prompt: "work",
						}),
					},
				},
				{
					index: 1,
					id: "rpc-steer",
					type: "function",
					function: {
						name: "subagent_steer",
						arguments: JSON.stringify({
							sessionId: 999,
							prompt: "change",
						}),
					},
				},
				{
					index: 2,
					id: "nested-rpc-wait",
					type: "function",
					function: {
						name: "subagent_wait",
						arguments: JSON.stringify({
							sessionIds: [1],
							timeoutMs: 2_147_483_647,
						}),
					},
				},
			];
			const common = {
				id: "runtime-wait-response",
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1_000),
				model: "wait",
			};
			response.write(
				`data: ${JSON.stringify({
					...common,
					choices: [
						{
							index: 0,
							delta: { role: "assistant", tool_calls: toolCalls },
							finish_reason: null,
						},
					],
				})}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({
					...common,
					choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
				})}\n\n`,
			);
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("abort probe server did not bind a TCP port");
	}
	return {
		server,
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		toolNames: () => toolNames,
	};
}

/** Writes one isolated models.json entry for the local abort probe server. */
function writeAbortProbeModel(agentDirectory: string, baseUrl: string): void {
	mkdirSync(agentDirectory, { recursive: true });
	writeFileSync(
		join(agentDirectory, "models.json"),
		JSON.stringify({
			providers: {
				"runtime-wait": {
					baseUrl,
					api: "openai-completions",
					apiKey: "runtime-wait-test-key",
					models: [
						{
							id: "wait",
							name: "Runtime Wait",
							reasoning: false,
							input: ["text"],
							contextWindow: 4_096,
							maxTokens: 256,
						},
					],
				},
			},
		}),
	);
}

test("production Pi RPC abort cancels one pending nested wait", async () => {
	// Purpose: the real Pi RPC abort command must become idle through the correlated nested wait cancellation path.
	// Input and expected output: a package-loaded worker enters subagent_wait; abort receives success within the prompt window and root handles one cancel_wait.
	// Edge case: no child feedback or wait timeout is available to unblock the RPC command.
	// Dependencies: local pi CLI, deterministic custom provider, production extension package, Node IPC bridge, coordinator, and system temporary state.
	const directory = mkdtempSync(join(tmpdir(), "subagents-v2-rpc-abort-"));
	const workers: ChildProcess[] = [];
	let workerDiagnostics = "";
	const bridge = new RootRuntimeBridge();
	const waits = new ObservableWaitCoordinator();
	const catalog = new SessionCatalog();
	let coordinator: SubagentCoordinator | undefined;
	let cancellationCalls = 0;
	const agentOperationCalls: string[] = [];
	let runtimeFailure: RuntimeChannelFailure | undefined;
	let modelServer: Server | undefined;
	try {
		const probe = await startAbortProbeServer();
		modelServer = probe.server;
		const agentDirectory = join(directory, "agent");
		writeAbortProbeModel(agentDirectory, probe.baseUrl);
		let supervisor: InvocationSupervisor | undefined;
		const store = new V2SessionStore({
			append: async (owner, record) => {
				const lease = supervisor?.findRuntimeLeaseForOwner(
					owner.ownerPiSessionId,
				);
				if (lease === undefined) {
					throw new Error("remote owner lease is unavailable");
				}
				await bridge.request(lease, "append_journal", record);
			},
			appendHistory: async (owner, feedback) => {
				const lease = supervisor?.findRuntimeLeaseForOwner(
					owner.ownerPiSessionId,
				);
				if (lease === undefined) {
					throw new Error("remote owner lease is unavailable");
				}
				await bridge.request(lease, "append_history", feedback);
			},
		});
		supervisor = new InvocationSupervisor({
			bridge,
			packagePath: join(
				process.cwd(),
				"pi-package/extensions/run-subagent/index.ts",
			),
			childEnvironment: {
				JITI_FS_CACHE: "0",
				JITI_REBUILD_FS_CACHE: "1",
				PI_AGENT_SUITE_DIR: join(directory, "agent-suite"),
				PI_CODING_AGENT_DIR: agentDirectory,
			},
			onEvent: () => undefined,
			onRuntimeFailure: (failure) => {
				runtimeFailure = failure;
			},
			onRuntimeRequest: async (owner, request) => {
				if (coordinator === undefined) {
					throw new Error("coordinator is unavailable");
				}
				return handleRuntimeRequest(
					coordinator,
					owner,
					request,
					(toolName) => agentOperationCalls.push(toolName),
					() => {
						cancellationCalls += 1;
					},
				);
			},
			spawnProcess: (command, args, options) => {
				const worker = spawn(command, [...args], options);
				worker.stderr?.on("data", (chunk: Buffer | string) => {
					workerDiagnostics += chunk.toString();
				});
				worker.stdout?.on("data", (chunk: Buffer | string) => {
					workerDiagnostics += chunk.toString();
				});
				workers.push(worker);
				return worker;
			},
		});
		coordinator = new SubagentCoordinator({
			catalog,
			invocations: supervisor,
			waits,
			store,
			clock: {
				monotonicNow: () => performance.now(),
				wallNow: () => Date.now(),
			},
			isAgentAvailable: (_owner, agentId) => agentId === "SubAgentCoder",
		});
		const agentsDirectory = join(
			directory,
			"agent-suite/agent-selection/agents",
		);
		mkdirSync(agentsDirectory, { recursive: true });
		writeFileSync(
			join(agentsDirectory, "SubAgentCoder.md"),
			[
				"---",
				"description: RPC abort parent",
				"type: subagent",
				"tools:",
				"  - subagent_start",
				"  - subagent_steer",
				"  - subagent_wait",
				"---",
				"Wait for the active child.",
			].join("\n"),
		);
		const configDirectory = join(directory, "agent-suite/run-subagent");
		mkdirSync(configDirectory, { recursive: true });
		writeFileSync(
			join(configDirectory, "config.json"),
			JSON.stringify({ enabled: true, maxDepth: 2 }),
		);
		const parent = await supervisor.launchWorker({
			owner: {
				ownerPiSessionId: "root-owner",
				ownerSessionFile: join(directory, "root.jsonl"),
			},
			sessionKey: {
				ownerPiSessionId: "root-owner",
				ownerLocalSessionId: 1,
			},
			agentId: "SubAgentCoder",
			taskName: "RPC abort parent",
			childSessionDir: join(directory, "parent"),
			launchConfiguration: {
				cwd: process.cwd(),
				modelId: "runtime-wait/wait",
				provider: "runtime-wait",
				thinking: "off",
				toolPatterns: ["subagent_start", "subagent_steer", "subagent_wait"],
				depth: 1,
				parentAuthVerified: true,
				runtimeFacts: {
					modelProvider: "runtime-wait",
					modelId: "wait",
					contextWindow: 4096,
				},
			},
		});
		const parentOwner: OwnerIdentity = {
			ownerPiSessionId: parent.childPiSessionId,
			ownerSessionFile: parent.childSessionFile,
		};
		const descendant: LogicalSession = {
			key: {
				ownerPiSessionId: parentOwner.ownerPiSessionId,
				ownerLocalSessionId: 1,
			},
			childPiSessionId: "logical-descendant",
			childSessionDir: join(directory, "descendant"),
			childSessionFile: join(directory, "descendant", "session.jsonl"),
			agentId: "SubAgentCoder",
			taskName: "Logical descendant",
			creationOrder: 1,
			invocationId: "logical-descendant-invocation",
			runtimeLeaseId: "logical-descendant-lease",
			ownerRuntimeLeaseId: parent.runtimeLeaseId,
			invocationMetadata: {
				startedAtMs: 1_700_000_000_000,
				elapsedMs: 1_000,
			},
			state: "active",
		};
		await bridge.request(parent.runtimeLeaseId, "append_journal", {
			kind: "session-accepted",
			session: descendant,
		});
		store.registerRemote(parentOwner, parent.runtimeLeaseId);
		catalog.add(descendant);
		coordinator.registerOwner(parentOwner);
		const parentProcess = workers[0];
		if (parentProcess?.stdin === null || parentProcess?.stdin === undefined) {
			throw new Error("production parent worker stdin is unavailable");
		}
		const abortResponse = observeRpcResponse(parentProcess, "abort");
		parentProcess.stdin.write(
			`${JSON.stringify({ id: "rpc-prompt", type: "prompt", message: "wait" })}\n`,
		);
		const admissionObserved = await Promise.race([
			waits.admitted.then(() => true),
			delay(2_000).then(() => false),
		]);
		if (!admissionObserved) {
			throw new Error(
				`production nested wait was not admitted; model tools=${probe.toolNames().join(",")}: ${workerDiagnostics}`,
			);
		}

		parentProcess.stdin.write(
			`${JSON.stringify({ id: "rpc-abort", type: "abort" })}\n`,
		);
		const promptAbortOutcome = await Promise.race([
			abortResponse.then(() => "settled" as const),
			delay(1_000).then(() => "pending" as const),
		]);
		if (promptAbortOutcome === "pending") {
			await coordinator.shutdown(parentOwner);
		}
		const finalAbortResponse = await Promise.race([
			abortResponse,
			delay(1_000).then(() => ({ success: false, timeout: true })),
		]);

		expect({
			promptAbortOutcome,
			abortSucceeded: finalAbortResponse["success"],
			modelToolNames: probe.toolNames(),
			agentOperationCalls: agentOperationCalls.sort(),
			cancellationCalls,
			runtimeFailure,
		}).toEqual({
			promptAbortOutcome: "settled",
			abortSucceeded: true,
			modelToolNames: ["subagent_start", "subagent_steer", "subagent_wait"],
			agentOperationCalls: [
				"subagent_start",
				"subagent_steer",
				"subagent_wait",
			],
			cancellationCalls: 1,
			runtimeFailure: undefined,
		});
	} finally {
		for (const worker of workers) {
			if (worker.exitCode === null && worker.signalCode === null) {
				worker.kill("SIGKILL");
			}
		}
		if (modelServer !== undefined) {
			modelServer.closeAllConnections();
			await new Promise<void>((resolve) => modelServer?.close(() => resolve()));
		}
		rmSync(directory, { recursive: true, force: true });
	}
}, 10_000);

/** Routes production V2 worker operations required by the RPC abort scenario. */
async function handleRuntimeRequest(
	coordinator: SubagentCoordinator,
	owner: OwnerIdentity,
	request: RuntimeRequest,
	onAgentOperation: (toolName: string) => void,
	onCancellation: () => void,
): Promise<unknown> {
	if (request.operation === "agent_operation") {
		const operation = request.payload;
		onAgentOperation(operation.toolName);
		try {
			if (operation.toolName === "subagent_start") {
				return {
					kind: "ok",
					result: await coordinator.start(owner, operation.params, {
						ownerRuntimeLeaseId: request.runtimeLeaseId,
					}),
				};
			}
			if (operation.toolName === "subagent_steer") {
				return {
					kind: "ok",
					result: await coordinator.steer(owner, operation.params, {
						ownerRuntimeLeaseId: request.runtimeLeaseId,
					}),
				};
			}
			return {
				kind: "ok",
				result: await coordinator.wait(owner, operation.params, {
					toolCallId: operation.toolCallId,
					requestId: request.requestId,
					runtimeLeaseId: request.runtimeLeaseId,
				}),
			};
		} catch (error) {
			if (error instanceof SubagentToolError) {
				return { kind: "failed", failure: error.details };
			}
			throw error;
		}
	}
	if (request.operation === "cancel_wait") {
		onCancellation();
		const cancelled = await coordinator.cancelWait(
			owner,
			{
				toolCallId: request.payload.waitToolCallId,
				requestId: request.payload.waitRequestId,
				runtimeLeaseId: request.runtimeLeaseId,
			},
			new Error("nested wait was aborted"),
		);
		if (!cancelled) {
			throw new Error("nested wait cancellation lost its correlation");
		}
		return { acknowledged: true };
	}
	throw new Error(`unexpected runtime operation ${request.operation}`);
}
