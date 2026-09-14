import { afterEach, describe, expect, test } from "bun:test";
import { SUBAGENT_ROOT_SESSION_ID_ENV } from "../../shared/subagent-environment";
import { readUsageProcessEnvironment } from "./environment";

const originalRootSessionId = process.env[SUBAGENT_ROOT_SESSION_ID_ENV];

afterEach(() => {
	if (originalRootSessionId === undefined) {
		delete process.env[SUBAGENT_ROOT_SESSION_ID_ENV];
		return;
	}
	process.env[SUBAGENT_ROOT_SESSION_ID_ENV] = originalRootSessionId;
});

describe("usage process environment", () => {
	test("reads the inherited root session identity for child attribution", () => {
		// Purpose: the default usage runtime must receive the root identity propagated by Subagents.
		// Inputs and expected output: one root-session environment value appears in the isolated usage environment snapshot.
		// Edge case: the snapshot uses the dedicated root field rather than the child own-session field.
		// Dependencies: the shared Subagents environment contract and process-local test environment.
		process.env[SUBAGENT_ROOT_SESSION_ID_ENV] = "root-session";

		expect(readUsageProcessEnvironment()[SUBAGENT_ROOT_SESSION_ID_ENV]).toBe(
			"root-session",
		);
	});
});
