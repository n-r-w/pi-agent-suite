import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, parse as parsePath } from "node:path";
import { parse } from "yaml";
import {
	validateWorkflowDefinition,
	type WorkflowDefinition,
} from "./workflow";

/** Catalog result that separates directory-wide errors from skipped workflow warnings. */
export interface WorkflowCatalogResult {
	readonly workflows: readonly WorkflowDefinition[];
	readonly warnings?: readonly Error[];
	readonly error?: Error;
}

/** Model-facing prompt text required whenever the subsystem is active. */
export interface WorkflowPrompts {
	readonly extensionDescription: string;
	readonly createDescription: string;
	readonly activateDescription: string;
	readonly getStageDescription: string;
	readonly editStageDescription: string;
	readonly transitionDescription: string;
}

export interface WorkflowConfiguration extends WorkflowPrompts {
	readonly reminderToolCallInterval: number;
}

const DEFAULT_REMINDER_TOOL_CALL_INTERVAL = 50;

const CONFIG_KEYS = new Set([
	"reminderToolCallInterval",
	"extensionDescriptionPromptFile",
	"createDescriptionPromptFile",
	"activateDescriptionPromptFile",
	"getStageDescriptionPromptFile",
	"editStageDescriptionPromptFile",
	"transitionDescriptionPromptFile",
]);

/** Captures one catalog read without making completion order affect validation order. */
type CatalogFileRead =
	| {
			readonly kind: "found";
			readonly fileName: string;
			readonly filePath: string;
			readonly content: string;
	  }
	| {
			readonly kind: "error";
			readonly filePath: string;
			readonly error: unknown;
	  };

/** Loads valid .yaml workflows in lexical order and reports invalid files separately. */
export async function loadWorkflowCatalog(
	directory: string,
): Promise<WorkflowCatalogResult> {
	let entries: string[];
	try {
		entries = (await readdir(directory))
			.filter((name) => name.endsWith(".yaml"))
			.sort((left, right) => left.localeCompare(right));
	} catch (error) {
		if (isFileNotFound(error)) {
			return { workflows: [] };
		}
		return {
			workflows: [],
			error: new Error(
				`${directory}: could not read workflow directory: ${errorMessage(error)}`,
			),
		};
	}
	const files = await Promise.all(
		entries.map((fileName) => readCatalogFile(directory, fileName)),
	);
	const workflows: WorkflowDefinition[] = [];
	const warnings: Error[] = [];
	for (const file of files) {
		try {
			if (file.kind === "error") {
				throw file.error;
			}
			const value: unknown = parse(file.content);
			workflows.push(
				validateWorkflowDefinition(
					parsePath(file.fileName).name,
					value,
					file.filePath,
				),
			);
		} catch (error) {
			// A file-level failure disables only that workflow so valid siblings remain usable.
			const message = errorMessage(error);
			warnings.push(
				new Error(
					message.includes(file.filePath)
						? message
						: `${file.filePath}: ${message}`,
				),
			);
		}
	}
	if (warnings.length === 0) {
		return { workflows };
	}
	return { workflows, warnings };
}

/** Reads one catalog file while preserving its lexical identity for later validation. */
async function readCatalogFile(
	directory: string,
	fileName: string,
): Promise<CatalogFileRead> {
	const filePath = join(directory, fileName);
	try {
		return {
			kind: "found",
			fileName,
			filePath,
			content: await readFile(filePath, "utf8"),
		};
	} catch (error) {
		return { kind: "error", filePath, error };
	}
}

/** Loads the closed workflow config and resolves every prompt and setting atomically. */
export async function loadWorkflowConfiguration(
	configPath: string,
	bundledDirectory: string,
): Promise<WorkflowConfiguration> {
	try {
		const config = await readWorkflowConfig(configPath);
		return {
			reminderToolCallInterval: config.reminderToolCallInterval,
			extensionDescription: await readPrompt(
				config.promptFiles["extensionDescriptionPromptFile"] ??
					join(bundledDirectory, "extension-description.md"),
				"extensionDescriptionPromptFile",
			),
			createDescription: await readPrompt(
				config.promptFiles["createDescriptionPromptFile"] ??
					join(bundledDirectory, "create-description.md"),
				"createDescriptionPromptFile",
			),
			activateDescription: await readPrompt(
				config.promptFiles["activateDescriptionPromptFile"] ??
					join(bundledDirectory, "activate-description.md"),
				"activateDescriptionPromptFile",
			),
			getStageDescription: await readPrompt(
				config.promptFiles["getStageDescriptionPromptFile"] ??
					join(bundledDirectory, "get-stage-description.md"),
				"getStageDescriptionPromptFile",
			),
			editStageDescription: await readPrompt(
				config.promptFiles["editStageDescriptionPromptFile"] ??
					join(bundledDirectory, "edit-stage-description.md"),
				"editStageDescriptionPromptFile",
			),
			transitionDescription: await readPrompt(
				config.promptFiles["transitionDescriptionPromptFile"] ??
					join(bundledDirectory, "transition-description.md"),
				"transitionDescriptionPromptFile",
			),
		};
	} catch (error) {
		throw new Error(`${configPath}: ${errorMessage(error)}`);
	}
}

interface ParsedWorkflowConfiguration {
	readonly promptFiles: Readonly<Record<string, string>>;
	readonly reminderToolCallInterval: number;
}

/** Parses absent configuration as defaults and rejects unknown or invalid fields. */
async function readWorkflowConfig(
	configPath: string,
): Promise<ParsedWorkflowConfiguration> {
	let content: string;
	try {
		content = await readFile(configPath, "utf8");
	} catch (error) {
		if (isFileNotFound(error)) {
			return {
				promptFiles: {},
				reminderToolCallInterval: DEFAULT_REMINDER_TOOL_CALL_INTERVAL,
			};
		}
		throw new Error(`could not read configuration: ${errorMessage(error)}`);
	}
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch (error) {
		throw new Error(`invalid JSON: ${errorMessage(error)}`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("configuration must be an object");
	}
	const promptFiles: Record<string, string> = {};
	let reminderToolCallInterval = DEFAULT_REMINDER_TOOL_CALL_INTERVAL;
	for (const [key, candidate] of Object.entries(value)) {
		if (!CONFIG_KEYS.has(key)) {
			throw new Error(`unsupported configuration key ${key}`);
		}
		if (key === "reminderToolCallInterval") {
			reminderToolCallInterval = parseReminderToolCallInterval(candidate);
			continue;
		}
		promptFiles[key] = parsePromptFilePath(key, candidate);
	}
	return { promptFiles, reminderToolCallInterval };
}

function parseReminderToolCallInterval(candidate: unknown): number {
	if (!Number.isSafeInteger(candidate) || Number(candidate) < 0) {
		throw new Error(
			"reminderToolCallInterval must be a non-negative safe integer",
		);
	}
	return Number(candidate);
}

function parsePromptFilePath(key: string, candidate: unknown): string {
	if (
		typeof candidate !== "string" ||
		candidate.length === 0 ||
		candidate.trim() !== candidate ||
		!isAbsolute(candidate)
	) {
		throw new Error(`${key} must be a non-empty absolute path`);
	}
	return candidate;
}

/** Reads and trims one required prompt while reporting the owning config field. */
async function readPrompt(filePath: string, field: string): Promise<string> {
	let content: string;
	try {
		content = (await readFile(filePath, "utf8")).trim();
	} catch (error) {
		throw new Error(
			`${field} could not read ${filePath}: ${errorMessage(error)}`,
		);
	}
	if (content.length === 0) {
		throw new Error(`${field} must reference a non-empty file: ${filePath}`);
	}
	return content;
}

/** Detects only filesystem absence without swallowing other read failures. */
function isFileNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		Reflect.get(error, "code") === "ENOENT"
	);
}

/** Converts unknown thrown values into stable diagnostics. */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
