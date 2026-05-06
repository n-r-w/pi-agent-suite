import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import conveneCouncil from "../../../pi-package/extensions/convene-council/index";
import { withIsolatedAgentDir, writeEnabledConfig } from "./support/env";
import {
	createCompletionQueue,
	createContext,
	createExtensionApiFake,
} from "./support/fakes";
import { createModel } from "./support/models";
import {
	finalAnswer,
	initialOpinion,
	nonTextFinalAnswer,
	participantResponse,
} from "./support/responses";
import { executeCouncil } from "./support/tool";

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

describe("convene-council retries", () => {
	test("retries malformed participant output as a response defect", async () => {
		// Purpose: response-defect retry must repair malformed participant XML without counting it as a completed turn.
		// Input and expected output: first malformed LLM1 output is retried once before normal convergence.
		// Edge case: the defective text must not be added to the next participant context.
		// Dependencies: fake queued model responses.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				finalAnswer("malformed"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("final after retry"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Repair output");

			expect(result.content).toEqual([
				{ type: "text", text: "final after retry" },
			]);
			expect(completion.calls).toHaveLength(6);
			expect(JSON.stringify(completion.calls[4]?.context)).not.toContain(
				"malformed",
			);
		});
	});

	test("passes abort signals to participant and final-answer runner calls", async () => {
		// Purpose: in-flight cancellation can work only when the active signal reaches every runner prompt.
		// Input and expected output: all participant and final-answer calls receive the caller signal.
		// Edge case: the signal is present but not aborted, so normal execution still completes.
		// Dependencies: fake runner call capture and AbortController.
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
		// Purpose: final answers must not contain discussion tags.
		// Input and expected output: tagged final answer is retried once and then final answer text is returned.
		// Edge case: final-answer retry uses the same response-defect retry budget as participant defects.
		// Dependencies: fake convergence and final-answer responses.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("<answer1>bad</answer1>"),
				finalAnswer("final answer"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Return final answer");

			expect(result.content).toEqual([{ type: "text", text: "final answer" }]);
			expect(completion.calls).toHaveLength(6);
		});
	});

	test("rejects duplicate participant blocks and outside text as response defects", async () => {
		// Purpose: participant response parsing must enforce exactly one status block and one opinion block with no outside text.
		// Input and expected output: duplicate opinion and leading whitespace are rejected before a completed participant pair.
		// Edge case: responseDefectRetries zero exposes the immediate parser decision.
		// Dependencies: suite config and fake queued model responses.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {
				participantIterationLimit: 2,
				responseDefectRetries: 0,
			});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				finalAnswer(
					"<status>NEED_INFO</status><opinion>a</opinion><opinion>b</opinion>",
				),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([model]);

			const duplicateResult = await executeCouncil(pi, ctx, "Reject duplicate");

			expect(duplicateResult.content).toEqual([
				{
					type: "text",
					text: "llm1 returned unusable participant output.",
				},
			]);
			expect(completion.calls).toHaveLength(3);
		});

		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {
				participantIterationLimit: 2,
				responseDefectRetries: 0,
			});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				finalAnswer(" <status>NEED_INFO</status><opinion>a</opinion>"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
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
			expect(completion.calls).toHaveLength(3);
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
				await writeEnabledConfig(agentDir, {
					participantIterationLimit: 2,
					responseDefectRetries: 0,
				});
				const model = createModel("openai", "main-model");
				const completion = createCompletionQueue([
					initialOpinion("llm1 initial"),
					initialOpinion("llm2 initial"),
					testCase.response,
				]);
				const pi = createExtensionApiFake();
				conveneCouncil(pi, {
					createParticipantRunner: completion.createParticipantRunner,
				});
				const ctx = createContext([model]);

				const result = await executeCouncil(pi, ctx, testCase.name);

				expect(result.content).toEqual([
					{
						type: "text",
						text: "llm1 returned unusable participant output.",
					},
				]);
				expect(completion.calls).toHaveLength(3);
			});
		}

		const finalCases = [
			{ name: "empty final answer", response: finalAnswer("   ") },
			{ name: "non-text final answer", response: nonTextFinalAnswer() },
		] as const;

		for (const testCase of finalCases) {
			await withIsolatedAgentDir(async (agentDir) => {
				await writeEnabledConfig(agentDir, {
					responseDefectRetries: 0,
				});
				const model = createModel("openai", "main-model");
				const completion = createCompletionQueue([
					initialOpinion("llm1 initial"),
					initialOpinion("llm2 initial"),
					participantResponse("AGREE", "llm1 agrees"),
					participantResponse("AGREE", "llm2 agrees"),
					testCase.response,
				]);
				const pi = createExtensionApiFake();
				conveneCouncil(pi, {
					createParticipantRunner: completion.createParticipantRunner,
				});
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
			await writeEnabledConfig(agentDir, {
				participantIterationLimit: 2,
				responseDefectRetries: 0,
			});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				finalAnswer("malformed"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
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
			await writeEnabledConfig(agentDir, { responseDefectRetries: 0 });
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("<status>bad</status>"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
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
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("An internal process handles scheduling."),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Domain wording");

			expect(result.content).toEqual([
				{ type: "text", text: "An internal process handles scheduling." },
			]);
		});
	});

	test("surfaces participant context-size failures with persisted rows", async () => {
		// Purpose: oversized child context must give the main agent failure information and keep TUI participant rows.
		// Input and expected output: participant runner context-size error is returned as failed council text with failed details.
		// Edge case: failure happens after participant sessions and runners are created.
		// Dependencies: custom runner fake.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			const model = createModel("openai", "main-model");
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				async createParticipantRunner() {
					return {
						async prompt() {
							throw new Error("context is too large");
						},
						async dispose() {},
					};
				},
			});
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Large context");

			expect(result.content).toEqual([
				{ type: "text", text: "context is too large" },
			]);
			expect(result.details).toMatchObject({
				type: "convene_council_progress",
				status: "failed",
				phase: "failed",
			});
			expect(JSON.stringify(result.details)).toContain("displayName");
		});
	});

	test("surfaces participant runner failures without transport retries", async () => {
		// Purpose: participant transport failures must fail the council without hidden retries.
		// Input and expected output: both independent initial participants fail once and final details keep participant rows.
		// Edge case: response-defect retry budget does not apply to transport failures.
		// Dependencies: custom runner fake.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, { responseDefectRetries: 3 });
			const model = createModel("openai", "main-model");
			const calls: unknown[] = [];
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				async createParticipantRunner() {
					return {
						async prompt() {
							calls.push(undefined);
							throw new Error("participant failure");
						},
						async dispose() {},
					};
				},
			});
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Participant failure");

			expect(result.content).toEqual([
				{
					type: "text",
					text: "participant request failed: participant failure",
				},
			]);
			expect(result.details).toMatchObject({
				type: "convene_council_progress",
				status: "failed",
				phase: "failed",
			});
			expect(calls).toHaveLength(2);
		});
	});

	test("does not prompt a participant when the signal is already aborted", async () => {
		// Purpose: cancellation requested before execution must prevent the first participant prompt and keep final rows.
		// Input and expected output: already-aborted signal returns abort information and records zero prompts.
		// Edge case: model resolution still succeeds before the first participant boundary.
		// Dependencies: AbortController and custom runner fake.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			const model = createModel("openai", "main-model");
			const calls: unknown[] = [];
			const abortController = new AbortController();
			abortController.abort();
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				async createParticipantRunner() {
					return {
						async prompt() {
							calls.push(undefined);
							throw new Error("should not be called");
						},
						async dispose() {},
					};
				},
			});
			const ctx = createContext([model]);

			const result = await executeCouncil(
				pi,
				ctx,
				"Already aborted",
				abortController.signal,
			);

			expect(result.content).toEqual([
				{ type: "text", text: "participant request aborted" },
			]);
			expect(result.details).toMatchObject({
				type: "convene_council_progress",
				status: "aborted",
				phase: "aborted",
			});
			expect(calls).toHaveLength(0);
		});
	});

	test("does not retry when participant runner fails after the signal is aborted", async () => {
		// Purpose: cancellation reported by the active participant call must not start retry attempts.
		// Input and expected output: the fake runner aborts the signal, throws once, and final rows show aborted state.
		// Edge case: response-defect retry does not apply to transport failures.
		// Dependencies: AbortController and custom runner fake.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			const model = createModel("openai", "main-model");
			const abortController = new AbortController();
			const calls: unknown[] = [];
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				async createParticipantRunner() {
					return {
						async prompt() {
							calls.push(undefined);
							abortController.abort();
							throw new Error("aborted participant call");
						},
						async dispose() {},
					};
				},
			});
			const ctx = createContext([model]);

			const result = await executeCouncil(
				pi,
				ctx,
				"Abort active call",
				abortController.signal,
			);

			expect(result.content).toEqual([
				{
					type: "text",
					text: "participant request failed: aborted participant call",
				},
			]);
			expect(result.details).toMatchObject({
				type: "convene_council_progress",
				status: "aborted",
				phase: "aborted",
			});
			expect(calls).toHaveLength(1);
		});
	});

	test("truncates large non-agreement output and saves the full output", async () => {
		// Purpose: non-agreement council output must use the same Pi-style truncation as final answers.
		// Input and expected output: large latest opinions produce a full-output notice and temp file details.
		// Edge case: the full output file must contain escaped answer tags.
		// Dependencies: shared truncation helper and system temp directory.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {
				participantIterationLimit: 1,
			});
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
				initialOpinion(llm1Opinion),
				initialOpinion(llm2Opinion),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Large no agreement");

			const text =
				result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("Full output:");
			const details = expectCouncilTruncationDetails(result.details);
			expectNoConsensusResult(
				await readFile(details.fullOutputPath, "utf8"),
				llm1Opinion,
				llm2Opinion,
			);
		});
	});

	test("truncates large final answers and saves the full output", async () => {
		// Purpose: council output must use Pi-style truncation for large final answers.
		// Input and expected output: large final answer produces a full-output notice and temp file details.
		// Edge case: the full output file must contain the untruncated answer.
		// Dependencies: shared truncation helper and system temp directory.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeEnabledConfig(agentDir, {});
			const model = createModel("openai", "main-model");
			const largeAnswer = Array.from(
				{ length: 2100 },
				(_, index) => `line-${index}`,
			).join("\n");
			const completion = createCompletionQueue([
				initialOpinion("llm1 initial"),
				initialOpinion("llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer(largeAnswer),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, {
				createParticipantRunner: completion.createParticipantRunner,
			});
			const ctx = createContext([model]);

			const result = await executeCouncil(pi, ctx, "Large answer");

			const text =
				result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("Full output:");
			const details = expectCouncilTruncationDetails(result.details);
			expect(await readFile(details.fullOutputPath, "utf8")).toBe(largeAnswer);
		});
	});
});

/** Verifies that truncation metadata is nested under persisted council UI details. */
function expectCouncilTruncationDetails(details: unknown): {
	readonly fullOutputPath: string;
} {
	expect(typeof details).toBe("object");
	expect(details).not.toBeNull();
	const record = details as Record<string, unknown>;
	expect(record["type"]).toBe("convene_council_progress");
	expect(Array.isArray(record["participants"])).toBe(true);
	const outputDetails = record["outputDetails"] as
		| Record<string, unknown>
		| undefined;
	expect(typeof outputDetails).toBe("object");
	expect(outputDetails).not.toBeNull();
	expect(Object.keys(outputDetails ?? {}).sort()).toEqual([
		"fullOutputPath",
		"truncation",
	]);
	expect(typeof outputDetails?.["fullOutputPath"]).toBe("string");
	expect(typeof outputDetails?.["truncation"]).toBe("object");
	expect(outputDetails?.["truncation"]).not.toBeNull();
	return { fullOutputPath: outputDetails?.["fullOutputPath"] as string };
}
