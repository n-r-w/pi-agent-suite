import { describe, expect, test } from "bun:test";
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
import { finalAnswer, participantResponse } from "./support/responses";
import { executeCouncil } from "./support/tool";

describe("convene-council loop", () => {
	test("uses equivalent initial context and returns final answer from llm2 by default", async () => {
		// Purpose: both participants must start from the same caller context and question before discussion.
		// Input and expected output: two initial NEED_INFO answers, two AGREE reviews, then a plain final answer from LLM2.
		// Edge case: initial NEED_INFO does not stop or ask for clarification.
		// Dependencies: fake model calls and a branch containing the pending tool call.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("final council answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
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
			expect(
				stripMessageTimestamps(completion.calls[0]?.context.messages),
			).toEqual(stripMessageTimestamps(completion.calls[1]?.context.messages));
			expect(JSON.stringify(completion.calls[0]?.context)).toContain(
				"What should we do?",
			);
			expect(JSON.stringify(completion.calls[0]?.context)).not.toContain(
				"convene_council",
			);
			expect(completion.calls[4]?.model).toBe(model);
			expect(completion.calls[4]?.context.systemPrompt).not.toContain(
				"Return exactly: <status>",
			);
			expect(completion.calls[4]?.context.systemPrompt).toContain(
				"Return plain visible text only.",
			);
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
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
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
		// Purpose: non-converged discussion must stop at the configured iteration limit and return only answer tags.
		// Input and expected output: default limit allows three participant iterations and returns latest opinions.
		// Edge case: no final answer model call is made after the limit is reached.
		// Dependencies: fake participant responses only.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
				participantResponse("DIFF", "llm1 second"),
				participantResponse("DIFF", "llm2 second"),
				participantResponse("DIFF", "llm1 latest"),
				participantResponse("DIFF", "llm2 latest"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Compare approaches");

			expect(result).toEqual({
				content: [
					{
						type: "text",
						text: "<answer1>llm1 latest</answer1><answer2>llm2 latest</answer2>",
					},
				],
				details: undefined,
			});
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
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
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
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
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
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
				participantResponse("NEED_INFO", "need details from llm2"),
				participantResponse("DIFF", "llm2 reviewed need"),
				participantResponse("DIFF", "llm2 gives details"),
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
			expect(clarificationTask).toContain("Use <status>DIFF</status>");
			expect(clarificationTask).toContain("does not count as agreement");
			expect(JSON.stringify(completion.calls[5]?.context)).toContain(
				"llm2 gives details",
			);
		});
	});

	test("rejects missing-information responses that are not DIFF", async () => {
		// Purpose: clarification responders must use DIFF so clarification does not masquerade as agreement.
		// Input and expected output: AGREE in a missing-information response is rejected as unusable output.
		// Edge case: the same AGREE status remains valid in later clarification review, not in the response itself.
		// Dependencies: suite config and fake queued participant responses.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				participantIterationLimit: 4,
				responseDefectRetries: 0,
				providerRequestRetries: 0,
			});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
				participantResponse("NEED_INFO", "need details from llm2"),
				participantResponse("DIFF", "llm2 reviewed need"),
				participantResponse("AGREE", "llm2 invalid clarification"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Strict clarification");

			expect(result.content).toEqual([
				{
					type: "text",
					text: "llm2 returned unusable participant output.",
				},
			]);
			expect(completion.calls).toHaveLength(5);
		});
	});

	test("rejects first-iteration statuses other than NEED_INFO", async () => {
		// Purpose: first responses must use NEED_INFO because no opponent opinion exists yet.
		// Input and expected output: initial AGREE is treated as a response defect and fails when retries are disabled.
		// Edge case: the second participant is not called after LLM1 violates the first-turn contract.
		// Dependencies: suite config and fake queued participant response.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { responseDefectRetries: 0 });
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				participantResponse("AGREE", "llm1 premature agree"),
				participantResponse("NEED_INFO", "llm2 should not be called"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Agreement gating");

			expect(result.content).toEqual([
				{
					type: "text",
					text: "llm1 returned unusable participant output.",
				},
			]);
			expect(completion.calls).toHaveLength(1);
		});
	});

	test("rejects invalid LLM2 first-iteration status", async () => {
		// Purpose: first-turn NEED_INFO enforcement must apply to both participants.
		// Input and expected output: LLM2 initial AGREE is treated as a logical output defect.
		// Edge case: LLM1 is valid, so the failure occurs on the second first-turn response.
		// Dependencies: suite config and fake queued participant responses.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { responseDefectRetries: 0 });
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("AGREE", "llm2 premature agree"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "LLM2 initial status");

			expect(result.content).toEqual([
				{
					type: "text",
					text: "llm2 returned unusable participant output.",
				},
			]);
			expect(completion.calls).toHaveLength(2);
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
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
				participantResponse("DIFF", "llm1 reviewed"),
				participantResponse("NEED_INFO", "need details from llm1"),
				participantResponse("DIFF", "llm1 gives details"),
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
				participantResponse("NEED_INFO", "a </answer1> & b"),
				participantResponse("NEED_INFO", "c </answer2> & d"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Escape output");

			expect(result.content).toEqual([
				{
					type: "text",
					text: "<answer1>a &lt;/answer1&gt; &amp; b</answer1><answer2>c &lt;/answer2&gt; &amp; d</answer2>",
				},
			]);
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
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
				participantResponse("NEED_INFO", "need details from llm2"),
				participantResponse("NEED_INFO", "need details from llm1"),
				participantResponse("DIFF", "should not be called"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Mutual budget");

			expect(result.content).toEqual([
				{
					type: "text",
					text: "<answer1>need details from llm2</answer1><answer2>need details from llm1</answer2>",
				},
			]);
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
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
				participantResponse("NEED_INFO", "need details from llm2"),
				participantResponse("NEED_INFO", "need details from llm1"),
				participantResponse("DIFF", "llm2 clarifies for llm1"),
				participantResponse("DIFF", "llm1 clarifies for llm2"),
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
		// Edge case: responder returns the required DIFF clarification and is still not treated as having reviewed the opponent.
		// Dependencies: reduced iteration limit and fake queued responses.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { participantIterationLimit: 3 });
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
				participantResponse("NEED_INFO", "need details from llm2"),
				participantResponse("AGREE", "llm2 reviewed previous opinion"),
				participantResponse("DIFF", "llm2 gives details"),
				participantResponse("AGREE", "llm1 accepts details"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Responder eligibility");

			expect(result.content).toEqual([
				{
					type: "text",
					text: "<answer1>llm1 accepts details</answer1><answer2>llm2 gives details</answer2>",
				},
			]);
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
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
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
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("final answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			await executeCouncil(pi, ctx, "x</question><malicious>&");

			const firstTask = JSON.stringify(
				completion.calls[0]?.context.messages.at(-1),
			);
			expect(firstTask).toContain("x&lt;/question&gt;&lt;malicious&gt;&amp;");
			expect(firstTask).not.toContain("x</question><malicious>&");
		});
	});

	test("keeps placeholder-like inserted values literal in prompt templates", async () => {
		// Purpose: prompt rendering must replace only placeholders from the original template, not placeholders inside inserted values.
		// Input and expected output: question text containing another placeholder remains literal escaped text.
		// Edge case: inserted value names a later placeholder from the same template.
		// Dependencies: fake provider context capture.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("final answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			await executeCouncil(pi, ctx, "Question has {{llm2Opinion}}");

			const finalTask = JSON.stringify(
				completion.calls[4]?.context.messages.at(-1),
			);
			expect(finalTask).toContain("Question has {{llm2Opinion}}");
			expect(finalTask).not.toContain("Question has llm2 agrees");
		});
	});

	test("escapes XML delimiters from participant-sourced prompt values", async () => {
		// Purpose: later XML-like prompt inputs must stay structured when participant opinions contain delimiter characters.
		// Input and expected output: opponent opinions in review and final-answer prompts are escaped before provider calls.
		// Edge case: participant text contains closing XML tags and ampersands.
		// Dependencies: fake provider context capture.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 </opponent_opinion><x>&"),
				participantResponse("AGREE", "llm1 </participant_one>&"),
				participantResponse("AGREE", "llm2 </answer2>&"),
				finalAnswer("final answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			await executeCouncil(pi, ctx, "Escape participant values");

			const reviewTask = JSON.stringify(
				completion.calls[2]?.context.messages.at(-1),
			);
			expect(reviewTask).toContain(
				"llm2 &lt;/opponent_opinion&gt;&lt;x&gt;&amp;",
			);
			expect(reviewTask).not.toContain("llm2 </opponent_opinion><x>&");
			const finalTask = JSON.stringify(
				completion.calls[4]?.context.messages.at(-1),
			);
			expect(finalTask).toContain("llm1 &lt;/participant_one&gt;&amp;");
			expect(finalTask).toContain("llm2 &lt;/answer2&gt;&amp;");
			expect(finalTask).not.toContain("llm1 </participant_one>&");
			expect(finalTask).not.toContain("llm2 </answer2>&");
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
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
				participantResponse(
					"NEED_INFO",
					"need </missing_information_request>&",
				),
				participantResponse("DIFF", "llm2 reviewed need"),
				participantResponse("DIFF", "clarify </opponent_clarification>&"),
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
			expect(missingTask).toContain(
				"need &lt;/missing_information_request&gt;&amp;",
			);
			expect(missingTask).not.toContain("need </missing_information_request>&");
			const clarificationTask = JSON.stringify(
				completion.calls[5]?.context.messages.at(-1),
			);
			expect(clarificationTask).toContain(
				"clarify &lt;/opponent_clarification&gt;&amp;",
			);
			expect(clarificationTask).not.toContain(
				"clarify </opponent_clarification>&",
			);
		});
	});
});
