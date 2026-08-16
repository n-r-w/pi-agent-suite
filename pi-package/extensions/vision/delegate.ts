import type { Context } from "@earendil-works/pi-ai";
import {
	type AuxiliaryLlmCompletion,
	type AuxiliaryLlmContext,
	type AuxiliaryLlmRuntime,
	buildAuxiliaryLlmOptions,
	completeAuxiliaryLlm,
	getAuxiliaryLlmResponseText,
	resolveAuxiliaryLlmRuntime,
} from "../../shared/auxiliary-llm";
import type { ReasoningLevel } from "../../shared/reasoning-levels";
import {
	createRetryableExternalError,
	type RetryConfig,
	withRetry,
} from "../../shared/retry";
import type { LoadedImage } from "./image";

export function mapRuntimeIssue(issue: string): string {
	if (issue.includes("not found")) {
		return "model_not_found";
	}
	if (issue.includes("auth")) {
		return "auth_error";
	}
	return "not_configured";
}

export class VisionGlobalError extends Error {
	public constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export function toGlobalVisionError(issue: string): VisionGlobalError {
	return new VisionGlobalError(mapRuntimeIssue(issue), issue);
}

export async function resolveVisionRuntime(
	ctx: AuxiliaryLlmContext,
	modelId: string,
	thinking: ReasoningLevel | undefined = undefined,
) {
	const runtimeResult = await resolveAuxiliaryLlmRuntime(
		ctx,
		modelId,
		thinking,
	);
	if ("issue" in runtimeResult) {
		throw toGlobalVisionError(runtimeResult.issue);
	}
	return runtimeResult;
}

export async function describeImage(options: {
	readonly runtime: AuxiliaryLlmRuntime;
	readonly thinking: ReasoningLevel | undefined;
	readonly image: LoadedImage;
	readonly prompt: string;
	readonly retry: RetryConfig;
	readonly signal: AbortSignal | undefined;
	readonly completeSimple: AuxiliaryLlmCompletion;
}): Promise<string> {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: [
					{
						type: "image",
						data: options.image.data,
						mimeType: options.image.mimeType,
					},
					{ type: "text", text: options.prompt },
				],
				timestamp: Date.now(),
			},
		],
	};
	return withRetry(
		async () => {
			const response = await completeAuxiliaryLlm(
				options.completeSimple,
				options.runtime,
				context,
				buildAuxiliaryLlmOptions(
					options.thinking,
					options.signal,
					options.runtime,
				),
			);
			if (response.stopReason === "error") {
				throw createRetryableExternalError("vision model returned an error");
			}
			return getAuxiliaryLlmResponseText(response);
		},
		{ retry: options.retry, signal: options.signal },
	);
}
