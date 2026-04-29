import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import {
	getSuiteExtensionDir,
	isFileNotFoundError,
} from "./agent-suite-storage";

const AGENT_SELECTION_EXTENSION_DIR = "agent-selection";
const AGENTS_DIR = "agents";
const AGENT_FILE_EXTENSION = ".md";
const TOP_LEVEL_KEYS = [
	"description",
	"type",
	"model",
	"tools",
	"agents",
] as const;
const MODEL_KEYS = ["id", "thinking"] as const;
const AGENT_TYPES = ["main", "subagent", "both"] as const;
const THINKING_VALUES = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

type AgentType = (typeof AGENT_TYPES)[number];
type ThinkingValue = (typeof THINKING_VALUES)[number];

/** Validated agent definition used by agent-related extensions. */
export interface AgentDefinition {
	readonly id: string;
	readonly description: string;
	readonly type: AgentType;
	readonly prompt: string;
	readonly model?: {
		readonly id?: string;
		readonly thinking?: ThinkingValue;
	};
	readonly tools?: readonly string[];
	readonly agents?: readonly string[];
}

/** Loads valid agent definitions from the isolated pi agent directory. */
export async function loadAgentDefinitions(): Promise<AgentDefinition[]> {
	const agentsDir = await resolveAgentsDir();
	if (agentsDir === undefined) {
		return [];
	}

	const agentEntries = [...agentsDir.entries]
		.sort()
		.filter((entry) => entry.endsWith(AGENT_FILE_EXTENSION));
	const agents = await Promise.all(
		agentEntries.map((entry) =>
			readAgentDefinition(agentsDir.path, entry, agentsDir.source),
		),
	);
	return agents.filter((agent) => agent !== undefined);
}

/** Resolves suite-owned agent definitions and falls back to the legacy directory only when the suite directory is absent. */
async function resolveAgentsDir(): Promise<
	| {
			readonly path: string;
			readonly entries: readonly string[];
			readonly source: "suite" | "legacy";
	  }
	| undefined
> {
	const suiteAgentsDir = join(
		getSuiteExtensionDir(AGENT_SELECTION_EXTENSION_DIR),
		AGENTS_DIR,
	);
	try {
		return {
			path: suiteAgentsDir,
			entries: await readdir(suiteAgentsDir),
			source: "suite",
		};
	} catch (error) {
		if (!isFileNotFoundError(error)) {
			throw new Error(
				`failed to read suite agents directory: ${formatError(error)}`,
			);
		}
	}

	const legacyAgentsDir = join(getAgentDir(), AGENTS_DIR);
	try {
		return {
			path: legacyAgentsDir,
			entries: await readdir(legacyAgentsDir),
			source: "legacy",
		};
	} catch {
		return undefined;
	}
}

/** Reads and parses one agent definition while isolating malformed files. */
async function readAgentDefinition(
	agentsDir: string,
	entry: string,
	source: "suite" | "legacy",
): Promise<AgentDefinition | undefined> {
	let content: string;
	try {
		content = await readFile(join(agentsDir, entry), "utf8");
	} catch (error) {
		if (source === "suite") {
			throw new Error(
				`failed to read suite agent definition ${entry}: ${formatError(error)}`,
			);
		}
		return undefined;
	}

	try {
		return parseAgentDefinition(entry, content);
	} catch {
		return undefined;
	}
}

/** Parses and validates one agent definition file. */
function parseAgentDefinition(
	fileName: string,
	content: string,
): AgentDefinition | undefined {
	const parsed = parseFrontmatter(content);
	const frontmatter = parsed.frontmatter;
	if (!hasOnlyKeys(frontmatter, TOP_LEVEL_KEYS)) {
		return undefined;
	}

	const {
		type: rawType,
		description,
		model: rawModel,
		tools: rawTools,
		agents: rawAgents,
	} = frontmatter;
	const type = rawType ?? "main";
	if (!isAgentType(type)) {
		return undefined;
	}

	if (description !== undefined && typeof description !== "string") {
		return undefined;
	}

	const model = parseModel(rawModel);
	if (model === false) {
		return undefined;
	}

	const tools = parseStringList(rawTools);
	if (tools === false) {
		return undefined;
	}

	const agents = parseStringList(rawAgents);
	if (agents === false) {
		return undefined;
	}

	return {
		id: basename(fileName, AGENT_FILE_EXTENSION),
		description: description ?? "",
		type,
		prompt: parsed.body.trim(),
		...(model !== undefined ? { model } : {}),
		...(tools !== undefined ? { tools } : {}),
		...(agents !== undefined ? { agents } : {}),
	};
}

/** Parses the optional model block and rejects unsupported nested keys. */
function parseModel(value: unknown): AgentDefinition["model"] | false {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value) || !hasOnlyKeys(value, MODEL_KEYS)) {
		return false;
	}

	const { id, thinking } = value;
	if (id !== undefined && !isModelId(id)) {
		return false;
	}

	if (thinking !== undefined && !isThinkingValue(thinking)) {
		return false;
	}

	return {
		...(typeof id === "string" ? { id } : {}),
		...(isThinkingValue(thinking) ? { thinking } : {}),
	};
}

/** Returns true when a model ID has provider and model parts separated by the first slash. */
function isModelId(value: unknown): value is string {
	if (typeof value !== "string") {
		return false;
	}

	const separatorIndex = value.indexOf("/");
	return separatorIndex > 0 && separatorIndex < value.length - 1;
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

/** Returns true when a runtime value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** Returns true when a runtime value is a supported thinking level. */
function isThinkingValue(value: unknown): value is ThinkingValue {
	return (
		typeof value === "string" &&
		(THINKING_VALUES as readonly string[]).includes(value)
	);
}
