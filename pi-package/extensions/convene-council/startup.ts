import { argv as processArgv, env as processEnv } from "node:process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withChildAgentProcessMarker } from "../../shared/child-agent-environment";
import { resolveToolPolicy } from "../../shared/tool-policy";
import type { ConveneCouncilConfig, ParticipantRuntime } from "./types";

const EXTENSION_ARGS = new Set(["--extension", "-e"]);
const NO_EXTENSIONS_ARGS = new Set(["--no-extensions", "-ne"]);
const REPRODUCIBLE_ENV_KEYS = [
	"PI_PACKAGE_DIR",
	"PI_CODING_AGENT_DIR",
] as const;
const DISABLED_CHILD_RESOURCE_ARGS = [
	"--no-context-files",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
] as const;
const REQUIRED_READ_TOOL_NAME = "read";

/** Contains child startup inputs that must be resolved before sessions are created. */
export interface ChildStartupPlan {
	readonly extensionArgs: readonly string[];
	readonly env: Record<string, string>;
}

/** Contains child process arguments for one participant session. */
export interface ChildParticipantStartup {
	readonly args: readonly string[];
	readonly env: Record<string, string>;
}

/** Resolves startup inputs that can be reproduced by a child pi CLI process. */
export function resolveChildStartupPlan(
	options: {
		readonly argv?: readonly string[];
		readonly env?: NodeJS.ProcessEnv;
	} = {},
): ChildStartupPlan | { readonly issue: string } {
	const argv = options.argv ?? processArgv.slice(2);
	const extensionArgs = collectExtensionArgs(argv);
	if (extensionArgs === undefined) {
		return { issue: "child startup cannot reproduce parent extension loading" };
	}
	const env = collectReproducibleEnvironment(options.env ?? processEnv);
	return { extensionArgs, env };
}

/** Builds the full child pi argument list for one participant process. */
export function buildChildParticipantStartup(options: {
	readonly plan: ChildStartupPlan;
	readonly config: ConveneCouncilConfig;
	readonly pi: Pick<ExtensionAPI, "getAllTools">;
	readonly runtime: ParticipantRuntime;
	readonly sessionFile: string;
	readonly sessionDir: string;
	readonly systemPrompt: string;
}): ChildParticipantStartup | { readonly issue: string } {
	const toolArgs = resolveCouncilToolArgs(options.config, options.pi);
	if ("issue" in toolArgs) {
		return toolArgs;
	}

	return buildChildParticipantStartupFromToolArgs({
		plan: options.plan,
		runtime: options.runtime,
		sessionFile: options.sessionFile,
		sessionDir: options.sessionDir,
		systemPrompt: options.systemPrompt,
		toolArgs: toolArgs.args,
	});
}

/** Builds participant startup from already resolved tool args. */
export function buildChildParticipantStartupFromToolArgs(options: {
	readonly plan: ChildStartupPlan;
	readonly runtime: ParticipantRuntime;
	readonly sessionFile: string;
	readonly sessionDir: string;
	readonly systemPrompt: string;
	readonly toolArgs: readonly string[];
}): ChildParticipantStartup {
	return {
		env: withChildAgentProcessMarker(options.plan.env),
		args: [
			"--mode",
			"rpc",
			"--session",
			options.sessionFile,
			"--session-dir",
			options.sessionDir,
			"--model",
			`${options.runtime.model.provider}/${options.runtime.model.id}`,
			"--thinking",
			options.runtime.thinking ?? "off",
			"--system-prompt",
			options.systemPrompt,
			...DISABLED_CHILD_RESOURCE_ARGS,
			...options.plan.extensionArgs,
			...options.toolArgs,
		],
	};
}

/** Resolves configured council tools to child CLI flags. */
export function resolveCouncilToolArgs(
	config: ConveneCouncilConfig,
	pi: Pick<ExtensionAPI, "getAllTools">,
): { readonly args: readonly string[] } | { readonly issue: string } {
	return resolveCouncilToolArgsForNames(
		config,
		pi.getAllTools().map((tool) => tool.name),
	);
}

/** Resolves configured council tools against an already captured tool list. */
export function resolveCouncilToolArgsForNames(
	config: ConveneCouncilConfig,
	availableToolNames: readonly string[],
): { readonly args: readonly string[] } | { readonly issue: string } {
	if (!availableToolNames.includes(REQUIRED_READ_TOOL_NAME)) {
		return { issue: "required tool read is unavailable" };
	}

	if (config.tools === undefined || config.tools.length === 0) {
		return { args: ["--tools", REQUIRED_READ_TOOL_NAME] };
	}

	const resolved = resolveToolPolicy(config.tools, availableToolNames);
	if ("issue" in resolved) {
		return resolved;
	}
	return {
		args: [
			"--tools",
			[
				REQUIRED_READ_TOOL_NAME,
				...resolved.tools.filter((tool) => tool !== REQUIRED_READ_TOOL_NAME),
			].join(","),
		],
	};
}

/** Collects parent extension flags that can be passed directly to child pi. */
function collectExtensionArgs(
	argv: readonly string[],
): readonly string[] | undefined {
	const args: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === undefined) {
			continue;
		}
		if (EXTENSION_ARGS.has(arg)) {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("-")) {
				return undefined;
			}
			args.push(arg, value);
			index += 1;
			continue;
		}
		if (NO_EXTENSIONS_ARGS.has(arg)) {
			args.push(arg);
		}
	}
	return args;
}

/** Propagates only documented Pi startup environment inputs. */
function collectReproducibleEnvironment(
	env: NodeJS.ProcessEnv,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key of REPRODUCIBLE_ENV_KEYS) {
		const value = env[key];
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}
