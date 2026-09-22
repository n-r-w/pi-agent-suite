import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import compactionTrigger from "../../pi-package/extensions/compaction-trigger";
import contextProjection from "../../pi-package/extensions/context-projection";
import {
	addPendingProjectionSavings,
	collectEffectiveProjectedReplacements,
	getProjectionAwareContextUsage,
	publishRuntimeProjectedReplacements,
	resetPendingProjectionSavings,
} from "../../pi-package/shared/context-projection";
import { createTempDir } from "../support/temp-dir";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";
const previousAgentDir = process.env[AGENT_DIR_ENV];
const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: (event: unknown, ctx: TestContext) => unknown;
}

interface TestContext {
	readonly cwd: string;
	readonly model: { readonly contextWindow: number };
	readonly signal: AbortSignal;
	readonly sessionManager: {
		getBranch(): SessionEntry[];
		getLeafId(): string | null;
		getSessionId(): string;
	};
	readonly ui: {
		notify(): void;
		setStatus(): void;
		readonly theme: { fg(_color: string, text: string): string };
	};
	abort(): void;
	compact(): void;
	getContextUsage(): {
		readonly tokens: number;
		readonly contextWindow: number;
		readonly percent: number;
	};
}

afterEach(() => {
	if (previousAgentDir === undefined) {
		delete process.env[AGENT_DIR_ENV];
	} else {
		process.env[AGENT_DIR_ENV] = previousAgentDir;
	}
	if (previousSuiteDir === undefined) {
		delete process.env[AGENT_SUITE_DIR_ENV];
	} else {
		process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
	}
});

function assistantMessage(): Extract<AgentMessage, { role: "assistant" }> {
	return {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call-old", name: "bash", arguments: {} },
		],
		api: "openai-responses",
		provider: "openai",
		model: "main",
		usage: {
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 110,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function createPi(handlers: RegisteredHandler[]): ExtensionAPI {
	return {
		on(eventName: string, handler: RegisteredHandler["handler"]): void {
			handlers.push({ eventName, handler });
		},
		appendEntry(): void {},
		getThinkingLevel: () => "off",
		sendMessage(): void {},
	} as unknown as ExtensionAPI;
}

test("retained-anchor navigation restores native usage before the trigger decision", async () => {
	const cwd = createTempDir("pi-retained-anchor-project-");
	const agentDir = createTempDir("pi-retained-anchor-agent-");
	const suiteDir = join(agentDir.path, "agent-suite");
	process.env[AGENT_DIR_ENV] = agentDir.path;
	process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
	mkdirSync(join(cwd.path, ".pi"), { recursive: true });
	mkdirSync(join(agentDir.path, "config"), { recursive: true });
	mkdirSync(join(suiteDir, "compaction-trigger"), { recursive: true });
	writeFileSync(
		join(cwd.path, ".pi", "settings.json"),
		JSON.stringify({ compaction: { enabled: false, reserveTokens: 100 } }),
	);
	writeFileSync(
		join(agentDir.path, "config", "context-projection.json"),
		JSON.stringify({
			enabled: true,
			projectionRemainingTokensL1: 100,
			minToolResultTokensL1: 5,
			projectionRemainingTokensL2: 50,
			minToolResultTokensL2: 5,
			projectionRemainingTokensL3: 25,
			minToolResultTokensL3: 5,
			keepRecentTurns: 0,
			keepRecentTurnsPercent: 0,
			projectionIgnoredTools: [],
		}),
	);
	writeFileSync(
		join(suiteDir, "compaction-trigger", "config.json"),
		JSON.stringify({ enabled: true, tolerancePercent: 0 }),
	);

	const branchEntries = [
		{
			type: "message",
			id: "01",
			parentId: null,
			timestamp: "t",
			message: assistantMessage(),
		},
		{
			type: "message",
			id: "02",
			parentId: "01",
			timestamp: "t",
			message: {
				role: "toolResult",
				toolCallId: "call-old",
				toolName: "bash",
				content: [{ type: "text", text: "old output ".repeat(20) }],
				isError: false,
				timestamp: 2,
			},
		},
		{
			type: "custom",
			id: "03",
			parentId: "02",
			timestamp: "t",
			customType: "context-projection",
			data: {
				appliedLevel: "L1",
				projectedEntries: [
					{ entryId: "02", replacementText: "Result omitted." },
				],
			},
		},
		{
			type: "message",
			id: "04",
			parentId: "03",
			timestamp: "t",
			message: { ...assistantMessage(), stopReason: "stop" },
		},
	] as SessionEntry[];
	const sessionId = "retained-anchor-session";
	resetPendingProjectionSavings(sessionId);
	publishRuntimeProjectedReplacements(
		cwd.path,
		new Map([["02", "Result omitted."]]),
		"02",
	);
	addPendingProjectionSavings(sessionId, {
		branchLeafId: "02",
		entries: [
			{
				entryId: "02",
				replacementText: "Result omitted.",
				savedTokens: 1,
			},
		],
	});
	branchEntries.splice(2);

	const handlers: RegisteredHandler[] = [];
	const pi = createPi(handlers);
	compactionTrigger(pi);
	contextProjection(pi);
	let abortCalls = 0;
	const controller = new AbortController();
	const nativeUsage = { tokens: 900, contextWindow: 1_000, percent: 90 };
	const ctx: TestContext = {
		cwd: cwd.path,
		model: { contextWindow: 1_000 },
		signal: controller.signal,
		sessionManager: {
			getBranch: () => branchEntries,
			getLeafId: () => branchEntries.at(-1)?.id ?? null,
			getSessionId: () => sessionId,
		},
		ui: {
			notify(): void {},
			setStatus(): void {},
			theme: { fg: (_color, text) => text },
		},
		abort(): void {
			abortCalls += 1;
			controller.abort();
		},
		compact(): void {},
		getContextUsage: () => nativeUsage,
	};

	try {
		const sessionTreeHandler = handlers.find(
			({ eventName }) => eventName === "session_tree",
		)?.handler;
		if (sessionTreeHandler === undefined) {
			throw new Error("expected context-projection session_tree handler");
		}
		await sessionTreeHandler({ type: "session_tree" }, ctx);

		expect(
			collectEffectiveProjectedReplacements(branchEntries, cwd.path),
		).toEqual(new Map());
		expect(
			getProjectionAwareContextUsage(sessionId, branchEntries, nativeUsage),
		).toEqual(nativeUsage);

		const triggerHandler = handlers.find(
			({ eventName }) => eventName === "context",
		)?.handler;
		if (triggerHandler === undefined) {
			throw new Error("expected compaction-trigger context handler");
		}
		expect(
			await triggerHandler({ type: "context", messages: branchEntries }, ctx),
		).toEqual({ messages: [] });
		expect(abortCalls).toBe(1);
	} finally {
		resetPendingProjectionSavings(sessionId);
		cwd.remove();
		agentDir.remove();
	}
});
