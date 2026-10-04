import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { type AgentFileSource, selectAgentFiles } from "./agent-file-overlay";
import {
	getSuiteExtensionDir,
	isFileNotFoundError,
} from "./agent-suite-storage";
import { isModelSettings, type ModelSettings } from "./model-settings";
import { isSingleLineText } from "./text-contracts";

const AGENT_SELECTION_EXTENSION_DIR = "agent-selection";
const AGENTS_DIR = "agents";
const PROJECT_RESOURCES_DIR = ".pi";
const AGENT_FILE_EXTENSION = ".md";
const TOP_LEVEL_KEYS = [
	"description",
	"type",
	"model",
	"tools",
	"workflows",
	"agents",
] as const;
const AGENT_TYPES = ["main", "subagent", "both"] as const;

type AgentType = (typeof AGENT_TYPES)[number];
interface AgentDirectory {
	readonly path: string;
	readonly entries: readonly string[];
}

interface AgentFile {
	readonly directory: AgentDirectory;
	readonly entry: string;
}

/** Validated agent definition used by agent-related extensions. */
export interface AgentDefinition {
	readonly id: string;
	readonly description: string;
	readonly type: AgentType;
	readonly prompt: string;
	readonly model?: ModelSettings;
	readonly tools?: readonly string[];
	readonly workflows?: readonly string[];
	readonly agents?: readonly string[];
}

/** Loads the global registry overlaid by valid project-owned agent file identities for one working directory. */
export async function loadAgentDefinitions(
	cwd: string,
	reportWarning: (warning: string) => void = (warning) =>
		process.stderr.write(`[agent-registry] ${warning}\n`),
): Promise<AgentDefinition[]> {
	const [globalDirectory, projectDirectory] = await Promise.all([
		resolveGlobalAgentsDir(reportWarning),
		resolveProjectAgentsDir(cwd, reportWarning),
	]);
	const agentFiles = resolveSelectedAgentFiles(
		globalDirectory,
		projectDirectory,
		reportWarning,
	);
	const agents = await Promise.all(
		agentFiles.map((file) => readAgentDefinition(file, reportWarning)),
	);
	return agents.filter((agent) => agent !== undefined);
}

/** Resolves suite-owned agent definitions and uses the legacy directory only when suite storage is absent. */
async function resolveGlobalAgentsDir(
	reportWarning: (warning: string) => void,
): Promise<AgentDirectory | undefined> {
	const suiteAgentsDir = join(
		getSuiteExtensionDir(AGENT_SELECTION_EXTENSION_DIR),
		AGENTS_DIR,
	);
	try {
		return {
			path: suiteAgentsDir,
			entries: await readdir(suiteAgentsDir),
		};
	} catch (error) {
		if (!isFileNotFoundError(error)) {
			reportWarning(
				`failed to read agents directory ${suiteAgentsDir}: ${formatError(error)}`,
			);
			return undefined;
		}
	}

	const legacyAgentsDir = join(getAgentDir(), AGENTS_DIR);
	try {
		return {
			path: legacyAgentsDir,
			entries: await readdir(legacyAgentsDir),
		};
	} catch (error) {
		if (!isFileNotFoundError(error)) {
			reportWarning(
				`failed to read agents directory ${legacyAgentsDir}: ${formatError(error)}`,
			);
		}
		return undefined;
	}
}

/** Resolves project agents and reports unreadable storage while preserving global agents. */
async function resolveProjectAgentsDir(
	cwd: string,
	reportWarning: (warning: string) => void,
): Promise<AgentDirectory | undefined> {
	const projectAgentsDir = join(cwd, PROJECT_RESOURCES_DIR, AGENTS_DIR);
	try {
		return {
			path: projectAgentsDir,
			entries: await readdir(projectAgentsDir),
		};
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return undefined;
		}
		reportWarning(
			`failed to read agents directory ${projectAgentsDir}: ${formatError(error)}`,
		);
		return undefined;
	}
}

/** Binds pure overlay selections back to their filesystem directories. */
function resolveSelectedAgentFiles(
	globalDirectory: AgentDirectory | undefined,
	projectDirectory: AgentDirectory | undefined,
	reportWarning: (warning: string) => void,
): AgentFile[] {
	const selectedFiles = selectAgentFiles(
		globalDirectory?.entries,
		projectDirectory?.entries,
		(warning) => reportWarning(`${projectDirectory?.path}: ${warning}`),
	);
	return selectedFiles.map((selectedFile) => ({
		directory: resolveSelectedAgentDirectory(
			selectedFile.source,
			globalDirectory,
			projectDirectory,
		),
		entry: selectedFile.entry,
	}));
}

/** Resolves the directory guaranteed by the entries supplied to the pure overlay selector. */
function resolveSelectedAgentDirectory(
	source: AgentFileSource,
	globalDirectory: AgentDirectory | undefined,
	projectDirectory: AgentDirectory | undefined,
): AgentDirectory {
	if (source === "global" && globalDirectory !== undefined) {
		return globalDirectory;
	}
	if (source === "project" && projectDirectory !== undefined) {
		return projectDirectory;
	}
	throw new Error(`selected ${source} agent file has no source directory`);
}

/** Reads one selected agent file and reports read or validation failures before skipping it. */
async function readAgentDefinition(
	file: AgentFile,
	reportWarning: (warning: string) => void,
): Promise<AgentDefinition | undefined> {
	const filePath = join(file.directory.path, file.entry);
	let content: string;
	try {
		content = await readFile(filePath, "utf8");
	} catch (error) {
		reportWarning(
			`failed to read agent definition ${filePath}; skipped: ${formatError(error)}`,
		);
		return undefined;
	}

	try {
		return parseAgentDefinition(file.entry, content);
	} catch (error) {
		reportWarning(
			`invalid agent definition ${filePath}; skipped: ${formatError(error)}`,
		);
		return undefined;
	}
}

/** Parses one agent definition and throws a field-specific error for invalid metadata. */
function parseAgentDefinition(
	fileName: string,
	content: string,
): AgentDefinition {
	const parsed = parseFrontmatter(content);
	const frontmatter = parsed.frontmatter;
	if (!hasOnlyKeys(frontmatter, TOP_LEVEL_KEYS)) {
		const unknownKeys = Object.keys(frontmatter).filter(
			(key) => !TOP_LEVEL_KEYS.includes(key as never),
		);
		throw new Error(
			`unsupported frontmatter fields: ${unknownKeys.join(", ")}`,
		);
	}

	const {
		type: rawType,
		description,
		model: rawModel,
		tools: rawTools,
		workflows: rawWorkflows,
		agents: rawAgents,
	} = frontmatter;
	const type = rawType ?? "main";
	if (!isAgentType(type)) {
		throw new Error("type must be main, subagent, or both");
	}

	if (description !== undefined && !isSingleLineText(description)) {
		throw new Error("description must be non-empty, trimmed, single-line text");
	}

	const model = parseModel(rawModel);
	if (model === false) {
		throw new Error("model must contain only a valid id and thinking level");
	}

	const tools = parseStringList(rawTools);
	if (tools === false) {
		throw new Error("tools must be a list of unique non-empty strings");
	}

	const workflows = parseIdentityList(rawWorkflows);
	if (workflows === false) {
		throw new Error(
			"workflows must be a list of unique, trimmed, single-line names",
		);
	}

	const agents = parseIdentityList(rawAgents);
	if (agents === false) {
		throw new Error(
			"agents must be a list of unique, trimmed, single-line names",
		);
	}

	const id = basename(fileName, AGENT_FILE_EXTENSION).normalize("NFC");
	if (!isSingleLineText(id)) {
		throw new Error(
			"agent filename must be non-empty, trimmed, single-line text",
		);
	}

	return {
		id,
		description: description ?? "",
		type,
		prompt: parsed.body.trim(),
		...(model !== undefined ? { model } : {}),
		...(tools !== undefined ? { tools } : {}),
		...(workflows !== undefined ? { workflows } : {}),
		...(agents !== undefined ? { agents } : {}),
	};
}

/** Parses the optional model block and rejects unsupported nested keys. */
function parseModel(value: unknown): AgentDefinition["model"] | false {
	if (value === undefined) {
		return undefined;
	}
	return isModelSettings(value) ? value : false;
}
/** Parses an optional list of normalized Unicode identity names. */
function parseIdentityList(
	value: unknown,
): readonly string[] | undefined | false {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		return false;
	}

	const identities: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (!isSingleLineText(item)) {
			return false;
		}
		const identity = item.normalize("NFC");
		if (seen.has(identity)) {
			return false;
		}
		seen.add(identity);
		identities.push(identity);
	}
	return identities;
}

/** Parses optional unique non-empty string lists from frontmatter. */
function parseStringList(
	value: unknown,
): readonly string[] | undefined | false {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		return false;
	}

	const values: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (
			typeof item !== "string" ||
			item.trim().length === 0 ||
			seen.has(item)
		) {
			return false;
		}
		seen.add(item);
		values.push(item);
	}

	return values;
}

/** Returns true when an object contains only keys from a finite set. */
function hasOnlyKeys(
	value: Record<string, unknown>,
	allowedKeys: readonly string[],
): boolean {
	return Object.keys(value).every((key) => allowedKeys.includes(key));
}

/** Returns true when a runtime value is a supported agent type. */
function isAgentType(value: unknown): value is AgentType {
	return (
		typeof value === "string" &&
		(AGENT_TYPES as readonly string[]).includes(value)
	);
}

/** Converts unknown filesystem failures to safe diagnostics without exposing raw objects. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
