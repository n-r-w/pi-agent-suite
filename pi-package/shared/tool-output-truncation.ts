import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	type TruncationResult,
	truncateTail,
} from "@mariozechner/pi-coding-agent";

/** Byte count used to create random temp file name suffixes. */
const TEMP_FILE_ID_BYTES = 8;

/** Result metadata added when model-facing tool text is truncated. */
export interface ToolTextOutputTruncationDetails {
	readonly truncation: TruncationResult;
	readonly fullOutputPath: string;
}

/** Model-facing tool text after applying Pi's standard tail truncation policy. */
export interface TruncatedToolTextOutput {
	readonly content: string;
	readonly details?: ToolTextOutputTruncationDetails;
}

/** Applies Pi-style tail truncation and stores the complete text only when truncation occurs. */
export async function truncateToolTextOutput(
	text: string,
	tempFilePrefix: string,
): Promise<TruncatedToolTextOutput> {
	const truncation = truncateTail(text);
	if (!truncation.truncated) {
		return { content: text };
	}

	const fullOutputPath = getTempFilePath(tempFilePrefix);
	await writeFile(fullOutputPath, text, "utf8");
	return {
		content: `${truncation.content}${formatTruncationNotice(
			text,
			truncation,
			fullOutputPath,
		)}`,
		details: { truncation, fullOutputPath },
	};
}

/** Creates an extension-specific file path under the system temp directory. */
function getTempFilePath(prefix: string): string {
	const id = randomBytes(TEMP_FILE_ID_BYTES).toString("hex");
	return join(tmpdir(), `${prefix}${id}.log`);
}

/** Formats the same actionable full-output notice used by Pi's bash tool. */
function formatTruncationNotice(
	fullText: string,
	truncation: TruncationResult,
	fullOutputPath: string,
): string {
	const startLine = truncation.totalLines - truncation.outputLines + 1;
	const endLine = truncation.totalLines;
	if (truncation.lastLinePartial) {
		const lastLineSize = formatSize(
			Buffer.byteLength(fullText.split("\n").pop() || "", "utf-8"),
		);
		return `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${fullOutputPath}]`;
	}
	if (truncation.truncatedBy === "lines") {
		return `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
	}

	return `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${fullOutputPath}]`;
}
