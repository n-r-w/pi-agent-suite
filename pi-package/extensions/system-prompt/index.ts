import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	formatSkillsForPrompt,
} from "@earendil-works/pi-coding-agent";
import { getAgentRuntimeComposition } from "../../shared/agent-runtime-composition";
import { writeRuntimeDiagnostic } from "../../shared/agent-runtime-diagnostics";
import {
	getSuiteConfigLocation,
	isFileNotFoundError,
} from "../../shared/agent-suite-storage";
import type { VisibleToolset } from "../../shared/toolsets/contracts";
import { getToolsetRuntime } from "../../shared/toolsets/runtime";
import { AVAILABLE_SUBAGENTS_PROMPT_OPENING_TAG } from "../run-subagent/contracts";

const EXTENSION_DIR = "system-prompt";
const ISSUE_PREFIX = "[system-prompt]";
const ENABLED_CONFIG_KEY = "enabled";
const TEMPLATE_FILE_CONFIG_KEY = "templateFile";
const CONFIG_KEYS = [ENABLED_CONFIG_KEY, TEMPLATE_FILE_CONFIG_KEY] as const;
const SUPPORTED_TEMPLATE_VARIABLES = [
	"date",
	"cwd",
	"tools",
	"toolGuidelines",
	"appendSystemPrompt",
	"contextFiles",
	"skills",
	"toolsets",
] as const;
const DEFAULT_SELECTED_TOOLS = ["read", "bash", "edit", "write"] as const;
const TEMPLATE_VARIABLE_PATTERN = /{{\s*([^{}]+?)\s*}}/g;

/** Extension-local Markdown template used when config does not override templateFile. */
const DEFAULT_TEMPLATE_FILE = join(
	dirname(fileURLToPath(import.meta.url)),
	"prompts",
	"system.md",
);

type TemplateVariable = (typeof SUPPORTED_TEMPLATE_VARIABLES)[number];

interface SystemPromptConfig {
	readonly templateFile: string;
}

type ConfigReadResult =
	| { readonly kind: "valid"; readonly config: SystemPromptConfig }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid"; readonly issue: string };

type TemplateState =
	| { readonly kind: "ready"; readonly template: string }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid" };

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

export default function systemPrompt(pi: ExtensionAPI): void {
	let templateState: TemplateState = { kind: "invalid" };

	pi.on("session_start", async (_event, ctx) => {
		templateState = await loadTemplateState(ctx as SessionContextLike);
		writeRuntimeDiagnostic("system-prompt.session-start.loaded", {
			templateState: templateState.kind,
		});
	});

	pi.on("before_agent_start", (event) => {
		const incomingPrompt = (event as BeforeAgentStartEventLike).systemPrompt;
		writeRuntimeDiagnostic("system-prompt.before-agent-start.started", {
			templateState: templateState.kind,
			incomingPromptLength: incomingPrompt.length,
			hasMainAgentRules: incomingPrompt.includes("<rules>"),
			hasAvailableSubagents: incomingPrompt.includes(
				AVAILABLE_SUBAGENTS_PROMPT_OPENING_TAG,
			),
		});
		if (templateState.kind !== "ready") {
			return undefined;
		}

		const typedEvent = event as BeforeAgentStartEventLike;
		const composition = getAgentRuntimeComposition(pi);
		composition.reconcileActiveTools();
		const options = {
			...typedEvent.systemPromptOptions,
			selectedTools: [...pi.getActiveTools()],
		};
		const toolsets = hasTemplateVariable(templateState.template, "toolsets")
			? getToolsetRuntime(pi).getVisibleToolsets()
			: [];
		const systemPrompt = renderTemplate(
			templateState.template,
			options,
			toolsets,
		);
		writeRuntimeDiagnostic("system-prompt.before-agent-start.applied", {
			incomingPromptLength: incomingPrompt.length,
			finalPromptLength: systemPrompt.length,
			droppedMainAgentRules:
				incomingPrompt.includes("<rules>") && !systemPrompt.includes("<rules>"),
			droppedAvailableSubagents:
				incomingPrompt.includes(AVAILABLE_SUBAGENTS_PROMPT_OPENING_TAG) &&
				!systemPrompt.includes(AVAILABLE_SUBAGENTS_PROMPT_OPENING_TAG),
		});
		return { systemPrompt };
	});
}

/** Loads effective config and template contents during startup or reload. */
async function loadTemplateState(
	ctx: SessionContextLike,
): Promise<TemplateState> {
	const configResult = await readSystemPromptConfig();
	if (configResult.kind === "disabled") {
		return { kind: "disabled" };
	}
	if (configResult.kind === "invalid") {
		reportIssue(ctx, configResult.issue);
		return { kind: "invalid" };
	}

	const templateResult = await readTemplate(configResult.config.templateFile);
	if (templateResult.kind === "invalid") {
		reportIssue(ctx, templateResult.issue);
		return { kind: "invalid" };
	}

	const unknownVariables = findUnknownTemplateVariables(
		templateResult.template,
	);
	if (unknownVariables.length > 0) {
		reportIssue(
			ctx,
			`removed unsupported template variable(s): ${unknownVariables.join(", ")}`,
		);
	}

	return { kind: "ready", template: templateResult.template };
}

/** Reads suite-owned config only; legacy config files are intentionally ignored. */
async function readSystemPromptConfig(): Promise<ConfigReadResult> {
	const location = getSuiteConfigLocation(EXTENSION_DIR);
	let content: string;
	try {
		content = await readFile(location.path, "utf8");
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return {
				kind: "valid",
				config: { templateFile: DEFAULT_TEMPLATE_FILE },
			};
		}

		return invalidConfig(`failed to read config: ${formatError(error)}`);
	}

	try {
		return parseSystemPromptConfig(JSON.parse(content));
	} catch (error) {
		return invalidConfig(`failed to parse config: ${formatError(error)}`);
	}
}

/** Parses unknown JSON config into the small runtime contract used by the extension. */
function parseSystemPromptConfig(config: unknown): ConfigReadResult {
	if (!isRecord(config)) {
		return invalidConfig("config must be an object");
	}

	const unsupportedKey = Object.keys(config).find(
		(key) => !CONFIG_KEYS.includes(key as (typeof CONFIG_KEYS)[number]),
	);
	if (unsupportedKey !== undefined) {
		return invalidConfig("config contains unsupported keys");
	}

	const enabled = config[ENABLED_CONFIG_KEY];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return invalidConfig("enabled must be a boolean");
	}
	if (enabled === false) {
		return { kind: "disabled" };
	}

	const templateFile = config[TEMPLATE_FILE_CONFIG_KEY];
	if (templateFile !== undefined && typeof templateFile !== "string") {
		return invalidConfig("templateFile must be a string");
	}
	if (templateFile !== undefined && !isAbsolute(templateFile)) {
		return invalidConfig("templateFile must be an absolute path");
	}

	return {
		kind: "valid",
		config: {
			templateFile: templateFile ?? DEFAULT_TEMPLATE_FILE,
		},
	};
}

/** Reads the configured Markdown template and keeps file diagnostics safe for UI display. */
async function readTemplate(
	templateFile: string,
): Promise<
	| { readonly kind: "valid"; readonly template: string }
	| { readonly kind: "invalid"; readonly issue: string }
> {
	try {
		return { kind: "valid", template: await readFile(templateFile, "utf8") };
	} catch (error) {
		return {
			kind: "invalid",
			issue: `failed to read template: ${formatError(error)}`,
		};
	}
}

/** Replaces supported placeholders with dynamic runtime values and removes unsupported placeholders. */
function renderTemplate(
	template: string,
	options: BuildSystemPromptOptions,
	toolsets: readonly VisibleToolset[],
): string {
	const values = buildTemplateValues(options, toolsets);

	return template.replace(
		TEMPLATE_VARIABLE_PATTERN,
		(_placeholder: string, rawVariableName: string): string => {
			const variableName = rawVariableName.trim();
			return isTemplateVariable(variableName) ? values[variableName] : "";
		},
	);
}

/** Builds the dynamic values allowed to cross from pi runtime state into the Markdown template. */
function buildTemplateValues(
	options: BuildSystemPromptOptions,
	toolsets: readonly VisibleToolset[],
): Record<TemplateVariable, string> {
	return {
		date: getLocalDate(),
		cwd: options.cwd.replace(/\\/g, "/"),
		tools: formatTools(options),
		toolGuidelines: formatToolGuidelines(options),
		appendSystemPrompt: options.appendSystemPrompt ?? "",
		contextFiles: formatContextFiles(options),
		skills: formatSkills(options),
		toolsets: formatToolsets(toolsets),
	};
}

/** Formats visible active tools as the one-line prompt snippets exposed by pi. */
function formatTools(options: BuildSystemPromptOptions): string {
	const tools = options.selectedTools ?? [...DEFAULT_SELECTED_TOOLS];
	const visibleTools = tools.filter((name) =>
		Boolean(options.toolSnippets?.[name]),
	);
	if (visibleTools.length === 0) {
		return "(none)";
	}

	return visibleTools
		.map((name) => `- ${name}: ${options.toolSnippets?.[name] ?? ""}`)
		.join("\n");
}

/** Formats only dynamic promptGuidelines supplied by active tools or extensions. */
function formatToolGuidelines(options: BuildSystemPromptOptions): string {
	return (options.promptGuidelines ?? [])
		.map((guideline) => guideline.trim())
		.filter((guideline) => guideline.length > 0)
		.map((guideline) => `- ${guideline}`)
		.join("\n");
}

/** Formats loaded project context files as XML-like structure for LLM readability. */
function formatContextFiles(options: BuildSystemPromptOptions): string {
	const contextFiles = options.contextFiles ?? [];
	if (contextFiles.length === 0) {
		return "";
	}

	return [
		"<project_specific_instructions>",
		...contextFiles.map(
			({ path, content }) =>
				`  <project_specific_instruction path="${path}">\n${content}\n  </project_specific_instruction>`,
		),
		"</project_specific_instructions>",
	].join("\n");
}

/** Formats loaded skills only when the read tool is active, matching pi's skill visibility rule. */
function formatSkills(options: BuildSystemPromptOptions): string {
	const selectedTools = options.selectedTools ?? [...DEFAULT_SELECTED_TOOLS];
	if (!selectedTools.includes("read") || (options.skills ?? []).length === 0) {
		return "";
	}

	return formatSkillsForPrompt(options.skills ?? []);
}

/** Formats the visible deferred catalog without exposing tool schemas or provider details. */
function formatToolsets(toolsets: readonly VisibleToolset[]): string {
	if (toolsets.length === 0) {
		return "";
	}

	return [
		"<toolsets>",
		...toolsets.map(
			({ name, description }) =>
				`<toolset name="${escapeXmlAttribute(name)}" description="${escapeXmlAttribute(description)}"/>`,
		),
		"</toolsets>",
	].join("\n");
}

/** Escapes XML-sensitive attribute characters while preserving all other Unicode text. */
function escapeXmlAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

/** Returns whether a template explicitly requests one supported dynamic value. */
function hasTemplateVariable(
	template: string,
	expectedName: TemplateVariable,
): boolean {
	return [...template.matchAll(TEMPLATE_VARIABLE_PATTERN)].some(
		(match) => match[1]?.trim() === expectedName,
	);
}

/** Returns the local date string in the same YYYY-MM-DD shape used by pi's base prompt. */
function getLocalDate(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");

	return `${year}-${month}-${day}`;
}

/** Finds unsupported template placeholders once so startup/reload can warn before agent turns. */
function findUnknownTemplateVariables(template: string): readonly string[] {
	const unknownVariables = new Set<string>();
	for (const match of template.matchAll(TEMPLATE_VARIABLE_PATTERN)) {
		const variableName = match[1]?.trim();
		if (variableName !== undefined && !isTemplateVariable(variableName)) {
			unknownVariables.add(variableName);
		}
	}

	return [...unknownVariables];
}

/** Narrows placeholder names to the finite supported variable set. */
function isTemplateVariable(value: string): value is TemplateVariable {
	return SUPPORTED_TEMPLATE_VARIABLES.includes(value as TemplateVariable);
}

/** Builds fail-closed config results while keeping behavior local to this extension. */
function invalidConfig(issue: string): ConfigReadResult {
	return { kind: "invalid", issue };
}

/** Reports startup/reload validation issues only when a user-facing UI is available. */
function reportIssue(ctx: SessionContextLike, issue: string): void {
	if (ctx.hasUI === false) {
		return;
	}

	ctx.ui?.notify(`${ISSUE_PREFIX} ${issue}`, "warning");
}

/** Returns true when unknown JSON is a plain object suitable for strict config parsing. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Converts unknown failures into safe diagnostics for startup warning messages. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
