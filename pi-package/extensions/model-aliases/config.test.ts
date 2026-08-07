import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_SUITE_DIR_ENV } from "../../shared/agent-suite-storage";
import {
	resolveModelSettingsWithAliases,
	resolveModelSettingsWithAliasesSync,
} from "./config";

describe("model aliases config", () => {
	let suiteDir = "";
	let previousSuiteDir: string | undefined;

	beforeEach(() => {
		previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
		suiteDir = mkdtempSync(join(tmpdir(), "model-aliases-config-"));
		process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
	});

	afterEach(() => {
		if (previousSuiteDir === undefined) {
			delete process.env[AGENT_SUITE_DIR_ENV];
		} else {
			process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
		}
		rmSync(suiteDir, { recursive: true, force: true });
	});

	test("keeps direct provider/model settings unchanged", async () => {
		// Purpose: explicit provider/model IDs must keep existing behavior without alias config.
		// Input and expected output: direct model ID with explicit thinking resolves unchanged.
		// Edge case: missing alias config directory must not fail resolution.
		// Dependencies: isolated suite directory with no model-aliases config.
		expect(
			await resolveModelSettingsWithAliases({
				id: "openai-codex/gpt-5.6-sol",
				thinking: "medium",
			}),
		).toEqual({
			settings: { id: "openai-codex/gpt-5.6-sol", thinking: "medium" },
		});
		expect(
			resolveModelSettingsWithAliasesSync({
				id: "openai-codex/gpt-5.6-sol",
				thinking: "medium",
			}),
		).toEqual({
			settings: { id: "openai-codex/gpt-5.6-sol", thinking: "medium" },
		});
	});

	test("resolves aliases and applies alias thinking when explicit thinking is absent", async () => {
		// Purpose: alias-only model IDs must resolve into real provider/model IDs before runtime usage.
		// Input and expected output: alias `analyst-complex` resolves model ID and alias thinking.
		// Edge case: async and sync resolvers must return the same resolved settings.
		// Dependencies: suite-owned model-aliases config file.
		const aliasesDir = join(suiteDir, "model-aliases");
		mkdirSync(aliasesDir, { recursive: true });
		writeFileSync(
			join(aliasesDir, "config.json"),
			JSON.stringify({
				"analyst-complex": {
					id: "openai-codex/gpt-5.6-sol",
					thinking: "medium",
				},
			}),
		);

		expect(
			await resolveModelSettingsWithAliases({ id: "analyst-complex" }),
		).toEqual({
			settings: { id: "openai-codex/gpt-5.6-sol", thinking: "medium" },
		});
		expect(
			resolveModelSettingsWithAliasesSync({ id: "analyst-complex" }),
		).toEqual({
			settings: { id: "openai-codex/gpt-5.6-sol", thinking: "medium" },
		});
	});

	test("keeps explicit thinking over alias thinking", async () => {
		// Purpose: call-site thinking overrides must preserve existing explicit configuration priority.
		// Input and expected output: alias with explicit `high` thinking keeps `high` while resolving model ID.
		// Edge case: alias defines a different thinking level that must not override explicit config.
		// Dependencies: suite-owned model-aliases config file.
		const aliasesDir = join(suiteDir, "model-aliases");
		mkdirSync(aliasesDir, { recursive: true });
		writeFileSync(
			join(aliasesDir, "config.json"),
			JSON.stringify({
				assistant: {
					id: "openai-codex/gpt-5.6-sol",
					thinking: "medium",
				},
			}),
		);

		expect(
			await resolveModelSettingsWithAliases({
				id: "assistant",
				thinking: "high",
			}),
		).toEqual({
			settings: { id: "openai-codex/gpt-5.6-sol", thinking: "high" },
		});
	});

	test("returns issues for unknown aliases and invalid alias config", async () => {
		// Purpose: alias resolution must fail closed when alias is unknown or config is invalid.
		// Input and expected output: unknown alias returns not-found issue; malformed config returns parse issue.
		// Edge case: malformed config must fail before alias lookup.
		// Dependencies: suite-owned model-aliases config file rewritten between assertions.
		const aliasesDir = join(suiteDir, "model-aliases");
		mkdirSync(aliasesDir, { recursive: true });
		writeFileSync(
			join(aliasesDir, "config.json"),
			JSON.stringify({
				known: { id: "openai-codex/gpt-5.6-sol" },
			}),
		);
		expect(await resolveModelSettingsWithAliases({ id: "unknown" })).toEqual({
			issue: "model alias unknown was not found",
		});

		writeFileSync(join(aliasesDir, "config.json"), "{ invalid json");
		const invalid = await resolveModelSettingsWithAliases({ id: "known" });
		expect("issue" in invalid).toBe(true);
	});
});
