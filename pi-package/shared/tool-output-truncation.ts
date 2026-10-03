import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatSize,
	type TruncationResult,
	truncateHead,
} from "@earendil-works/pi-coding-agent";

/** Byte count used to create random temp file name suffixes. */
const TEMP_FILE_ID_BYTES = 8;

/** Result metadata added when model-facing tool text is truncated. */
export interface ToolTextOutputTruncationDetails {
	readonly truncation: TruncationResult;
	readonly fullOutputPath: string;
}

/** Model-facing tool text after truncation that keeps its start. */
export interface TruncatedToolTextOutput {
	readonly content: string;
	readonly details?: ToolTextOutputTruncationDetails;
}

/**
 * Keeps start of text within Pi's line and byte limits, like Pi's read tool, and stores the complete text
 * only when truncation occurs. Line longer than byte limit is cut at UTF-8 character boundary.
 */
export async function truncateToolTextOutput(
	text: string,
	tempFilePrefix: string,
): Promise<TruncatedToolTextOutput> {
	const truncation = truncateHead(text);
	if (!truncation.truncated) {
		return { content: text };
	}

	const fullOutputPath = getTempFilePath(tempFilePrefix);
	await writeFile(fullOutputPath, text, "utf8");
	if (truncation.firstLineExceedsLimit) {
		const firstLine = text.split("\n", 1)[0] ?? "";
		const lineSize = formatSize(Buffer.byteLength(firstLine, "utf-8"));
		return {
			content: `${cutToBytes(firstLine, truncation.maxBytes)}\n\n[Showing first ${formatSize(truncation.maxBytes)} of line 1 (line is ${lineSize}). Full output: ${fullOutputPath}]`,
			details: { truncation, fullOutputPath },
		};
	}

	const nextLine = truncation.outputLines + 1;
	return {
		content: `${truncation.content}\n\n[Showing lines 1-${truncation.outputLines} of ${truncation.totalLines}. Use offset=${nextLine} to continue. Full output: ${fullOutputPath}]`,
		details: { truncation, fullOutputPath },
	};
}

/** Returns longest start of text whose UTF-8 size is at most maxBytes, without splitting a character. */
function cutToBytes(text: string, maxBytes: number): string {
	let size = 0;
	let end = 0;
	for (const char of text) {
		size += Buffer.byteLength(char, "utf-8");
		if (size > maxBytes) {
			break;
		}
		end += char.length;
	}
	return text.slice(0, end);
}

/** Creates an extension-specific file path under the system temp directory. */
function getTempFilePath(prefix: string): string {
	const id = randomBytes(TEMP_FILE_ID_BYTES).toString("hex");
	return join(tmpdir(), `${prefix}${id}.log`);
}
