import type { Context, Message } from "@earendil-works/pi-ai";
import {
	getEncodingNameForModel,
	Tiktoken,
	type TiktokenModel,
} from "js-tiktoken/lite";
import cl100kBase from "js-tiktoken/ranks/cl100k_base";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import r50kBase from "js-tiktoken/ranks/r50k_base";

/** Extra request framing reserve for chat wrappers, roles, and provider metadata. */
const MODEL_INPUT_TOKEN_RESERVE = 256;

/** Per-message framing reserve for role labels and provider chat wrappers. */
const MESSAGE_TOKEN_RESERVE = 4;

/** Per-tool framing reserve for tool schema wrappers. */
const TOOL_TOKEN_RESERVE = 8;

/** Image reserve aligned with Pi's compaction estimate: about 1200 tokens per image. */
const IMAGE_TOKEN_RESERVE = 1_200;

const TOKENIZERS = {
	cl100k_base: new Tiktoken(cl100kBase),
	o200k_base: new Tiktoken(o200kBase),
	r50k_base: new Tiktoken(r50kBase),
} as const;

const OPENAI_FAMILY_PROVIDERS = new Set([
	"azure-openai-responses",
	"openai",
	"openai-codex",
]);

const MODERN_OPENAI_MODEL_PATTERN =
	/(?:^|[/_-])(chatgpt-4o|gpt-4\.1|gpt-4o|gpt-5|o[134])(?:$|[._/-])/;

type SupportedEncoding = keyof typeof TOKENIZERS;

/** Returns a tokenizer-based estimate for model-visible context input. */
export function estimateSerializedInputTokens(
	context: Context,
	modelId: string | undefined,
	provider: string | undefined,
): number {
	return (
		estimateModelVisibleContextTokens(context, modelId, provider) +
		MODEL_INPUT_TOKEN_RESERVE
	);
}

/** Returns a tokenizer-based estimate for standalone model-visible text. */
export function estimateTextTokens(
	text: string,
	modelId: string | undefined,
	provider: string | undefined,
): number {
	return countTextTokens(text, modelId, provider);
}

/** Returns a selected-tokenizer prefix containing at most the requested token count. */
export function takeTextTokenPrefix(
	text: string,
	maxTokens: number,
	modelId: string | undefined,
	provider: string | undefined,
): string {
	if (!Number.isInteger(maxTokens) || maxTokens <= 0 || text.length === 0) {
		return "";
	}
	const encoding = getTextEncoding(text, modelId, provider);
	const tokenizer = TOKENIZERS[encoding];
	const tokens = tokenizer.encode(text, [], []);
	for (
		let tokenCount = Math.min(maxTokens, tokens.length);
		tokenCount > 0;
		tokenCount -= 1
	) {
		const prefix = tokenizer.decode(tokens.slice(0, tokenCount));
		if (text.startsWith(prefix)) {
			return prefix;
		}
	}
	return "";
}

/** Returns a tokenizer-based count for model-visible text with the default projection encoding. */
export function countProjectionTextTokens(text: string): number {
	return countTokens(text, "o200k_base");
}

/** Counts only fields that become model-visible provider input. */
function estimateModelVisibleContextTokens(
	context: Context,
	modelId: string | undefined,
	provider: string | undefined,
): number {
	let tokens = 0;
	if (context.systemPrompt !== undefined) {
		tokens += countTextTokens(context.systemPrompt, modelId, provider);
	}
	for (const message of context.messages) {
		tokens += estimateMessageTokens(message, modelId, provider);
	}
	for (const tool of context.tools ?? []) {
		tokens +=
			countTextTokens(JSON.stringify(tool), modelId, provider) +
			TOOL_TOKEN_RESERVE;
	}
	return tokens;
}

/** Estimates one message from role-visible text, tool calls, and images. */
function estimateMessageTokens(
	message: Message,
	modelId: string | undefined,
	provider: string | undefined,
): number {
	let tokens = MESSAGE_TOKEN_RESERVE;
	switch (message.role) {
		case "user": {
			return tokens + estimateContentTokens(message.content, modelId, provider);
		}
		case "assistant": {
			for (const block of message.content) {
				if (block.type === "text") {
					tokens += countTextTokens(block.text, modelId, provider);
				} else if (block.type === "thinking") {
					tokens += countTextTokens(block.thinking, modelId, provider);
				} else if (block.type === "toolCall") {
					tokens += countTextTokens(
						`${block.name}\n${JSON.stringify(block.arguments)}`,
						modelId,
						provider,
					);
				}
			}
			return tokens;
		}
		case "toolResult": {
			return tokens + estimateContentTokens(message.content, modelId, provider);
		}
	}
}

/** Estimates text and image content blocks that are visible to the model. */
function estimateContentTokens(
	content: Message["content"],
	modelId: string | undefined,
	provider: string | undefined,
): number {
	if (typeof content === "string") {
		return countTextTokens(content, modelId, provider);
	}

	let tokens = 0;
	for (const block of content) {
		if (block.type === "text") {
			tokens += countTextTokens(block.text, modelId, provider);
		} else if (block.type === "image") {
			tokens += IMAGE_TOKEN_RESERVE;
		}
	}
	return tokens;
}

/** Counts text with a known model encoding or with a max-of-common-encodings fallback. */
function countTextTokens(
	text: string,
	modelId: string | undefined,
	provider: string | undefined,
): number {
	const knownEncoding = getKnownEncoding(modelId, provider);
	if (knownEncoding !== undefined) {
		return countTokens(text, knownEncoding);
	}

	return Math.max(
		countTokens(text, "o200k_base"),
		countTokens(text, "cl100k_base"),
		countTokens(text, "r50k_base"),
	);
}

/** Selects the known model encoding or the most conservative loaded encoding for this text. */
function getTextEncoding(
	text: string,
	modelId: string | undefined,
	provider: string | undefined,
): SupportedEncoding {
	const knownEncoding = getKnownEncoding(modelId, provider);
	if (knownEncoding !== undefined) {
		return knownEncoding;
	}
	return (Object.keys(TOKENIZERS) as SupportedEncoding[]).reduce(
		(selected, candidate) =>
			countTokens(text, candidate) > countTokens(text, selected)
				? candidate
				: selected,
		"o200k_base",
	);
}

/** Maps supported OpenAI model IDs to their tokenizer encoding. */
function getKnownEncoding(
	modelId: string | undefined,
	provider: string | undefined,
): SupportedEncoding | undefined {
	if (modelId === undefined || !isOpenAiFamilyProvider(provider)) {
		return undefined;
	}

	try {
		const encoding = getEncodingNameForModel(modelId as TiktokenModel);
		return isSupportedEncoding(encoding) ? encoding : undefined;
	} catch {
		return isModernOpenAiModel(modelId) ? "o200k_base" : undefined;
	}
}

/** Counts text tokens while treating special-token-looking text as normal user text. */
function countTokens(text: string, encoding: SupportedEncoding): number {
	return TOKENIZERS[encoding].encode(text, [], []).length;
}

/** Returns true when this module loaded the tokenizer rank for an encoding. */
function isSupportedEncoding(value: string): value is SupportedEncoding {
	return (
		value === "cl100k_base" || value === "o200k_base" || value === "r50k_base"
	);
}

/** Returns true for providers that use OpenAI-compatible model families. */
function isOpenAiFamilyProvider(provider: string | undefined): boolean {
	return provider !== undefined && OPENAI_FAMILY_PROVIDERS.has(provider);
}

/** Returns true when a model family is known to use the modern OpenAI tokenizer. */
function isModernOpenAiModel(modelId: string): boolean {
	return MODERN_OPENAI_MODEL_PATTERN.test(modelId);
}
