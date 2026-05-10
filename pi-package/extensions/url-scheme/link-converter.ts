import { statSync } from "node:fs";
import { resolve } from "node:path";
import { formatEditorUrl, type SupportedScheme } from "./editor-url";

/** Characters that can trail a prose file reference without being part of it. */
const TRAILING_REFERENCE_PUNCTUATION = new Set([".", ",", ";", ")", "]", "}"]);

/** Parses optional line and column suffixes after a file path. */
const REFERENCE_SUFFIX_REGEX =
	/^(?<filePath>.+?):(?<line>[1-9]\d*)(?::(?<column>[1-9]\d*))?$/u;

/** Detects absolute Windows drive paths independent of the host OS. */
const WINDOWS_DRIVE_ABSOLUTE_REGEX = /^[A-Za-z]:[\\/]/u;

/** Detects one ASCII letter before checking for Windows drive prefixes. */
const ASCII_LETTER_REGEX = /^[A-Za-z]$/u;

/** Detects token boundaries before possible file references. */
const REFERENCE_BOUNDARY_REGEX = /[\s([{<"']/u;

/** Detects characters allowed at the start of relative file paths. */
const RELATIVE_PATH_START_CHARACTER_REGEX = /^[\p{L}\p{N}_@+-]$/u;

/** Detects fenced Markdown code blocks that must not be modified. */
const FENCED_CODE_BLOCK_REGEX = /(^|\n)```[\s\S]*?(?:\n```|$)/gu;

/** Detects existing Markdown links and images that must not be modified. */
const MARKDOWN_LINK_OR_IMAGE_REGEX = /!?\[[^\]]*\]\([^)]*\)/gu;

/** Detects existing Markdown links and images with parseable label and target spans. */
const MARKDOWN_LINK_OR_IMAGE_PARSE_REGEX =
	/(?<image>!)?\[(?<label>[^\]]*)\]\((?<target>[^)]*)\)/gu;

/** Detects single-backtick spans that may contain one file reference. */
const SINGLE_BACKTICK_SPAN_REGEX = /`([^`\n]+)`/gu;

/** Detects non-boundary characters after a colon that make a line suffix invalid. */
const INVALID_SUFFIX_TAIL_REGEX = /^[^\s,;)}\]]+/u;

/** Side-effect dependency used to verify candidate file references. */
export type FileExists = (path: string) => boolean;

/** Text content block shape transformed by this extension. */
interface TextContentBlock extends Record<string, unknown> {
	readonly type: "text";
	readonly text: string;
	readonly textSignature?: unknown;
}

/** Protected text span that must not be rewritten as a file reference. */
interface TextRange {
	readonly start: number;
	readonly end: number;
}

/** Parsed file reference found in assistant text. */
interface FileReferenceMatch {
	readonly referenceText: string;
	readonly filePath: string;
	readonly absolutePath: string;
	readonly line?: number;
	readonly column?: number;
	readonly consumedLength: number;
}

/** Parsed numeric line and column suffix for a file reference. */
interface ParsedReferenceSuffix {
	readonly filePath: string;
	readonly line?: number;
	readonly column?: number;
}

/** Rewrites eligible assistant text blocks while preserving every other block. */
export function convertAssistantContent(options: {
	readonly content: readonly unknown[];
	readonly cwd: string;
	readonly scheme: SupportedScheme;
	readonly fileExists: FileExists;
}): readonly unknown[] | undefined {
	let changed = false;
	const replacementContent: unknown[] = [];

	for (const block of options.content) {
		if (!isTextContentBlock(block)) {
			replacementContent.push(block);
			continue;
		}

		const replacementText = convertTextReferences({
			text: block.text,
			cwd: options.cwd,
			scheme: options.scheme,
			fileExists: options.fileExists,
		});
		if (replacementText === undefined) {
			replacementContent.push(block);
			continue;
		}

		changed = true;
		const { textSignature: _staleTextSignature, ...safeBlock } = block;
		replacementContent.push({
			...safeBlock,
			text: replacementText,
		});
	}

	return changed ? replacementContent : undefined;
}

/** Checks that a resolved reference points to an existing regular file. */
export function defaultFileExists(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** Returns true for assistant text blocks that can contain file references. */
function isTextContentBlock(block: unknown): block is TextContentBlock {
	return (
		isRecord(block) &&
		block["type"] === "text" &&
		typeof block["text"] === "string"
	);
}

/** Converts file references in unprotected Markdown text regions. */
function convertTextReferences(options: {
	readonly text: string;
	readonly cwd: string;
	readonly scheme: SupportedScheme;
	readonly fileExists: FileExists;
}): string | undefined {
	const existenceCache = new Map<string, boolean>();
	const textWithConvertedLinks = convertMarkdownFileLinks({
		text: options.text,
		cwd: options.cwd,
		scheme: options.scheme,
		fileExists: options.fileExists,
		existenceCache,
	});
	const textWithConvertedBackticks = convertSingleBacktickFileReferences({
		text: textWithConvertedLinks.text,
		cwd: options.cwd,
		scheme: options.scheme,
		fileExists: options.fileExists,
		existenceCache,
	});
	const sourceText = textWithConvertedBackticks.text;
	const protectedRanges = collectProtectedRanges(sourceText);
	let changed = false;
	let output = "";
	let index = 0;

	while (index < sourceText.length) {
		const protectedRange = findProtectedRangeAt(protectedRanges, index);
		if (protectedRange !== undefined) {
			output += sourceText.slice(protectedRange.start, protectedRange.end);
			index = protectedRange.end;
			continue;
		}

		const match = findFileReferenceAt({
			text: sourceText,
			index,
			cwd: options.cwd,
			fileExists: options.fileExists,
			existenceCache,
		});
		if (match === undefined) {
			output += sourceText[index] ?? "";
			index += 1;
			continue;
		}

		changed = true;
		output += `[${match.referenceText}](${formatEditorUrl({
			scheme: options.scheme,
			absolutePath: match.absolutePath,
			...(match.line === undefined ? {} : { line: match.line }),
			...(match.column === undefined ? {} : { column: match.column }),
		})})`;
		index += match.consumedLength;
	}

	return changed ||
		textWithConvertedLinks.changed ||
		textWithConvertedBackticks.changed
		? output
		: undefined;
}

/** Rewrites Markdown links whose target points to an existing file. */
function convertMarkdownFileLinks(options: {
	readonly text: string;
	readonly cwd: string;
	readonly scheme: SupportedScheme;
	readonly fileExists: FileExists;
	readonly existenceCache: Map<string, boolean>;
}): { readonly text: string; readonly changed: boolean } {
	let changed = false;
	const text = options.text.replace(
		MARKDOWN_LINK_OR_IMAGE_PARSE_REGEX,
		(match: string, ...args: unknown[]): string => {
			const groups = args.at(-1);
			if (!isRecord(groups) || groups["image"] === "!") {
				return match;
			}

			const label = groups["label"];
			const target = groups["target"];
			if (typeof label !== "string" || typeof target !== "string") {
				return match;
			}

			const parsedReference = parseReferenceSuffix(target);
			const fileLink = buildExistingFileLink({
				cwd: options.cwd,
				referenceText: target,
				parsedReference,
				scheme: options.scheme,
				fileExists: options.fileExists,
				existenceCache: options.existenceCache,
			});
			if (fileLink === undefined) {
				return match;
			}

			changed = true;
			return `[${label}](${fileLink.url})`;
		},
	);

	return { text, changed };
}

/** Converts exact file references wrapped in single backticks and removes those backticks. */
function convertSingleBacktickFileReferences(options: {
	readonly text: string;
	readonly cwd: string;
	readonly scheme: SupportedScheme;
	readonly fileExists: FileExists;
	readonly existenceCache: Map<string, boolean>;
}): { readonly text: string; readonly changed: boolean } {
	let changed = false;
	const text = options.text.replace(
		SINGLE_BACKTICK_SPAN_REGEX,
		(match: string, referenceText: string): string => {
			const parsedReference = parseReferenceSuffix(referenceText);
			const fileLink = buildExistingFileLink({
				cwd: options.cwd,
				referenceText,
				parsedReference,
				scheme: options.scheme,
				fileExists: options.fileExists,
				existenceCache: options.existenceCache,
			});
			if (fileLink === undefined) {
				return match;
			}

			changed = true;
			return `[${referenceText}](${fileLink.url})`;
		},
	);

	return { text, changed };
}

/** Builds link data only when the parsed reference points to an existing file. */
function buildExistingFileLink(options: {
	readonly cwd: string;
	readonly referenceText: string;
	readonly parsedReference: ParsedReferenceSuffix;
	readonly scheme: SupportedScheme;
	readonly fileExists: FileExists;
	readonly existenceCache: Map<string, boolean>;
}): { readonly absolutePath: string; readonly url: string } | undefined {
	if (!couldBeSupportedPath(options.parsedReference.filePath)) {
		return undefined;
	}

	const absolutePath = resolveReferencePath(
		options.cwd,
		options.parsedReference.filePath,
	);
	const exists = cachedFileExists(
		absolutePath,
		options.fileExists,
		options.existenceCache,
	);
	if (!exists) {
		return undefined;
	}

	return {
		absolutePath,
		url: formatEditorUrl({
			scheme: options.scheme,
			absolutePath,
			...(options.parsedReference.line === undefined
				? {}
				: { line: options.parsedReference.line }),
			...(options.parsedReference.column === undefined
				? {}
				: { column: options.parsedReference.column }),
		}),
	};
}

/** Finds one file reference at a text position by selecting the longest existing file prefix. */
function findFileReferenceAt(options: {
	readonly text: string;
	readonly index: number;
	readonly cwd: string;
	readonly fileExists: FileExists;
	readonly existenceCache: Map<string, boolean>;
}): FileReferenceMatch | undefined {
	if (!canStartReference(options.text, options.index)) {
		return undefined;
	}

	const lineEnd = findLineEnd(options.text, options.index);
	const remainder = options.text.slice(options.index, lineEnd);
	if (!couldContainFileReference(remainder)) {
		return undefined;
	}

	for (let end = remainder.length; end > 0; end--) {
		const referenceText = trimReferenceEnd(remainder.slice(0, end));
		if (referenceText.length === 0 || referenceText.length !== end) {
			continue;
		}

		const parsedReference = parseReferenceSuffix(referenceText);
		if (!couldBeSupportedPath(parsedReference.filePath)) {
			continue;
		}

		const absolutePath = resolveReferencePath(
			options.cwd,
			parsedReference.filePath,
		);
		const exists = cachedFileExists(
			absolutePath,
			options.fileExists,
			options.existenceCache,
		);
		if (!exists) {
			continue;
		}

		if (hasInvalidNumericSuffixAfterCandidate(remainder, referenceText)) {
			return undefined;
		}

		return buildFileReferenceMatch({
			referenceText,
			parsedReference,
			absolutePath,
		});
	}

	return undefined;
}

/** Builds a matched reference while preserving optional line and column absence. */
function buildFileReferenceMatch(options: {
	readonly referenceText: string;
	readonly parsedReference: ParsedReferenceSuffix;
	readonly absolutePath: string;
}): FileReferenceMatch {
	return {
		referenceText: options.referenceText,
		filePath: options.parsedReference.filePath,
		absolutePath: options.absolutePath,
		...(options.parsedReference.line === undefined
			? {}
			: { line: options.parsedReference.line }),
		...(options.parsedReference.column === undefined
			? {}
			: { column: options.parsedReference.column }),
		consumedLength: options.referenceText.length,
	};
}

/** Returns true when a valid file prefix is followed by an invalid line or column suffix. */
function hasInvalidNumericSuffixAfterCandidate(
	remainder: string,
	referenceText: string,
): boolean {
	const suffix = remainder.slice(referenceText.length);
	return (
		suffix.startsWith(":") && INVALID_SUFFIX_TAIL_REGEX.test(suffix.slice(1))
	);
}

/** Uses one filesystem check per candidate path during a single text conversion. */
function cachedFileExists(
	path: string,
	fileExists: FileExists,
	cache: Map<string, boolean>,
): boolean {
	const cached = cache.get(path);
	if (cached !== undefined) {
		return cached;
	}

	const exists = fileExists(path);
	cache.set(path, exists);
	return exists;
}

/** Parses optional :line and :line:column suffixes without confusing Windows drive colons. */
function parseReferenceSuffix(referenceText: string): ParsedReferenceSuffix {
	const match = REFERENCE_SUFFIX_REGEX.exec(referenceText);
	if (match?.groups === undefined) {
		return { filePath: referenceText };
	}

	return {
		filePath: match.groups["filePath"] ?? referenceText,
		line: Number(match.groups["line"]),
		...(match.groups["column"] === undefined
			? {}
			: { column: Number(match.groups["column"]) }),
	};
}

/** Resolves relative references against the active Pi working directory. */
function resolveReferencePath(cwd: string, referencePath: string): string {
	if (isAbsoluteReferencePath(referencePath)) {
		return referencePath;
	}

	return resolve(cwd, referencePath);
}

/** Detects POSIX, Windows drive, and UNC absolute path forms without host OS assumptions. */
function isAbsoluteReferencePath(referencePath: string): boolean {
	return (
		referencePath.startsWith("/") ||
		WINDOWS_DRIVE_ABSOLUTE_REGEX.test(referencePath) ||
		referencePath.startsWith("\\\\")
	);
}

/** Returns true when a text fragment can name a nested path or a file-like root entry. */
function couldContainFileReference(text: string): boolean {
	return text.includes("/") || text.includes("\\") || text.includes(".");
}

/** Returns true for candidate paths supported by this converter. */
function couldBeSupportedPath(filePath: string): boolean {
	return filePath.length > 0 && couldContainFileReference(filePath);
}

/** Returns true when a new file reference can start at the current character. */
function canStartReference(text: string, index: number): boolean {
	const current = text[index];
	if (current === undefined || !hasReferenceBoundaryBefore(text, index)) {
		return false;
	}

	if (current === "/") {
		return text[index + 1] !== "/";
	}
	if (current === "\\") {
		return text[index + 1] === "\\";
	}
	if (current === ".") {
		return text[index + 1] === "/" || text[index + 1] === ".";
	}
	if (ASCII_LETTER_REGEX.test(current)) {
		return text[index + 1] === ":" || isRelativePathStartCharacter(current);
	}

	return isRelativePathStartCharacter(current);
}

/** Ensures a path is not matched from the middle of a word or another token. */
function hasReferenceBoundaryBefore(text: string, index: number): boolean {
	if (index === 0) {
		return true;
	}

	const previous = text[index - 1];
	return previous === undefined || REFERENCE_BOUNDARY_REGEX.test(previous);
}

/** Returns true for characters commonly allowed at the start of relative file paths. */
function isRelativePathStartCharacter(character: string): boolean {
	return RELATIVE_PATH_START_CHARACTER_REGEX.test(character);
}

/** Finds the current line boundary so reference parsing never crosses paragraphs. */
function findLineEnd(text: string, index: number): number {
	const newlineIndex = text.indexOf("\n", index);
	return newlineIndex === -1 ? text.length : newlineIndex;
}

/** Removes punctuation that belongs to prose after a file reference. */
function trimReferenceEnd(referenceText: string): string {
	let end = referenceText.length;
	while (end > 0) {
		const character = referenceText[end - 1];
		if (
			character === undefined ||
			!TRAILING_REFERENCE_PUNCTUATION.has(character)
		) {
			break;
		}
		end -= 1;
	}

	return referenceText.slice(0, end);
}

/** Collects Markdown ranges where automatic file-link conversion would corrupt authored content. */
function collectProtectedRanges(text: string): readonly TextRange[] {
	const ranges: TextRange[] = [];
	collectRegexRanges(text, FENCED_CODE_BLOCK_REGEX, ranges);
	collectRegexRanges(text, MARKDOWN_LINK_OR_IMAGE_REGEX, ranges);

	return mergeRanges(ranges);
}

/** Adds regex match ranges while excluding leading newlines used only as anchors. */
function collectRegexRanges(
	text: string,
	pattern: RegExp,
	ranges: TextRange[],
): void {
	for (const match of text.matchAll(pattern)) {
		const matchedText = match[0];
		const rawStart = match.index;
		if (rawStart === undefined) {
			continue;
		}

		const leadingNewlineOffset = matchedText.startsWith("\n") ? 1 : 0;
		ranges.push({
			start: rawStart + leadingNewlineOffset,
			end: rawStart + matchedText.length,
		});
	}
}

/** Merges overlapping protected ranges so conversion can skip them with one pass. */
function mergeRanges(ranges: readonly TextRange[]): readonly TextRange[] {
	const sortedRanges = [...ranges].sort(
		(left, right) => left.start - right.start,
	);
	const mergedRanges: TextRange[] = [];

	for (const range of sortedRanges) {
		const lastRange = mergedRanges.at(-1);
		if (lastRange === undefined || range.start > lastRange.end) {
			mergedRanges.push(range);
			continue;
		}

		mergedRanges[mergedRanges.length - 1] = {
			start: lastRange.start,
			end: Math.max(lastRange.end, range.end),
		};
	}

	return mergedRanges;
}

/** Finds a protected range that starts at the current conversion index. */
function findProtectedRangeAt(
	ranges: readonly TextRange[],
	index: number,
): TextRange | undefined {
	return ranges.find((range) => range.start === index);
}

/** Returns true when an unknown value is safe for dynamic property reads. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
