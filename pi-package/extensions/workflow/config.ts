import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, parse as parsePath } from "node:path";
import { parse } from "yaml";
import {
	validateWorkflowDefinition,
	type WorkflowDefinition,
} from "./workflow";

/** Atomic catalog result that keeps a configuration error separate from saved state. */
export interface WorkflowCatalogResult {
	readonly workflows: readonly WorkflowDefinition[];
	readonly error?: Error;
}

/** Model-facing prompt text required whenever the subsystem is active. */
export interface WorkflowPrompts {
	readonly extensionDescription: string;
	readonly activateDescription: string;
	readonly transitionDescription: string;
}

const CONFIG_KEYS = new Set([
	"extensionDescriptionPromptFile",
	"activateDescriptionPromptFile",
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

/** Loads every .yaml file in lexical order and rejects the catalog atomically. */
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
			const message = errorMessage(error);
			return {
				workflows: [],
				error: new Error(
					message.includes(file.filePath)
						? message
						: `${file.filePath}: ${message}`,
				),
			};
		}
	}
	return { workflows };
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

/** Loads the closed optional prompt config and resolves all three files as one result. */
export async function loadWorkflowPrompts(
	configPath: string,
	bundledDirectory: string,
): Promise<WorkflowPrompts> {
	try {
		const config = await readPromptConfig(configPath);
		return {
			extensionDescription: await readPrompt(
				config["extensionDescriptionPromptFile"] ??
					join(bundledDirectory, "extension-description.md"),
				"extensionDescriptionPromptFile",
			),
			activateDescription: await readPrompt(
				config["activateDescriptionPromptFile"] ??
					join(bundledDirectory, "activate-description.md"),
				"activateDescriptionPromptFile",
			),
			transitionDescription: await readPrompt(
				config["transitionDescriptionPromptFile"] ??
					join(bundledDirectory, "transition-description.md"),
				"transitionDescriptionPromptFile",
			),
		};
	} catch (error) {
		throw new Error(`${configPath}: ${errorMessage(error)}`);
	}
}

/** Parses absent configuration as defaults and rejects unknown or non-string fields. */
async function readPromptConfig(
	configPath: string,
): Promise<Record<string, string>> {
	let content: string;
	try {
		content = await readFile(configPath, "utf8");
	} catch (error) {
		if (isFileNotFound(error)) {
			return {};
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
	const result: Record<string, string> = {};
	for (const [key, candidate] of Object.entries(value)) {
		if (!CONFIG_KEYS.has(key)) {
			throw new Error(`unsupported configuration key ${key}`);
		}
		if (
			typeof candidate !== "string" ||
			candidate.length === 0 ||
			candidate.trim() !== candidate ||
			!isAbsolute(candidate)
		) {
			throw new Error(`${key} must be a non-empty absolute path`);
		}
		result[key] = candidate;
	}
	return result;
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
