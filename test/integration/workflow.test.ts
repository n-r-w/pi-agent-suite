import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflowExtension from "../../pi-package/extensions/workflow/index";
import { CHILD_AGENT_PROCESS_ENV } from "../../pi-package/shared/child-agent-environment.ts";
import { SUBAGENT_WORKFLOW_IDS_ENV } from "../../pi-package/shared/subagent-environment.ts";

const temporaryDirectories: string[] = [];
const originalSuiteDirectory = process.env["PI_AGENT_SUITE_DIR"];
const originalChildMarker = process.env[CHILD_AGENT_PROCESS_ENV];
const originalChildWorkflowIds = process.env[SUBAGENT_WORKFLOW_IDS_ENV];

/** Isolates the main-agent integration fixture from ambient child policy. */
beforeEach(() => {
	delete process.env[CHILD_AGENT_PROCESS_ENV];
	delete process.env[SUBAGENT_WORKFLOW_IDS_ENV];
});

/**
 * Proves the real entry composes catalog loading, registration, persistence, and active-stage instructions.
 * Input and expected output: activating the delivery fixture projects its initial stage and normalized prompt.
 * Edge case: repeated session initialization still registers each workflow tool only once.
 * Dependencies: isolated files, an ExtensionAPI fake, and the real workflow entry point.
 */
test("workflow entry activates a configured workflow and projects its initial stage", async () => {
	const suite = await mkdtemp(join(tmpdir(), "pi-workflow-integration-"));
	temporaryDirectories.push(suite);
	const workflows = join(suite, "workflow", "workflows");
	await mkdir(workflows, { recursive: true });
	await writeFile(
		join(workflows, "delivery.yaml"),
		"description: Delivery\nstages:\n  - id: start\n    description: Start\n    prompt: Start work\n    initial: true\n  - id: done\n    description: Done\n    prompt: Finish work\n    final: true\ntransitions:\n  - from: start\n    to: done\n    type: advance\n",
	);
	process.env["PI_AGENT_SUITE_DIR"] = suite;
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const tools: Array<{
		name: string;
		execute: (...args: unknown[]) => Promise<unknown>;
	}> = [];
	const appended: Array<{ customType: string; data: unknown }> = [];
	let activeTools = ["read"];
	let thinkingLevel = "medium";
	const pi = {
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
		registerTool(tool: {
			name: string;
			execute: (...args: unknown[]) => Promise<unknown>;
		}) {
			tools.push(tool);
			activeTools.push(tool.name);
		},
		registerFlag(): void {},
		getFlag(): undefined {
			return undefined;
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
		getThinkingLevel() {
			return thinkingLevel;
		},
		setThinkingLevel(level: string) {
			thinkingLevel = level;
		},
		appendEntry(customType: string, data: unknown) {
			appended.push({ customType, data });
		},
		events: {
			emit() {},
			on() {
				return () => {};
			},
		},
	};
	await workflowExtension(pi as unknown as ExtensionAPI);
	const lifecycle = handlers.get("session_start");
	if (lifecycle === undefined) {
		throw new Error("session_start handler missing");
	}
	const renderingModel = {
		provider: "test",
		id: "current",
		api: "test-api",
		baseUrl: "https://example.test",
		reasoning: true,
		name: "test/current",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_192,
	};
	const context = {
		model: renderingModel,
		modelRegistry: {
			find(provider: string, id: string) {
				return provider === "test" && id === "current"
					? renderingModel
					: undefined;
			},
		},
		sessionManager: { getBranch: () => [] },
	};
	await lifecycle({ type: "session_start" }, context);
	await lifecycle({ type: "session_start" }, context);
	expect(tools.map(({ name }) => name)).toEqual([
		"workflow_activate",
		"workflow_get_stage",
		"workflow_edit_stage",
		"workflow_transition",
		"workflow_create",
	]);
	const activate = tools[0];
	if (activate === undefined) {
		throw new Error("activation tool missing");
	}
	await activate.execute("call", { workflowId: "delivery" });
	expect(appended).toHaveLength(1);
	expect(appended[0]?.customType).toBe("workflow-state");
	const contextHandler = handlers.get("context");
	if (contextHandler === undefined) {
		throw new Error("context handler missing");
	}
	const prior = { role: "user", content: "preserve", timestamp: 1 };
	const result = await contextHandler({ messages: [prior] }, {});
	const messages = (result as { messages: Array<{ content: unknown }> })
		.messages;
	expect(messages[0]).toBe(prior);
	expect(String(messages[1]?.content)).toContain('active_stage_id="start"');
	expect(String(messages[1]?.content)).toContain(
		"<active_stage_guidelines>\nStart work\n  </active_stage_guidelines>",
	);
});

afterEach(async () => {
	if (originalSuiteDirectory === undefined) {
		delete process.env["PI_AGENT_SUITE_DIR"];
	} else {
		process.env["PI_AGENT_SUITE_DIR"] = originalSuiteDirectory;
	}
	if (originalChildMarker === undefined) {
		delete process.env[CHILD_AGENT_PROCESS_ENV];
	} else {
		process.env[CHILD_AGENT_PROCESS_ENV] = originalChildMarker;
	}
	if (originalChildWorkflowIds === undefined) {
		delete process.env[SUBAGENT_WORKFLOW_IDS_ENV];
	} else {
		process.env[SUBAGENT_WORKFLOW_IDS_ENV] = originalChildWorkflowIds;
	}
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});
