import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import {
	addPendingProjectionSavings,
	type ContextProjectionConfig,
	estimatePendingProjectionSavings,
	getProjectionAwareContextUsage,
	type MappedContextEntry,
	projectContextMessages,
	replayContextProjection,
	resetPendingProjectionSavings,
	setPendingProjectionSavings,
} from "../../pi-package/shared/context-projection";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";
const CUSTOM_TYPE = "context-projection";
const PLACEHOLDER = "[projected]";
const PROJECTION_CONFIG: ContextProjectionConfig = {
	enabled: true,
	projectionRemainingTokens: 100_000,
	keepRecentTurns: 0,
	keepRecentTurnsPercent: 0,
	minToolResultTokens: 0,
	projectionIgnoredTools: [],
	placeholder: PLACEHOLDER,
	summary: {
		enabled: false,
		maxConcurrency: 1,
		retryCount: 1,
		retryDelayMs: 0,
	},
};

/** Runs a test with an isolated pi agent directory. */
async function withIsolatedAgentDir<T>(
	action: (agentDir: string) => Promise<T>,
): Promise<T> {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const previousAgentSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
	const agentDir = await mkdtemp(join(tmpdir(), "pi-projection-replay-"));
	process.env[AGENT_DIR_ENV] = agentDir;
	delete process.env[AGENT_SUITE_DIR_ENV];
	try {
		return await action(agentDir);
	} finally {
		restoreEnv(AGENT_DIR_ENV, previousAgentDir);
		restoreEnv(AGENT_SUITE_DIR_ENV, previousAgentSuiteDir);
		await rm(agentDir, { recursive: true, force: true });
	}
}

/** Restores an environment variable to its previous value. */
function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		return;
	}
	process.env[key] = value;
}

/** Writes context-projection config into the isolated agent directory. */
async function writeProjectionConfig(
	agentDir: string,
	config: unknown,
): Promise<void> {
	await mkdir(join(agentDir, "config"), { recursive: true });
	await writeFile(
		join(agentDir, "config", "context-projection.json"),
		JSON.stringify(config),
	);
}

/** Creates a session message entry for projection replay tests. */
function messageEntry(
	id: string,
	message: AgentMessage,
	parentId: string | null,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "t",
		message,
	} as SessionEntry;
}

/** Creates a projection state entry matching the persisted context-projection contract. */
function projectionStateEntry(
	id: string,
	entryId: string,
	placeholder: string,
	parentId: string | null,
): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: "t",
		customType: CUSTOM_TYPE,
		data: { projectedEntries: [{ entryId, placeholder }] },
	} as SessionEntry;
}

/** Creates a user message. */
function userMessage(text = "hello"): AgentMessage {
	return { role: "user", content: text, timestamp: 1 };
}

/** Creates an assistant tool-call message. */
function assistantMessage(
	toolCallId: string,
	toolName = "bash",
): Extract<AgentMessage, { role: "assistant" }> {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: toolCallId,
				name: toolName,
				arguments: {},
			},
		],
		api: "openai-responses",
		provider: "openai",
		model: "main",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

/** Creates a successful text tool result. */
function toolResultMessage(
	toolCallId: string,
	text: string,
	toolName = "bash",
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3,
	};
}

describe("projection-aware context usage", () => {
	test("subtracts only pending projection savings from known context usage", () => {
		// Purpose: UI and overflow checks must show provider-context size while provider usage is stale after projection.
		// Input and expected output: 48k pending savings turns raw 130k usage into 82k and recomputes percent.
		// Edge case: pending savings larger than raw tokens clamps usage to zero.
		// Dependencies: in-memory runtime projection state only.
		const sessionId = "projection-aware-usage";
		resetPendingProjectionSavings(sessionId);
		addPendingProjectionSavings(sessionId, 48_000, {
			branchLeafId: "leaf-1",
			entryIds: ["entry-1"],
		});

		expect(
			getProjectionAwareContextUsage(sessionId, {
				tokens: 130_000,
				contextWindow: 272_000,
				percent: 47.79,
			}),
		).toEqual({
			tokens: 82_000,
			contextWindow: 272_000,
			percent: (82_000 / 272_000) * 100,
		});

		addPendingProjectionSavings(sessionId, 100_000, {
			branchLeafId: "leaf-1",
			entryIds: ["entry-2"],
		});
		expect(
			getProjectionAwareContextUsage(sessionId, {
				tokens: 90_000,
				contextWindow: 272_000,
				percent: (90_000 / 272_000) * 100,
			}),
		).toEqual({ tokens: 0, contextWindow: 272_000, percent: 0 });
		resetPendingProjectionSavings(sessionId);
	});

	test("preserves live pending savings during branch sync and deduplicates them after persistence", () => {
		// Purpose: context sync must not lose a live projection before its custom entry is visible in the branch.
		// Input and expected output: a live 48k saving remains after empty branch sync, then branch-backed sync for the same entry still subtracts 48k only once.
		// Edge case: branch synchronization runs between provider context projection and custom entry visibility.
		// Dependencies: in-memory runtime projection state only.
		const sessionId = "projection-aware-live-sync";
		resetPendingProjectionSavings(sessionId);
		addPendingProjectionSavings(sessionId, 48_000, {
			branchLeafId: "leaf-1",
			entryIds: ["entry-1"],
		});

		setPendingProjectionSavings(sessionId, 0, [], new Set(["leaf-1"]));
		expect(
			getProjectionAwareContextUsage(sessionId, {
				tokens: 130_000,
				contextWindow: 272_000,
				percent: (130_000 / 272_000) * 100,
			}),
		).toEqual({
			tokens: 82_000,
			contextWindow: 272_000,
			percent: (82_000 / 272_000) * 100,
		});

		setPendingProjectionSavings(
			sessionId,
			48_000,
			["entry-1"],
			new Set(["leaf-1"]),
		);
		expect(
			getProjectionAwareContextUsage(sessionId, {
				tokens: 130_000,
				contextWindow: 272_000,
				percent: (130_000 / 272_000) * 100,
			}),
		).toEqual({
			tokens: 82_000,
			contextWindow: 272_000,
			percent: (82_000 / 272_000) * 100,
		});
		resetPendingProjectionSavings(sessionId);
	});

	test("clears live pending savings when branch sync moves to another branch", () => {
		// Purpose: live pending savings from one branch must not undercount context usage after tree navigation.
		// Input and expected output: a live 48k saving anchored to branch A is removed when branch sync observes branch B.
		// Edge case: branch B has no persisted pending projection state yet uses the same session id.
		// Dependencies: in-memory runtime projection state only.
		const sessionId = "projection-aware-branch-sync";
		resetPendingProjectionSavings(sessionId);
		addPendingProjectionSavings(sessionId, 48_000, {
			branchLeafId: "leaf-a",
			entryIds: ["entry-a"],
		});

		setPendingProjectionSavings(sessionId, 0, [], new Set(["leaf-b"]));
		expect(
			getProjectionAwareContextUsage(sessionId, {
				tokens: 130_000,
				contextWindow: 272_000,
				percent: (130_000 / 272_000) * 100,
			}),
		).toEqual({
			tokens: 130_000,
			contextWindow: 272_000,
			percent: (130_000 / 272_000) * 100,
		});
		resetPendingProjectionSavings(sessionId);
	});

	test("keeps unknown context usage unknown while projection savings are pending", () => {
		// Purpose: pending projection savings must not invent a token count when pi reports unknown usage.
		// Input and expected output: null tokens stay null after pending savings are recorded.
		// Edge case: post-compaction unknown usage uses the same null shape.
		// Dependencies: in-memory runtime projection state only.
		const sessionId = "projection-aware-null-usage";
		resetPendingProjectionSavings(sessionId);
		addPendingProjectionSavings(sessionId, 48_000, {
			branchLeafId: "leaf-1",
			entryIds: ["entry-1"],
		});

		expect(
			getProjectionAwareContextUsage(sessionId, {
				tokens: null,
				contextWindow: 272_000,
				percent: null,
			}),
		).toEqual({ tokens: null, contextWindow: 272_000, percent: null });
		resetPendingProjectionSavings(sessionId);
	});

	test("estimates pending savings only for projection state after the latest valid assistant usage", () => {
		// Purpose: session reload must preserve the stale-usage correction only when provider usage has not caught up.
		// Input and expected output: projection state after latest successful usage is pending; a later successful assistant clears it.
		// Edge case: error assistant messages after projection do not clear pending savings.
		// Dependencies: in-memory branch entries and shared token estimation.
		const projectedBranch = [
			messageEntry("01", assistantMessage("call-old"), null),
			messageEntry(
				"02",
				toolResultMessage("call-old", "old output ".repeat(20)),
				"01",
			),
			projectionStateEntry("03", "02", PLACEHOLDER, "02"),
			messageEntry(
				"04",
				{ ...assistantMessage("call-error"), stopReason: "error" },
				"03",
			),
			messageEntry(
				"05",
				{ ...assistantMessage("call-aborted"), stopReason: "aborted" },
				"04",
			),
		];

		expect(
			estimatePendingProjectionSavings({
				branchEntries: projectedBranch,
				cwd: "/tmp/project",
				config: PROJECTION_CONFIG,
			}).savedTokens,
		).toBeGreaterThan(0);

		expect(
			estimatePendingProjectionSavings({
				branchEntries: [
					...projectedBranch,
					messageEntry("06", assistantMessage("call-new"), "05"),
				],
				cwd: "/tmp/project",
				config: PROJECTION_CONFIG,
			}).savedTokens,
		).toBe(0);
	});
});

describe("context projection replay", () => {
	test("replays persisted placeholders when projection config is valid", async () => {
		// Purpose: advisor input must reuse recorded projection instead of sending full old tool output.
		// Input and expected output: valid config plus one projected entry replaces only that tool result with its placeholder.
		// Edge case: projection state is stored as a custom entry after the projected message and must still match by entry ID.
		// Dependencies: isolated agent config and in-memory session entries.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeProjectionConfig(agentDir, { enabled: true });
			const branchEntries = [
				messageEntry("01", userMessage(), null),
				messageEntry("02", assistantMessage("call-old"), "01"),
				messageEntry("03", toolResultMessage("call-old", "old output"), "02"),
				projectionStateEntry("04", "03", PLACEHOLDER, "03"),
			];

			const messages = await replayContextProjection({
				branchEntries,
				cwd: "/tmp/project",
			});

			expect(JSON.stringify(messages)).not.toContain("old output");
			expect(JSON.stringify(messages)).toContain(PLACEHOLDER);
		});
	});

	test("keeps protected council results visible during projection replay", async () => {
		// Purpose: replay must not hide built-in protected tool results even when stale projection state contains their entry IDs.
		// Input and expected output: convene_council output stays visible, while ordinary bash output replays its persisted placeholder.
		// Edge case: both entries have persisted placeholders, but built-in protection takes precedence for the council result.
		// Dependencies: isolated agent config and in-memory session entries.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeProjectionConfig(agentDir, { enabled: true });
			const branchEntries = [
				messageEntry("01", userMessage(), null),
				messageEntry(
					"02",
					assistantMessage("call-council", "convene_council"),
					"01",
				),
				messageEntry(
					"03",
					toolResultMessage(
						"call-council",
						"council output",
						"convene_council",
					),
					"02",
				),
				messageEntry("04", assistantMessage("call-bash"), "03"),
				messageEntry("05", toolResultMessage("call-bash", "bash output"), "04"),
				projectionStateEntry("06", "03", "[hidden council]", "05"),
				projectionStateEntry("07", "05", PLACEHOLDER, "06"),
			];

			const replayed = JSON.stringify(
				await replayContextProjection({ branchEntries, cwd: "/tmp/project" }),
			);

			expect(replayed).toContain("council output");
			expect(replayed).not.toContain("[hidden council]");
			expect(replayed).not.toContain("bash output");
			expect(replayed).toContain(PLACEHOLDER);
		});
	});

	test("keeps protected council results visible during first-time projection discovery", () => {
		// Purpose: projection discovery must never persist convene_council results as newly projected entries.
		// Input and expected output: bash is projected, while convene_council remains visible and absent from newProjectedEntries.
		// Edge case: discovery is enabled with zero recent-turn and token protections.
		// Dependencies: direct shared projection decision helper and in-memory mapped context.
		const mappedContext: readonly MappedContextEntry[] = [
			{
				entry: messageEntry(
					"01",
					assistantMessage("call-council", "convene_council"),
					null,
				),
				message: assistantMessage("call-council", "convene_council"),
			},
			{
				entry: messageEntry(
					"02",
					toolResultMessage(
						"call-council",
						"council output",
						"convene_council",
					),
					"01",
				),
				message: toolResultMessage(
					"call-council",
					"council output",
					"convene_council",
				),
			},
			{
				entry: messageEntry("03", assistantMessage("call-bash"), "02"),
				message: assistantMessage("call-bash"),
			},
			{
				entry: messageEntry(
					"04",
					toolResultMessage("call-bash", "bash output"),
					"03",
				),
				message: toolResultMessage("call-bash", "bash output"),
			},
		];

		const decision = projectContextMessages({
			mappedContext,
			projectedPlaceholdersByEntryId: new Map(),
			config: PROJECTION_CONFIG,
			loadedSkillRoots: [],
			cwd: "/tmp/project",
			discoverNewEntries: true,
		});
		const projected = JSON.stringify(decision.messages);

		expect(projected).toContain("council output");
		expect(projected).not.toContain("bash output");
		expect(projected).toContain(PLACEHOLDER);
		expect(decision.newProjectedEntries).toEqual([
			{ entryId: "04", placeholder: PLACEHOLDER },
		]);
	});

	test("returns full context when projection config is disabled or invalid", async () => {
		// Purpose: disabled or invalid projection must not hide advisor context.
		// Input and expected output: persisted projection state exists, but disabled and invalid configs both keep the original text.
		// Edge case: invalid config must fail closed to full context instead of replaying stale state.
		// Dependencies: isolated agent config and in-memory session entries.
		await withIsolatedAgentDir(async (agentDir) => {
			const branchEntries = [
				messageEntry("01", assistantMessage("call-old"), null),
				messageEntry("02", toolResultMessage("call-old", "old output"), "01"),
				projectionStateEntry("03", "02", PLACEHOLDER, "02"),
			];

			await writeProjectionConfig(agentDir, { enabled: false });
			expect(
				JSON.stringify(
					await replayContextProjection({ branchEntries, cwd: "/tmp/project" }),
				),
			).toContain("old output");

			await writeProjectionConfig(agentDir, { enabled: "bad" });
			expect(
				JSON.stringify(
					await replayContextProjection({ branchEntries, cwd: "/tmp/project" }),
				),
			).toContain("old output");
		});
	});

	test("returns full context when enabled projection has no valid active-branch state", async () => {
		// Purpose: replay must fail safe to full context unless valid projection state matches active branch entries.
		// Input and expected output: empty state, malformed state, empty placeholder, and stale entry IDs all keep original output visible.
		// Edge case: persisted custom entries can exist without a valid projected item for this active branch.
		// Dependencies: isolated agent config and in-memory session entries.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeProjectionConfig(agentDir, { enabled: true });
			const baseEntries = [
				messageEntry("01", assistantMessage("call-old"), null),
				messageEntry("02", toolResultMessage("call-old", "old output"), "01"),
			];
			const cases: readonly SessionEntry[][] = [
				baseEntries,
				[
					...baseEntries,
					{
						type: "custom",
						id: "03",
						parentId: "02",
						timestamp: "t",
						customType: CUSTOM_TYPE,
						data: { projectedEntries: [{ entryId: "02" }] },
					} as SessionEntry,
				],
				[...baseEntries, projectionStateEntry("03", "02", "", "02")],
				[
					...baseEntries,
					projectionStateEntry("03", "stale-id", PLACEHOLDER, "02"),
				],
			];

			for (const branchEntries of cases) {
				const replayed = JSON.stringify(
					await replayContextProjection({ branchEntries, cwd: "/tmp/project" }),
				);

				expect(replayed).toContain("old output");
				expect(replayed).not.toContain(PLACEHOLDER);
			}
		});
	});
});
