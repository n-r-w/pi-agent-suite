import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GitProjectResolution } from "../../pi-package/extensions/knowledge/git-context";
import knowledgeExtension from "../../pi-package/extensions/knowledge/index";
import { createProjectPaths } from "../../pi-package/extensions/knowledge/paths";
import projectRules from "../../pi-package/extensions/project-rules/index";
import systemPrompt from "../../pi-package/extensions/system-prompt/index";
import { getAgentRuntimeComposition } from "../../pi-package/shared/agent-runtime-composition";
import { getToolsetRuntime } from "../../pi-package/shared/toolsets/runtime";
import {
	type CacheRequestSnapshot,
	registerCacheProvider,
} from "./toolset-cache-provider";

/** Results from real native sessions with only external model and tool behavior replaced. */
export interface CacheSessionOutcome {
	requests: CacheRequestSnapshot[];
	executions: string[];
	sessionFile: string;
	activations: number;
	knowledgeReads: number;
	errors: string[];
}

/** Builds a stable project identity without reading real git state. */
function createKnowledgeProject(): Extract<
	GitProjectResolution,
	{ readonly project: unknown }
> {
	const digestLength = 64;
	const key = "a".repeat(digestLength);
	return {
		kind: "resolved-read-only",
		project: {
			profile: "github-v1",
			canonicalIdentity: "github.com/fixture/project",
			displayName: "fixture",
			key,
			directoryName: `fixture-${key}`,
		},
		identityMetadata: {
			schema: "knowledge-project-identity/v1",
			key,
			profile: "github-v1",
			displayName: "fixture",
			canonicalIdentity: "github.com/fixture/project",
			remoteNames: ["origin"],
			redactedFetchUrls: ["https://github.com/fixture/project.git"],
		},
		branch: null,
	};
}

/** Writes isolated settings, templates, project rules, and applicable knowledge. */
function prepareDisk(
	root: string,
	resolution: Extract<GitProjectResolution, { readonly project: unknown }>,
): void {
	const files: Record<string, string> = {
		[join(root, "system.md")]:
			"{{#mainAgent}}main fixture{{/mainAgent}}{{#childAgent}}child fixture{{/childAgent}}\n{{toolsets}}\n{{toolGuidelines}}\n{{contextFiles}}",
		[join(root, "suite", "system-prompt", "config.json")]: JSON.stringify({
			templateFile: join(root, "system.md"),
		}),
		[join(root, "suite", "project-rules", "config.json")]: JSON.stringify({
			enabled: true,
		}),
		[join(root, "suite", "knowledge", "config.json")]: JSON.stringify({
			enabled: true,
			dataDir: join(root, "knowledge"),
		}),
		[join(root, "project", ".pi", "rules", "fixture.md")]:
			"fixture project rule",
		[join(root, "agent", "settings.json")]: JSON.stringify({
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
		[createProjectPaths(
			join(root, "knowledge"),
			resolution.project.directoryName,
		).globalKnowledgeFile]: "fixture project knowledge",
	};
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content);
	}
}

/** Registers an external tool provider through the real deferred-toolset runtime. */
function registerTools(
	pi: ExtensionAPI,
	resumed: boolean,
	outcome: CacheSessionOutcome,
): void {
	const names = resumed
		? ["files_write", "files_read"]
		: ["files_read", "files_write"];
	for (const name of names) {
		pi.registerTool({
			name,
			label: name,
			description: `fixture ${name}`,
			parameters: Type.Object({}),
			promptGuidelines: [`fixture guideline for ${name}`],
			async execute() {
				outcome.executions.push(name);
				return {
					content: [{ type: "text", text: "fixture tool result" }],
					details: {},
				};
			},
		});
	}
	const runtime = getToolsetRuntime(pi);
	runtime.replaceProvider("fixture", [
		{
			providerId: "fixture",
			name: "files",
			description: "fixture files",
			toolNames: names,
			async activate() {
				outcome.activations += 1;
				return names;
			},
		},
	]);
	pi.on("session_start", (_event, ctx) => {
		getAgentRuntimeComposition(pi).setSelectedAgentContribution({
			prompt: "fixture selected agent",
			tools: ["activate_toolset", ...names],
		});
		runtime.restoreFromBranch(ctx.sessionManager.getBranch(), ctx);
	});
}

/** Opens one genuine AgentSession with all four package prompt contributors loaded. */
async function openSession({
	root,
	model,
	resumed,
	manager,
	outcome,
}: {
	root: string;
	model: Model<Api>;
	resumed: boolean;
	manager: SessionManager;
	outcome: CacheSessionOutcome;
}) {
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const settings = SettingsManager.create(cwd, agentDir);
	const resolution = createKnowledgeProject();
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: settings,
		noExtensions: true,
		noContextFiles: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [
			systemPrompt,
			projectRules,
			(pi) =>
				knowledgeExtension(pi, {
					resolveProject: () => {
						outcome.knowledgeReads += 1;
						return resolution;
					},
					runtimeEnv: {},
				}),
			(pi) => {
				registerTools(pi, resumed, outcome);
				registerCacheProvider(pi, model, resumed, outcome.requests);
			},
		],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		thinkingLevel: "off",
		resourceLoader: loader,
		sessionManager: manager,
		settingsManager: settings,
	});
	await session.bindExtensions({
		onError: (error) => {
			outcome.errors.push(error.error);
		},
	});
	return session;
}

/** Drives activation, direct tool use, continuation, and saved-session restoration. */
async function run(): Promise<void> {
	const root = process.argv[2];
	const provider = process.argv[3];
	const mode = process.argv[4];
	const savedFile = process.argv[5];
	if (
		!root ||
		(provider !== "openai" && provider !== "openai-codex") ||
		(mode !== "initial" && mode !== "resumed")
	) {
		throw new Error(
			"Fixture root, target provider, and session mode are required",
		);
	}
	const resumed = mode === "resumed";
	if (resumed && !savedFile) {
		throw new Error("A saved session file is required for restoration");
	}
	prepareDisk(root, createKnowledgeProject());
	const model = getBuiltinModel(provider, "gpt-6.1-sol") as Model<Api>;
	const outcome: CacheSessionOutcome = {
		requests: [],
		executions: [],
		sessionFile: "",
		activations: 0,
		knowledgeReads: 0,
		errors: [],
	};
	const manager = savedFile
		? SessionManager.open(savedFile)
		: SessionManager.create(join(root, "project"), join(root, "sessions"));
	const session = await openSession({ root, model, resumed, manager, outcome });
	try {
		if (resumed) {
			await session.prompt("use restored fixture tools");
		} else {
			await session.prompt("activate fixture tools");
			await session.prompt("continue with fixture tools");
		}
	} finally {
		await session.extensionRunner.emit({
			type: "session_shutdown",
			reason: "quit",
		});
		session.dispose();
	}
	const file = manager.getSessionFile();
	if (!file) {
		throw new Error("The native session was not persisted");
	}
	outcome.sessionFile = file;
	process.stdout.write(JSON.stringify(outcome));
}

await run();
