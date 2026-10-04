import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTempDir } from "../support/temp-dir";

// Pi loads shared modules separately for each extension, so an actual CLI run proves reporter sharing.
test.each([
	{ extensions: ["main-agent-selection"] },
	{ extensions: ["run-subagent"] },
	{ extensions: ["main-agent-selection", "run-subagent"] },
])("Pi reports a broken agent once with extensions %j", ({ extensions }) => {
	const temporary = createTempDir("pi-agent-registry-warnings-");
	try {
		const agentDir = join(temporary.path, "agent");
		const suiteDir = join(agentDir, "agent-suite");
		const agentsDir = join(suiteDir, "agent-selection", "agents");
		const cwd = join(temporary.path, "project");
		mkdirSync(agentsDir, { recursive: true });
		mkdirSync(cwd);
		const file = join(agentsDir, "Broken.md");
		writeFileSync(file, '---\ntools: [read,\n"bash"]\n---\n');
		writeFileSync(join(agentsDir, "Valid.md"), "---\ntype: both\n---\n");
		const result = spawnSync(
			"pi",
			[
				"--offline",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-session",
				"-p",
				...extensions.flatMap((extension) => [
					"-e",
					resolve("pi-package", "extensions", extension, "index.ts"),
				]),
			],
			{
				cwd,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: agentDir,
					PI_AGENT_SUITE_DIR: suiteDir,
				},
				input: "",
				encoding: "utf8",
				timeout: 20_000,
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stderr.match(/invalid agent definition/g)).toHaveLength(1);
		expect(result.stderr).toContain(file);
		expect(result.stderr).toContain("indented");
	} finally {
		temporary.remove();
	}
}, 25_000);
