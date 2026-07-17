import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SELECTED_AGENT_STATE_HASH_ENCODING = "hex";
const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";
const SUBAGENT_AGENT_ID_ENV = "PI_SUBAGENT_AGENT_ID";
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_TOOL_PATTERNS_ENV = "PI_SUBAGENT_TOOL_PATTERNS";

interface RuntimeDump {
	readonly activeTools: readonly string[];
	readonly tools: readonly string[];
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
			"description: Extractor",
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
			'tools: ["run_subagent"]',
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

/** Writes a debug extension that exits after dumping loaded tools and final system prompt. */
function writeRuntimeDumpExtension(directory: string): string {
	const extensionPath = join(directory, "dump-runtime.ts");
	writeFileSync(
		extensionPath,
		[
			'import { writeFileSync } from "node:fs";',
			"",
			"export default function dumpRuntime(pi) {",
			'\tpi.on("before_agent_start", (event) => {',
			"\t\tconst dumpFile = process.env.PI_RUNTIME_DUMP_FILE;",
			'\t\tif (dumpFile === undefined) throw new Error("PI_RUNTIME_DUMP_FILE is required");',
			"\t\twriteFileSync(dumpFile, JSON.stringify({",
			"\t\t\tactiveTools: pi.getActiveTools(),",
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
	// Purpose: real pi package loading must keep main-agent-selection and run-subagent in one runtime composition.
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
			"- agentId: SubAgentExtractor\n  description: Extractor",
		);
		expect(prompt).not.toContain("- agentId: SubAgentCoder");
		expect(prompt).not.toContain("- agentId: TestAgent");
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

test("runtime child loading uses the project agent override", () => {
	// Purpose: real child Pi must preserve its full catalog while applying only its independently transported active-tool policy.
	// Input and expected output: project SubAgentExtractor contributes its prompt, the catalog retains bash, and active tools equal read.
	// Edge case: the child agent ID keeps global casing while the project override and tool policy remain independent of caller tools.
	// Dependencies: local Pi CLI, isolated agent files, package lifecycle handlers, and a debug extension that exits before model access.
	const repositoryDir = process.cwd();
	const projectDir = realpathSync(
		mkdtempSync(join(tmpdir(), "pi-runtime-project-agents-")),
	);
	const scratchDir = mkdtempSync(join(tmpdir(), "pi-runtime-project-dump-"));
	const agentDir = createIsolatedAgentDir(projectDir);
	const runtimeDumpFile = join(scratchDir, "runtime.json");
	const debugExtensionPath = writeRuntimeDumpExtension(scratchDir);
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
		[SUBAGENT_TOOL_PATTERNS_ENV]: JSON.stringify(["read"]),
	};

	try {
		const result = spawnSync(
			"pi",
			[
				"--no-session",
				"--no-extensions",
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
		expect(runtime.tools).toContain("bash");
		expect(runtime.activeTools).toEqual(["read"]);
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
