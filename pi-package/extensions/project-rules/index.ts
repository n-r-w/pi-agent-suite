import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { readProjectRulesConfig } from "./config";
import {
	createProjectRulesPathPolicy,
	isProjectRulesPathForbidden,
	type ProjectRulesPathPolicy,
} from "./path-policy";

const ISSUE_PREFIX = "[project-rules]";
const MARKDOWN_EXTENSION = ".md";

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

type ProjectRulesReadResult =
	| { readonly kind: "valid"; readonly rules: readonly ProjectRule[] }
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
		const pathPolicy = await createProjectRulesPathPolicy();
		const rulesResult = await readProjectRules(
			typedEvent.systemPromptOptions.cwd,
			configResult.config.rulesDir,
			pathPolicy,
		);
		if (rulesResult.kind === "invalid") {
			reportIssue(ctx as SessionContextLike, rulesResult.issue);
			return undefined;
		}
		if (rulesResult.rules.length === 0) {
			return undefined;
		}

		return {
			systemPrompt: `${typedEvent.systemPrompt}\n\n${renderProjectRules(rulesResult.rules)}`,
		};
	});
}

/** Reads all visible *.md files under rulesDir while following approved symlink targets. */
async function readProjectRules(
	cwd: string,
	rulesDir: string,
	pathPolicy: ProjectRulesPathPolicy,
): Promise<ProjectRulesReadResult> {
	const rootDir = join(cwd, rulesDir);
	if (isProjectRulesPathForbidden(rootDir, pathPolicy)) {
		return { kind: "valid", rules: [] };
	}

	const visitedRealDirs = new Set<string>();
	const rules: ProjectRule[] = [];

	const rootStatus = await resolveDirectoryStatus(rootDir);
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
		pathPolicy,
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

		return inspectMissingDirectoryPath(directory);
	}
}

/** Separates an absent rulesDir from a broken symlink at the rulesDir path. */
async function inspectMissingDirectoryPath(
	directory: string,
): Promise<
	| { readonly kind: "missing" }
	| { readonly kind: "invalid"; readonly issue: string }
> {
	try {
		const linkStat = await lstat(directory);
		return {
			kind: "invalid",
			issue: linkStat.isSymbolicLink()
				? "rulesDir symlink target does not exist"
				: "rulesDir could not be inspected",
		};
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return { kind: "missing" };
		}

		return {
			kind: "invalid",
			issue: `failed to inspect rulesDir: ${formatError(error)}`,
		};
	}
}

/** Recursively walks directories and records non-empty Markdown files by visible path. */
async function walkRulesDirectory(options: {
	readonly actualDir: string;
	readonly visibleDir: string;
	readonly visitedRealDirs: Set<string>;
	readonly rules: ProjectRule[];
	readonly pathPolicy: ProjectRulesPathPolicy;
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
	if (isProjectRulesPathForbidden(realDir, options.pathPolicy)) {
		return { kind: "valid" };
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
		readonly pathPolicy: ProjectRulesPathPolicy;
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
			pathPolicy: options.pathPolicy,
		});
	}

	if (!entryStat.isFile() || !visiblePath.endsWith(MARKDOWN_EXTENSION)) {
		return { kind: "valid" };
	}

	let realFile: string;
	try {
		realFile = await realpath(actualPath);
	} catch (error) {
		return {
			kind: "invalid",
			issue: `failed to resolve rule file: ${formatError(error)}`,
		};
	}
	if (isProjectRulesPathForbidden(realFile, options.pathPolicy)) {
		return { kind: "valid" };
	}

	let content: string;
	try {
		content = await readFile(realFile, "utf8");
	} catch (error) {
		return {
			kind: "invalid",
			issue: `failed to read rule file: ${formatError(error)}`,
		};
	}
	if (content.trim().length === 0) {
		return { kind: "valid" };
	}

	options.rules.push({ path: visiblePath, content });
	return { kind: "valid" };
}

/** Renders a stable XML-like block without changing rule file contents. */
function renderProjectRules(rules: readonly ProjectRule[]): string {
	return [
		"<project_rules>",
		...rules.flatMap((rule) => [
			`  <project_rule path="${escapeAttribute(rule.path)}">`,
			rule.content,
			"  </project_rule>",
		]),
		"</project_rules>",
	].join("\n");
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
