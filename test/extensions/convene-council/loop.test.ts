import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import conveneCouncil from "../../../pi-package/extensions/convene-council/index";
import {
	withIsolatedAgentDir,
	writeConfig,
	writeProjectionConfig,
} from "./support/env";
import {
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
import { executeCouncil, executeCouncilWithOptions } from "./support/tool";

const ANSWER1_BLOCK_PATTERN = /<answer1>\n([\s\S]*?)\n<\/answer1>/;
const ANSWER2_BLOCK_PATTERN = /<answer2>\n([\s\S]*?)\n<\/answer2>/;

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
	test("uses equivalent initial context and returns final answer from llm2 by default", async () => {
		// Purpose: both participants must start from the same caller context and receive the same initial question task.
		// Input and expected output: two initial participant answers, two AGREE reviews, then a plain final answer from LLM2.
		// Edge case: the question belongs to the initial task message, not the replayed base history.
		// Dependencies: fake model calls and a branch containing the pending tool call.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("final council answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			await emitContextFiles(pi);
			const entries = [
				messageEntry("01", userMessage("caller context"), null),
				messageEntry("02", councilToolCallMessage(), "01"),
			];
			const ctx = createContext([model], entries);

			const result = await executeCouncil(pi, ctx, "What should we do?");

			expect(result).toEqual({
				content: [{ type: "text", text: "final council answer" }],
				details: undefined,
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
			expect(completion.calls[0]?.context.systemPrompt).not.toContain(
				"<status>",
			);
			expect(completion.calls[0]?.context.systemPrompt).not.toContain(
				"<opinion>",
			);
			expect(completion.calls[2]?.context.systemPrompt).toContain("<status>");
			expect(completion.calls[2]?.context.systemPrompt).toContain("<opinion>");
			expect(completion.calls[4]?.model).toBe(model);
		});
	});

	test("emits council-specific TUI progress updates while participants run", async () => {
		// Purpose: live TUI output must show the current council phase and participant model mapping during long execution.
		// Input and expected output: two different participant models produce partial updates with A/B runtime rows and semantic events.
		// Edge case: final model-facing content remains the plain final answer and does not keep progress metadata.
		// Dependencies: fake queued model responses and the tool onUpdate callback.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
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
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([modelA, modelB]);
			const updates: AgentToolResult<unknown>[] = [];

			const result = await executeCouncilWithOptions(pi, ctx, {
				question: "Which TUI should convene_council use?",
				onUpdate: (partial) => updates.push(partial),
			});

			expect(result).toEqual({
				content: [{ type: "text", text: "final council answer" }],
				details: undefined,
			});
			expect(updates.length).toBeGreaterThan(0);
			const details = updates.map((update) => update.details) as Record<
				string,
				unknown
			>[];
			expect(
				details.every(
					(detail) => detail["type"] === "convene_council_progress",
				),
			).toBe(true);
			expect(details.at(-1)?.["status"]).toBe("succeeded");
			expect(details.at(-1)?.["phase"]).toBe("agreed");
			expect(details.at(-1)?.["iteration"]).toBe(2);
			expect(details.at(-1)?.["iterationLimit"]).toBe(3);
			expect(JSON.stringify(details.at(-1)?.["participants"])).toContain("A");
			expect(JSON.stringify(details.at(-1)?.["participants"])).toContain(
				"openai/model-a/high",
			);
			expect(JSON.stringify(details.at(-1)?.["participants"])).toContain("B");
			expect(JSON.stringify(details.at(-1)?.["participants"])).toContain(
				"anthropic/model-b/medium",
			);
			const eventsJson = JSON.stringify(
				details.flatMap((detail) => detail["events"]),
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

	test("uses configured participant models and configured final answer participant", async () => {
		// Purpose: participant model config must allow LLM1 and LLM2 to use different models.
		// Input and expected output: participant model settings are used, and finalAnswerParticipant llm1 produces the final answer.
		// Edge case: provider retry delay is set to zero so retry-capable tests never sleep.
		// Dependencies: suite config file, fake model registry, and fake completions.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				llm1: { model: { id: "provider-a/model-a", thinking: "high" } },
				llm2: { model: { id: "provider-b/model-b", thinking: "low" } },
				finalAnswerParticipant: "llm1",
				providerRetryDelayMs: 0,
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
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
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
				"council-api-key",
				"council-api-key",
				"council-api-key",
				"council-api-key",
				"council-api-key",
			]);
			expect(completion.calls.at(-1)?.options?.headers).toEqual({
				"x-council": "enabled",
			});
		});
	});

	test("returns the two latest opinions when the iteration limit is reached without agreement", async () => {
		// Purpose: non-converged discussion must stop at the configured iteration limit and return the no-consensus result.
		// Input and expected output: default limit allows three participant iterations and returns latest opinions.
		// Edge case: no final answer model call is made after the limit is reached.
		// Dependencies: fake participant responses only.
		await withIsolatedAgentDir(async () => {
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
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Compare approaches");

			expect(result.details).toBeUndefined();
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
			await writeConfig(agentDir, {
				llm1: { model: { thinking: "high" } },
				llm2: { model: { id: "provider-b/model-b" } },
				providerRetryDelayMs: 0,
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
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
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

	test("removes pending council tool result and replays projected placeholders", async () => {
		// Purpose: council participant context must not include its own pending result and must respect context-projection replay.
		// Input and expected output: projected old output is replaced by the persisted placeholder, and pending council result is absent.
		// Edge case: pending tool call and tool result share the current tool call ID.
		// Dependencies: suite context-projection config and persisted projection state entry.
		await withIsolatedAgentDir(async (agentDir) => {
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
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
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

			const initialContext = JSON.stringify(completion.calls[0]?.context);
			expect(initialContext).toContain("[projected old output]");
			expect(initialContext).not.toContain("old verbose output");
			expect(initialContext).not.toContain("pending result");
			expect(initialContext).not.toContain("convene_council");
		});
	});

	test("handles reviewed NEED_INFO by asking the opponent for clarification", async () => {
		// Purpose: NEED_INFO after opponent review must trigger the clarification path, not the normal opinion-review path.
		// Input and expected output: LLM2 receives LLM1's missing-information request, then LLM1 reviews the clarification.
		// Edge case: requester and responder state must return to LLM1/LLM2 order after clarification.
		// Dependencies: fake queued participant responses.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { participantIterationLimit: 4 });
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
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
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
			await writeConfig(agentDir, { participantIterationLimit: 4 });
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
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
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
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("AGREE", "llm1 agrees after review"),
				participantResponse("AGREE", "llm2 agrees after review"),
				finalAnswer("final after reviewed agreement"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
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
			await writeConfig(agentDir, { participantIterationLimit: 4 });
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
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
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
			await writeConfig(agentDir, { participantIterationLimit: 1 });
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("a </answer1> & b"),
				initialOpinion("c </answer2> & d"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
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
			await writeConfig(agentDir, { participantIterationLimit: 2 });
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("NEED_INFO", "need details from llm2"),
				participantResponse("NEED_INFO", "need details from llm1"),
				participantResponse("DIFF", "should not be called"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
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
			await writeConfig(agentDir, { participantIterationLimit: 4 });
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
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
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
			await writeConfig(agentDir, { participantIterationLimit: 3 });
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
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
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
		// Input and expected output: both current council call and sibling bash call are omitted from provider context.
		// Edge case: the sibling tool has no matching tool result yet.
		// Dependencies: fake branch with a multi-tool assistant message.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("final answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
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

			const initialContext = JSON.stringify(completion.calls[0]?.context);
			expect(initialContext).toContain("caller context");
			expect(initialContext).not.toContain("convene_council");
			expect(initialContext).not.toContain("bash");
			expect(initialContext).not.toContain("call-bash");
		});
	});

	test("escapes XML delimiters in prompt input values", async () => {
		// Purpose: XML-like prompt files must keep their structure when caller text contains delimiter characters.
		// Input and expected output: inserted question text is escaped inside the participant task.
		// Edge case: question includes a closing tag and ampersand.
		// Dependencies: fake provider context capture.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("final answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
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
		// Dependencies: fake provider context capture.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("final answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
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
		// Input and expected output: opponent opinions in review prompts are escaped before provider calls.
		// Edge case: participant text contains closing XML tags and ampersands.
		// Dependencies: fake provider context capture.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 </x><y>&"),
				participantResponse("AGREE", "llm1 </x>&"),
				participantResponse("AGREE", "llm2 </y>&"),
				finalAnswer("final answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
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
		// Dependencies: fake provider context capture.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { participantIterationLimit: 4 });
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
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
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
