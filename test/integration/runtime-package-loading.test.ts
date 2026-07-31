import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SELECTED_AGENT_STATE_HASH_ENCODING = "hex";
const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";
const CHILD_AGENT_PROCESS_ENV = "PI_AGENT_SUITE_CHILD_AGENT_PROCESS";
const SUBAGENT_AGENT_ID_ENV = "PI_SUBAGENT_AGENT_ID";
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_TOOL_PATTERNS_ENV = "PI_SUBAGENT_TOOL_PATTERNS";
const SUBAGENT_WORKFLOW_IDS_ENV = "PI_SUBAGENT_WORKFLOW_IDS";
/** Matches Pi diagnostics that report extension loading or execution failures. */
const PI_EXTENSION_ERROR_PATTERN =
	/(?:Extension error|Failed to load extension|Extension failed)/i;
/** Defines the isolated model provider used by online Pi runtime tests. */
const RUNTIME_TEST_PROVIDER_ID = "runtime-test";
const RUNTIME_TEST_MODEL_ID = "fake";
const RUNTIME_TEST_MODEL = `${RUNTIME_TEST_PROVIDER_ID}/${RUNTIME_TEST_MODEL_ID}`;
const RUNTIME_TEST_PROVIDER_LINES = [
	`\tpi.registerProvider("${RUNTIME_TEST_PROVIDER_ID}", {`,
	'\t\tname: "Runtime Test",',
	'\t\tbaseUrl: "http://127.0.0.1:1/v1",',
	'\t\tapiKey: "test",',
	'\t\tapi: "openai-completions",',
	"\t\tmodels: [{",
	`\t\t\tid: "${RUNTIME_TEST_MODEL_ID}",`,
	'\t\t\tname: "Fake",',
	"\t\t\treasoning: false,",
	'\t\t\tinput: ["text"],',
	"\t\t\tcost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },",
	"\t\t\tcontextWindow: 128000,",
	"\t\t\tmaxTokens: 4096,",
	"\t\t}],",
	"\t});",
] as const;

interface RuntimeDump {
	readonly activeTools: readonly string[];
	readonly toolDescriptions: Readonly<Record<string, string>>;
	readonly tools: readonly string[];
	readonly systemPrompt: string;
}

interface WorkflowRuntimeDump {
	readonly activeTools: readonly string[];
	readonly activeToolDescriptions: Readonly<Record<string, string>>;
	readonly contextMessages: readonly {
		readonly role: string;
		readonly customType?: string;
		readonly content: unknown;
	}[];
	readonly systemPrompt: string;
}

/** Writes one markdown agent definition into the isolated suite agent directory. */
function writeAgent(agentDir: string, fileName: string, content: string): void {
	writeFileSync(
		join(agentDir, "agent-suite", "agent-selection", "agents", fileName),
		content,
	);
}

/** Writes one markdown agent definition into a project's local agent directory. */
function writeProjectAgent(
	projectDir: string,
	fileName: string,
	content: string,
): void {
	const agentsDir = join(projectDir, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, fileName), content);
}

/** Returns the hash-based selected-agent state file name for one normalized working directory. */
function selectedAgentStateFileName(cwd: string): string {
	return `${createHash("sha256").update(cwd).digest(SELECTED_AGENT_STATE_HASH_ENCODING)}.json`;
}

/** Creates an isolated pi agent directory with selected TestAgent state. */
function createIsolatedAgentDir(cwd: string): string {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-runtime-package-"));
	mkdirSync(join(agentDir, "agent-suite", "agent-selection", "agents"), {
		recursive: true,
	});
	mkdirSync(join(agentDir, "agent-suite", "agent-selection", "state"), {
		recursive: true,
	});
	writeFileSync(
		join(
			agentDir,
			"agent-suite",
			"agent-selection",
			"state",
			selectedAgentStateFileName(cwd),
		),
		JSON.stringify({ cwd, activeAgentId: "TestAgent" }),
	);

	writeAgent(
		agentDir,
		"SubAgentCoder.md",
		["---", "description: Coder", "type: subagent", "---", "Coder prompt"].join(
			"\n",
		),
	);
	writeAgent(
		agentDir,
		"SubAgentExtractor.md",
		[
			"---",
			'description: "Extractor & verifier <safe>"',
			"type: subagent",
			"---",
			"Extractor prompt",
		].join("\n"),
	);
	writeAgent(
		agentDir,
		"TestAgent.md",
		[
			"---",
			"description: Agent for testing subagents subsystem.",
			"type: both",
			'tools: ["subagent_start", "subagent_steer", "subagent_wait", "subagent_query"]',
			'agents: ["SubAgentExtractor"]',
			"---",
			"Test agent prompt",
		].join("\n"),
	);

	return agentDir;
}

/** Writes a debug extension that exits after dumping the final before_agent_start prompt. */
function writePromptDumpExtension(directory: string): string {
	const extensionPath = join(directory, "dump-prompt.ts");
	writeFileSync(
		extensionPath,
		[
			'import { writeFileSync } from "node:fs";',
			"",
			"export default function dumpPrompt(pi) {",
			...RUNTIME_TEST_PROVIDER_LINES,
			'\tpi.on("before_agent_start", (event) => {',
			"\t\tconst dumpFile = process.env.PI_PROMPT_DUMP_FILE;",
			'\t\tif (dumpFile === undefined) throw new Error("PI_PROMPT_DUMP_FILE is required");',
			"\t\twriteFileSync(dumpFile, event.systemPrompt);",
			"\t\tprocess.exit(23);",
			"\t});",
			"}",
		].join("\n"),
	);
	return extensionPath;
}

/** Writes a debug extension that exits from context before any provider request. */
function writeWorkflowRuntimeDumpExtension(
	directory: string,
	mainContributionReset?: {
		readonly runtimeCompositionUrl: string;
		readonly tools: readonly string[];
	},
): string {
	const extensionPath = join(directory, "dump-workflow-runtime.ts");
	writeFileSync(
		extensionPath,
		[
			'import { writeFileSync } from "node:fs";',
			...(mainContributionReset === undefined
				? []
				: [
						`import { getAgentRuntimeComposition } from ${JSON.stringify(mainContributionReset.runtimeCompositionUrl)};`,
					]),
			"",
			"export default function dumpWorkflowRuntime(pi) {",
			...RUNTIME_TEST_PROVIDER_LINES,
			...(mainContributionReset === undefined
				? []
				: [
						'\tpi.on("session_start", () => {',
						`\t\tgetAgentRuntimeComposition(pi).setMainAgentContribution({ prompt: "Runtime reset", tools: ${JSON.stringify(mainContributionReset.tools)} });`,
						"\t});",
					]),
			'\tlet systemPrompt = "";',
			'\tpi.on("before_agent_start", (event) => {',
			"\t\tsystemPrompt = event.systemPrompt;",
			"\t});",
			'\tpi.on("context", (event) => {',
			"\t\tconst dumpFile = process.env.PI_WORKFLOW_RUNTIME_DUMP_FILE;",
			'\t\tif (dumpFile === undefined) throw new Error("PI_WORKFLOW_RUNTIME_DUMP_FILE is required");',
			"\t\tconst activeTools = pi.getActiveTools();",
			"\t\tconst descriptions = Object.fromEntries(pi.getAllTools().map((tool) => [tool.name, tool.description]));",
			"\t\twriteFileSync(dumpFile, JSON.stringify({",
			"\t\t\tactiveTools,",
			"\t\t\tactiveToolDescriptions: Object.fromEntries(activeTools.map((name) => [name, descriptions[name]])),",
			"\t\t\tcontextMessages: event.messages,",
			"\t\t\tsystemPrompt,",
			"\t\t}, null, 2));",
			"\t\tprocess.exit(23);",
			"\t});",
			"}",
		].join("\n"),
	);
	return extensionPath;
}

/** Writes a debug extension that exits after dumping loaded tools and final system prompt. */
function writeRuntimeDumpExtension(directory: string): string {
	const extensionPath = join(directory, "dump-runtime.ts");
	writeFileSync(
		extensionPath,
		[
			'import { writeFileSync } from "node:fs";',
			"",
			"export default function dumpRuntime(pi) {",
			...RUNTIME_TEST_PROVIDER_LINES,
			'\tpi.on("before_agent_start", (event) => {',
			"\t\tconst dumpFile = process.env.PI_RUNTIME_DUMP_FILE;",
			'\t\tif (dumpFile === undefined) throw new Error("PI_RUNTIME_DUMP_FILE is required");',
			"\t\twriteFileSync(dumpFile, JSON.stringify({",
			"\t\t\tactiveTools: pi.getActiveTools(),",
			"\t\t\ttoolDescriptions: Object.fromEntries(pi.getAllTools().map((tool) => [tool.name, tool.description])),",
			"\t\t\ttools: pi.getAllTools().map((tool) => tool.name),",
			"\t\t\tsystemPrompt: event.systemPrompt,",
			"\t\t}, null, 2));",
			"\t\tprocess.exit(23);",
			"\t});",
			"}",
		].join("\n"),
	);
	return extensionPath;
}

test("runtime package loading keeps selected-agent allowlist across split entries", () => {
	// Purpose: real Pi package loading must keep main-agent selection and Subagents in one runtime composition.
	// Input and expected output: selected TestAgent allows only SubAgentExtractor, so the final prompt lists only SubAgentExtractor.
	// Edge case: pi loads package entries separately; disconnected shared state would expose SubAgentCoder and TestAgent too.
	// Dependencies: this integration check uses the local pi CLI, isolated temp agent files, and a debug extension that exits before any model request.
	const repositoryDir = process.cwd();
	const projectDir = realpathSync(
		mkdtempSync(join(tmpdir(), "pi-runtime-package-project-")),
	);
	const scratchDir = mkdtempSync(join(tmpdir(), "pi-runtime-package-debug-"));
	const agentDir = createIsolatedAgentDir(projectDir);
	const poisonedSuiteDir = mkdtempSync(
		join(tmpdir(), "pi-runtime-poison-suite-"),
	);
	const promptDumpFile = join(scratchDir, "system-prompt.txt");
	const debugExtensionPath = writePromptDumpExtension(scratchDir);
	const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
	process.env[AGENT_SUITE_DIR_ENV] = poisonedSuiteDir;
	const childEnv: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_AGENT_SUITE_DIR: join(agentDir, "agent-suite"),
		PI_PROMPT_DUMP_FILE: promptDumpFile,
	};
	delete childEnv[SUBAGENT_AGENT_ID_ENV];
	delete childEnv[SUBAGENT_DEPTH_ENV];
	delete childEnv[SUBAGENT_TOOL_PATTERNS_ENV];

	try {
		const result = spawnSync(
			"pi",
			[
				"--no-session",
				"--no-extensions",
				"--model",
				RUNTIME_TEST_MODEL,
				"-p",
				"-e",
				join(repositoryDir, "pi-package"),
				"-e",
				debugExtensionPath,
				"debug prompt dump",
			],
			{
				cwd: projectDir,
				encoding: "utf8",
				env: childEnv,
				timeout: 30_000,
			},
		);

		expect(result.status).toBe(23);
		const prompt = readFileSync(promptDumpFile, "utf8");
		expect(prompt).toContain("Test agent prompt");
		expect(prompt).toContain(
			[
				'<available_subagents note="List of available subagent IDs">',
				'<agent id="SubAgentExtractor">',
				"Extractor &amp; verifier &lt;safe&gt;",
				"</agent>",
				"</available_subagents>",
			].join("\n"),
		);
		expect(prompt).not.toContain('<agent id="SubAgentCoder">');
		expect(prompt).not.toContain('<agent id="TestAgent">');
	} finally {
		if (previousSuiteDir === undefined) {
			delete process.env[AGENT_SUITE_DIR_ENV];
		} else {
			process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
		}
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
		rmSync(poisonedSuiteDir, { recursive: true, force: true });
		rmSync(scratchDir, { recursive: true, force: true });
	}
});

test("runtime child loading removes subagent context at maxDepth", () => {
	// Purpose: a child at maxDepth must keep its selected-agent prompt while receiving no subagent tools or prompt sections.
	// Input and expected output: the project agent prompt wins, every transported subagent tool is removed, and only the unrelated read tool stays active.
	// Edge case: the child agent ID keeps global casing while the project override and tool policy remain independent of caller tools.
	// Dependencies: local Pi CLI, isolated agent files and config, package lifecycle handlers, and a debug extension that exits before model access.
	const repositoryDir = process.cwd();
	const projectDir = realpathSync(
		mkdtempSync(join(tmpdir(), "pi-runtime-project-agents-")),
	);
	const scratchDir = mkdtempSync(join(tmpdir(), "pi-runtime-project-dump-"));
	const agentDir = createIsolatedAgentDir(projectDir);
	const runtimeDumpFile = join(scratchDir, "runtime.json");
	const debugExtensionPath = writeRuntimeDumpExtension(scratchDir);
	const extensionDescriptionPromptFile = join(scratchDir, "extension.md");
	const configDir = join(agentDir, "agent-suite", "run-subagent");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(extensionDescriptionPromptFile, " child extension ");
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({
			enabled: true,
			maxDepth: 1,
			extensionDescriptionPromptFile,
		}),
	);
	writeProjectAgent(
		projectDir,
		"subagentextractor.md",
		[
			"---",
			"description: Project extractor",
			"type: subagent",
			"---",
			"PROJECT_AGENT_BODY",
		].join("\n"),
	);
	const childEnv: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_AGENT_SUITE_DIR: join(agentDir, "agent-suite"),
		PI_RUNTIME_DUMP_FILE: runtimeDumpFile,
		[SUBAGENT_AGENT_ID_ENV]: "SubAgentExtractor",
		[SUBAGENT_DEPTH_ENV]: "1",
		[SUBAGENT_TOOL_PATTERNS_ENV]: JSON.stringify([
			"read",
			"subagent_start",
			"subagent_steer",
			"subagent_wait",
		]),
	};

	try {
		const result = spawnSync(
			"pi",
			[
				"--no-session",
				"--no-extensions",
				"--model",
				RUNTIME_TEST_MODEL,
				"-p",
				"-e",
				join(repositoryDir, "pi-package"),
				"-e",
				debugExtensionPath,
				"debug project agent override",
			],
			{
				cwd: projectDir,
				encoding: "utf8",
				env: childEnv,
				timeout: 30_000,
			},
		);

		expect(result.status).toBe(23);
		const runtime = JSON.parse(
			readFileSync(runtimeDumpFile, "utf8"),
		) as RuntimeDump;
		expect(runtime.systemPrompt).toContain("PROJECT_AGENT_BODY");
		expect(runtime.systemPrompt).not.toContain("Extractor prompt");
		expect(runtime.systemPrompt).not.toContain("child extension");
		expect(runtime.systemPrompt).not.toContain("<subagent_tools_guidelines>");
		expect(runtime.systemPrompt).not.toContain("<available_subagents");
		expect(runtime.tools).toContain("bash");
		expect(runtime.activeTools).toEqual(["read"]);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
		rmSync(scratchDir, { recursive: true, force: true });
	}
});

test("loads Subagents in isolated offline modes", () => {
	// Purpose: real Pi must load the subagent entry alone and through the complete package without discovered extensions or model access.
	// Input and expected output: both explicit offline targets use one isolated TestAgent policy and exit successfully without extension diagnostics.
	// Edge case: print mode receives no prompt because Pi prohibits prompts while offline.
	// Dependencies: local Pi CLI, production extension entry points, and isolated temporary project and agent state.
	const repositoryDir = process.cwd();
	let projectDir: string | undefined;
	let agentDir: string | undefined;

	try {
		projectDir = realpathSync(
			mkdtempSync(join(tmpdir(), "pi-runtime-loading-project-")),
		);
		agentDir = createIsolatedAgentDir(projectDir);
		const childEnv: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_AGENT_SUITE_DIR: join(agentDir, "agent-suite"),
		};
		delete childEnv[CHILD_AGENT_PROCESS_ENV];
		delete childEnv[SUBAGENT_AGENT_ID_ENV];
		delete childEnv[SUBAGENT_DEPTH_ENV];
		delete childEnv[SUBAGENT_TOOL_PATTERNS_ENV];
		const targets = [
			join(
				repositoryDir,
				"pi-package",
				"extensions",
				"run-subagent",
				"index.ts",
			),
			join(repositoryDir, "pi-package"),
		];
		for (const target of targets) {
			const result = spawnSync(
				"pi",
				["--no-session", "--no-extensions", "--offline", "-p", "-e", target],
				{
					cwd: projectDir,
					encoding: "utf8",
					env: childEnv,
					timeout: 30_000,
				},
			);

			expect(result.error).toBeUndefined();
			expect(result.signal).toBeNull();
			expect(result.status).toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).not.toMatch(
				PI_EXTENSION_ERROR_PATTERN,
			);
		}
	} finally {
		if (agentDir !== undefined) {
			rmSync(agentDir, { recursive: true, force: true });
			expect(existsSync(agentDir)).toBeFalse();
		}
		if (projectDir !== undefined) {
			rmSync(projectDir, { recursive: true, force: true });
			expect(existsSync(projectDir)).toBeFalse();
		}
	}
});

test("exposes subagent runtime tools and available-agent context", () => {
	// Purpose: real Pi must expose only subagent tools and compose the selected-agent policy before its first model turn.
	// Input and expected output: controlled TestAgent and SubAgentExtractor definitions produce the active tools and structured available-agent section.
	// Edge case: the debug extension exits from before_agent_start after selecting the isolated model, before any network or authentication request.
	// Dependencies: local Pi CLI, isolated package state, production runtime composition, and the provider-registering runtime dump extension.
	const repositoryDir = process.cwd();
	let projectDir: string | undefined;
	let scratchDir: string | undefined;
	let agentDir: string | undefined;
	let configDir: string | undefined;
	let runtimeDumpFile: string | undefined;
	let debugExtensionPath: string | undefined;

	try {
		projectDir = realpathSync(
			mkdtempSync(join(tmpdir(), "pi-runtime-snapshot-project-")),
		);
		scratchDir = mkdtempSync(join(tmpdir(), "pi-runtime-snapshot-"));
		agentDir = createIsolatedAgentDir(projectDir);
		configDir = join(agentDir, "agent-suite", "run-subagent");
		runtimeDumpFile = join(scratchDir, "runtime.json");
		debugExtensionPath = writeRuntimeDumpExtension(scratchDir);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify({ enabled: true, maxDepth: 1 }),
		);
		const childEnv: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_AGENT_SUITE_DIR: join(agentDir, "agent-suite"),
			PI_RUNTIME_DUMP_FILE: runtimeDumpFile,
		};
		delete childEnv[CHILD_AGENT_PROCESS_ENV];
		delete childEnv[SUBAGENT_AGENT_ID_ENV];
		delete childEnv[SUBAGENT_DEPTH_ENV];
		delete childEnv[SUBAGENT_TOOL_PATTERNS_ENV];
		const result = spawnSync(
			"pi",
			[
				"--no-session",
				"--no-extensions",
				"--model",
				RUNTIME_TEST_MODEL,
				"-p",
				"-e",
				join(repositoryDir, "pi-package"),
				"-e",
				debugExtensionPath,
				"capture isolated subagent runtime",
			],
			{
				cwd: projectDir,
				encoding: "utf8",
				env: childEnv,
				timeout: 30_000,
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.signal).toBeNull();
		expect(result.status).toBe(23);
		expect(`${result.stdout}\n${result.stderr}`).not.toMatch(
			PI_EXTENSION_ERROR_PATTERN,
		);
		const runtime = JSON.parse(
			readFileSync(runtimeDumpFile, "utf8"),
		) as RuntimeDump;
		const subagentTools = runtime.tools.filter(
			(name) => name.startsWith("subagent_") || name.endsWith("_subagent"),
		);
		expect(runtime.activeTools).toEqual([
			"subagent_start",
			"subagent_steer",
			"subagent_wait",
			"subagent_query",
		]);
		expect(subagentTools).toEqual([
			"subagent_start",
			"subagent_steer",
			"subagent_wait",
			"subagent_query",
		]);
		expect(runtime.systemPrompt).toContain("Test agent prompt");
		expect(runtime.systemPrompt).toContain(
			[
				'<available_subagents note="List of available subagent IDs">',
				'<agent id="SubAgentExtractor">',
				"Extractor &amp; verifier &lt;safe&gt;",
				"</agent>",
				"</available_subagents>",
			].join("\n"),
		);
		expect(runtime.systemPrompt).not.toContain('<agent id="SubAgentCoder">');
		expect(runtime.systemPrompt).not.toContain('<agent id="TestAgent">');
	} finally {
		if (agentDir !== undefined) {
			rmSync(agentDir, { recursive: true, force: true });
		}
		if (projectDir !== undefined) {
			rmSync(projectDir, { recursive: true, force: true });
		}
		if (scratchDir !== undefined) {
			rmSync(scratchDir, { recursive: true, force: true });
		}
		for (const temporaryPath of [
			configDir,
			agentDir,
			projectDir,
			debugExtensionPath,
			runtimeDumpFile,
			scratchDir,
		]) {
			if (temporaryPath !== undefined) {
				expect(existsSync(temporaryPath)).toBeFalse();
			}
		}
	}
});

test("runtime package loading snapshots configured subagent descriptions on the first turn", () => {
	// Purpose: real Pi must await extension and tool description configuration before its first model-visible snapshot.
	// Input and expected output: four absolute custom prompt files produce shared extension guidance and exactly four active subagent tools with matching configured descriptions.
	// Edge case: the debug extension exits from the first before_agent_start event after selecting the isolated model, before any network or authentication request.
	// Dependencies: local Pi CLI, isolated package config, selected main-agent restoration, production extension loading, and the provider-registering runtime dump extension.
	const repositoryDir = process.cwd();
	const projectDir = realpathSync(
		mkdtempSync(join(tmpdir(), "pi-runtime-description-project-")),
	);
	const scratchDir = mkdtempSync(
		join(tmpdir(), "pi-runtime-description-dump-"),
	);
	const agentDir = createIsolatedAgentDir(projectDir);
	const runtimeDumpFile = join(scratchDir, "runtime.json");
	const debugExtensionPath = writeRuntimeDumpExtension(scratchDir);
	const configDir = join(agentDir, "agent-suite", "run-subagent");
	mkdirSync(configDir, { recursive: true });
	const descriptionFiles = {
		extensionDescriptionPromptFile: join(scratchDir, "extension.md"),
		startDescriptionPromptFile: join(scratchDir, "start.md"),
		steerDescriptionPromptFile: join(scratchDir, "steer.md"),
		waitDescriptionPromptFile: join(scratchDir, "wait.md"),
	};
	writeFileSync(
		descriptionFiles.extensionDescriptionPromptFile,
		" real extension ",
	);
	writeFileSync(descriptionFiles.startDescriptionPromptFile, " real start ");
	writeFileSync(descriptionFiles.steerDescriptionPromptFile, " real steer ");
	writeFileSync(descriptionFiles.waitDescriptionPromptFile, " real wait ");
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({ enabled: true, maxDepth: 1, ...descriptionFiles }),
	);
	const childEnv: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_AGENT_SUITE_DIR: join(agentDir, "agent-suite"),
		PI_RUNTIME_DUMP_FILE: runtimeDumpFile,
	};
	delete childEnv[SUBAGENT_AGENT_ID_ENV];
	delete childEnv[SUBAGENT_DEPTH_ENV];
	delete childEnv[SUBAGENT_TOOL_PATTERNS_ENV];

	try {
		const result = spawnSync(
			"pi",
			[
				"--no-session",
				"--no-extensions",
				"--model",
				RUNTIME_TEST_MODEL,
				"-p",
				"-e",
				join(repositoryDir, "pi-package"),
				"-e",
				debugExtensionPath,
				"debug configured descriptions",
			],
			{
				cwd: projectDir,
				encoding: "utf8",
				env: childEnv,
				timeout: 30_000,
			},
		);

		expect(result.status).toBe(23);
		const runtime = JSON.parse(
			readFileSync(runtimeDumpFile, "utf8"),
		) as RuntimeDump;
		expect({
			activeTools: runtime.activeTools,
			subagentTools: runtime.tools.filter((name) =>
				name.startsWith("subagent_"),
			),
			hasExtensionDescription: runtime.systemPrompt.includes("real extension"),
			descriptions: {
				start: runtime.toolDescriptions["subagent_start"],
				steer: runtime.toolDescriptions["subagent_steer"],
				wait: runtime.toolDescriptions["subagent_wait"],
			},
		}).toEqual({
			activeTools: [
				"subagent_start",
				"subagent_steer",
				"subagent_wait",
				"subagent_query",
			],
			subagentTools: [
				"subagent_start",
				"subagent_steer",
				"subagent_wait",
				"subagent_query",
			],
			hasExtensionDescription: true,
			descriptions: {
				start: "real start",
				steer: "real steer",
				wait: "real wait",
			},
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
		rmSync(scratchDir, { recursive: true, force: true });
	}
});

test("runtime package loading applies system-prompt before agent runtime contributions", () => {
	// Purpose: real package load order must let system-prompt replace only the base prompt and keep selected-agent prompt additions after it.
	// Input and expected output: suite config points system-prompt to a temp Markdown template, and selected TestAgent still appears later.
	// Edge case: the extension must be registered before the shared runtime composition handler is created by agent-related extensions.
	// Dependencies: local pi CLI, isolated temp agent files, and a debug extension that exits before any model request.
	const repositoryDir = process.cwd();
	const projectDir = realpathSync(
		mkdtempSync(join(tmpdir(), "pi-runtime-system-project-")),
	);
	const scratchDir = mkdtempSync(join(tmpdir(), "pi-runtime-system-prompt-"));
	const agentDir = createIsolatedAgentDir(projectDir);
	const promptDumpFile = join(scratchDir, "system-prompt.txt");
	const debugExtensionPath = writePromptDumpExtension(scratchDir);
	const customTemplateFile = join(scratchDir, "system.md");
	mkdirSync(join(agentDir, "agent-suite", "system-prompt"), {
		recursive: true,
	});
	writeFileSync(
		customTemplateFile,
		"Suite system prompt\n\nTools:\n{{tools}}\n\n{{unknown-from-test}}",
	);
	writeFileSync(
		join(agentDir, "agent-suite", "system-prompt", "config.json"),
		JSON.stringify({ templateFile: customTemplateFile }),
	);
	const childEnv: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_AGENT_SUITE_DIR: join(agentDir, "agent-suite"),
		PI_PROMPT_DUMP_FILE: promptDumpFile,
	};
	delete childEnv[SUBAGENT_AGENT_ID_ENV];
	delete childEnv[SUBAGENT_DEPTH_ENV];
	delete childEnv[SUBAGENT_TOOL_PATTERNS_ENV];

	try {
		const result = spawnSync(
			"pi",
			[
				"--no-session",
				"--no-extensions",
				"--model",
				RUNTIME_TEST_MODEL,
				"-p",
				"-e",
				join(repositoryDir, "pi-package"),
				"-e",
				debugExtensionPath,
				"debug system prompt package order",
			],
			{
				cwd: projectDir,
				encoding: "utf8",
				env: childEnv,
				timeout: 30_000,
			},
		);

		expect(result.status).toBe(23);
		const prompt = readFileSync(promptDumpFile, "utf8");
		expect(prompt).toStartWith("Suite system prompt");
		expect(prompt).toContain("Test agent prompt");
		expect(prompt).not.toContain("{{unknown-from-test}}");
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
		rmSync(scratchDir, { recursive: true, force: true });
	}
});

test("runtime package loading exposes convene_council when enabled", () => {
	// Purpose: real pi package loading must register convene_council when the config opts in.
	// Input and expected output: enabled config exposes the tool when all tools are active.
	// Edge case: this test uses no selected main-agent allowlist that could hide the tool.
	// Dependencies: local pi CLI, isolated temp agent files, and a debug extension that exits before any model request.
	const repositoryDir = process.cwd();
	const projectDir = realpathSync(
		mkdtempSync(join(tmpdir(), "pi-runtime-council-project-")),
	);
	const scratchDir = mkdtempSync(join(tmpdir(), "pi-runtime-council-debug-"));
	const agentDir = mkdtempSync(join(tmpdir(), "pi-runtime-council-agent-"));
	const runtimeDumpFile = join(scratchDir, "runtime.json");
	const debugExtensionPath = writeRuntimeDumpExtension(scratchDir);
	const childEnv: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_AGENT_SUITE_DIR: join(agentDir, "agent-suite"),
		PI_RUNTIME_DUMP_FILE: runtimeDumpFile,
	};
	delete childEnv[SUBAGENT_AGENT_ID_ENV];
	delete childEnv[SUBAGENT_DEPTH_ENV];
	delete childEnv[SUBAGENT_TOOL_PATTERNS_ENV];

	try {
		const configDir = join(agentDir, "agent-suite", "convene-council");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify({ enabled: true }),
		);

		const result = spawnSync(
			"pi",
			[
				"--no-session",
				"--no-extensions",
				"--model",
				RUNTIME_TEST_MODEL,
				"-p",
				"-e",
				join(repositoryDir, "pi-package"),
				"-e",
				debugExtensionPath,
				"debug runtime dump",
			],
			{ cwd: projectDir, encoding: "utf8", env: childEnv, timeout: 30_000 },
		);

		expect(result.status).toBe(23);
		const runtime = JSON.parse(
			readFileSync(runtimeDumpFile, "utf8"),
		) as RuntimeDump;
		expect(runtime.tools).toContain("convene_council");
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
		rmSync(scratchDir, { recursive: true, force: true });
	}
});

const MAIN_WORKFLOW_POLICY_CASES = [
	{
		mode: "main",
		policyTools: ["workflow_activate", "workflow_transition"],
		projectsWorkflow: true,
		expectedWorkflowIds: ["delivery", "review"],
	},
	{
		mode: "main",
		policyTools: ["workflow_activate"],
		workflowPolicy: ["DELIVERY"],
		projectsWorkflow: true,
		expectedWorkflowIds: ["delivery"],
	},
	{
		mode: "main",
		policyTools: ["workflow_activate"],
		workflowPolicy: [],
		projectsWorkflow: false,
	},
	{ mode: "main", policyTools: ["read"], projectsWorkflow: false },
	{
		mode: "main-reset",
		policyTools: ["workflow_activate", "workflow_transition"],
		projectsWorkflow: false,
	},
] as const;

const CHILD_WORKFLOW_POLICY_CASES = [
	{
		mode: "child",
		policyTools: ["workflow_activate", "workflow_transition"],
		projectsWorkflow: true,
		expectedWorkflowIds: ["delivery", "review"],
	},
	{
		mode: "child",
		policyTools: ["workflow_transition"],
		workflowPolicy: ["REVIEW"],
		projectsWorkflow: true,
		expectedWorkflowIds: ["review"],
	},
	{
		mode: "child",
		policyTools: ["workflow_transition"],
		workflowPolicy: [],
		projectsWorkflow: false,
	},
	{ mode: "child", policyTools: ["read"], projectsWorkflow: false },
] as const;

type WorkflowPolicyCase =
	| (typeof MAIN_WORKFLOW_POLICY_CASES)[number]
	| (typeof CHILD_WORKFLOW_POLICY_CASES)[number];

/** Runs isolated real-Pi policy cases and checks active tools plus provider context. */
function verifyWorkflowPolicyCases(cases: readonly WorkflowPolicyCase[]): void {
	const repositoryDir = process.cwd();
	for (const runtimeCase of cases) {
		const projectDir = realpathSync(
			mkdtempSync(join(tmpdir(), "pi-workflow-policy-project-")),
		);
		const scratchDir = mkdtempSync(join(tmpdir(), "pi-workflow-policy-dump-"));
		const agentDir = createIsolatedAgentDir(projectDir);
		const suiteDir = join(agentDir, "agent-suite");
		const workflowDir = join(suiteDir, "workflow");
		const workflowsDir = join(workflowDir, "workflows");
		const runtimeDumpFile = join(scratchDir, "workflow-runtime.json");
		const debugExtensionPath = writeWorkflowRuntimeDumpExtension(
			scratchDir,
			runtimeCase.mode === "main-reset"
				? {
						runtimeCompositionUrl: pathToFileURL(
							join(
								repositoryDir,
								"pi-package/shared/agent-runtime-composition.ts",
							),
						).href,
						tools: ["read"],
					}
				: undefined,
		);
		const activatePromptFile = join(scratchDir, "activate.md");
		const transitionPromptFile = join(scratchDir, "transition.md");
		const extensionPromptFile = join(scratchDir, "extension.md");
		mkdirSync(workflowsDir, { recursive: true });
		const workflowYaml =
			"stages:\n  - id: start\n    description: Start\n    prompt: Start work\n    initial: true\n  - id: done\n    description: Done\n    prompt: Finish work\n    final: true\ntransitions:\n  - from: start\n    to: done\n    type: advance\n";
		writeFileSync(
			join(workflowsDir, "delivery.yaml"),
			`description: Runtime delivery\n${workflowYaml}`,
		);
		writeFileSync(
			join(workflowsDir, "review.yaml"),
			`description: Runtime review\n${workflowYaml}`,
		);
		writeFileSync(activatePromptFile, "WORKFLOW_ACTIVATE_RUNTIME_DESCRIPTION");
		writeFileSync(
			transitionPromptFile,
			"WORKFLOW_TRANSITION_RUNTIME_DESCRIPTION",
		);
		writeFileSync(extensionPromptFile, "WORKFLOW_RUNTIME_GUIDELINES");
		writeFileSync(
			join(workflowDir, "config.json"),
			JSON.stringify({
				extensionDescriptionPromptFile: extensionPromptFile,
				activateDescriptionPromptFile: activatePromptFile,
				transitionDescriptionPromptFile: transitionPromptFile,
			}),
		);

		if (runtimeCase.mode === "main" || runtimeCase.mode === "main-reset") {
			writeAgent(
				agentDir,
				"TestAgent.md",
				[
					"---",
					"description: Workflow main policy",
					"type: main",
					`tools: ${JSON.stringify(runtimeCase.policyTools)}`,
					...("workflowPolicy" in runtimeCase
						? [`workflows: ${JSON.stringify(runtimeCase.workflowPolicy)}`]
						: []),
					"---",
					"Workflow main prompt",
				].join("\n"),
			);
		}
		if (runtimeCase.mode === "child" && "workflowPolicy" in runtimeCase) {
			writeAgent(
				agentDir,
				"SubAgentExtractor.md",
				[
					"---",
					"description: Workflow child policy",
					"type: subagent",
					`workflows: ${JSON.stringify(runtimeCase.workflowPolicy)}`,
					"---",
					"Workflow child prompt",
				].join("\n"),
			);
		}

		const childEnv: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_AGENT_SUITE_DIR: suiteDir,
			PI_WORKFLOW_RUNTIME_DUMP_FILE: runtimeDumpFile,
		};
		if (runtimeCase.mode === "child") {
			childEnv[CHILD_AGENT_PROCESS_ENV] = "1";
			childEnv[SUBAGENT_AGENT_ID_ENV] = "SubAgentExtractor";
			childEnv[SUBAGENT_DEPTH_ENV] = "0";
			childEnv[SUBAGENT_TOOL_PATTERNS_ENV] = JSON.stringify(
				runtimeCase.policyTools,
			);
			if ("workflowPolicy" in runtimeCase) {
				childEnv[SUBAGENT_WORKFLOW_IDS_ENV] = JSON.stringify(
					"expectedWorkflowIds" in runtimeCase
						? runtimeCase.expectedWorkflowIds
						: [],
				);
			} else {
				delete childEnv[SUBAGENT_WORKFLOW_IDS_ENV];
			}
		} else {
			delete childEnv[CHILD_AGENT_PROCESS_ENV];
			delete childEnv[SUBAGENT_AGENT_ID_ENV];
			delete childEnv[SUBAGENT_DEPTH_ENV];
			delete childEnv[SUBAGENT_TOOL_PATTERNS_ENV];
			delete childEnv[SUBAGENT_WORKFLOW_IDS_ENV];
		}

		try {
			const result = spawnSync(
				"pi",
				[
					"--no-session",
					"--no-extensions",
					"--model",
					RUNTIME_TEST_MODEL,
					"-p",
					"-e",
					join(repositoryDir, "pi-package"),
					"-e",
					debugExtensionPath,
					"capture workflow policy runtime",
				],
				{
					cwd: projectDir,
					encoding: "utf8",
					env: childEnv,
					timeout: 30_000,
				},
			);
			expect(result.error).toBeUndefined();
			expect(result.signal).toBeNull();
			expect(result.status).toBe(23);
			expect(`${result.stdout}\n${result.stderr}`).not.toMatch(
				PI_EXTENSION_ERROR_PATTERN,
			);
			const runtime = JSON.parse(
				readFileSync(runtimeDumpFile, "utf8"),
			) as WorkflowRuntimeDump;
			const workflowMessages = runtime.contextMessages.filter(
				(message) => message.customType === "workflow",
			);
			const expectedWorkflowTools =
				runtimeCase.mode === "main-reset" || !runtimeCase.projectsWorkflow
					? []
					: runtimeCase.policyTools.filter((name) =>
							name.startsWith("workflow_"),
						);
			for (const [name, description] of [
				["workflow_activate", "WORKFLOW_ACTIVATE_RUNTIME_DESCRIPTION"],
				["workflow_transition", "WORKFLOW_TRANSITION_RUNTIME_DESCRIPTION"],
			] as const) {
				if (expectedWorkflowTools.includes(name)) {
					expect(runtime.activeTools).toContain(name);
					expect(runtime.activeToolDescriptions[name]).toBe(description);
				} else {
					expect(runtime.activeTools).not.toContain(name);
					expect(runtime.activeToolDescriptions[name]).toBeUndefined();
				}
			}
			if (runtimeCase.projectsWorkflow) {
				expect(workflowMessages).toHaveLength(1);
				expect(String(workflowMessages[0]?.content)).toContain(
					"WORKFLOW_RUNTIME_GUIDELINES",
				);
				const workflowContent = String(workflowMessages[0]?.content);
				if (expectedWorkflowTools.includes("workflow_activate")) {
					expect(workflowContent).toContain("<workflow_activation_options>");
					const expectedWorkflowIds = new Set<string>(
						"expectedWorkflowIds" in runtimeCase
							? runtimeCase.expectedWorkflowIds
							: [],
					);
					for (const workflowId of ["delivery", "review"]) {
						if (expectedWorkflowIds.has(workflowId)) {
							expect(workflowContent).toContain(`id="${workflowId}"`);
						} else {
							expect(workflowContent).not.toContain(`id="${workflowId}"`);
						}
					}
				} else {
					expect(workflowContent).not.toContain("<workflow_activation_options");
				}
			} else {
				expect(workflowMessages).toHaveLength(0);
				expect(JSON.stringify(runtime.contextMessages)).not.toContain(
					"<workflow_",
				);
			}
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(projectDir, { recursive: true, force: true });
			rmSync(scratchDir, { recursive: true, force: true });
		}
	}
}

/** Proves main-agent single, combined, absent, and post-start reset policies. */
test("workflow visibility follows real main-agent tool policy", () => {
	verifyWorkflowPolicyCases(MAIN_WORKFLOW_POLICY_CASES);
}, 30_000);

/** Proves child single, combined, and absent policies before provider access. */
test("workflow visibility follows real child tool policy", () => {
	verifyWorkflowPolicyCases(CHILD_WORKFLOW_POLICY_CASES);
}, 30_000);
