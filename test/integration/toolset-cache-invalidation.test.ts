import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createTempDir } from "../support/temp-dir";
import type { CacheSessionOutcome } from "../support/toolset-cache-session";

/** Creates isolated native Pi state and selects the process role for the fixture. */
function childEnvironment(root: string, child: boolean): NodeJS.ProcessEnv {
	return {
		...Object.fromEntries(
			Object.entries(process.env).filter(
				([name]) =>
					!name.startsWith("PI_SUBAGENT_") &&
					name !== "PI_AGENT_SUITE_CHILD_AGENT_PROCESS",
			),
		),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_AGENT_SUITE_DIR: join(root, "suite"),
		PI_AGENT_SUITE_CHILD_AGENT_PROCESS: child ? "1" : undefined,
	};
}

/** Executes one native-session phase in a fresh process with isolated state. */
function runSession(
	root: string,
	provider: string,
	child: boolean,
	savedFile?: string,
): CacheSessionOutcome {
	const result = spawnSync(
		"bun",
		[
			"run",
			"test/support/toolset-cache-session.ts",
			root,
			provider,
			savedFile ? "resumed" : "initial",
			...(savedFile ? [savedFile] : []),
		],
		{
			env: childEnvironment(root, child),
			encoding: "utf8",
			timeout: 30_000,
		},
	);
	if (result.status !== 0) {
		throw new Error(`${result.stdout}\n${result.stderr}`);
	}
	return JSON.parse(result.stdout) as CacheSessionOutcome;
}

for (const provider of ["openai", "openai-codex"] as const) {
	for (const child of [false, true]) {
		test(`${provider} ${child ? "child" : "main"} preserves real session request prefixes through activation and resume`, () => {
			const temporary = createTempDir("pi-toolset-native-prefix-");
			try {
				const initial = runSession(temporary.path, provider, child);
				const resumed = runSession(
					temporary.path,
					provider,
					child,
					initial.sessionFile,
				);
				expect(initial.errors).toEqual([]);
				expect(resumed.errors).toEqual([]);
				expect(initial.activations).toBe(1);
				expect(resumed.activations).toBe(0);
				expect(initial.executions).toEqual(["files_read", "files_write"]);
				expect(resumed.executions).toEqual(["files_read"]);
				expect(initial.knowledgeReads).toBeGreaterThan(0);
				expect(resumed.knowledgeReads).toBeGreaterThan(0);
				expect(resumed.sessionFile).toBe(initial.sessionFile);
				expect(initial.requests).toHaveLength(5);
				expect(resumed.requests).toHaveLength(2);
				const requests = [...initial.requests, ...resumed.requests];
				expect(requests[0]?.toolNames).toEqual(["activate_toolset"]);
				for (const request of requests.slice(1)) {
					expect(request.toolNames).toContain("files_read");
					expect(request.toolNames).toContain("files_write");
					expect(request.toolNames).not.toContain("activate_toolset");
				}
				for (let index = 1; index < requests.length; index += 1) {
					const previous = requests[index - 1]?.payload;
					const current = requests[index]?.payload;
					if (!previous || !current) {
						throw new Error("Missing serialized native request");
					}
					expect(current.input.slice(0, previous.input.length)).toEqual(
						previous.input,
					);
					expect(current.input.length).toBeGreaterThan(previous.input.length);
					const { input: _previousInput, ...previousLeading } = previous;
					const { input: _currentInput, ...currentLeading } = current;
					expect(currentLeading).toEqual(previousLeading);
				}
			} finally {
				temporary.remove();
			}
		}, 40_000);
	}
}
