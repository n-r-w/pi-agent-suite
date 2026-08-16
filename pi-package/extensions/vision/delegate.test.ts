import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { AGENT_SUITE_DIR_ENV } from "../../shared/agent-suite-storage";
import type { AuxiliaryLlmContext } from "../../shared/auxiliary-llm";
import { REASONING_LEVELS } from "../../shared/reasoning-levels";
import {
	describeImage,
	mapRuntimeIssue,
	resolveVisionRuntime,
	toGlobalVisionError,
	VisionGlobalError,
} from "./delegate";

const RETRY_DISABLED = { enabled: false, maxRetries: 0, baseDelayMs: 0 };
const IMAGE = { data: "iVBORw0KGgo=", mimeType: "image/png" } as const;

function createModel(): Model<Api> {
	return {
		provider: "p",
		id: "m",
		api: "fake-api",
		baseUrl: "https://example.test",
		reasoning: true,
		thinkingLevelMap: Object.fromEntries(
			REASONING_LEVELS.map((level) => [level, level]),
		),
		name: "p/m",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_192,
	} as Model<Api>;
}

function createContext(
	options: {
		readonly find?: Model<Api> | null;
		readonly auth?:
			| { readonly ok: true; readonly apiKey: string }
			| { readonly ok: false; readonly error: string };
	} = {},
): AuxiliaryLlmContext {
	const model =
		options.find === null ? undefined : (options.find ?? createModel());
	return {
		model: undefined,
		modelRegistry: {
			find: () => model,
			async getApiKeyAndHeaders() {
				return options.auth ?? { ok: true, apiKey: "key" };
			},
		},
	};
}

function assistantMessage(
	text: string,
	stopReason: "done" | "error",
): AssistantMessage {
	return {
		api: "openai-completions",
		provider: "p",
		model: "m",
		name: "m",
		description: "test model",
		parameters: {},
		stopReason,
		content: [{ type: "text", text }],
		timestamp: 1,
	} as unknown as AssistantMessage;
}

describe("vision delegation", () => {
	test("maps auxiliary runtime issues to tool error codes", () => {
		expect(mapRuntimeIssue("model provider/model was not found")).toBe(
			"model_not_found",
		);
		expect(mapRuntimeIssue("model auth unavailable: no key")).toBe(
			"auth_error",
		);
		const error = toGlobalVisionError("model provider/model was not found");
		expect(error).toBeInstanceOf(VisionGlobalError);
		expect(error.code).toBe("model_not_found");
	});

	test("resolves an authenticated runtime", async () => {
		const resolved = await resolveVisionRuntime(createContext(), "p/m");
		expect(resolved.runtime.model.id).toBe("m");
		expect(resolved.runtime.apiKey).toBe("key");
	});

	test("throws model_not_found and auth_error for resolution failures", async () => {
		await expect(
			resolveVisionRuntime(createContext({ find: null }), "p/m"),
		).rejects.toMatchObject({ code: "model_not_found" });
		await expect(
			resolveVisionRuntime(
				createContext({ auth: { ok: false, error: "missing" } }),
				"p/m",
			),
		).rejects.toMatchObject({ code: "auth_error" });
	});

	test("resolves an alias and lets explicit thinking override its default", async () => {
		// Purpose: vision uses the shared alias precedence contract before calling the selected model.
		// Input and expected output: an alias with low thinking resolves p/m, while explicit high thinking becomes the request reasoning.
		// Edge case: resolving the same alias without explicit thinking retains the alias default.
		// Dependencies: isolated model-alias config, fake model registry, and injected completion boundary.
		const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
		const suiteDir = await mkdtemp(join(tmpdir(), "vision-alias-"));
		await mkdir(join(suiteDir, "model-aliases"));
		await writeFile(
			join(suiteDir, "model-aliases", "config.json"),
			JSON.stringify({
				"vision-default": { id: "p/m", thinking: "low" },
			}),
		);
		process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
		try {
			const aliasDefault = await resolveVisionRuntime(
				createContext(),
				"vision-default",
			);
			expect(aliasDefault.thinking).toBe("low");

			const explicit = await resolveVisionRuntime(
				createContext(),
				"vision-default",
				"high",
			);
			expect(explicit.runtime.model.id).toBe("m");
			expect(explicit.thinking).toBe("high");

			let capturedOptions: SimpleStreamOptions | undefined;
			await describeImage({
				runtime: explicit.runtime,
				thinking: explicit.thinking,
				image: IMAGE,
				prompt: "Describe",
				retry: RETRY_DISABLED,
				signal: undefined,
				completeSimple: async (_model, _context, options) => {
					capturedOptions = options;
					return assistantMessage("description", "done");
				},
			});
			expect(capturedOptions?.reasoning).toBe("high");
		} finally {
			if (previousSuiteDir === undefined) {
				delete process.env[AGENT_SUITE_DIR_ENV];
			} else {
				process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
			}
		}
	});

	test("sends image and prompt content and returns the response text", async () => {
		let captured: Context | undefined;
		const complete = async (
			_model: Model<Api>,
			context: Context,
		): Promise<AssistantMessage> => {
			captured = context;
			return assistantMessage("description", "done");
		};
		const resolved = await resolveVisionRuntime(createContext(), "p/m");
		const result = await describeImage({
			runtime: resolved.runtime,
			thinking: resolved.thinking,
			image: IMAGE,
			prompt: "What is shown?",
			retry: RETRY_DISABLED,
			signal: undefined,
			completeSimple: complete,
		});
		expect(result).toBe("description");
		expect(captured?.messages[0]?.content).toEqual([
			{ type: "image", data: IMAGE.data, mimeType: IMAGE.mimeType },
			{ type: "text", text: "What is shown?" },
		]);
	});

	test("retries an error response before returning success", async () => {
		let calls = 0;
		const complete = async (): Promise<AssistantMessage> => {
			calls += 1;
			return calls === 1
				? assistantMessage("failed", "error")
				: assistantMessage("recovered", "done");
		};
		const resolved = await resolveVisionRuntime(createContext(), "p/m");
		const result = await describeImage({
			runtime: resolved.runtime,
			thinking: resolved.thinking,
			image: IMAGE,
			prompt: "Describe",
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			signal: undefined,
			completeSimple: complete,
		});
		expect(result).toBe("recovered");
		expect(calls).toBeGreaterThan(1);
	});

	test("does not retry an abort error", async () => {
		let calls = 0;
		const complete = async (): Promise<AssistantMessage> => {
			calls += 1;
			const error = new Error("aborted");
			error.name = "AbortError";
			throw error;
		};
		const resolved = await resolveVisionRuntime(createContext(), "p/m");
		await expect(
			describeImage({
				runtime: resolved.runtime,
				thinking: resolved.thinking,
				image: IMAGE,
				prompt: "Describe",
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
				signal: undefined,
				completeSimple: complete,
			}),
		).rejects.toThrow("aborted");
		expect(calls).toBe(1);
	});
});
