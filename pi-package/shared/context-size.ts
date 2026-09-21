import {
	type Context,
	type Message,
	normalizeContext,
	type Tool,
} from "@earendil-works/pi-ai";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

/** Extra request framing reserve for chat wrappers, roles, and provider metadata. */
const MODEL_INPUT_TOKEN_RESERVE = 256;

/** Per-message framing reserve for role labels and provider chat wrappers. */
const MESSAGE_TOKEN_RESERVE = 4;

/** Per-tool framing reserve for tool schema wrappers. */
const TOOL_TOKEN_RESERVE = 8;

/** Image reserve aligned with Pi's compaction estimate: about 1200 tokens per image. */
const IMAGE_TOKEN_RESERVE = 1_200;

/** The tokenizer stays uninitialized until token counting is first needed. */
let tokenizer: Tiktoken | undefined;

/** Returns a tokenizer-based estimate for model-visible context input. */
export function estimateSerializedInputTokens(context: Context): number {
	return estimateModelVisibleContextTokens(context) + MODEL_INPUT_TOKEN_RESERVE;
}

/** Returns a tokenizer-based estimate for standalone model-visible text. */
export function estimateTextTokens(text: string): number {
	return countTokens(text);
}

/** Returns an o200k token prefix containing at most the requested token count. */
export function takeTextTokenPrefix(text: string, maxTokens: number): string {
	if (!Number.isInteger(maxTokens) || maxTokens <= 0 || text.length === 0) {
		return "";
	}
	const activeTokenizer = getTokenizer();
	const tokens = activeTokenizer.encode(text, [], []);
	for (
		let tokenCount = Math.min(maxTokens, tokens.length);
		tokenCount > 0;
		tokenCount -= 1
	) {
		const prefix = activeTokenizer.decode(tokens.slice(0, tokenCount));
		if (text.startsWith(prefix)) {
			return prefix;
		}
	}
	return "";
}

/** Returns a tokenizer-based count for model-visible text with the fixed o200k encoding. */
export function countProjectionTextTokens(text: string): number {
	return countTokens(text);
}

/** Returns a tokenizer-based count for bounded knowledge files with the fixed o200k encoding. */
export function countKnowledgeTextTokens(text: string): number {
	return countTokens(text);
}

/** Counts only fields that become model-visible provider input. */
function estimateModelVisibleContextTokens(context: Context): number {
	let tokens = 0;
	for (const message of normalizeContext(context).messages) {
		tokens += estimateMessageTokens(message);
	}
	return tokens;
}

/** Estimates one message from role-visible text, tool calls, and images. */
function estimateMessageTokens(message: Message): number {
	let tokens = MESSAGE_TOKEN_RESERVE;
	switch (message.role) {
		case "system": {
			return estimateSystemMessageTokens(message);
		}
		case "user": {
			return tokens + estimateContentTokens(message.content);
		}
		case "assistant": {
			for (const block of message.content) {
				if (block.type === "text") {
					tokens += countTokens(block.text);
				} else if (block.type === "thinking") {
					tokens += countTokens(block.thinking);
				} else if (block.type === "toolCall") {
					tokens += countTokens(
						`${block.name}\n${JSON.stringify(block.arguments)}`,
					);
				}
			}
			return tokens;
		}
		case "toolResult": {
			return tokens + estimateContentTokens(message.content);
		}
	}
}

/** Estimates one ordered system-state record and every model-visible state change it carries. */
function estimateSystemMessageTokens(
	message: Extract<Message, { role: "system" }>,
): number {
	let tokens = MESSAGE_TOKEN_RESERVE + estimateContentTokens(message.content);
	for (const section of Object.entries(message.sections ?? {})) {
		tokens += countTokens(JSON.stringify(section));
	}
	for (const tool of message.toolsAdded ?? []) {
		tokens += estimateToolTokens(tool);
	}
	for (const tool of message.toolsRemoved ?? []) {
		tokens += countTokens(JSON.stringify(tool));
	}
	return tokens;
}

/** Estimates one model-visible tool declaration with its provider framing reserve. */
function estimateToolTokens(tool: Tool): number {
	return countTokens(JSON.stringify(tool)) + TOOL_TOKEN_RESERVE;
}

/** Estimates text and image content blocks that are visible to the model. */
function estimateContentTokens(content: Message["content"]): number {
	if (typeof content === "string") {
		return countTokens(content);
	}

	let tokens = 0;
	for (const block of content) {
		if (block.type === "text") {
			tokens += countTokens(block.text);
		} else if (block.type === "image") {
			tokens += IMAGE_TOKEN_RESERVE;
		}
	}
	return tokens;
}

/** Creates the shared o200k tokenizer only when a caller first needs token counting. */
function getTokenizer(): Tiktoken {
	if (tokenizer === undefined) {
		tokenizer = new Tiktoken(o200kBase);
	}
	return tokenizer;
}

/** Counts text tokens while treating special-token-looking text as normal user text. */
function countTokens(text: string): number {
	return getTokenizer().encode(text, [], []).length;
}
