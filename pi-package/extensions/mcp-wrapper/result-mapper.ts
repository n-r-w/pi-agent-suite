import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { truncateToolTextOutput } from "../../shared/tool-output-truncation.ts";

const TEMP_FILE_ID_BYTES = 8;
const TEMP_FILE_MODE = 0o600;
const IMAGE_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};

export interface McpToolResultDetails {
	readonly rawResult: unknown;
	readonly isError: boolean;
	readonly truncation?: unknown;
}

type McpContentBlock =
	| { readonly type: "text"; readonly text?: string }
	| {
			readonly type: "image";
			readonly data?: string;
			readonly mimeType?: string;
	  }
	| {
			readonly type: "audio";
			readonly data?: string;
			readonly mimeType?: string;
	  }
	| {
			readonly type: "resource";
			readonly resource?: {
				readonly uri?: string;
				readonly text?: string;
				readonly blob?: string;
				readonly mimeType?: string;
			};
	  }
	| {
			readonly type: "resource_link";
			readonly uri?: string;
			readonly name?: string;
			readonly mimeType?: string;
	  };

interface McpCallResult {
	readonly content?: readonly McpContentBlock[];
	readonly isError?: boolean;
}

interface MappedContentBlock {
	readonly text?: string;
	readonly image?: {
		readonly type: "image";
		readonly data: string;
		readonly mimeType: string;
	};
}

/** Maps MCP tool content into Pi model-facing tool result content. */
export async function mapMcpToolResult(
	result: McpCallResult,
): Promise<AgentToolResult<McpToolResultDetails>> {
	const content = await mapContent(result.content ?? []);
	const text = content.textParts.join("\n");
	const truncated =
		text.length > 0
			? await truncateToolTextOutput(text, "mcp-wrapper-")
			: undefined;

	return {
		content: [
			...(truncated === undefined
				? []
				: [{ type: "text" as const, text: truncated.content }]),
			...content.images,
		],
		details: {
			rawResult: result,
			isError: result.isError ?? false,
			...(truncated?.details !== undefined
				? { truncation: truncated.details }
				: {}),
		},
	};
}

async function mapContent(content: readonly McpContentBlock[]): Promise<{
	readonly textParts: readonly string[];
	readonly images: ReadonlyArray<{
		readonly type: "image";
		readonly data: string;
		readonly mimeType: string;
	}>;
}> {
	const blocks = await Promise.all(content.map(mapContentBlock));
	return {
		textParts: blocks.flatMap((block) =>
			block.text === undefined ? [] : [block.text],
		),
		images: blocks.flatMap((block) =>
			block.image === undefined ? [] : [block.image],
		),
	};
}

async function mapContentBlock(
	block: McpContentBlock,
): Promise<MappedContentBlock> {
	if (block.type === "text") {
		return { text: block.text ?? "" };
	}
	if (block.type === "image") {
		return mapImageContent(block);
	}
	return { text: formatNonTextContent(block) };
}

async function mapImageContent(
	block: Extract<McpContentBlock, { readonly type: "image" }>,
): Promise<MappedContentBlock> {
	const data = block.data ?? "";
	const mimeType = block.mimeType ?? "image/png";
	if (Buffer.byteLength(data, "utf8") <= DEFAULT_MAX_BYTES) {
		return { image: { type: "image", data, mimeType } };
	}

	const path = await saveOversizedImage(data, mimeType);
	return { text: `Saved image payload: ${path}` };
}

function formatNonTextContent(
	block: Exclude<McpContentBlock, { readonly type: "text" | "image" }>,
): string {
	if (block.type === "resource") {
		const uri = block.resource?.uri ?? "(no URI)";
		return `[Resource: ${uri}]\n${block.resource?.text ?? formatBinaryResource(block)}`;
	}
	if (block.type === "resource_link") {
		const name = block.name ?? block.uri ?? "unknown";
		return `[Resource Link: ${name}]\nURI: ${block.uri ?? "(no URI)"}`;
	}

	return `[Audio content: ${block.mimeType ?? "audio/*"}]`;
}

function formatBinaryResource(
	block: Extract<McpContentBlock, { readonly type: "resource" }>,
): string {
	if (block.resource?.blob === undefined) {
		return "(no content)";
	}
	const mimeType = block.resource.mimeType ?? "application/octet-stream";
	return `[Binary data: ${mimeType} base64 payload omitted]`;
}

async function saveOversizedImage(
	data: string,
	mimeType: string,
): Promise<string> {
	const extension = IMAGE_MIME_EXTENSIONS[mimeType] ?? "bin";
	const path = join(
		tmpdir(),
		`mcp-wrapper-image-${randomBytes(TEMP_FILE_ID_BYTES).toString("hex")}.${extension}`,
	);
	await writeFile(path, data, { encoding: "utf8", mode: TEMP_FILE_MODE });
	return path;
}
