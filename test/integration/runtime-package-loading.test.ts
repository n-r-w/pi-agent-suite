import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SELECTED_AGENT_STATE_HASH_ENCODING = "hex";

/** Writes one markdown agent definition into the isolated pi agent directory. */
function writeAgent(agentDir: string, fileName: string, content: string): void {
	writeFileSync(join(agentDir, "agents", fileName), content);
}

/** Returns the hash-based selected-agent state file name for one normalized working directory. */
function selectedAgentStateFileName(cwd: string): string {
	return `${createHash("sha256").update(cwd).digest(SELECTED_AGENT_STATE_HASH_ENCODING)}.json`;
}

/** Creates an isolated pi agent directory with selected TestAgent state. */
function createIsolatedAgentDir(cwd: string): string {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-runtime-package-"));
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	mkdirSync(join(agentDir, "agent-selection", "state"), { recursive: true });
	writeFileSync(
		join(agentDir, "agent-selection", "state", selectedAgentStateFileName(cwd)),
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

test("runtime package loading keeps selected-agent allowlist across split entries", () => {
	// Purpose: real pi package loading must keep main-agent-selection and run-subagent in one runtime composition.
	// Input and expected output: selected TestAgent allows only SubAgentExtractor, so the final prompt lists only SubAgentExtractor.
	// Edge case: pi loads package entries separately; disconnected shared state would expose SubAgentCoder and TestAgent too.
	// Dependencies: this integration check uses the local pi CLI, isolated temp agent files, and a debug extension that exits before any model request.
	const cwd = process.cwd();
	const scratchDir = mkdtempSync(join(tmpdir(), "pi-runtime-package-debug-"));
	const agentDir = createIsolatedAgentDir(cwd);
	const promptDumpFile = join(scratchDir, "system-prompt.txt");
	const debugExtensionPath = writePromptDumpExtension(scratchDir);

	try {
		const result = spawnSync(
			"pi",
			[
				"--no-session",
				"--offline",
				"--no-extensions",
				"-p",
				"-e",
				join(cwd, "pi-package"),
				"-e",
				debugExtensionPath,
				"debug prompt dump",
			],
			{
				cwd,
				encoding: "utf8",
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: agentDir,
					PI_PROMPT_DUMP_FILE: promptDumpFile,
				},
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
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(scratchDir, { recursive: true, force: true });
	}
});
