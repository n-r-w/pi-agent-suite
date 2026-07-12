import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { readProjectRulesConfig } from "./config";

const ISSUE_PREFIX = "[project-rules]";
const MARKDOWN_EXTENSION = ".md";
const BYTES_PER_KIBIBYTE = 1024;
const MAX_RULE_FILE_KIBIBYTES = 64;
const MAX_RULE_FILE_COUNT = 64;
const MAX_TOTAL_RULE_CONTENT_KIBIBYTES = 256;
const MAX_RENDERED_PROJECT_RULES_KIBIBYTES = 320;
const MAX_RULE_FILE_BYTES = MAX_RULE_FILE_KIBIBYTES * BYTES_PER_KIBIBYTE;
const MAX_TOTAL_RULE_CONTENT_BYTES =
	MAX_TOTAL_RULE_CONTENT_KIBIBYTES * BYTES_PER_KIBIBYTE;
const MAX_RENDERED_PROJECT_RULES_LENGTH =
	MAX_RENDERED_PROJECT_RULES_KIBIBYTES * BYTES_PER_KIBIBYTE;
const RULE_FILE_SIZE_ISSUE = "rule file exceeds 64 KiB limit";
const RULE_FILE_COUNT_ISSUE = "rule file count exceeds 64";
const TOTAL_RULE_CONTENT_ISSUE = "total rule content exceeds 256 KiB limit";
const RENDERED_PROJECT_RULES_ISSUE =
	"rendered project rules exceed 320 KiB limit";

interface SessionContextLike {
	readonly hasUI?: boolean;
	readonly ui?: {
		notify(message: string, type: "warning"): void;
	};
}

interface BeforeAgentStartEventLike {
	readonly systemPrompt: string;
	readonly systemPromptOptions: BuildSystemPromptOptions;
}

interface ProjectRule {
	readonly path: string;
	readonly content: string;
}

interface RuleLoadBudget {
	candidateCount: number;
	totalContentBytes: number;
}

type ProjectRulesReadResult =
	| { readonly kind: "valid"; readonly rules: readonly ProjectRule[] }
	| { readonly kind: "invalid"; readonly issue: string };

type MissingDirectoryStatus =
	| { readonly kind: "missing" }
	| { readonly kind: "invalid"; readonly issue: string };

/** Appends project-local Markdown rules after the base system prompt is assembled. */
export default function projectRules(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const configResult = readProjectRulesConfig();
		if (configResult.kind === "invalid") {
			reportIssue(ctx as SessionContextLike, configResult.issue);
			return undefined;
		}
		if (!configResult.config.enabled) {
			return undefined;
		}

		const typedEvent = event as BeforeAgentStartEventLike;
		const rulesResult = await readProjectRules(
			typedEvent.systemPromptOptions.cwd,
			configResult.config.rulesDir,
		);
		if (rulesResult.kind === "invalid") {
			reportIssue(ctx as SessionContextLike, rulesResult.issue);
			return undefined;
		}
		if (rulesResult.rules.length === 0) {
			return undefined;
		}

		let renderedRules: string;
		try {
			renderedRules = renderProjectRules(rulesResult.rules);
		} catch (error) {
			reportIssue(
				ctx as SessionContextLike,
				error instanceof Error ? error.message : RENDERED_PROJECT_RULES_ISSUE,
			);
			return undefined;
		}

		return {
			systemPrompt: `${typedEvent.systemPrompt}\n\n${renderedRules}`,
		};
	});
}

/** Reads all visible *.md files under rulesDir while following approved symlink targets. */
async function readProjectRules(
	cwd: string,
	rulesDir: string,
): Promise<ProjectRulesReadResult> {
	const rootDir = join(cwd, rulesDir);
	const visitedRealDirs = new Set<string>();
	const rules: ProjectRule[] = [];
	const budget: RuleLoadBudget = { candidateCount: 0, totalContentBytes: 0 };

	const rootStatus = await resolveDirectoryStatus(rootDir, cwd, rulesDir);
	if (rootStatus.kind === "missing") {
		return { kind: "valid", rules: [] };
	}
	if (rootStatus.kind === "invalid") {
		return rootStatus;
	}

	const walkResult = await walkRulesDirectory({
		actualDir: rootDir,
		visibleDir: toPromptPath(rulesDir),
		visitedRealDirs,
		rules,
		budget,
	});
	if (walkResult.kind === "invalid") {
		return walkResult;
	}

	return {
		kind: "valid",
		rules: rules.sort((left, right) => left.path.localeCompare(right.path)),
	};
}

/** Distinguishes absent default rules from unreadable or non-directory entry points. */
async function resolveDirectoryStatus(
	directory: string,
	cwd: string,
	rulesDir: string,
): Promise<
	| { readonly kind: "valid" }
	| { readonly kind: "missing" }
	| { readonly kind: "invalid"; readonly issue: string }
> {
	try {
		const directoryStat = await stat(directory);
		if (!directoryStat.isDirectory()) {
			return {
				kind: "invalid",
				issue: "rulesDir must point to a directory",
			};
		}
		return { kind: "valid" };
	} catch (error) {
		if (!isFileNotFoundError(error)) {
			return {
				kind: "invalid",
				issue: `failed to inspect rulesDir: ${formatError(error)}`,
			};
		}

		return inspectMissingDirectoryPath(cwd, rulesDir);
	}
}

/** Separates an absent rulesDir from a broken symlink in its project-relative path. */
async function inspectMissingDirectoryPath(
	cwd: string,
	rulesDir: string,
): Promise<MissingDirectoryStatus> {
	return inspectMissingPathComponents(cwd, normalize(rulesDir).split(sep));
}

/** Inspects configured path components in order so an absent parent stops probing. */
async function inspectMissingPathComponents(
	parentPath: string,
	components: readonly string[],
): Promise<MissingDirectoryStatus> {
	const [component, ...remainingComponents] = components;
	if (component === undefined) {
		return { kind: "missing" };
	}

	const currentPath = join(parentPath, component);
	let linkStat: Awaited<ReturnType<typeof lstat>>;
	try {
		linkStat = await lstat(currentPath);
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return { kind: "missing" };
		}

		return {
			kind: "invalid",
			issue: `failed to inspect rulesDir: ${formatError(error)}`,
		};
	}

	if (linkStat.isSymbolicLink()) {
		try {
			await stat(currentPath);
		} catch (error) {
			return {
				kind: "invalid",
				issue: isFileNotFoundError(error)
					? "rulesDir symlink target does not exist"
					: `failed to inspect rulesDir: ${formatError(error)}`,
			};
		}
	}

	return inspectMissingPathComponents(currentPath, remainingComponents);
}

/** Recursively walks directories and records non-empty Markdown files by visible path. */
async function walkRulesDirectory(options: {
	readonly actualDir: string;
	readonly visibleDir: string;
	readonly visitedRealDirs: Set<string>;
	readonly rules: ProjectRule[];
	readonly budget: RuleLoadBudget;
}): Promise<
	| { readonly kind: "valid" }
	| { readonly kind: "invalid"; readonly issue: string }
> {
	let realDir: string;
	try {
		realDir = await realpath(options.actualDir);
	} catch (error) {
		return {
			kind: "invalid",
			issue: `failed to resolve directory: ${formatError(error)}`,
		};
	}
	if (options.visitedRealDirs.has(realDir)) {
		return { kind: "valid" };
	}
	options.visitedRealDirs.add(realDir);

	let entries: Dirent<string>[];
	try {
		entries = await readdir(options.actualDir, { withFileTypes: true });
	} catch (error) {
		return {
			kind: "invalid",
			issue: `failed to read directory: ${formatError(error)}`,
		};
	}

	return entries
		.sort((left, right) => left.name.localeCompare(right.name))
		.reduce<
			Promise<
				| { readonly kind: "valid" }
				| { readonly kind: "invalid"; readonly issue: string }
			>
		>(
			async (previousResult, entry) => {
				const result = await previousResult;
				if (result.kind === "invalid") {
					return result;
				}

				const actualPath = join(options.actualDir, entry.name);
				const visiblePath = `${options.visibleDir}/${entry.name}`;
				return processDirectoryEntry(actualPath, visiblePath, options);
			},
			Promise.resolve({ kind: "valid" }),
		);
}

/** Applies Markdown filtering to visible paths while symlink targets decide file type. */
async function processDirectoryEntry(
	actualPath: string,
	visiblePath: string,
	options: {
		readonly visitedRealDirs: Set<string>;
		readonly rules: ProjectRule[];
		readonly budget: RuleLoadBudget;
	},
): Promise<
	| { readonly kind: "valid" }
	| { readonly kind: "invalid"; readonly issue: string }
> {
	let entryStat: Awaited<ReturnType<typeof stat>>;
	try {
		entryStat = await stat(actualPath);
	} catch (error) {
		return {
			kind: "invalid",
			issue: `failed to inspect rule entry: ${formatError(error)}`,
		};
	}

	if (entryStat.isDirectory()) {
		return walkRulesDirectory({
			actualDir: actualPath,
			visibleDir: visiblePath,
			visitedRealDirs: options.visitedRealDirs,
			rules: options.rules,
			budget: options.budget,
		});
	}

	if (!entryStat.isFile() || !visiblePath.endsWith(MARKDOWN_EXTENSION)) {
		return { kind: "valid" };
	}

	options.budget.candidateCount += 1;
	if (options.budget.candidateCount > MAX_RULE_FILE_COUNT) {
		return { kind: "invalid", issue: RULE_FILE_COUNT_ISSUE };
	}
	if (entryStat.size > MAX_RULE_FILE_BYTES) {
		return { kind: "invalid", issue: RULE_FILE_SIZE_ISSUE };
	}

	let content: string;
	try {
		content = await readFile(actualPath, "utf8");
	} catch (error) {
		return {
			kind: "invalid",
			issue: `failed to read rule file: ${formatError(error)}`,
		};
	}
	const contentBytes = Buffer.byteLength(content, "utf8");
	if (contentBytes > MAX_RULE_FILE_BYTES) {
		return { kind: "invalid", issue: RULE_FILE_SIZE_ISSUE };
	}
	options.budget.totalContentBytes += contentBytes;
	if (options.budget.totalContentBytes > MAX_TOTAL_RULE_CONTENT_BYTES) {
		return { kind: "invalid", issue: TOTAL_RULE_CONTENT_ISSUE };
	}
	if (content.trim().length === 0) {
		return { kind: "valid" };
	}

	options.rules.push({ path: visiblePath, content });
	return { kind: "valid" };
}

/** Renders a stable XML-like block without changing rule file contents. */
export function renderProjectRules(rules: readonly ProjectRule[]): string {
	const rendered = [
		"<project_rules>",
		...rules.flatMap((rule) => [
			`  <project_rule path="${escapeAttribute(rule.path)}">`,
			rule.content,
			"  </project_rule>",
		]),
		"</project_rules>",
	].join("\n");
	if (rendered.length > MAX_RENDERED_PROJECT_RULES_LENGTH) {
		throw new Error(RENDERED_PROJECT_RULES_ISSUE);
	}

	return rendered;
}

/** Normalizes visible paths to prompt-friendly slash separators. */
function toPromptPath(path: string): string {
	return path.replace(/\\/g, "/");
}

/** Escapes only XML attribute delimiters so rule text remains unchanged. */
function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** Reports one warning when project rules cannot be loaded safely. */
function reportIssue(ctx: SessionContextLike, issue: string): void {
	if (ctx.hasUI === false) {
		return;
	}

	ctx.ui?.notify(`${ISSUE_PREFIX} ${issue}`, "warning");
}

/** Detects file-not-found errors without depending on platform-specific messages. */
function isFileNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { readonly code?: unknown }).code === "ENOENT"
	);
}

/** Converts unknown failures into short diagnostics without exposing file contents. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
