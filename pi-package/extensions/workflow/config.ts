import { readdir, readFile } from "node:fs/promises";
import {
	dirname,
	isAbsolute,
	join,
	parse as parsePath,
	resolve,
} from "node:path";
import { parse } from "yaml";
import { expandHomePath } from "../../shared/path-expansion";
import {
	requireKnownWorkflowKind,
	validateWorkflowKinds,
	type WorkflowKind,
} from "./kinds";
import {
	validateWorkflowBindings,
	validateWorkflowDefinition,
	type WorkflowDefinition,
} from "./workflow";

/** Catalog result that separates directory-wide errors from skipped workflow warnings. */
export interface WorkflowCatalogResult {
	readonly kinds?: readonly WorkflowKind[];
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
	readonly exitDescription: string;
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
	"exitDescriptionPromptFile",
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
	let kinds: readonly WorkflowKind[] = [];
	try {
		kinds = await loadWorkflowKinds(join(dirname(directory), "kinds.yaml"));
		entries = (await readdir(directory))
			.filter((name) => name.endsWith(".yaml"))
			.sort((left, right) => left.localeCompare(right));
	} catch (error) {
		if (isFileNotFound(error)) {
			return { workflows: [], ...(kinds.length === 0 ? {} : { kinds }) };
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
	const outcomes = await Promise.all(
		files.map((file) => loadCatalogFile(file, kinds, directory)),
	);
	const workflows: WorkflowDefinition[] = [];
	const warnings: Error[] = [];
	for (const outcome of outcomes) {
		if (outcome instanceof Error) {
			warnings.push(outcome);
		} else {
			workflows.push(outcome);
		}
	}
	return {
		workflows: filterWorkflowBindings(workflows, directory, warnings),
		...(warnings.length === 0 ? {} : { warnings }),
		...(kinds.length === 0 ? {} : { kinds }),
	};
}

/** Removes invalid bindings to a fixed point while retaining mutually bound nested workflows. */
function filterWorkflowBindings(
	workflows: readonly WorkflowDefinition[],
	directory: string,
	warnings: Error[],
): readonly WorkflowDefinition[] {
	let accepted = workflows;
	for (;;) {
		const valid = accepted.filter((workflow) => {
			try {
				validateWorkflowBindings(workflow, accepted);
				return true;
			} catch (error) {
				warnings.push(
					new Error(
						`${join(directory, `${workflow.id}.yaml`)}: ${errorMessage(error)}`,
					),
				);
				return false;
			}
		});
		if (valid.length === accepted.length) {
			return valid;
		}
		accepted = valid;
	}
}

/** Returns the definition of one catalog file, or its failure as a warning that names the file. */
async function loadCatalogFile(
	file: CatalogFileRead,
	kinds: readonly WorkflowKind[],
	directory: string,
): Promise<WorkflowDefinition | Error> {
	try {
		return await validateCatalogFile(file, kinds, directory);
	} catch (error) {
		// A file-level failure disables only that workflow so valid siblings remain usable.
		const message = errorMessage(error);
		return new Error(
			message.includes(file.filePath)
				? message
				: `${file.filePath}: ${message}`,
		);
	}
}

/** Converts a catalog read into a definition under the installed kinds catalog. */
async function validateCatalogFile(
	file: CatalogFileRead,
	kinds: readonly WorkflowKind[],
	directory: string,
): Promise<WorkflowDefinition> {
	if (file.kind === "error") {
		throw file.error;
	}
	const value = await substituteFileReferences(parse(file.content), directory);
	const workflow = validateWorkflowDefinition(
		parsePath(file.fileName).name,
		value,
		file.filePath,
	);
	requireKnownWorkflowKind(workflow.kind, kinds);
	return workflow;
}

/** Matches a reference `{{path}}` whose file text replaces it in a catalog workflow. */
const FILE_REFERENCE = /\{\{([^{}]*)\}\}/g;

/** Replaces each file reference in the strings of a parsed workflow with the trimmed file text, resolving paths against the workflow directory. */
async function substituteFileReferences(
	value: unknown,
	directory: string,
): Promise<unknown> {
	if (typeof value === "string") {
		const texts = await Promise.all(
			Array.from(value.matchAll(FILE_REFERENCE), (match) =>
				readReferencedFile(resolve(directory, (match[1] ?? "").trim())),
			),
		);
		let index = 0;
		return value.replace(FILE_REFERENCE, () => texts[index++] ?? "");
	}
	if (Array.isArray(value)) {
		return Promise.all(
			value.map((item) => substituteFileReferences(item, directory)),
		);
	}
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			await Promise.all(
				Object.entries(value).map(async ([key, item]) => [
					key,
					await substituteFileReferences(item, directory),
				]),
			),
		);
	}
	return value;
}

/** Reads the trimmed text of a referenced file and names the file in a read failure. */
async function readReferencedFile(path: string): Promise<string> {
	try {
		return (await readFile(path, "utf8")).trim();
	} catch (error) {
		throw new Error(
			`could not read referenced file ${path}: ${errorMessage(error)}`,
		);
	}
}

/** Loads the optional kinds file without weakening validation of present files. */
async function loadWorkflowKinds(
	path: string,
): Promise<readonly WorkflowKind[]> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (isFileNotFound(error)) {
			return [];
		}
		throw new Error(`${path}: ${errorMessage(error)}`);
	}
	try {
		return validateWorkflowKinds(parse(content));
	} catch (error) {
		throw new Error(`${path}: ${errorMessage(error)}`);
	}
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
			exitDescription: await readPrompt(
				config.promptFiles["exitDescriptionPromptFile"] ??
					join(bundledDirectory, "exit-description.md"),
				"exitDescriptionPromptFile",
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
		candidate.trim() !== candidate
	) {
		throw new Error(`${key} must be a non-empty absolute path`);
	}
	const expandedPath = expandHomePath(candidate);
	if (!isAbsolute(expandedPath)) {
		throw new Error(`${key} must be a non-empty absolute path`);
	}
	return expandedPath;
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
