import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	AGENT_SUITE_DIR_ENV,
	getAgentSuiteDir,
} from "./agent-suite-storage.ts";
import { expandHomePath } from "./path-expansion.ts";

const HOME_DIRECTORY = "/test/home";

describe("home path expansion", () => {
	test.each([
		["~", HOME_DIRECTORY],
		["~/path", `${HOME_DIRECTORY}/path`],
		["$HOME", HOME_DIRECTORY],
		["$HOME/path", `${HOME_DIRECTORY}/path`],
		[`\${HOME}`, HOME_DIRECTORY],
		[`\${HOME}/path`, `${HOME_DIRECTORY}/path`],
	])("expands the supported home prefix in %s", (input, expected) => {
		// Purpose: all public home-path spellings must resolve through one deterministic contract.
		// Input and expected output: a supported prefix becomes the injected home directory.
		// Edge cases: exact aliases and aliases followed by a path segment are both covered.
		// Dependencies: the injected directory avoids the process environment and real user files.
		expect(expandHomePath(input, HOME_DIRECTORY)).toBe(expected);
	});

	test.each([
		"~/suite",
		"$HOME/suite",
		`\${HOME}/suite`,
	])("expands PI_AGENT_SUITE_DIR value %s", (configuredDirectory) => {
		// Purpose: every extension must find its suite root through the shared home-path contract.
		// Input and expected output: a home-prefixed suite environment value becomes an absolute path.
		// Edge case: all supported home alias spellings are covered without accessing the directory.
		// Dependencies: only PI_AGENT_SUITE_DIR is restored; HOME and user files are not changed.
		const previousDirectory = process.env[AGENT_SUITE_DIR_ENV];
		try {
			process.env[AGENT_SUITE_DIR_ENV] = configuredDirectory;
			expect(getAgentSuiteDir()).toBe(join(homedir(), "suite"));
		} finally {
			if (previousDirectory === undefined) {
				delete process.env[AGENT_SUITE_DIR_ENV];
			} else {
				process.env[AGENT_SUITE_DIR_ENV] = previousDirectory;
			}
		}
	});

	test.each([
		"",
		"relative/path",
		"/absolute/path",
		"~other/path",
		"$HOMEother/path",
		`\${OTHER}/path`,
		"prefix/$HOME/path",
	])("preserves unsupported or non-prefix input %s", (input) => {
		// Purpose: expansion must not become general shell interpolation.
		// Input and expected output: unsupported or misplaced aliases remain byte-for-byte unchanged.
		// Edge cases: similar names, another variable, and a non-leading alias are covered.
		// Dependencies: this is a pure function test with no filesystem access.
		expect(expandHomePath(input, HOME_DIRECTORY)).toBe(input);
	});
});
