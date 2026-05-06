import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { parseSessionEntries } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import conveneCouncil from "../../../pi-package/extensions/convene-council/index";
import {
	type CouncilRunDetails,
	isCouncilRunDetails,
} from "../../../pi-package/extensions/convene-council/progress";
import type { ParticipantRunnerFactory } from "../../../pi-package/extensions/convene-council/types";
import {
	withIsolatedAgentDir,
	writeEnabledConfig,
	writeProjectionConfig,
} from "./support/env";
import {
	type CompletionCall,
	createCompletionQueue,
	createContext,
	createExtensionApiFake,
} from "./support/fakes";
import {
	councilToolCallMessage,
	messageEntry,
	projectionStateEntry,
	toolCallMessage,
	toolResultMessage,
	userMessage,
} from "./support/messages";
import { createModel } from "./support/models";
import { stripMessageTimestamps } from "./support/normalize";
import {
	finalAnswer,
	initialOpinion,
	participantResponse,
} from "./support/responses";
import {
	executeCouncil,
	executeCouncilWithOptions,
	getCouncilTool,
} from "./support/tool";

const ANSWER1_BLOCK_PATTERN = /<answer1>\n([\s\S]*?)\n<\/answer1>/;
const ANSWER2_BLOCK_PATTERN = /<answer2>\n([\s\S]*?)\n<\/answer2>/;
const COUNCIL_CONTEXT_FILE_PREFIX = "pi-convene-council-context-";
const CONTEXT_FILE_PATH_PATTERN = new RegExp(
	`${escapeRegExp(tmpdir())}[\\\\/]${escapeRegExp(COUNCIL_CONTEXT_FILE_PREFIX)}[0-9a-f-]+\\.xml`,
);

function expectNoConsensusResult(
	text: string,
	answer1: string,
	answer2: string,
): void {
	expect(text).toStartWith("<result>\n");
	expect(text).toContain("\n</result>");
	expect(text.match(ANSWER1_BLOCK_PATTERN)?.[1]).toBe(answer1);
	expect(text.match(ANSWER2_BLOCK_PATTERN)?.[1]).toBe(answer2);
}

/** Extracts the generated context file path from the initial participant task. */
function extractContextFilePath(task: string): string {
	const match = task.match(CONTEXT_FILE_PATH_PATTERN);
	if (match?.[0] === undefined) {
		throw new Error("initial task did not include a council context file path");
	}
	return match[0];
}

/** Escapes literal text before inserting it into a regular expression. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lists council context temp files that exist outside the repository. */
function listCouncilContextTempFiles(): readonly string[] {
	return readdirSync(tmpdir()).filter((name) =>
		name.startsWith(COUNCIL_CONTEXT_FILE_PREFIX),
	);
}

/** Extracts validated live council details from tool updates. */
function collectCouncilRunDetails(
	updates: readonly AgentToolResult<unknown>[],
	finalResult?: AgentToolResult<unknown>,
): CouncilRunDetails[] {
	return [
		...updates.map((update) => update.details),
		...(finalResult === undefined ? [] : [finalResult.details]),
	].filter(isCouncilRunDetails);
}

/** Verifies that a parallel participant stage owns one shared header phase. */
function expectParallelPhaseIncludesParticipants(
	details: readonly CouncilRunDetails[],
	activity: string,
	phaseFragment: string,
): void {
	const parallelDetails = details.filter(
		(detail) =>
			detail.status === "running" &&
			detail.participants.length === 2 &&
			detail.participants.every(
				(participant) => participant.activity === activity,
			),
	);

	expect(parallelDetails.length).toBeGreaterThan(0);
	for (const detail of parallelDetails) {
		const [first, second] = detail.participants;
		if (first === undefined || second === undefined) {
			throw new Error("expected two council participants");
		}
		expect(detail.phase).toContain(first.displayName);
		expect(detail.phase).toContain(second.displayName);
		expect(detail.phase).toContain(phaseFragment);
	}
}

interface DeferredCompletionCall extends CompletionCall {
	readonly key: string;
}

function createDeferredCompletion(
	responses: ReadonlyMap<string, AssistantMessage["content"]>,
): {
	readonly calls: readonly DeferredCompletionCall[];
	readonly completeSimple: (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
	readonly createParticipantRunner: ParticipantRunnerFactory;
	readonly waitForCallCount: (count: number) => Promise<boolean>;
	readonly waitForKeys: (keys: readonly string[]) => Promise<boolean>;
	readonly resolveCallsUntil: (count: number) => Promise<void>;
} {
	const calls: DeferredCompletionCall[] = [];
	const resolvers: Array<() => void> = [];
	const resolvedIndexes = new Set<number>();
	const waiters = new Set<() => void>();

	const notifyWaiters = (): void => {
		for (const waiter of waiters) {
			waiter();
		}
	};

	const waitForCondition = (predicate: () => boolean): Promise<boolean> => {
		if (predicate()) {
			return Promise.resolve(true);
		}

		return new Promise<boolean>((resolve) => {
			const timeout = setTimeout(() => {
				waiters.delete(check);
				resolve(false);
			}, 50);
			const check = (): void => {
				if (!predicate()) {
					return;
				}
				clearTimeout(timeout);
				waiters.delete(check);
				resolve(true);
			};
			waiters.add(check);
		});
	};

	const resolveCall = (index: number): void => {
		if (resolvedIndexes.has(index)) {
			return;
		}
		const resolver = resolvers[index];
		if (resolver === undefined) {
			throw new Error(`completion call ${index} has not started`);
		}
		resolvedIndexes.add(index);
		resolver();
	};

	const completeSimple = async (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): Promise<AssistantMessage> => {
		const key = classifyDeferredCompletionCall(model, context);
		const content = responses.get(key);
		if (content === undefined) {
			throw new Error(`missing deferred completion response for ${key}`);
		}

		calls.push({ model, context, options, key });
		notifyWaiters();

		return new Promise<AssistantMessage>((resolve) => {
			resolvers.push(() => resolve(createAssistantMessage(model, content)));
		});
	};
	return {
		calls,
		completeSimple,
		async createParticipantRunner(options) {
			return {
				async prompt(task, signal) {
					return completeSimple(
						options.runtime.model,
						{
							systemPrompt: options.systemPrompt,
							messages: [
								...readSessionMessages(options.sessionFile),
								{ role: "user", content: task, timestamp: Date.now() },
							],
							tools: [...options.tools],
						},
						{
							...(signal === undefined ? {} : { signal }),
							...(options.runtime.thinking !== undefined &&
							options.runtime.thinking !== "off"
								? { reasoning: options.runtime.thinking }
								: {}),
						},
					);
				},
				async dispose() {},
			};
		},
		waitForCallCount(count: number): Promise<boolean> {
			return waitForCondition(() => calls.length >= count);
		},
		waitForKeys(keys: readonly string[]): Promise<boolean> {
			return waitForCondition(() =>
				keys.every((key) => calls.some((call) => call.key === key)),
			);
		},
		async resolveCallsUntil(count: number): Promise<void> {
			for (let index = 0; index < count; index += 1) {
				expect(await waitForCondition(() => calls.length >= index + 1)).toBe(
					true,
				);
				resolveCall(index);
			}
		},
	};
}

function readSessionMessages(sessionFile: string): Context["messages"] {
	return parseSessionEntries(readFileSync(sessionFile, "utf8")).flatMap(
		(entry) => (entry.type === "message" ? [entry.message] : []),
	) as Context["messages"];
}

function classifyDeferredCompletionCall(
	model: Model<Api>,
	context: Context,
): string {
	const task = JSON.stringify(context.messages.at(-1)?.content ?? "");
	const stage = (() => {
		if (task.includes("Analyze the question")) {
			return "initial";
		}
		if (task.includes("Review the opponent opinion")) {
			return "opinion-review";
		}
		if (task.includes("Provide the missing information")) {
			return "missing-response";
		}
		if (task.includes("Review the opponent clarification")) {
			return "clarification-review";
		}
		if (task.includes("Produce the final answer")) {
			return "final-answer";
		}
		return "unknown";
	})();
	return `${stage}:${model.id}`;
}

function createAssistantMessage(
	model: Model<Api>,
	content: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		stopReason: "stop",
		timestamp: 1,
	};
}

async function emitContextFiles(
	pi: ReturnType<typeof createExtensionApiFake>,
): Promise<void> {
	for (const handler of pi.handlers
		.filter((item) => item.eventName === "before_agent_start")
		.map((item) => item.handler)) {
		if (typeof handler !== "function") {
			continue;
		}
		await handler({
			systemPrompt: "Base",
			systemPromptOptions: {
				contextFiles: [
					{
						path: "/tmp/project/AGENTS.md",
						content: "Project rule: use the project validation scripts.",
					},
				],
			},
		});
	}
}

describe("convene-council loop", () => {
	test("starts initial participant opinions before waiting for either result", async () => {
		// Purpose: independent first-turn participant calls should run in parallel to avoid unnecessary latency.
		// Input and expected output: LLM1 and LLM2 initial calls both start before either deferred response is released.
		// Edge case: later dependent review calls still complete in the configured participant order.
		// Dependencies: deferred completion fake and two configured participant models.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {
				llm1: { model: { id: "provider-a/model-a" } },
				llm2: { model: { id: "provider-b/model-b" } },
			});
			const llm1Model = createModel("provider-a", "model-a");
			const llm2Model = createModel("provider-b", "model-b");
			const completion = createDeferredCompletion(
				new Map([
					["initial:model-a", initialOpinion("llm1 initial")],
					["initial:model-b", initialOpinion("llm2 initial")],
					[
						"opinion-review:model-a",
						participantResponse("AGREE", "llm1 agrees"),
					],
					[
						"opinion-review:model-b",
						participantResponse("AGREE", "llm2 agrees"),
					],
					["final-answer:model-b", finalAnswer("final council answer")],
				]),
			);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([llm1Model, llm2Model]);

			const resultPromise = executeCouncil(pi, ctx, "Parallel initial calls");
			const initialCallsStartedTogether = await completion.waitForKeys([
				"initial:model-a",
				"initial:model-b",
			]);
			await completion.resolveCallsUntil(5);
			const result = await resultPromise;

			expect(result.content).toEqual([
				{ type: "text", text: "final council answer" },
			]);
			expect(initialCallsStartedTogether).toBe(true);
		});
	});

	test("emits each initial opinion when that participant finishes", async () => {
		// Purpose: compact TUI must show the completed participant opinion while the other initial participant is still running.
		// Input and expected output: resolving only the first initial call emits that participant's opinion preview.
		// Edge case: the second participant remains unresolved during the assertion.
		// Dependencies: deferred completion fake, progress updates, and two configured participant models.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {
				llm1: { model: { id: "provider-a/model-a" } },
				llm2: { model: { id: "provider-b/model-b" } },
			});
			const llm1Model = createModel("provider-a", "model-a");
			const llm2Model = createModel("provider-b", "model-b");
			const completion = createDeferredCompletion(
				new Map([
					["initial:model-a", initialOpinion("llm1 initial")],
					["initial:model-b", initialOpinion("llm2 initial")],
					[
						"opinion-review:model-a",
						participantResponse("AGREE", "llm1 agrees"),
					],
					[
						"opinion-review:model-b",
						participantResponse("AGREE", "llm2 agrees"),
					],
					["final-answer:model-b", finalAnswer("final council answer")],
				]),
			);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([llm1Model, llm2Model]);
			const updates: AgentToolResult<unknown>[] = [];
			let resolveOpinionUpdate: (() => void) | undefined;
			const opinionUpdate = new Promise<void>((resolve) => {
				resolveOpinionUpdate = resolve;
			});

			const resultPromise = executeCouncilWithOptions(pi, ctx, {
				question: "Show initial opinion when one participant finishes",
				onUpdate: (partial) => {
					updates.push(partial);
					if (
						isCouncilRunDetails(partial.details) &&
						partial.details.participants.some(
							(participant) => participant.activity === "opinion llm1 initial",
						)
					) {
						resolveOpinionUpdate?.();
					}
				},
			});
			expect(
				await completion.waitForKeys(["initial:model-a", "initial:model-b"]),
			).toBe(true);
			await completion.resolveCallsUntil(1);
			await opinionUpdate;

			const details = collectCouncilRunDetails(updates);
			expect(
				details.some((detail) =>
					detail.participants.some(
						(participant) => participant.activity === "opinion llm1 initial",
					),
				),
			).toBe(true);

			await completion.resolveCallsUntil(5);
			await resultPromise;
		});
	});

	test("adds selected participant tool names to participant system prompts", async () => {
		// Purpose: participant instructions must use the same selected tools that are passed to the child runtime.
		// Input and expected output: config tools read and grep are present in both initial participant system prompts.
		// Edge case: the prompt template placeholder is fully rendered before participant startup.
		// Dependencies: fake tool registry, isolated config, and queued participant runner.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, { tools: ["read", "grep"] });
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("final council answer"),
			]);
			const pi = createExtensionApiFake();
			for (const toolName of ["read", "grep"]) {
				pi.registerTool({
					name: toolName,
					label: toolName,
					description: `${toolName} test tool`,
					parameters: Type.Object({}),
					async execute() {
						return {
							content: [{ type: "text", text: "unused" }],
							details: undefined,
						};
					},
				});
			}
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([createModel("openai", "main-model")]);

			await executeCouncil(
				pi,
				ctx,
				"Which evidence should participants inspect?",
			);

			const initialCalls = completion.calls.slice(0, 2);
			expect(initialCalls).toHaveLength(2);
			for (const call of initialCalls) {
				expect(call.context.tools?.map((tool) => tool.name)).toEqual([
					"read",
					"grep",
				]);
				expect(call.context.systemPrompt).toContain(
					"Your current available tools: read, grep.",
				);
				expect(call.context.systemPrompt).not.toContain("{{tools}}");
			}
		});
	});

	test("starts independent mutual missing-information calls before waiting for paired results", async () => {
		// Purpose: mutual NEED_INFO handling has two independent clarification answers and two independent clarification reviews.
		// Input and expected output: both calls in each independent pair start before either paired response is released.
		// Edge case: the normal opinion-review pair remains sequential before mutual NEED_INFO is reached.
		// Dependencies: deferred completion fake and participantIterationLimit large enough for mutual clarification.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {
				llm1: { model: { id: "provider-a/model-a" } },
				llm2: { model: { id: "provider-b/model-b" } },
				participantIterationLimit: 4,
			});
			const llm1Model = createModel("provider-a", "model-a");
			const llm2Model = createModel("provider-b", "model-b");
			const completion = createDeferredCompletion(
				new Map([
					["initial:model-a", initialOpinion("llm1 initial")],
					["initial:model-b", initialOpinion("llm2 initial")],
					[
						"opinion-review:model-a",
						participantResponse("NEED_INFO", "need details from llm2"),
					],
					[
						"opinion-review:model-b",
						participantResponse("NEED_INFO", "need details from llm1"),
					],
					[
						"missing-response:model-b",
						initialOpinion("llm2 clarifies for llm1"),
					],
					[
						"missing-response:model-a",
						initialOpinion("llm1 clarifies for llm2"),
					],
					[
						"clarification-review:model-a",
						participantResponse("AGREE", "llm1 accepts clarification"),
					],
					[
						"clarification-review:model-b",
						participantResponse("AGREE", "llm2 accepts clarification"),
					],
					[
						"final-answer:model-b",
						finalAnswer("final after both clarifications"),
					],
				]),
			);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([llm1Model, llm2Model]);
			const updates: AgentToolResult<unknown>[] = [];

			const resultPromise = executeCouncilWithOptions(pi, ctx, {
				question: "Mutual parallel calls",
				onUpdate: (partial) => updates.push(partial),
			});
			await completion.resolveCallsUntil(4);
			const missingResponsesStartedTogether = await completion.waitForKeys([
				"missing-response:model-b",
				"missing-response:model-a",
			]);
			await completion.resolveCallsUntil(6);
			const clarificationReviewsStartedTogether = await completion.waitForKeys([
				"clarification-review:model-a",
				"clarification-review:model-b",
			]);
			await completion.resolveCallsUntil(9);
			const result = await resultPromise;

			expect(result.content).toEqual([
				{ type: "text", text: "final after both clarifications" },
			]);
			const details = collectCouncilRunDetails(updates, result);
			expectParallelPhaseIncludesParticipants(
				details,
				"answers missing info",
				"missing info",
			);
			expectParallelPhaseIncludesParticipants(
				details,
				"reviews clarification",
				"clarification",
			);
			expect(missingResponsesStartedTogether).toBe(true);
			expect(clarificationReviewsStartedTogether).toBe(true);
		});
	});

	test("uses equivalent initial context and returns final answer from llm2 by default", async () => {
		// Purpose: both participants must start from the same caller context and receive the same initial question task.
		// Input and expected output: two initial participant answers, two AGREE reviews, then a plain final answer from LLM2.
		// Edge case: the question belongs to the initial task message, not the replayed base history.
		// Dependencies: fake model calls and a branch containing the pending tool call.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("final council answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			await emitContextFiles(pi);
			const entries = [
				messageEntry("01", userMessage("caller context"), null),
				messageEntry("02", councilToolCallMessage(), "01"),
			];
			const ctx = createContext([model], entries);

			const result = await executeCouncil(pi, ctx, "What should we do?");

			expect(result.content).toEqual([
				{ type: "text", text: "final council answer" },
			]);
			expect(result.details).toMatchObject({
				type: "convene_council_progress",
				status: "succeeded",
				phase: "agreed",
			});
			expect(completion.calls).toHaveLength(5);
			expect(completion.calls[0]?.context.systemPrompt).toContain(
				"/tmp/project/AGENTS.md",
			);
			expect(completion.calls[0]?.context.systemPrompt).toContain(
				"Project rule: use the project validation scripts.",
			);
			expect(completion.calls[2]?.context.systemPrompt).toContain(
				"/tmp/project/AGENTS.md",
			);
			expect(completion.calls[2]?.context.systemPrompt).toContain(
				"Project rule: use the project validation scripts.",
			);
			expect(completion.calls[4]?.context.systemPrompt).toContain(
				"/tmp/project/AGENTS.md",
			);
			expect(completion.calls[4]?.context.systemPrompt).toContain(
				"Project rule: use the project validation scripts.",
			);
			expect(
				stripMessageTimestamps(completion.calls[0]?.context.messages),
			).toEqual(stripMessageTimestamps(completion.calls[1]?.context.messages));
			const firstMessages = completion.calls[0]?.context.messages ?? [];
			expect(firstMessages.at(-1)?.content).toContain("What should we do?");
			expect(JSON.stringify(firstMessages.slice(0, -1))).not.toContain(
				"What should we do?",
			);
			expect(JSON.stringify(completion.calls[0]?.context)).not.toContain(
				"convene_council",
			);
			expect(completion.calls[2]?.context.systemPrompt).toBe(
				completion.calls[0]?.context.systemPrompt,
			);
			expect(completion.calls[4]?.model).toBe(model);
		});
	});

	test("fails before participant startup when read is unavailable", async () => {
		// Purpose: the initial prompt requires read, so council execution must stop before child startup when read is absent.
		// Input and expected output: a registry without read returns a tool error and creates no participant runner.
		// Edge case: a different available tool does not satisfy the read requirement.
		// Dependencies: direct tool execution bypasses the test helper that registers read for normal council runs.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			const model = createModel("openai", "main-model");
			let runnerStarts = 0;
			const pi = createExtensionApiFake();
			pi.registerTool({
				name: "grep",
				label: "grep",
				description: "grep test tool",
				parameters: Type.Object({}),
				async execute() {
					return {
						content: [{ type: "text", text: "unused" }],
						details: undefined,
					};
				},
			});
			conveneCouncil(pi, {
				async createParticipantRunner() {
					runnerStarts += 1;
					throw new Error("runner must not start");
				},
			});
			const ctx = createContext([model]);

			await expect(
				getCouncilTool(pi).execute(
					"call-council",
					{ question: "Needs read" },
					undefined,
					undefined,
					ctx as never,
				),
			).rejects.toThrow("required tool read is unavailable");
			expect(runnerStarts).toBe(0);
		});
	});

	test("passes parent context through a temporary file and removes it after success", async () => {
		// Purpose: initial participant prompts must carry a context file path instead of inline parent context.
		// Input and expected output: both participants receive the same context file path, the file contains caller context during the prompt, and the file is deleted after completion.
		// Edge case: the initial task keeps the question inline but not the parent evidence body.
		// Dependencies: custom participant runner, temp filesystem, and fake branch entries.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("final council answer"),
			]);
			const contextFilePaths: string[] = [];
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				async createParticipantRunner(options) {
					const runner = await completion.createParticipantRunner(options);
					return {
						async prompt(task, signal) {
							if (task.includes("Analyze the question")) {
								const contextFilePath = extractContextFilePath(task);
								contextFilePaths.push(contextFilePath);
								expect(existsSync(contextFilePath)).toBe(true);
								expect(readFileSync(contextFilePath, "utf8")).toContain(
									"caller context from file",
								);
								expect(task).toContain("What should we do?");
								expect(task).not.toContain("caller context from file");
								expect(task).toContain("read");
								expect(task).toContain("offset");
							}
							return runner.prompt(task, signal);
						},
						async dispose() {
							await runner.dispose();
						},
					};
				},
			});
			const ctx = createContext(
				[model],
				[messageEntry("01", userMessage("caller context from file"), null)],
			);

			await executeCouncil(pi, ctx, "What should we do?");

			expect(contextFilePaths).toHaveLength(2);
			expect(new Set(contextFilePaths).size).toBe(1);
			expect(existsSync(contextFilePaths[0] ?? "")).toBe(false);
		});
	});

	test("always adds read and cleans the context file after participant prompt failure", async () => {
		// Purpose: participants must receive read for the context file even when config requests only another tool.
		// Input and expected output: read and grep are both available, the context file exists during the initial prompt, and the file is deleted after prompt failure.
		// Edge case: cleanup runs after a participant prompt throws before the council reaches agreement.
		// Dependencies: isolated config, fake tool registry, temp filesystem, and custom participant runner.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, { tools: ["grep"] });
			const model = createModel("openai", "main-model");
			const capturedContextFilePaths: string[] = [];
			const capturedToolNames: string[][] = [];
			const pi = createExtensionApiFake();
			for (const toolName of ["read", "grep"]) {
				pi.registerTool({
					name: toolName,
					label: toolName,
					description: `${toolName} test tool`,
					parameters: Type.Object({}),
					async execute() {
						return {
							content: [{ type: "text", text: "unused" }],
							details: undefined,
						};
					},
				});
			}
			conveneCouncil(pi, {
				async createParticipantRunner(options) {
					capturedToolNames.push(options.tools.map((tool) => tool.name));
					expect(options.systemPrompt).toContain(
						"Your current available tools: read, grep.",
					);
					return {
						async prompt(task) {
							const contextFilePath = extractContextFilePath(task);
							capturedContextFilePaths.push(contextFilePath);
							expect(existsSync(contextFilePath)).toBe(true);
							throw new Error("participant prompt failed");
						},
						async dispose() {},
					};
				},
			});
			const ctx = createContext(
				[model],
				[messageEntry("01", userMessage("cleanup context"), null)],
			);

			const result = await executeCouncil(pi, ctx, "Failure cleanup");

			expect(JSON.stringify(result.content)).toContain(
				"participant prompt failed",
			);
			expect(capturedToolNames).toEqual([
				["read", "grep"],
				["read", "grep"],
			]);
			expect(capturedContextFilePaths.length).toBeGreaterThan(0);
			for (const contextFilePath of capturedContextFilePaths) {
				expect(existsSync(contextFilePath)).toBe(false);
			}
		});
	});

	test("cleans participant sessions, runners, and context file when participant startup fails", async () => {
		// Purpose: failed child startup must not leak participant sessions, already-created participant runners, or the parent context file.
		// Input and expected output: LLM1 runner is created, LLM2 startup fails, LLM1 is disposed, temp session dirs are removed, and no council context temp file remains.
		// Edge case: cleanup happens after context file creation but before discussion iterations start.
		// Dependencies: custom participant runner factory, temp participant sessions, and temp context file lifecycle.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			const model = createModel("openai", "main-model");
			const disposed: string[] = [];
			const sessionDirs: string[] = [];
			const beforeContextFiles = listCouncilContextTempFiles();
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				async createParticipantRunner(options) {
					sessionDirs.push(options.sessionDir);
					if (options.participantId === "llm2") {
						throw new Error("llm2 startup failed");
					}
					return {
						async prompt() {
							throw new Error("should not prompt after startup failure");
						},
						async dispose() {
							disposed.push(options.participantId);
						},
					};
				},
			});
			const ctx = createContext([model]);

			await expect(executeCouncil(pi, ctx, "Startup failure")).rejects.toThrow(
				"llm2 startup failed",
			);

			expect(disposed).toEqual(["llm1"]);
			expect(sessionDirs).toHaveLength(2);
			expect(sessionDirs.every((sessionDir) => !existsSync(sessionDir))).toBe(
				true,
			);
			expect(listCouncilContextTempFiles()).toEqual(beforeContextFiles);
		});
	});

	test("emits council-specific TUI progress updates while participants run", async () => {
		// Purpose: live TUI output must show the current council phase and participant model mapping during long execution.
		// Input and expected output: two different participant models produce partial updates with A/B runtime rows and semantic events.
		// Edge case: final model-facing content remains the plain final answer and does not keep progress metadata.
		// Dependencies: fake queued model responses and the tool onUpdate callback.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {
				llm1: { model: { id: "openai/model-a", thinking: "high" } },
				llm2: { model: { id: "anthropic/model-b", thinking: "medium" } },
			});
			const modelA = createModel("openai", "model-a");
			const modelB = createModel("anthropic", "model-b");
			const longOpinionSuffix = "A_RAW_SUFFIX_MUST_NOT_APPEAR";
			const completion = createCompletionQueue([
				initialOpinion(
					`${"A recommends PostgreSQL for relational hotel data. ".repeat(8)}${longOpinionSuffix}`,
				),
				initialOpinion(
					"B recommends PostgreSQL but asks about search filters.",
				),
				participantResponse(
					"AGREE",
					"A agrees after B clarified search needs.",
				),
				participantResponse(
					"AGREE",
					"B agrees with PostgreSQL as source of truth.",
				),
				finalAnswer("final council answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([modelA, modelB]);
			const updates: AgentToolResult<unknown>[] = [];

			const result = await executeCouncilWithOptions(pi, ctx, {
				question: "Which TUI should convene_council use?",
				onUpdate: (partial) => updates.push(partial),
			});

			expect(result.content).toEqual([
				{ type: "text", text: "final council answer" },
			]);
			expect(result.details).toMatchObject({
				type: "convene_council_progress",
				status: "succeeded",
				phase: "agreed",
				iteration: 2,
				iterationLimit: 3,
			});
			expect(updates.length).toBeGreaterThan(0);
			const details = collectCouncilRunDetails(updates, result);
			expect(details).toHaveLength(updates.length + 1);
			expect(details.at(-1)?.status).toBe("succeeded");
			expect(details.at(-1)?.phase).toBe("agreed");
			expect(details.at(-1)?.iteration).toBe(2);
			expect(details.at(-1)?.iterationLimit).toBe(3);
			expectParallelPhaseIncludesParticipants(
				details,
				"initial opinion",
				"initial opinion",
			);
			const finalParticipantsJson = JSON.stringify(
				details.at(-1)?.participants,
			);
			expect(finalParticipantsJson).toContain("displayName");
			expect(finalParticipantsJson).toContain("openai/model-a/high");
			expect(finalParticipantsJson).toContain("anthropic/model-b/medium");
			expect(finalParticipantsJson).toContain("final answer accepted");
			expect(finalParticipantsJson).not.toContain('"displayName":"A"');
			expect(finalParticipantsJson).not.toContain('"displayName":"B"');
			const eventsJson = JSON.stringify(
				details.flatMap((detail) => detail.events),
			);
			expect(eventsJson).toContain("A initial opinion");
			expect(eventsJson).toContain("B initial opinion");
			expect(eventsJson).toContain("A opinion");
			expect(eventsJson).toContain("A recommends PostgreSQL");
			expect(eventsJson).not.toContain(longOpinionSuffix);
			expect(eventsJson).toContain("B opinion");
			expect(eventsJson).toContain("B recommends PostgreSQL");
			expect(eventsJson).toContain("A AGREE");
			expect(eventsJson).toContain("A agrees after B clarified search needs");
			expect(eventsJson).toContain("B AGREE");
			expect(eventsJson).toContain(
				"B agrees with PostgreSQL as source of truth",
			);
			expect(eventsJson).toContain("B final answer");
		});
	});

	test("emits participant child tool events in live TUI progress", async () => {
		// Purpose: child RPC tool activity must be visible while council participants are working.
		// Input and expected output: participant runners emit tool start/end events and progress details include A/B labeled tool rows.
		// Edge case: full tool output is bounded and does not leak the raw long suffix into live details.
		// Dependencies: fake participant runner events and the tool onUpdate callback.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			const model = createModel("openai", "model-a");
			const longToolSuffix = "TOOL_SUFFIX_MUST_NOT_APPEAR";
			const responses: AssistantMessage["content"][] = [
				initialOpinion("A initial answer"),
				initialOpinion("B initial answer"),
				participantResponse("AGREE", "A agrees"),
				participantResponse("AGREE", "B agrees"),
				finalAnswer("final council answer"),
			];
			const createParticipantRunner: ParticipantRunnerFactory = async (
				options,
			) => ({
				async prompt() {
					options.onSessionEvent?.({
						type: "tool_execution_start",
						toolCallId: `${options.participantId}-read`,
						toolName: "read",
						args: { path: `${options.participantId}.md` },
					});
					options.onSessionEvent?.({
						type: "tool_execution_end",
						toolCallId: `${options.participantId}-read`,
						toolName: "read",
						result: {
							content: [
								{
									type: "text",
									text: `${"tool output ".repeat(40)}${longToolSuffix}`,
								},
							],
						},
						isError: false,
					});
					options.onSessionEvent?.({
						type: "message_end",
						message: {
							role: "assistant",
							usage: {
								totalTokens: options.participantId === "llm1" ? 12_345 : 67_890,
							},
						},
					});
					const response = responses.shift();
					if (response === undefined) {
						throw new Error("missing participant response");
					}
					return createAssistantMessage(options.runtime.model, response);
				},
				async dispose() {},
			});
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { createParticipantRunner });
			const updates: AgentToolResult<unknown>[] = [];

			const result = await executeCouncilWithOptions(
				pi,
				createContext([model]),
				{
					question: "Which files did participants inspect?",
					onUpdate: (partial) => updates.push(partial),
				},
			);

			const eventsJson = JSON.stringify(
				updates.flatMap((update) => {
					const details = update.details as { events?: unknown } | undefined;
					return Array.isArray(details?.events) ? details.events : [];
				}),
			);
			const finalParticipantsJson = JSON.stringify(
				(result.details as { participants?: unknown } | undefined)
					?.participants,
			);
			expect(eventsJson).toContain("A read");
			expect(eventsJson).toContain("llm1.md");
			expect(eventsJson).toContain("A read result");
			expect(eventsJson).toContain("B read");
			expect(eventsJson).toContain("llm2.md");
			expect(eventsJson).toContain("B read result");
			expect(eventsJson).not.toContain(longToolSuffix);
			const runningParticipantsJson = JSON.stringify(
				updates.flatMap((update) => {
					const details = update.details as
						| { status?: unknown; participants?: unknown }
						| undefined;
					return details?.status === "running" &&
						Array.isArray(details.participants)
						? details.participants
						: [];
				}),
			);
			expect(runningParticipantsJson).toContain("read result");
			expect(runningParticipantsJson).not.toContain('"status":"succeeded"');
			expect(finalParticipantsJson).toContain('"tokens":12345');
			expect(finalParticipantsJson).toContain('"tokens":67890');
			expect(finalParticipantsJson).toContain('"contextWindow":100000');
		});
	});

	test("uses configured participant models and configured final answer participant", async () => {
		// Purpose: participant model config must allow LLM1 and LLM2 to use different models.
		// Input and expected output: participant model settings are used, and finalAnswerParticipant llm1 produces the final answer.
		// Edge case: LLM1 and LLM2 use different configured thinking levels.
		// Dependencies: suite config file, fake model registry, and fake completions.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {
				llm1: { model: { id: "provider-a/model-a", thinking: "high" } },
				llm2: { model: { id: "provider-b/model-b", thinking: "low" } },
				finalAnswerParticipant: "llm1",
			});
			const llm1Model = createModel("provider-a", "model-a");
			const llm2Model = createModel("provider-b", "model-b");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("llm1 final answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([llm1Model, llm2Model]);

			const result = await executeCouncil(pi, ctx, "Choose an option");

			expect(result.content).toEqual([
				{ type: "text", text: "llm1 final answer" },
			]);
			expect(completion.calls.map((call) => call.model.id)).toEqual([
				"model-a",
				"model-b",
				"model-a",
				"model-b",
				"model-a",
			]);
			expect(completion.calls.map((call) => call.options?.reasoning)).toEqual([
				"high",
				"low",
				"high",
				"low",
				"high",
			]);
			expect(completion.calls.map((call) => call.options?.apiKey)).toEqual([
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
			]);
			expect(completion.calls.at(-1)?.options?.headers).toBeUndefined();
		});
	});

	test("returns the two latest opinions when the iteration limit is reached without agreement", async () => {
		// Purpose: non-converged discussion must stop at the configured iteration limit and return the no-consensus result.
		// Input and expected output: default limit allows three participant iterations and returns latest opinions.
		// Edge case: no final answer model call is made after the limit is reached.
		// Dependencies: fake participant responses only.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("DIFF", "llm1 second"),
				participantResponse("DIFF", "llm2 second"),
				participantResponse("DIFF", "llm1 latest"),
				participantResponse("DIFF", "llm2 latest"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Compare approaches");

			expect(result.details).toMatchObject({
				type: "convene_council_progress",
				status: "succeeded",
				phase: "iteration limit reached",
			});
			expect(result.content[0]?.type).toBe("text");
			if (result.content[0]?.type === "text") {
				expectNoConsensusResult(
					result.content[0].text,
					"llm1 latest",
					"llm2 latest",
				);
			}
			expect(completion.calls).toHaveLength(6);
		});
	});

	test("uses current model and current thinking for partial participant model config", async () => {
		// Purpose: configured participants must fall back per missing field, not only when the full model config is absent.
		// Input and expected output: missing id uses current model, and missing thinking uses current thinking.
		// Edge case: one participant has only thinking while the other has only model id.
		// Dependencies: suite config and fake model registry.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {
				llm1: { model: { thinking: "high" } },
				llm2: { model: { id: "provider-b/model-b" } },
			});
			const currentModel = createModel("openai", "main-model");
			const llm2Model = createModel("provider-b", "model-b");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("final answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([currentModel, llm2Model]);

			await executeCouncil(pi, ctx, "Choose an option");

			expect(completion.calls.map((call) => call.model.id)).toEqual([
				"main-model",
				"model-b",
				"main-model",
				"model-b",
				"model-b",
			]);
			expect(completion.calls.map((call) => call.options?.reasoning)).toEqual([
				"high",
				"medium",
				"high",
				"medium",
				"medium",
			]);
		});
	});

	test("removes pending council tool result and ignores projected placeholders", async () => {
		// Purpose: council participant context must use raw active-branch evidence and must not include its own pending result.
		// Input and expected output: old raw output remains visible, projection state is ignored, and pending council result is absent.
		// Edge case: pending tool call and tool result share the current tool call ID.
		// Dependencies: suite context-projection config and persisted projection state entry.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			await writeProjectionConfig(agentDir, { enabled: true });
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("final council answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const entries = [
				messageEntry("01", userMessage("caller context"), null),
				messageEntry(
					"02",
					toolResultMessage("old-call", "old verbose output", "bash"),
					"01",
				),
				projectionStateEntry("03", "02", "[projected old output]", "02"),
				messageEntry("04", councilToolCallMessage(), "03"),
				messageEntry(
					"05",
					toolResultMessage("call-council", "pending result"),
					"04",
				),
			];
			const ctx = createContext([model], entries);

			await executeCouncil(pi, ctx, "What should we do?");

			const initialTask = String(
				completion.calls[0]?.context.messages.at(-1)?.content,
			);
			expect(extractContextFilePath(initialTask)).toStartWith("/");
			expect(initialTask).not.toContain("[projected old output]");
			expect(initialTask).not.toContain("pending result");
			expect(initialTask).not.toContain("convene_council");
		});
	});

	test("handles reviewed NEED_INFO by asking the opponent for clarification", async () => {
		// Purpose: NEED_INFO after opponent review must trigger the clarification path, not the normal opinion-review path.
		// Input and expected output: LLM2 receives LLM1's missing-information request, then LLM1 reviews the clarification.
		// Edge case: requester and responder state must return to LLM1/LLM2 order after clarification.
		// Dependencies: fake queued participant responses.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {
				participantIterationLimit: 4,
			});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("NEED_INFO", "need details from llm2"),
				participantResponse("DIFF", "llm2 reviewed need"),
				initialOpinion("llm2 gives details"),
				participantResponse("AGREE", "llm1 accepts details"),
				participantResponse("AGREE", "llm1 reviews after details"),
				participantResponse("AGREE", "llm2 reviews after details"),
				finalAnswer("final after clarification"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Need more info path");

			expect(result.content).toEqual([
				{ type: "text", text: "final after clarification" },
			]);
			const clarificationTask = JSON.stringify(
				completion.calls[4]?.context.messages.at(-1),
			);
			expect(clarificationTask).toContain("need details from llm2");
			expect(clarificationTask).not.toContain("<status>");
			expect(clarificationTask).not.toContain("<opinion>");
			expect(JSON.stringify(completion.calls[5]?.context)).toContain(
				"llm2 gives details",
			);
		});
	});

	test("accepts free-form missing-information responses before structured clarification review", async () => {
		// Purpose: missing-information answers are clarifications, not agreement decisions.
		// Input and expected output: statusless clarification is accepted, then the requester decides AGREE in structured review.
		// Edge case: clarification itself does not count as reviewed agreement.
		// Dependencies: fake queued participant responses.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {
				participantIterationLimit: 4,
			});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("NEED_INFO", "need details from llm2"),
				participantResponse("DIFF", "llm2 reviewed need"),
				initialOpinion("llm2 clarification without status"),
				participantResponse("AGREE", "llm1 accepts clarification"),
				participantResponse("AGREE", "llm1 reviews after clarification"),
				participantResponse("AGREE", "llm2 reviews after clarification"),
				finalAnswer("final after statusless clarification"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Statusless clarification");

			expect(result.content).toEqual([
				{ type: "text", text: "final after statusless clarification" },
			]);
			expect(JSON.stringify(completion.calls[5]?.context)).toContain(
				"llm2 clarification without status",
			);
		});
	});

	test("accepts plain initial opinions before structured review", async () => {
		// Purpose: first responses are plain opinions, but final agreement still requires opponent review.
		// Input and expected output: plain initial answers are followed by structured AGREE review turns before the final answer.
		// Edge case: plain initial answers do not bypass the reviewed-opponent gate.
		// Dependencies: fake queued participant responses.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("AGREE", "llm1 agrees after review"),
				participantResponse("AGREE", "llm2 agrees after review"),
				finalAnswer("final after reviewed agreement"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Agreement gating");

			expect(result.content).toEqual([
				{ type: "text", text: "final after reviewed agreement" },
			]);
			expect(completion.calls).toHaveLength(5);
			expect(
				JSON.stringify(completion.calls[2]?.context.messages.at(-1)),
			).toContain("llm2 initial");
		});
	});

	test("handles reviewed NEED_INFO from LLM2 by asking LLM1 for clarification", async () => {
		// Purpose: single-requester missing-information handling must work when LLM2 is the requester.
		// Input and expected output: LLM1 answers LLM2, then LLM2 reviews the clarification before agreement.
		// Edge case: requester/responder state must remain in LLM1/LLM2 order.
		// Dependencies: fake queued participant responses.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {
				participantIterationLimit: 4,
			});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("DIFF", "llm1 reviewed"),
				participantResponse("NEED_INFO", "need details from llm1"),
				initialOpinion("llm1 gives details"),
				participantResponse("AGREE", "llm2 accepts details"),
				participantResponse("AGREE", "llm1 reviews after details"),
				participantResponse("AGREE", "llm2 reviews after details"),
				finalAnswer("final after llm2 clarification"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "LLM2 need info");

			expect(result.content).toEqual([
				{ type: "text", text: "final after llm2 clarification" },
			]);
			expect(JSON.stringify(completion.calls[4]?.context)).toContain(
				"need details from llm1",
			);
			expect(JSON.stringify(completion.calls[5]?.context)).toContain(
				"llm1 gives details",
			);
		});
	});

	test("escapes XML delimiters in non-agreement output", async () => {
		// Purpose: answer tags must stay well formed when participant opinions contain XML delimiter characters.
		// Input and expected output: participant opinions are escaped inside answer1 and answer2.
		// Edge case: opinions include closing answer tags and ampersands.
		// Dependencies: fake participant responses only.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {
				participantIterationLimit: 1,
			});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("a </answer1> & b"),
				initialOpinion("c </answer2> & d"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Escape output");

			expect(result.content[0]?.type).toBe("text");
			if (result.content[0]?.type === "text") {
				expectNoConsensusResult(
					result.content[0].text,
					"a &lt;/answer1&gt; &amp; b",
					"c &lt;/answer2&gt; &amp; d",
				);
			}
		});
	});

	test("stops before mutual NEED_INFO when one iteration slot remains", async () => {
		// Purpose: mutual clarification consumes two participant pairs and must respect the remaining iteration budget.
		// Input and expected output: with one remaining slot, the tool returns latest opinions instead of making four clarification calls.
		// Edge case: both participants have reviewed opponent opinions and both latest statuses are NEED_INFO.
		// Dependencies: suite config and fake queued participant responses.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {
				participantIterationLimit: 2,
			});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("NEED_INFO", "need details from llm2"),
				participantResponse("NEED_INFO", "need details from llm1"),
				participantResponse("DIFF", "should not be called"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Mutual budget");

			expect(result.content[0]?.type).toBe("text");
			if (result.content[0]?.type === "text") {
				expectNoConsensusResult(
					result.content[0].text,
					"need details from llm2",
					"need details from llm1",
				);
			}
			expect(completion.calls).toHaveLength(4);
		});
	});

	test("handles simultaneous reviewed NEED_INFO requests", async () => {
		// Purpose: when both participants request missing information, both requests must be answered and reviewed.
		// Input and expected output: each participant provides clarification, then each requester reviews the matching clarification.
		// Edge case: neither pending request is lost when both latest reviewed statuses are NEED_INFO.
		// Dependencies: fake queued participant responses.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {
				participantIterationLimit: 4,
			});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("NEED_INFO", "need details from llm2"),
				participantResponse("NEED_INFO", "need details from llm1"),
				initialOpinion("llm2 clarifies for llm1"),
				initialOpinion("llm1 clarifies for llm2"),
				participantResponse("AGREE", "llm1 accepts clarification"),
				participantResponse("AGREE", "llm2 accepts clarification"),
				finalAnswer("final after both clarifications"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Both need info");

			expect(result.content).toEqual([
				{ type: "text", text: "final after both clarifications" },
			]);
			expect(JSON.stringify(completion.calls[4]?.context)).toContain(
				"need details from llm2",
			);
			expect(JSON.stringify(completion.calls[5]?.context)).toContain(
				"need details from llm1",
			);
			expect(JSON.stringify(completion.calls[6]?.context)).toContain(
				"llm2 clarifies for llm1",
			);
			expect(JSON.stringify(completion.calls[7]?.context)).toContain(
				"llm1 clarifies for llm2",
			);
		});
	});

	test("does not count a missing-information response as reviewed agreement", async () => {
		// Purpose: the responder must not become agreement-eligible by only answering a clarification request.
		// Input and expected output: after one clarification pair, the loop returns latest opinions instead of final answer.
		// Edge case: responder returns a clarification and is still not treated as having reviewed the opponent.
		// Dependencies: reduced iteration limit and fake queued responses.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {
				participantIterationLimit: 3,
			});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("NEED_INFO", "need details from llm2"),
				participantResponse("AGREE", "llm2 reviewed previous opinion"),
				initialOpinion("llm2 gives details"),
				participantResponse("AGREE", "llm1 accepts details"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Responder eligibility");

			expect(result.content[0]?.type).toBe("text");
			if (result.content[0]?.type === "text") {
				expectNoConsensusResult(
					result.content[0].text,
					"llm1 accepts details",
					"llm2 gives details",
				);
			}
			expect(completion.calls).toHaveLength(6);
		});
	});

	test("removes sibling pending tool calls from participant context", async () => {
		// Purpose: participant context must not include unresolved tool calls from the active tool-use message.
		// Input and expected output: both current council call and sibling bash call are omitted from participant context.
		// Edge case: the sibling tool has no matching tool result yet.
		// Dependencies: fake branch with a multi-tool assistant message.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("final answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const entries = [
				messageEntry("01", userMessage("caller context"), null),
				messageEntry(
					"02",
					toolCallMessage([
						{
							type: "toolCall",
							id: "call-council",
							name: "convene_council",
							arguments: { question: "question" },
						},
						{
							type: "toolCall",
							id: "call-bash",
							name: "bash",
							arguments: { command: "echo sibling" },
						},
					]),
					"01",
				),
			];
			const ctx = createContext([model], entries);

			await executeCouncil(pi, ctx, "Clean sibling calls");

			const initialTask = String(
				completion.calls[0]?.context.messages.at(-1)?.content,
			);
			expect(extractContextFilePath(initialTask)).toStartWith("/");
			expect(initialTask).not.toContain("convene_council");
			expect(initialTask).not.toContain("bash");
			expect(initialTask).not.toContain("call-bash");
		});
	});

	test("escapes XML delimiters in prompt input values", async () => {
		// Purpose: XML-like prompt files must keep their structure when caller text contains delimiter characters.
		// Input and expected output: inserted question text is escaped inside the participant task.
		// Edge case: question includes a closing tag and ampersand.
		// Dependencies: fake participant context capture.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("final answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([model]);

			await executeCouncil(pi, ctx, "x</x><y>&");

			const firstTask = JSON.stringify(
				completion.calls[0]?.context.messages.at(-1),
			);
			expect(firstTask).toContain("x&lt;/x&gt;&lt;y&gt;&amp;");
			expect(firstTask).not.toContain("x</x><y>&");
		});
	});

	test("keeps placeholder-like inserted values literal in prompt templates", async () => {
		// Purpose: prompt rendering must replace only placeholders from the original template, not placeholders inside inserted values.
		// Input and expected output: question text containing another placeholder remains literal text in the initial task.
		// Edge case: inserted value names a placeholder used by another prompt.
		// Dependencies: fake participant context capture.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("final answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([model]);

			await executeCouncil(pi, ctx, "Question has {{llm2Opinion}}");

			const initialTask = JSON.stringify(
				completion.calls[0]?.context.messages.at(-1),
			);
			expect(initialTask).toContain("Question has {{llm2Opinion}}");
			expect(initialTask).not.toContain("Question has llm2 agrees");
		});
	});

	test("escapes XML delimiters from participant-sourced prompt values", async () => {
		// Purpose: later XML-like prompt inputs must stay structured when participant opinions contain delimiter characters.
		// Input and expected output: opponent opinions in review prompts are escaped before participant calls.
		// Edge case: participant text contains closing XML tags and ampersands.
		// Dependencies: fake participant context capture.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 </x><y>&"),
				participantResponse("AGREE", "llm1 </x>&"),
				participantResponse("AGREE", "llm2 </y>&"),
				finalAnswer("final answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([model]);

			await executeCouncil(pi, ctx, "Escape participant values");

			const reviewTask = JSON.stringify(
				completion.calls[2]?.context.messages.at(-1),
			);
			expect(reviewTask).toContain("llm2 &lt;/x&gt;&lt;y&gt;&amp;");
			expect(reviewTask).not.toContain("llm2 </x><y>&");
			expect(
				JSON.stringify(completion.calls[4]?.context.messages.at(-1)),
			).toContain("Produce the final answer");
		});
	});

	test("escapes XML delimiters in missing-information request and clarification values", async () => {
		// Purpose: XML escaping must protect the missing-information path, not only normal opinion review.
		// Input and expected output: missing request and clarification values are escaped in later prompt tasks.
		// Edge case: values contain closing tags and ampersands.
		// Dependencies: fake participant context capture.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {
				participantIterationLimit: 4,
			});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("NEED_INFO", "need </x>&"),
				participantResponse("DIFF", "llm2 reviewed need"),
				participantResponse("DIFF", "clarify </y>&"),
				participantResponse("AGREE", "llm1 accepts"),
				participantResponse("AGREE", "llm1 reviews"),
				participantResponse("AGREE", "llm2 reviews"),
				finalAnswer("final answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([model]);

			await executeCouncil(pi, ctx, "Escape missing info");

			const missingTask = JSON.stringify(
				completion.calls[4]?.context.messages.at(-1),
			);
			expect(missingTask).toContain("need &lt;/x&gt;&amp;");
			expect(missingTask).not.toContain("need </x>&");
			const clarificationTask = JSON.stringify(
				completion.calls[5]?.context.messages.at(-1),
			);
			expect(clarificationTask).toContain("clarify &lt;/y&gt;&amp;");
			expect(clarificationTask).not.toContain("clarify </y>&");
		});
	});
});
