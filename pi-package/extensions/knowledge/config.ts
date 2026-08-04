import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isFileNotFoundError } from "../../shared/agent-suite-storage";
import { isModelSelectorId } from "../../shared/model-settings";

/** Defines the complete strict top-level configuration contract. */
const TOP_LEVEL_KEYS = [
	"enabled",
	"dataDir",
	"globalTokenLimit",
	"localTokenLimit",
	"primaryBranches",
	"extraction",
	"merge",
] as const;
/** Defines the complete strict extraction and merge configuration contract. */
const OPERATION_KEYS = [
	"model",
	"thinking",
	"systemPromptFile",
	"retryCount",
] as const;
/** Defines the thinking values accepted by knowledge model operations. */
const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;
/** Defines bounded-file, retry, and primary-branch defaults. */
const DEFAULT_TOKEN_LIMIT = 5_000;
const DEFAULT_EXTRACTION_RETRIES = 1;
const DEFAULT_MERGE_RETRIES = 2;
const DEFAULT_PRIMARY_BRANCHES = ["main", "master"] as const;
/** Defines the agent-suite-relative configuration and catalog locations. */
const CONFIG_FILE = "config.json";
const KNOWLEDGE_DIRECTORY = "knowledge";
const DEFAULT_DATA_DIRECTORY = "data";
/** Resolves bundled prompts independently from the process working directory. */
const BUNDLED_EXTRACTION_PROMPT = fileURLToPath(
	new URL("./prompts/extraction.md", import.meta.url),
);
const BUNDLED_MERGE_PROMPT = fileURLToPath(
	new URL("./prompts/merge.md", import.meta.url),
);

type UnknownRecord = Record<string, unknown>;

export type KnowledgeThinking = (typeof THINKING_LEVELS)[number];

/** Holds one operation's resolved model, thinking, prompt, and retry settings. */
export interface KnowledgeOperationConfig {
	readonly model: string | undefined;
	readonly thinking: KnowledgeThinking | undefined;
	readonly systemPrompt: string;
	readonly retryCount: number;
}

/** Holds the fully resolved knowledge configuration. */
export interface KnowledgeConfig {
	readonly enabled: boolean;
	readonly dataDir: string;
	readonly globalTokenLimit: number;
	readonly localTokenLimit: number;
	readonly primaryBranches: readonly string[];
	readonly extraction: KnowledgeOperationConfig;
	readonly merge: KnowledgeOperationConfig;
}

/** Reports either a valid configuration or a fail-closed validation issue. */
export type KnowledgeConfigResult =
	| { readonly kind: "valid"; readonly config: KnowledgeConfig }
	| { readonly kind: "invalid"; readonly issue: string };

/** Supplies the active suite directory and an isolated Git branch validator. */
export interface KnowledgeConfigParseOptions {
	readonly agentSuiteDir: string;
	readonly isGitBranchName?: (name: string) => boolean;
}

/** Parses and validates one knowledge configuration value. */
export function parseKnowledgeConfig(
	value: unknown,
	options: KnowledgeConfigParseOptions,
): KnowledgeConfigResult {
	if (!isRecord(value)) {
		return invalid("config must be an object");
	}
	if (!hasOnlyKeys(value, TOP_LEVEL_KEYS)) {
		return invalid("config contains unsupported fields");
	}

	const scalarFields = parseScalarFields(value, options.agentSuiteDir);
	if (typeof scalarFields === "string") {
		return invalid(scalarFields);
	}
	const primaryBranches = parsePrimaryBranches(
		value["primaryBranches"],
		options,
	);
	if (typeof primaryBranches === "string") {
		return invalid(primaryBranches);
	}
	const extraction = parseOperationConfig(
		value["extraction"],
		BUNDLED_EXTRACTION_PROMPT,
		DEFAULT_EXTRACTION_RETRIES,
		"extraction",
	);
	if (typeof extraction === "string") {
		return invalid(extraction);
	}
	const merge = parseOperationConfig(
		value["merge"],
		BUNDLED_MERGE_PROMPT,
		DEFAULT_MERGE_RETRIES,
		"merge",
	);
	if (typeof merge === "string") {
		return invalid(merge);
	}

	return {
		kind: "valid",
		config: {
			...scalarFields,
			primaryBranches,
			extraction,
			merge,
		},
	};
}

/** Reads the optional knowledge configuration from the active suite directory. */
export function readKnowledgeConfig(
	options: KnowledgeConfigParseOptions,
): KnowledgeConfigResult {
	const configPath = join(
		options.agentSuiteDir,
		KNOWLEDGE_DIRECTORY,
		CONFIG_FILE,
	);
	let content: string;
	try {
		content = readFileSync(configPath, "utf8");
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return parseKnowledgeConfig({}, options);
		}
		return invalid(`could not read ${configPath}: ${errorMessage(error)}`);
	}

	try {
		return parseKnowledgeConfig(JSON.parse(content), options);
	} catch (error) {
		return invalid(`invalid JSON in ${configPath}: ${errorMessage(error)}`);
	}
}

/** Holds validated top-level scalars before operation settings are added. */
interface KnowledgeScalarConfig {
	readonly enabled: boolean;
	readonly dataDir: string;
	readonly globalTokenLimit: number;
	readonly localTokenLimit: number;
}

/** Validates and resolves the top-level scalar fields. */
function parseScalarFields(
	value: UnknownRecord,
	agentSuiteDir: string,
): KnowledgeScalarConfig | string {
	const enabled = value["enabled"];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return "enabled must be a boolean";
	}
	const dataDir = value["dataDir"];
	if (
		dataDir !== undefined &&
		(typeof dataDir !== "string" || !isAbsolute(dataDir))
	) {
		return "dataDir must be an absolute path";
	}
	const globalTokenLimit = value["globalTokenLimit"];
	if (
		globalTokenLimit !== undefined &&
		!isPositiveSafeInteger(globalTokenLimit)
	) {
		return "globalTokenLimit must be a positive safe integer";
	}
	const localTokenLimit = value["localTokenLimit"];
	if (
		localTokenLimit !== undefined &&
		!isPositiveSafeInteger(localTokenLimit)
	) {
		return "localTokenLimit must be a positive safe integer";
	}
	return {
		enabled: enabled ?? true,
		dataDir:
			dataDir ??
			join(agentSuiteDir, KNOWLEDGE_DIRECTORY, DEFAULT_DATA_DIRECTORY),
		globalTokenLimit: globalTokenLimit ?? DEFAULT_TOKEN_LIMIT,
		localTokenLimit: localTokenLimit ?? DEFAULT_TOKEN_LIMIT,
	};
}

/** Validates the configured primary-branch set without consulting repository refs. */
function parsePrimaryBranches(
	value: unknown,
	options: KnowledgeConfigParseOptions,
): readonly string[] | string {
	if (value === undefined) {
		return [...DEFAULT_PRIMARY_BRANCHES];
	}
	if (!Array.isArray(value) || value.length === 0) {
		return "primaryBranches must be a non-empty array";
	}
	if (!value.every((branch): branch is string => typeof branch === "string")) {
		return "primaryBranches must contain only strings";
	}
	if (new Set(value).size !== value.length) {
		return "primaryBranches must contain unique names";
	}
	const validateBranch = options.isGitBranchName ?? isGitBranchName;
	if (!value.every((branch) => validateBranch(branch))) {
		return "primaryBranches must contain only Git-valid branch names";
	}
	return [...value];
}

/** Resolves one nested operation config while preserving current-runtime defaults. */
function parseOperationConfig(
	value: unknown,
	defaultPromptFile: string,
	defaultRetryCount: number,
	fieldName: string,
): KnowledgeOperationConfig | string {
	if (value !== undefined && !isRecord(value)) {
		return `${fieldName} must be an object`;
	}
	const config = value ?? {};
	if (!hasOnlyKeys(config, OPERATION_KEYS)) {
		return `${fieldName} contains unsupported fields`;
	}
	const model = config["model"];
	if (model !== undefined && !isModelSelectorId(model)) {
		return `${fieldName}.model must be a non-empty string`;
	}
	const thinking = config["thinking"];
	if (thinking !== undefined && !isThinking(thinking)) {
		return `${fieldName}.thinking is unsupported`;
	}
	const retryCount = config["retryCount"];
	if (retryCount !== undefined && !isNonNegativeSafeInteger(retryCount)) {
		return `${fieldName}.retryCount must be a non-negative safe integer`;
	}
	const promptFile = config["systemPromptFile"] ?? defaultPromptFile;
	if (typeof promptFile !== "string" || !isAbsolute(promptFile)) {
		return `${fieldName}.systemPromptFile must be an absolute path`;
	}
	const prompt = readPromptFile(promptFile);
	if ("issue" in prompt) {
		return `${fieldName}.systemPromptFile ${prompt.issue}`;
	}

	return {
		model,
		thinking,
		systemPrompt: prompt.content,
		retryCount: retryCount ?? defaultRetryCount,
	};
}

/** Reads one validated prompt so model calls receive content rather than its path. */
function readPromptFile(
	path: string,
): { readonly content: string } | { readonly issue: string } {
	try {
		const content = readFileSync(path, "utf8").trim();
		return content.length === 0 ? { issue: "must not be empty" } : { content };
	} catch (error) {
		return { issue: `could not be read: ${errorMessage(error)}` };
	}
}

/** Delegates exact branch-name grammar to Git without requiring repository state. */
export function isGitBranchName(name: string): boolean {
	const result = spawnSync("git", ["check-ref-format", "--branch", name], {
		encoding: "utf8",
		stdio: "ignore",
	});
	return result.status === 0;
}

/** Checks the closed thinking-level set accepted by knowledge operations. */
function isThinking(value: unknown): value is KnowledgeThinking {
	return (
		typeof value === "string" &&
		(THINKING_LEVELS as readonly string[]).includes(value)
	);
}

/** Checks the positive integer contract used by file token limits. */
function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Checks the finite retry allowance contract, including zero retries. */
function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Checks JSON object shape without accepting arrays. */
function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Enforces strict fields at one configuration object level. */
function hasOnlyKeys(value: UnknownRecord, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

/** Constructs the fail-closed result used for any present invalid config. */
function invalid(issue: string): KnowledgeConfigResult {
	return { kind: "invalid", issue };
}

/** Converts unknown exceptions into stable configuration diagnostics. */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
