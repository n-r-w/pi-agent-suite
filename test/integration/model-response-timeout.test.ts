import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
	Api,
	AssistantMessage,
	Model,
} from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createModelResponseTimeoutExtension } from "../../pi-package/extensions/model-response-timeout";
import {
	type ChildRpcPromptDecision,
	createChildRpcPromptCompletion,
} from "../../pi-package/shared/child-rpc-completion";
import { createTempDir } from "../support/temp-dir";

const MODEL: Model<"openai-completions"> = {
	api: "openai-completions",
	provider: "timeout-fixture",
	id: "fixture",
	name: "Timeout fixture",
	baseUrl: "http://127.0.0.1:1/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 100,
};

function assistantMessage(
	model: Model<Api>,
	stopReason: "aborted" | "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "partial" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

async function runTimeoutScenario(maxRetries: number, timeoutAttempts: number) {
	const directory = createTempDir("model-timeout-integration-");
	const cwd = join(directory.path, "cwd");
	const agentDir = join(directory.path, "agent");
	const suiteDir = join(directory.path, "suite");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	mkdirSync(join(suiteDir, "model-response-timeout"), { recursive: true });
	writeFileSync(
		join(suiteDir, "model-response-timeout", "config.json"),
		JSON.stringify({ timeoutSeconds: 600, maxRetries }),
	);
	const previousSuiteDir = process.env["PI_AGENT_SUITE_DIR"];
	process.env["PI_AGENT_SUITE_DIR"] = suiteDir;
	let session:
		| Awaited<ReturnType<typeof createAgentSession>>["session"]
		| undefined;
	let providerRequests = 0;
	const providerRoles: string[][] = [];
	const failedContentLengths: number[] = [];
	const settledDecisions: ChildRpcPromptDecision[] = [];
	const completion = createChildRpcPromptCompletion({
		modelProvider: MODEL.provider,
		modelId: MODEL.id,
		contextWindow: MODEL.contextWindow,
	});
	try {
		const settingsManager = SettingsManager.inMemory({
			retry: { enabled: false },
			compaction: { enabled: false },
		});
		const sessionManager = SessionManager.inMemory(cwd);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			skillsOverride: () => ({ skills: [], diagnostics: [] }),
			agentsFilesOverride: () => ({ agentsFiles: [] }),
			promptsOverride: () => ({ prompts: [], diagnostics: [] }),
			extensionFactories: [
				(pi) => {
					pi.registerProvider(MODEL.provider, {
						name: "Timeout fixture",
						baseUrl: MODEL.baseUrl,
						apiKey: "fake",
						api: MODEL.api,
						models: [MODEL],
					});
				},
				createModelResponseTimeoutExtension({
					setTimeout: (callback) => setTimeout(callback, 10),
					clearTimeout: (timer) => clearTimeout(timer),
				}),
			],
		});
		await loader.reload();
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			model: MODEL,
			thinkingLevel: "off",
			settingsManager,
			sessionManager,
			resourceLoader: loader,
			tools: [],
		}));
		const fakeStream = ((model, context, options) => {
			providerRequests++;
			const requestNumber = providerRequests;
			providerRoles.push(context.messages.map((message) => message.role));
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				try {
					await options?.onPayload?.({}, model);
					if (requestNumber <= timeoutAttempts) {
						stream.push({
							type: "start",
							partial: assistantMessage(model, "aborted"),
						});
						await new Promise<void>((resolve) => {
							if (options?.signal?.aborted) {
								resolve();
							} else {
								options?.signal?.addEventListener("abort", () => resolve(), {
									once: true,
								});
							}
						});
						stream.push({
							type: "error",
							reason: "aborted",
							error: assistantMessage(model, "aborted"),
						});
					} else {
						stream.push({
							type: "done",
							reason: "stop",
							message: assistantMessage(model, "stop"),
						});
					}
				} finally {
					stream.end();
				}
			});
			return stream;
		}) satisfies StreamFn;
		// Pi owns the Agent; replace only its public stream contract with a local fake.
		(
			session as unknown as { agent: { streamFunction: StreamFn } }
		).agent.streamFunction = fakeStream;
		session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.stopReason === "error"
			) {
				failedContentLengths.push(event.message.content.length);
			}
			const decision = completion.handleSessionEvent(event);
			if (event.type === "agent_settled") {
				settledDecisions.push(decision);
			}
		});
		await Promise.race([
			session.prompt("Question"),
			Bun.sleep(5_000).then(() => {
				throw new Error("timeout scenario did not settle");
			}),
		]);
		return {
			providerRequests,
			providerRoles,
			failedContentLengths,
			settledDecisions,
			branch: sessionManager.getBranch(),
		};
	} finally {
		session?.dispose();
		if (previousSuiteDir === undefined) {
			delete process.env["PI_AGENT_SUITE_DIR"];
		} else {
			process.env["PI_AGENT_SUITE_DIR"] = previousSuiteDir;
		}
		directory.remove();
	}
}

test("a timed-out child request retries after its first settlement", async () => {
	// Purpose: prove that a real Pi session can recover after its aborted run and that the parent waits for it.
	// Inputs and expected outputs: one timed-out request followed by a successful request yields wait then success.
	// Edge cases: Pi's own retry is disabled; failed output and hidden trigger do not reach the second provider request.
	// Dependencies: real AgentSession boundaries, isolated fake provider, and child RPC completion state.
	const result = await runTimeoutScenario(1, 1);
	expect(result.providerRequests).toBe(2);
	expect(result.providerRoles).toEqual([
		["system", "user"],
		["system", "user"],
	]);
	expect(result.failedContentLengths).toEqual([0]);
	expect(result.settledDecisions.map((decision) => decision.kind)).toEqual([
		"wait",
		"success",
	]);
	expect(
		result.branch.filter(
			(entry) => entry.type === "message" && entry.message.role === "user",
		),
	).toHaveLength(1);
	expect(
		result.branch.filter(
			(entry) => entry.type === "context_edit" && entry.replacement === null,
		),
	).toHaveLength(1);
});

test("an exhausted child timeout retry fails only after the last settlement", async () => {
	// Purpose: prove the child budget ends after the configured number of retries, not at the first timeout.
	// Inputs and expected outputs: three timed-out requests with maxRetries two yield wait, wait, then failure.
	// Edge cases: no fourth provider call or hidden continuation occurs after the exhausted attempt.
	// Dependencies: real AgentSession boundaries, isolated fake provider, and child RPC completion state.
	const result = await runTimeoutScenario(2, 3);
	expect(result.providerRequests).toBe(3);
	expect(result.failedContentLengths).toEqual([0, 0, 0]);
	expect(result.settledDecisions.map((decision) => decision.kind)).toEqual([
		"wait",
		"wait",
		"failure",
	]);
	expect(
		result.providerRoles.every((roles) => roles.join(",") === "system,user"),
	).toBe(true);
});
