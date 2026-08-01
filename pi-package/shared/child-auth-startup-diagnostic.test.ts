import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChildAuthStartupAttemptRecord } from "./child-auth-startup";
import {
	CHILD_AUTH_STARTUP_DIAGNOSTIC_CUSTOM_TYPE,
	createChildAuthStartupDiagnosticRecorder,
} from "./child-auth-startup-diagnostic";

const ATTEMPT: ChildAuthStartupAttemptRecord = {
	owner: "run-subagent",
	provider: "openai-codex",
	attempt: 2,
	totalAttempts: 11,
	stage: "child_prompt",
	promptAccepted: false,
	decision: "retry",
	reason: "prompt_auth_unavailable",
	durationMs: 180,
};

describe("child startup diagnostic recorder", () => {
	test("persists only the safe structured attempt record", () => {
		// Purpose: authentication recovery evidence must use Pi session diagnostics instead of process output.
		// Input and expected output: one attempt is appended under the dedicated custom entry type.
		// Edge case: the persisted object is a copy that cannot mutate the shared attempt history.
		// Dependencies: an isolated ExtensionAPI appendEntry fake.
		const entries: Array<{ type: string; data: unknown }> = [];
		const recorder = createChildAuthStartupDiagnosticRecorder({
			appendEntry(type: string, data?: unknown): void {
				entries.push({ type, data });
			},
		} as Pick<ExtensionAPI, "appendEntry">);

		recorder(ATTEMPT);

		expect(entries).toEqual([
			{
				type: CHILD_AUTH_STARTUP_DIAGNOSTIC_CUSTOM_TYPE,
				data: { ...ATTEMPT },
			},
		]);
		expect(entries[0]?.data).not.toBe(ATTEMPT);
	});

	test("does not change startup behavior when session persistence fails", () => {
		// Purpose: diagnostics must remain observational and never block authentication recovery.
		// Input and expected output: an appendEntry failure is contained by the recorder.
		// Edge case: no fallback output is written to stderr or another sink.
		// Dependencies: an isolated throwing ExtensionAPI appendEntry fake.
		const recorder = createChildAuthStartupDiagnosticRecorder({
			appendEntry(): void {
				throw new Error("session is read-only");
			},
		} as Pick<ExtensionAPI, "appendEntry">);

		expect(() => recorder(ATTEMPT)).not.toThrow();
	});
});
