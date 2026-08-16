import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isFileNotFoundError } from "../../shared/agent-suite-storage";
import {
	type ModelSettings,
	parseModelSettings,
} from "../../shared/model-settings";
import { parseSimpleFraction } from "./size-target";

/** Defines the complete strict top-level configuration contract. */
const TOP_LEVEL_KEYS = [
	"enabled",
	"dataDir",
	"globalTokenLimit",
	"localTokenLimit",
	"primaryBranches",
	"preferredRemotes",
	"extraction",
	"mergeLocal",
	"mergeGlobal",
] as const;
/** Defines the shared strict operation fields used by extraction and merge. */
const OPERATION_KEYS = [
	"model",
	"systemPromptFile",
	"taskPromptFile",
	"maxFractionDenominator",
	"initialFraction",
	"reductionCoefficient",
] as const;
/** Defines bounded-file and primary-branch defaults. */
const DEFAULT_TOKEN_LIMIT = 5_000;
const DEFAULT_PRIMARY_BRANCHES = ["main", "master"] as const;
const DEFAULT_PREFERRED_REMOTES = ["origin"] as const;
/** Defines the A4-page size-target defaults shared by every model operation. */
const DEFAULT_INITIAL_FRACTION = "2/3";
const DEFAULT_REDUCTION_COEFFICIENT = "3/4";
/** Defines the fraction-denominator range accepted per operation. */
const MIN_FRACTION_DENOMINATOR = 4;
const MAX_FRACTION_DENOMINATOR = 32;
const DEFAULT_FRACTION_DENOMINATOR = 8;
/** Defines the agent-suite-relative configuration and catalog locations. */
const CONFIG_FILE = "config.json";
const KNOWLEDGE_DIRECTORY = "knowledge";
const DEFAULT_DATA_DIRECTORY = "data";
/** Resolves bundled prompts independently from the process working directory. */
const BUNDLED_EXTRACTION_SYSTEM_PROMPT = fileURLToPath(
	new URL("./prompts/extraction-system.md", import.meta.url),
);
const BUNDLED_EXTRACTION_TASK_PROMPT = fileURLToPath(
	new URL("./prompts/extraction.md", import.meta.url),
);
const BUNDLED_MERGE_LOCAL_SYSTEM_PROMPT = fileURLToPath(
	new URL("./prompts/merge-local-system.md", import.meta.url),
);
const BUNDLED_MERGE_LOCAL_TASK_PROMPT = fileURLToPath(
	new URL("./prompts/merge-local.md", import.meta.url),
);
const BUNDLED_MERGE_GLOBAL_SYSTEM_PROMPT = fileURLToPath(
	new URL("./prompts/merge-global-system.md", import.meta.url),
);
const BUNDLED_MERGE_GLOBAL_TASK_PROMPT = fileURLToPath(
	new URL("./prompts/merge-global.md", import.meta.url),
);

type UnknownRecord = Record<string, unknown>;

/** Holds one operation's resolved model, prompt, and size-target settings. */
export interface KnowledgeOperationConfig {
	readonly model: ModelSettings | undefined;
	readonly systemPrompt: string;
	readonly taskPrompt: string;
	readonly maxFractionDenominator: number;
	readonly initialFraction: number;
	readonly reductionCoefficient: number;
}

/** Holds the fully resolved knowledge configuration. */
export interface KnowledgeConfig {
	readonly enabled: boolean;
	readonly dataDir: string;
	readonly globalTokenLimit: number;
	readonly localTokenLimit: number;
	readonly primaryBranches: readonly string[];
	readonly preferredRemotes: readonly string[];
	readonly extraction: KnowledgeOperationConfig;
	readonly mergeLocal: KnowledgeOperationConfig;
	readonly mergeGlobal: KnowledgeOperationConfig;
}

/** Reports either a valid configuration or a fail-closed validation issue. */
export type KnowledgeConfigResult =
	| { readonly kind: "valid"; readonly config: KnowledgeConfig }
	| { readonly kind: "invalid"; readonly issue: string };

/** Supplies the active suite directory and an isolated Git branch validator. */
export interface KnowledgeConfigParseOptions {
	readonly agentSuiteDir: string;
	readonly isGitBranchName?: (name: string) => boolean;
	readonly isGitRemoteName?: (name: string) => boolean;
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
	const preferredRemotes = parsePreferredRemotes(
		value["preferredRemotes"],
		options,
	);
	if (typeof preferredRemotes === "string") {
		return invalid(preferredRemotes);
	}
	const extraction = parseOperationConfig({
		value: value["extraction"],
		defaultPromptFile: BUNDLED_EXTRACTION_SYSTEM_PROMPT,
		defaultTaskPromptFile: BUNDLED_EXTRACTION_TASK_PROMPT,
		fieldName: "extraction",
		allowedKeys: OPERATION_KEYS,
	});
	if (typeof extraction === "string") {
		return invalid(extraction);
	}
	const mergeLocal = parseOperationConfig({
		value: value["mergeLocal"],
		defaultPromptFile: BUNDLED_MERGE_LOCAL_SYSTEM_PROMPT,
		defaultTaskPromptFile: BUNDLED_MERGE_LOCAL_TASK_PROMPT,
		fieldName: "mergeLocal",
		allowedKeys: OPERATION_KEYS,
	});
	if (typeof mergeLocal === "string") {
		return invalid(mergeLocal);
	}
	const mergeGlobal = parseOperationConfig({
		value: value["mergeGlobal"],
		defaultPromptFile: BUNDLED_MERGE_GLOBAL_SYSTEM_PROMPT,
		defaultTaskPromptFile: BUNDLED_MERGE_GLOBAL_TASK_PROMPT,
		fieldName: "mergeGlobal",
		allowedKeys: OPERATION_KEYS,
	});
	if (typeof mergeGlobal === "string") {
		return invalid(mergeGlobal);
	}

	return {
		kind: "valid",
		config: {
			...scalarFields,
			primaryBranches,
			preferredRemotes,
			extraction,
			mergeLocal,
			mergeGlobal,
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

/** Validates the configured preferred-remote set without consulting repository remotes. */
function parsePreferredRemotes(
	value: unknown,
	options: KnowledgeConfigParseOptions,
): readonly string[] | string {
	if (value === undefined) {
		return [...DEFAULT_PREFERRED_REMOTES];
	}
	if (!Array.isArray(value) || value.length === 0) {
		return "preferredRemotes must be a non-empty array";
	}
	if (!value.every((remote): remote is string => typeof remote === "string")) {
		return "preferredRemotes must contain only strings";
	}
	if (new Set(value).size !== value.length) {
		return "preferredRemotes must contain unique names";
	}
	const validateRemote = options.isGitRemoteName ?? isGitRemoteName;
	if (!value.every((remote) => validateRemote(remote))) {
		return "preferredRemotes must contain only Git-valid remote names";
	}
	return [...value];
}

/** Defines one operation parser call with prompt defaults and allowed field set. */
interface ParseOperationConfigOptions {
	readonly value: unknown;
	readonly defaultPromptFile: string;
	readonly defaultTaskPromptFile: string;
	readonly fieldName: string;
	readonly allowedKeys: readonly string[];
}

/** Resolves one nested operation config while preserving current-runtime defaults. */
function parseOperationConfig(
	options: ParseOperationConfigOptions,
): KnowledgeOperationConfig | string {
	const parsed = parseOperationRecord(options.value, options.fieldName);
	if (typeof parsed === "string") {
		return parsed;
	}
	if (!hasOnlyKeys(parsed, options.allowedKeys)) {
		return `${options.fieldName} contains unsupported fields`;
	}
	let model: ModelSettings | undefined;
	try {
		model = parseModelSettings(parsed["model"], `${options.fieldName}.model`);
	} catch (error) {
		return errorMessage(error);
	}
	const maxFractionDenominator = resolveFractionDenominator(
		parsed["maxFractionDenominator"],
		options.fieldName,
	);
	if (typeof maxFractionDenominator === "string") {
		return maxFractionDenominator;
	}
	const initialFraction = resolveFractionSetting(
		parsed["initialFraction"],
		`${options.fieldName}.initialFraction`,
		DEFAULT_INITIAL_FRACTION,
		maxFractionDenominator,
	);
	if (typeof initialFraction === "string") {
		return initialFraction;
	}
	const reductionCoefficient = resolveFractionSetting(
		parsed["reductionCoefficient"],
		`${options.fieldName}.reductionCoefficient`,
		DEFAULT_REDUCTION_COEFFICIENT,
		maxFractionDenominator,
	);
	if (typeof reductionCoefficient === "string") {
		return reductionCoefficient;
	}
	const systemPrompt = resolveOperationPrompt(
		parsed,
		options.fieldName,
		"systemPromptFile",
		options.defaultPromptFile,
	);
	if (systemPrompt.kind === "invalid") {
		return systemPrompt.issue;
	}
	const taskPrompt = resolveOperationPrompt(
		parsed,
		options.fieldName,
		"taskPromptFile",
		options.defaultTaskPromptFile,
	);
	if (taskPrompt.kind === "invalid") {
		return taskPrompt.issue;
	}
	return {
		model,
		systemPrompt: systemPrompt.content,
		taskPrompt: taskPrompt.content,
		maxFractionDenominator,
		initialFraction,
		reductionCoefficient,
	};
}

/** Validates one optional nested operation object and returns a normalized record. */
function parseOperationRecord(
	value: unknown,
	fieldName: string,
): UnknownRecord | string {
	if (value === undefined) {
		return {};
	}
	if (!isRecord(value)) {
		return `${fieldName} must be an object`;
	}
	return value;
}

/** Resolves the per-operation denominator bound or its documented default. */
function resolveFractionDenominator(
	value: unknown,
	fieldName: string,
): number | string {
	if (value === undefined) {
		return DEFAULT_FRACTION_DENOMINATOR;
	}
	if (
		!isIntegerInRange(value, MIN_FRACTION_DENOMINATOR, MAX_FRACTION_DENOMINATOR)
	) {
		return `${fieldName}.maxFractionDenominator must be an integer between ${MIN_FRACTION_DENOMINATOR} and ${MAX_FRACTION_DENOMINATOR}`;
	}
	return value;
}

/** Resolves one simple-fraction setting from config or its documented default. */
function resolveFractionSetting(
	value: unknown,
	fieldPath: string,
	defaultValue: string,
	maxDenominator: number,
): number | string {
	const parsed = parseSimpleFraction(value ?? defaultValue, maxDenominator);
	if (typeof parsed === "string") {
		return `${fieldPath} ${parsed}`;
	}
	return parsed;
}

/** Resolves one prompt content field from config or its default bundled path. */
function resolveOperationPrompt(
	config: UnknownRecord,
	fieldName: string,
	configKey: "systemPromptFile" | "taskPromptFile",
	defaultPath: string,
):
	| { readonly kind: "ok"; readonly content: string }
	| {
			readonly kind: "invalid";
			readonly issue: string;
	  } {
	const configuredPath = config[configKey] ?? defaultPath;
	if (typeof configuredPath !== "string" || !isAbsolute(configuredPath)) {
		return {
			kind: "invalid",
			issue: `${fieldName}.${configKey} must be an absolute path`,
		};
	}
	const prompt = readPromptFile(configuredPath);
	if ("issue" in prompt) {
		return {
			kind: "invalid",
			issue: `${fieldName}.${configKey} ${prompt.issue}`,
		};
	}
	return { kind: "ok", content: prompt.content };
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

/** Delegates exact remote-name grammar to Git without requiring repository state. */
export function isGitRemoteName(name: string): boolean {
	const result = spawnSync(
		"git",
		["check-ref-format", `refs/remotes/${name}`],
		{
			encoding: "utf8",
			stdio: "ignore",
		},
	);
	return result.status === 0;
}

/** Checks the positive integer contract used by file token limits. */
function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Checks the inclusive integer range contract for fraction denominators. */
function isIntegerInRange(
	value: unknown,
	min: number,
	max: number,
): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= min &&
		value <= max
	);
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
