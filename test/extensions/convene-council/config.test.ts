import { describe, expect, test } from "bun:test";
import conveneCouncil from "../../../pi-package/extensions/convene-council/index";
import {
	withIsolatedAgentDir,
	writeConfig,
	writeRawConfig,
} from "./support/env";
import {
	createCompletionQueue,
	createContext,
	createExtensionApiFake,
} from "./support/fakes";
import { createModel } from "./support/models";
import { finalAnswer, participantResponse } from "./support/responses";
import { executeCouncil } from "./support/tool";

describe("convene-council config", () => {
	test("does not register convene_council when explicitly disabled", async () => {
		// Purpose: disabled config must remove the council tool and prompt contribution.
		// Input and expected output: enabled false registers no convene_council tool.
		// Edge case: missing dependencies are not involved, so config is the only disablement source.
		// Dependencies: isolated agent directory and in-memory ExtensionAPI fake.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { enabled: false });
			const pi = createExtensionApiFake();

			conveneCouncil(pi);

			expect(pi.tools.map((tool) => tool.name)).not.toContain(
				"convene_council",
			);
		});
	});

	test("throws tool errors for invalid config without provider calls", async () => {
		// Purpose: invalid config is a non-logical tool failure and must not call any participant model.
		// Input and expected output: representative invalid config values throw safe errors and notify the UI.
		// Edge case: each validation branch should fail before model resolution and provider calls.
		// Dependencies: suite config file and fake completion queue.
		const cases: ReadonlyArray<{
			readonly config: unknown;
			readonly error: string;
		}> = [
			{ config: null, error: "config must be an object" },
			{
				config: { extra: true },
				error: "config contains unsupported keys",
			},
			{ config: { enabled: "yes" }, error: "enabled must be a boolean" },
			{ config: { llm1: "bad" }, error: "llm1 must be an object" },
			{
				config: { llm1: { extra: true } },
				error: "llm1 contains unsupported keys",
			},
			{
				config: { llm1: { model: "bad" } },
				error: "llm1.model must be an object",
			},
			{
				config: { llm1: { model: { extra: true } } },
				error: "llm1.model contains unsupported keys",
			},
			{
				config: { llm1: { model: { id: "" } } },
				error: "llm1.model.id must be a non-empty string",
			},
			{
				config: { llm1: { model: { id: "missing-separator" } } },
				error: "llm1.model.id must use provider/model",
			},
			{
				config: { llm1: { model: { thinking: "huge" } } },
				error:
					"llm1.model.thinking must be one of off, minimal, low, medium, high, xhigh",
			},
			{
				config: { participantIterationLimit: 0 },
				error: "participantIterationLimit must be a positive integer",
			},
			{
				config: { responseDefectRetries: -1 },
				error: "responseDefectRetries must be a non-negative integer",
			},
			{
				config: { providerRequestRetries: 1.5 },
				error: "providerRequestRetries must be a non-negative integer",
			},
			{
				config: { providerRetryDelayMs: -1 },
				error: "providerRetryDelayMs must be a non-negative integer",
			},
			{
				config: { finalAnswerParticipant: "llm3" },
				error: "finalAnswerParticipant must be one of llm1, llm2",
			},
		];

		for (const testCase of cases) {
			await withIsolatedAgentDir(async (agentDir) => {
				await writeConfig(agentDir, testCase.config);
				const model = createModel("openai", "main-model");
				const completion = createCompletionQueue([
					participantResponse("NEED_INFO", "should not be used"),
				]);
				const pi = createExtensionApiFake();
				conveneCouncil(pi, { completeSimple: completion.completeSimple });
				const ctx = createContext([model]);

				await expect(executeCouncil(pi, ctx, "Invalid config")).rejects.toThrow(
					testCase.error,
				);
				expect(completion.calls).toHaveLength(0);
				expect(ctx.notifications).toEqual([
					{
						message: `[convene-council] ${testCase.error}`,
						type: "warning",
					},
				]);
			});
		}
	});

	test("throws a tool error for malformed config JSON without provider calls", async () => {
		// Purpose: corrupted config files must fail as configuration errors before any model call.
		// Input and expected output: malformed JSON throws a safe parse error and notifies the UI.
		// Edge case: the file exists, so missing-config defaults must not apply.
		// Dependencies: raw suite config file and fake completion queue.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeRawConfig(agentDir, "{");
			const model = createModel("openai", "main-model");
			const completion = createCompletionQueue([
				participantResponse("NEED_INFO", "should not be used"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([model]);

			await expect(executeCouncil(pi, ctx, "Malformed config")).rejects.toThrow(
				"failed to parse config",
			);
			expect(completion.calls).toHaveLength(0);
			expect(ctx.notifications).toHaveLength(1);
			expect(ctx.notifications[0]?.message).toContain(
				"[convene-council] failed to parse config",
			);
		});
	});

	test("throws tool errors for runtime model and auth failures", async () => {
		// Purpose: runtime resolution failures are non-logical tool failures and must not call providers.
		// Input and expected output: missing current model, missing configured model, and auth failure throw safe errors.
		// Edge case: config validation succeeds before each runtime failure.
		// Dependencies: fake model registry and fake completion queue.
		const cases: ReadonlyArray<{
			readonly config?: unknown;
			readonly models: ReturnType<typeof createModel>[];
			readonly authResult?: { readonly ok: false; readonly error: string };
			readonly error: string;
		}> = [
			{
				models: [],
				error: "current model is unavailable",
			},
			{
				config: { llm1: { model: { id: "missing/model" } } },
				models: [createModel("openai", "main-model")],
				error: "llm1 model missing/model was not found",
			},
			{
				models: [createModel("openai", "main-model")],
				authResult: { ok: false, error: "missing token" },
				error: "llm1 model auth unavailable: missing token",
			},
		];

		for (const testCase of cases) {
			await withIsolatedAgentDir(async (agentDir) => {
				if (testCase.config !== undefined) {
					await writeConfig(agentDir, testCase.config);
				}
				const completion = createCompletionQueue([
					participantResponse("NEED_INFO", "should not be used"),
				]);
				const pi = createExtensionApiFake();
				conveneCouncil(pi, { completeSimple: completion.completeSimple });
				const ctx = createContext(
					testCase.models,
					[],
					testCase.authResult === undefined
						? {}
						: { authResult: testCase.authResult },
				);

				await expect(
					executeCouncil(pi, ctx, "Runtime failure"),
				).rejects.toThrow(testCase.error);
				expect(completion.calls).toHaveLength(0);
				expect(ctx.notifications).toEqual([
					{
						message: `[convene-council] ${testCase.error}`,
						type: "warning",
					},
				]);
			});
		}
	});

	test("uses llm2 as the default final answer participant", async () => {
		// Purpose: missing finalAnswerParticipant must use LLM2, not the last caller by accident.
		// Input and expected output: the final provider call uses the LLM2 configured model.
		// Edge case: LLM1 and LLM2 use different configured models.
		// Dependencies: suite config and fake model registry.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				llm1: { model: { id: "provider-a/model-a" } },
				llm2: { model: { id: "provider-b/model-b" } },
			});
			const llm1Model = createModel("provider-a", "model-a");
			const llm2Model = createModel("provider-b", "model-b");
			const completion = createCompletionQueue([
				participantResponse("NEED_INFO", "llm1 initial"),
				participantResponse("NEED_INFO", "llm2 initial"),
				participantResponse("AGREE", "llm1 agrees"),
				participantResponse("AGREE", "llm2 agrees"),
				finalAnswer("llm2 final"),
			]);
			const pi = createExtensionApiFake();
			conveneCouncil(pi, { completeSimple: completion.completeSimple });
			const ctx = createContext([llm1Model, llm2Model]);

			await executeCouncil(pi, ctx, "Default final participant");

			expect(completion.calls.at(-1)?.model.id).toBe("model-b");
		});
	});
});
