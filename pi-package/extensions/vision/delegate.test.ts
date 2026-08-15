import { describe, expect, test } from "bun:test";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
} from "@earendil-works/pi-ai";
import type { AuxiliaryLlmContext } from "../../shared/auxiliary-llm";
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
		input: ["text", "image"],
		contextWindow: 100_000,
	} as unknown as Model<Api>;
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
		const runtime = await resolveVisionRuntime(createContext(), "p", "m");
		expect(runtime.model.id).toBe("m");
		expect(runtime.apiKey).toBe("key");
	});

	test("throws model_not_found and auth_error for resolution failures", async () => {
		await expect(
			resolveVisionRuntime(createContext({ find: null }), "p", "m"),
		).rejects.toMatchObject({ code: "model_not_found" });
		await expect(
			resolveVisionRuntime(
				createContext({ auth: { ok: false, error: "missing" } }),
				"p",
				"m",
			),
		).rejects.toMatchObject({ code: "auth_error" });
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
		const result = await describeImage({
			runtime: await resolveVisionRuntime(createContext(), "p", "m"),
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
		const result = await describeImage({
			runtime: await resolveVisionRuntime(createContext(), "p", "m"),
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
		await expect(
			describeImage({
				runtime: await resolveVisionRuntime(createContext(), "p", "m"),
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
