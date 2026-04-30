import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import conveneCouncil from "../../../pi-package/extensions/convene-council/index";
import { withIsolatedAgentDir, writeConfig } from "./support/env";
import {
	createCompletionQueue,
	createContext,
	createExtensionApiFake,
} from "./support/fakes";
import { createModel } from "./support/models";
import {
	finalAnswer,
	nonTextFinalAnswer,
	participantResponse,
} from "./support/responses";
import { executeCouncil } from "./support/tool";

describe("convene-council retries", () => {
	test("retries malformed participant output as a response defect", async () => {
		// Purpose: response-defect retry must repair malformed participant XML without counting it as a completed turn.
		// Input and expected output: first malformed LLM1 output is retried once before normal convergence.
		// Edge case: the defective text must not be added to the next participant context.
		// Dependencies: fake queued model responses.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				finalAnswer("malformed"),
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("final after retry"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Repair output");

			expect(result.content).toEqual([
				{ type: "text", text: "final after retry" },
			]);
			expect(completion.calls).toHaveLength(6);
			expect(JSON.stringify(completion.calls[2]?.context)).not.toContain(
				"malformed",
			);
		});
	});

	test("retries thrown provider errors separately from response defects", async () => {
		// Purpose: provider retry must repeat a failed provider request without consuming response-defect retry budget.
		// Input and expected output: one thrown provider error is retried, then the discussion reaches a final answer.
		// Edge case: zero retry delay keeps the behavior deterministic in tests.
		// Dependencies: suite config and fake provider failure.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { providerRetryDelayMs: 0 });
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				new Error("temporary network failure"),
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("final after provider retry"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Retry provider");

			expect(result.content).toEqual([
				{ type: "text", text: "final after provider retry" },
			]);
			expect(completion.calls).toHaveLength(6);
		});
	});

	test("retries provider errors on later participant and final-answer calls", async () => {
		// Purpose: provider retry must apply to every model call, not only the first participant request.
		// Input and expected output: one later participant failure and one final-answer failure are retried before success.
		// Edge case: provider failures must not consume response-defect retry budget.
		// Dependencies: suite config and fake provider failures.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { providerRetryDelayMs: 0 });
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				new Error("temporary later participant failure"),
				participantResponse("AGREE", "llm2 agrees"),
				new Error("temporary final failure"),
				finalAnswer("final after later retries"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Retry later calls");

			expect(result.content).toEqual([
				{ type: "text", text: "final after later retries" },
			]);
			expect(completion.calls).toHaveLength(7);
		});
	});

	test("retries unstructured provider throws", async () => {
		// Purpose: provider retry must handle thrown values that are not Error instances.
		// Input and expected output: a thrown string is retried once before normal convergence.
		// Edge case: the thrown value has no message property.
		// Dependencies: suite config and custom provider fake.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				providerRequestRetries: 1,
				providerRetryDelayMs: 0,
			});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("final after string throw"),
			]);
			let attempts = 0;
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				async completeSimple(modelArg, context, options) {
					attempts += 1;
					if (attempts === 1) {
						return Promise.reject("temporary string failure");
					}
					return completion.completeSimple(modelArg, context, options);
				},
			});
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Retry string throw");

			expect(result.content).toEqual([
				{ type: "text", text: "final after string throw" },
			]);
			expect(attempts).toBe(6);
		});
	});

	test("passes abort signals to participant and final-answer provider calls", async () => {
		// Purpose: in-flight cancellation can work only when the active signal reaches every provider request.
		// Input and expected output: all participant and final-answer calls receive the caller signal.
		// Edge case: the signal is present but not aborted, so normal execution still completes.
		// Dependencies: fake provider call capture and AbortController.
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
			const abortController = new AbortController();

			await executeCouncil(
				pi,
				ctx,
				"Signal propagation",
				abortController.signal,
			);

			expect(completion.calls.map((call) => call.options?.signal)).toEqual([
				abortController.signal,
				abortController.signal,
				abortController.signal,
				abortController.signal,
				abortController.signal,
			]);
		});
	});

	test("rejects empty or tagged final answers before returning tool content", async () => {
		// Purpose: final answers must be plain visible text without discussion tags.
		// Input and expected output: tagged final answer is retried once and then plain text is returned.
		// Edge case: final-answer retry uses the same response-defect retry budget as participant defects.
		// Dependencies: fake convergence and final-answer responses.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("<answer1>bad</answer1>"),
				finalAnswer("plain final answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Return plain answer");

			expect(result.content).toEqual([
				{ type: "text", text: "plain final answer" },
			]);
			expect(completion.calls).toHaveLength(6);
		});
	});

	test("rejects duplicate participant blocks and outside text as response defects", async () => {
		// Purpose: participant response parsing must enforce exactly one status block and one opinion block with no outside text.
		// Input and expected output: duplicate opinion and leading whitespace are rejected before a completed participant pair.
		// Edge case: responseDefectRetries zero exposes the immediate parser decision.
		// Dependencies: suite config and fake queued model responses.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				participantIterationLimit: 1,
				responseDefectRetries: 0,
			});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				finalAnswer(
					"<status>NEED_INFO</status><opinion>a</opinion><opinion>b</opinion>",
				),
				participantResponse("NEED_INFO", "llm2 should not complete pair"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			const duplicateResult = await executeCouncil(pi, ctx, "Reject duplicate");

			expect(duplicateResult.content).toEqual([
				{
					type: "text",
					text: "llm1 returned unusable participant output.",
				},
			]);
			expect(completion.calls).toHaveLength(1);
		});

		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { responseDefectRetries: 0 });
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				finalAnswer(" <status>NEED_INFO</status><opinion>a</opinion>"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			const outsideTextResult = await executeCouncil(
				pi,
				ctx,
				"Reject whitespace",
			);

			expect(outsideTextResult.content).toEqual([
				{
					type: "text",
					text: "llm1 returned unusable participant output.",
				},
			]);
			expect(completion.calls).toHaveLength(1);
		});
	});

	test("rejects required participant and final-answer defect classes", async () => {
		// Purpose: every documented response-defect class must use the same defect retry path.
		// Input and expected output: invalid status, missing opinion, empty opinion, empty final answer, and non-text final answer are rejected.
		// Edge case: responseDefectRetries zero exposes the first defect decision without repair.
		// Dependencies: suite config and fake queued model responses.
		const participantCases = [
			{
				name: "invalid status",
				response: finalAnswer(
					"<status>UNKNOWN</status><opinion>invalid</opinion>",
				),
			},
			{
				name: "missing opinion",
				response: finalAnswer("<status>NEED_INFO</status>"),
			},
			{
				name: "empty opinion",
				response: finalAnswer(
					"<status>NEED_INFO</status><opinion>   </opinion>",
				),
			},
		] as const;

		for (const testCase of participantCases) {
			await withIsolatedAgentDir(async (agentDir) => {
				await writeConfig(agentDir, { responseDefectRetries: 0 });
				const model = createModel("openai", "main-model");
				const completion = createCompletionQueue([testCase.response]);
				const pi = createExtensionApiFake();
				conveneCouncil(pi, { completeSimple: completion.completeSimple });
				const ctx = createContext([model]);

				const result = await executeCouncil(pi, ctx, testCase.name);

				expect(result.content).toEqual([
					{
						type: "text",
						text: "llm1 returned unusable participant output.",
					},
				]);
				expect(completion.calls).toHaveLength(1);
			});
		}

		const finalCases = [
			{ name: "empty final answer", response: finalAnswer("   ") },
			{ name: "non-text final answer", response: nonTextFinalAnswer() },
		] as const;

		for (const testCase of finalCases) {
			await withIsolatedAgentDir(async (agentDir) => {
				await writeConfig(agentDir, { responseDefectRetries: 0 });
				const model = createModel("openai", "main-model");
				const completion = createCompletionQueue([
					participantResponse("NEED_INFO", "llm1 initial"),
					participantResponse("NEED_INFO", "llm2 initial"),
					participantResponse("AGREE", "llm1 agrees"),
					participantResponse("AGREE", "llm2 agrees"),
					testCase.response,
				]);
				const pi = createExtensionApiFake();
				conveneCouncil(pi, { completeSimple: completion.completeSimple });
				const ctx = createContext([model]);

				const result = await executeCouncil(pi, ctx, testCase.name);

				expect(result.content).toEqual([
					{
						type: "text",
						text: "Council returned an unusable final answer.",
					},
				]);
				expect(completion.calls).toHaveLength(5);
			});
		}
	});

	test("returns safe errors when response and final-answer repair retries are exhausted", async () => {
		// Purpose: exhausted defect retries must fail closed with documented errors.
		// Input and expected output: repeated malformed participant output and final answer defects return clear tool errors.
		// Edge case: responseDefectRetries zero allows only the first defective response.
		// Dependencies: suite config and fake queued responses.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { responseDefectRetries: 0 });
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([finalAnswer("malformed")]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Exhaust participant retry");

			expect(result.content).toEqual([
				{
					type: "text",
					text: "llm1 returned unusable participant output.",
				},
			]);
		});

		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { responseDefectRetries: 0 });
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("<status>bad</status>"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Exhaust final retry");

			expect(result.content).toEqual([
				{
					type: "text",
					text: "Council returned an unusable final answer.",
				},
			]);
		});
	});

	test("accepts valid final answers that contain internal process as domain text", async () => {
		// Purpose: final-answer validation must reject protocol tags, not safe domain wording.
		// Input and expected output: a plain final answer containing internal process is returned unchanged.
		// Edge case: the phrase is part of the answer domain, not a council-process comment.
		// Dependencies: fake convergence and final-answer response.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("An internal process handles scheduling."),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Domain wording");

			expect(result.content).toEqual([
				{ type: "text", text: "An internal process handles scheduling." },
			]);
		});
	});

	test("throws before provider calls when participant input exceeds the model context window", async () => {
		// Purpose: oversized council input is a non-logical tool failure and must not call the provider.
		// Input and expected output: tiny context window rejects the participant request before completeSimple.
		// Edge case: context-size failure happens after model/auth resolution.
		// Dependencies: fake model context window and fake completion queue.
		await withIsolatedAgentDir(async () => {
			const model = {
				...createModel("openai", "main-model"),
				contextWindow: 1,
			};
			const completion = createCompletionQueue([
				participantResponse("NEED_INFO", "should not be used"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			await expect(executeCouncil(pi, ctx, "Large context")).rejects.toThrow(
				"context is too large",
			);
			expect(completion.calls).toHaveLength(0);
		});
	});

	test("stops provider retries after the configured retry count", async () => {
		// Purpose: sustained provider failures must stop after providerRequestRetries without using response-defect retries.
		// Input and expected output: one retry after the first failure yields two provider calls and a safe error.
		// Edge case: retry delay zero avoids timer dependency.
		// Dependencies: suite config and fake thrown provider errors.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				providerRequestRetries: 1,
				providerRetryDelayMs: 0,
				responseDefectRetries: 3,
			});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				new Error("first failure"),
				new Error("second failure"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			await expect(executeCouncil(pi, ctx, "Provider failure")).rejects.toThrow(
				"provider request failed: second failure",
			);
			expect(completion.calls).toHaveLength(2);
		});
	});

	test("does not start a provider call when the signal is already aborted", async () => {
		// Purpose: cancellation requested before execution must prevent the first external provider request.
		// Input and expected output: already-aborted signal throws a provider-abort error and records zero provider calls.
		// Edge case: model and auth resolution still succeed before the first provider boundary.
		// Dependencies: AbortController and custom provider fake.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "main-model");
			const calls: unknown[] = [];
			const abortController = new AbortController();
			abortController.abort();
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				async completeSimple() {
					calls.push(undefined);
					throw new Error("should not be called");
				},
			});
			const ctx = createContext([model]);

			await expect(
				executeCouncil(pi, ctx, "Already aborted", abortController.signal),
			).rejects.toThrow("provider request aborted");
			expect(calls).toHaveLength(0);
		});
	});

	test("does not start another provider call when aborted during retry delay", async () => {
		// Purpose: cancellation during provider backoff must not start another provider request.
		// Input and expected output: aborting the signal during retry delay returns an error after one provider call.
		// Edge case: delay is non-zero so the abort happens inside waitForRetryDelay.
		// Dependencies: AbortController and fake thrown provider error.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				providerRequestRetries: 2,
				providerRetryDelayMs: 20,
			});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				new Error("first failure"),
				participantResponse("NEED_INFO", "should not be used"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);
			const abortController = new AbortController();
			setTimeout(() => abortController.abort(), 1);

			await expect(
				executeCouncil(pi, ctx, "Abort retry", abortController.signal),
			).rejects.toThrow("provider request failed");
			expect(completion.calls).toHaveLength(1);
		});
	});

	test("does not retry when provider throws after the signal is aborted", async () => {
		// Purpose: cancellation reported by the active provider call must not start retry attempts.
		// Input and expected output: the fake provider aborts the signal and throws once, then execution throws a provider error.
		// Edge case: retry count is available but cancellation takes precedence.
		// Dependencies: AbortController and custom fake completeSimple.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				providerRequestRetries: 3,
				providerRetryDelayMs: 0,
			});
			const model = createModel("openai", "main-model");
			const abortController = new AbortController();
			const calls: unknown[] = [];
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				async completeSimple() {
					calls.push(undefined);
					abortController.abort();
					throw new Error("aborted provider call");
				},
			});
			const ctx = createContext([model]);

			await expect(
				executeCouncil(pi, ctx, "Abort active call", abortController.signal),
			).rejects.toThrow("provider request failed: aborted provider call");
			expect(calls).toHaveLength(1);
		});
	});

	test("truncates large non-agreement output and saves the full output", async () => {
		// Purpose: non-agreement council output must use the same Pi-style truncation as final answers.
		// Input and expected output: large latest opinions produce a full-output notice and temp file details.
		// Edge case: the full output file must contain escaped answer tags.
		// Dependencies: shared truncation helper and system temp directory.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { participantIterationLimit: 1 });
			const model = createModel("openai", "main-model");
			const llm1Opinion = Array.from(
				{ length: 1100 },
				(_, index) => `llm1-${index}`,
			).join("\n");
			const llm2Opinion = Array.from(
				{ length: 1100 },
				(_, index) => `llm2-${index}`,
			).join("\n");
			const completion = createCompletionQueue([
				participantResponse("NEED_INFO", llm1Opinion),
				participantResponse("NEED_INFO", llm2Opinion),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Large no agreement");

			const text =
				result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("Full output:");
			const fullOutput = `<answer1>${llm1Opinion}</answer1><answer2>${llm2Opinion}</answer2>`;
			const details = expectMinimalTruncationDetails(result.details);
			expect(await readFile(details.fullOutputPath, "utf8")).toBe(fullOutput);
		});
	});

	test("truncates large final answers and saves the full output", async () => {
		// Purpose: council output must use Pi-style truncation for large final answers.
		// Input and expected output: large final answer produces a full-output notice and temp file details.
		// Edge case: the full output file must contain the untruncated answer.
		// Dependencies: shared truncation helper and system temp directory.
		await withIsolatedAgentDir(async () => {
			const model = createModel("openai", "main-model");
			const largeAnswer = Array.from(
				{ length: 2100 },
				(_, index) => `line-${index}`,
			).join("\n");
			const completion = createCompletionQueue([
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer(largeAnswer),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Large answer");

			const text =
				result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("Full output:");
			const details = expectMinimalTruncationDetails(result.details);
			expect(await readFile(details.fullOutputPath, "utf8")).toBe(largeAnswer);
		});
	});
});

/** Verifies that truncated results expose only shared truncation metadata. */
function expectMinimalTruncationDetails(details: unknown): {
	readonly fullOutputPath: string;
} {
	expect(typeof details).toBe("object");
	expect(details).not.toBeNull();
	const record = details as Record<string, unknown>;
	expect(Object.keys(record).sort()).toEqual(["fullOutputPath", "truncation"]);
	expect(typeof record["fullOutputPath"]).toBe("string");
	expect(typeof record["truncation"]).toBe("object");
	expect(record["truncation"]).not.toBeNull();
	const serialized = JSON.stringify(record);
	for (const forbiddenField of ["history", "status", "iterations", "retries"]) {
		expect(serialized).not.toContain(forbiddenField);
	}
	return { fullOutputPath: record["fullOutputPath"] as string };
}
