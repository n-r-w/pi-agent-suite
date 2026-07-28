import { expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SubagentCoordinator } from "../../pi-package/extensions/run-subagent/coordinator";
import type {
	InvocationMetadata,
	LogicalSession,
	OwnerIdentity,
} from "../../pi-package/extensions/run-subagent/domain";
import type { InvocationEvent } from "../../pi-package/extensions/run-subagent/invocation-contracts";
import { InvocationSupervisor } from "../../pi-package/extensions/run-subagent/invocation-supervisor";
import { V2SessionStore } from "../../pi-package/extensions/run-subagent/persistence";
import { RootRuntimeBridge } from "../../pi-package/extensions/run-subagent/runtime-bridge";
import { SessionCatalog } from "../../pi-package/extensions/run-subagent/session-catalog";
import { WaitCoordinator } from "../../pi-package/extensions/run-subagent/wait-coordinator";

/** Controls one deterministic two-turn model stream for real Pi steering. */
interface SteerProbe {
	readonly server: Server;
	readonly baseUrl: string;
	readonly firstRequestSeen: Promise<void>;
	releaseFirstResponse(): void;
	requestCount(): number;
}

/** Starts a local model whose first response remains pending while Pi queues steering. */
async function startSteerProbe(): Promise<SteerProbe> {
	let markFirstRequest = (): void => undefined;
	const firstRequestSeen = new Promise<void>((resolve) => {
		markFirstRequest = resolve;
	});
	let releaseFirstResponse = (): void => undefined;
	const firstResponseReleased = new Promise<void>((resolve) => {
		releaseFirstResponse = resolve;
	});
	let requestCount = 0;
	const server = createServer((request, response) => {
		let requestBody = "";
		request.on("data", (chunk: Buffer | string) => {
			requestBody += chunk.toString();
		});
		request.on("end", async () => {
			let requestParsed = false;
			try {
				JSON.parse(requestBody);
				requestParsed = true;
			} catch {}
			if (!requestParsed) {
				response.writeHead(400).end();
				return;
			}
			requestCount += 1;
			const currentRequest = requestCount;
			if (currentRequest === 1) {
				markFirstRequest();
			}
			if (currentRequest === 1) {
				await firstResponseReleased;
			}
			if (response.destroyed) {
				return;
			}
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			const common = {
				id: `steer-probe-${currentRequest}`,
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1_000),
				model: "steer",
			};
			response.write(
				`data: ${JSON.stringify({
					...common,
					choices: [
						{
							index: 0,
							delta: {
								role: "assistant",
								content:
									currentRequest === 1
										? "initial response"
										: "steered response",
							},
							finish_reason: null,
						},
					],
				})}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({
					...common,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				})}\n\n`,
			);
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("steer probe server did not bind a TCP port");
	}
	return {
		server,
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		firstRequestSeen,
		releaseFirstResponse,
		requestCount: () => requestCount,
	};
}

/** Writes one isolated model entry for the local steering probe. */
function writeSteerProbeModel(agentDirectory: string, baseUrl: string): void {
	mkdirSync(agentDirectory, { recursive: true });
	writeFileSync(
		join(agentDirectory, "models.json"),
		JSON.stringify({
			providers: {
				"runtime-steer": {
					baseUrl,
					api: "openai-completions",
					apiKey: "runtime-steer-test-key",
					models: [
						{
							id: "steer",
							name: "Runtime Steer",
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

/** Resolves after one bounded interval without changing child state. */
function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Counts one exact prompt in the saved public Pi session branch. */
function countSavedPrompt(
	sessionFile: string,
	directory: string,
	prompt: string,
): number {
	const branch = SessionManager.open(
		sessionFile,
		directory,
		directory,
	).getBranch();
	return JSON.stringify(branch).split(prompt).length - 1;
}

test("real Pi keeps queued active steering accepted when its response is delayed", async () => {
	// Purpose: Pi queue mutation must outrank parent cancellation once the steer command has been dispatched.
	// Input and expected output: delayed response observation plus signal abort returns accepted, sends no abort, and saves the steer prompt once.
	// Edge case: the first model request remains active while the child queues steer and the parent pauses child stdout.
	// Dependencies: real Pi 0.82.1 RPC mode, local deterministic provider, production supervisor and bridge, and public SessionManager.
	const directory = mkdtempSync(join(tmpdir(), "subagents-v2-rpc-steer-"));
	const workers: ChildProcess[] = [];
	let probe: SteerProbe | undefined;
	let supervisor: InvocationSupervisor | undefined;
	let runtimeLeaseId: string | undefined;
	let workerDiagnostics = "";
	try {
		// Arrange: keep the first model request active so steering enters Pi's live queue.
		probe = await startSteerProbe();
		const agentDirectory = join(directory, "agent");
		writeSteerProbeModel(agentDirectory, probe.baseUrl);
		const agentsDirectory = join(
			directory,
			"agent-suite/agent-selection/agents",
		);
		mkdirSync(agentsDirectory, { recursive: true });
		writeFileSync(
			join(agentsDirectory, "SubAgentCoder.md"),
			[
				"---",
				"description: RPC steer child",
				"type: subagent",
				"tools: []",
				"---",
				"Apply steering exactly once.",
			].join("\n"),
		);
		const terminalEvents: InvocationEvent[] = [];
		let markTerminal = (): void => undefined;
		const terminalObserved = new Promise<void>((resolve) => {
			markTerminal = resolve;
		});
		supervisor = new InvocationSupervisor({
			bridge: new RootRuntimeBridge(),
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
			onEvent: (event) => {
				terminalEvents.push(event);
				if (event.kind === "terminal") {
					markTerminal();
				}
			},
			onRuntimeFailure: () => undefined,
			onRuntimeRequest: async () => {
				throw new Error("steer probe does not permit nested runtime requests");
			},
			sessionsDir: join(directory, "child-sessions"),
			resolveLaunch: async () => ({
				cwd: process.cwd(),
				modelId: "runtime-steer/steer",
				provider: "runtime-steer",
				thinking: "off",
				toolPatterns: [],
				depth: 1,
				parentAuthVerified: true,
				runtimeFacts: {
					modelProvider: "runtime-steer",
					modelId: "steer",
					contextWindow: 4_096,
				},
			}),
			spawnProcess: (command, args, options) => {
				const worker = spawn(command, [...args], options);
				worker.stderr?.on("data", (chunk: Buffer | string) => {
					workerDiagnostics += chunk.toString();
				});
				workers.push(worker);
				return worker;
			},
		});
		const acceptance = await supervisor.start({
			owner: {
				ownerPiSessionId: "root-steer-owner",
				ownerSessionFile: join(directory, "root.jsonl"),
			},
			sessionKey: {
				ownerPiSessionId: "root-steer-owner",
				ownerLocalSessionId: 1,
			},
			agentId: "SubAgentCoder",
			taskName: "RPC steer child",
			prompt: "initial work",
		});
		runtimeLeaseId = acceptance.runtimeLeaseId;
		await Promise.race([
			probe.firstRequestSeen,
			delay(2_000).then(() => {
				throw new Error(
					`first model request was not observed: ${workerDiagnostics}`,
				);
			}),
		]);
		const owner: OwnerIdentity = {
			ownerPiSessionId: "root-steer-owner",
			ownerSessionFile: join(directory, "root.jsonl"),
		};
		const invocationMetadata: InvocationMetadata = {
			startedAtMs: 1_700_000_000_000,
			elapsedMs: 1_000,
		};
		const session: LogicalSession = {
			key: { ownerPiSessionId: owner.ownerPiSessionId, ownerLocalSessionId: 1 },
			childPiSessionId: acceptance.childPiSessionId,
			childSessionDir: acceptance.childSessionDir,
			childSessionFile: acceptance.childSessionFile,
			agentId: "SubAgentCoder",
			taskName: "RPC steer child",
			creationOrder: 1,
			invocationId: acceptance.invocationId,
			runtimeLeaseId: acceptance.runtimeLeaseId,
			invocationMetadata,
			state: "active",
		};
		const catalog = new SessionCatalog();
		catalog.add(session);
		const coordinator = new SubagentCoordinator({
			catalog,
			invocations: supervisor,
			waits: new WaitCoordinator(),
			store: new V2SessionStore(),
			clock: {
				monotonicNow: () => performance.now(),
				wallNow: () => Date.now(),
			},
			isAgentAvailable: () => true,
		});
		coordinator.registerOwner(owner);
		const child = workers[0];
		if (child?.stdout === null || child?.stdout === undefined) {
			throw new Error("steer probe child stdout is unavailable");
		}
		await delay(0);
		child.stdout.pause();

		// Act: Pi receives steer while its success response cannot reach the supervisor.
		const controller = new AbortController();
		const pending = coordinator
			.steer(
				owner,
				{ sessionId: 1, prompt: "apply exactly once" },
				{ signal: controller.signal },
			)
			.catch((error: unknown) =>
				error instanceof Error ? error.message : String(error),
			);
		await delay(50);
		controller.abort(new Error("cancel after Pi queued steer"));
		child.stdout.resume();
		const outcome = await Promise.race([
			pending,
			delay(2_000).then(() => "steer-timeout" as const),
		]);
		probe.releaseFirstResponse();
		if (typeof outcome === "object") {
			await Promise.race([
				terminalObserved,
				delay(3_000).then(() => {
					throw new Error(
						`steered child did not complete: ${workerDiagnostics}`,
					);
				}),
			]);
		} else {
			await delay(100);
		}

		// Assert: accepted outcome and durable session evidence agree on one prompt.
		expect({
			outcome,
			modelRequests: probe.requestCount(),
			savedPromptCount: countSavedPrompt(
				acceptance.childSessionFile,
				acceptance.childSessionDir,
				"apply exactly once",
			),
			terminalCount: terminalEvents.filter((event) => event.kind === "terminal")
				.length,
		}).toEqual({
			outcome: { outcome: "accepted", sessionId: 1 },
			modelRequests: 2,
			savedPromptCount: 1,
			terminalCount: 1,
		});
	} finally {
		probe?.releaseFirstResponse();
		if (supervisor !== undefined && runtimeLeaseId !== undefined) {
			await supervisor.terminateLease(runtimeLeaseId).catch(() => undefined);
		}
		for (const worker of workers) {
			if (worker.exitCode === null && worker.signalCode === null) {
				worker.kill("SIGKILL");
			}
		}
		if (probe !== undefined) {
			probe.server.closeAllConnections();
			await new Promise<void>((resolve) =>
				probe?.server.close(() => resolve()),
			);
		}
		rmSync(directory, { recursive: true, force: true });
	}
}, 10_000);
