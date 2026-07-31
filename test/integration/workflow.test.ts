import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflowExtension from "../../pi-package/extensions/workflow/index";

const temporaryDirectories: string[] = [];
const originalSuiteDirectory = process.env["PI_AGENT_SUITE_DIR"];

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
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
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
	const context = { sessionManager: { getBranch: () => [] } };
	await lifecycle({ type: "session_start" }, context);
	await lifecycle({ type: "session_start" }, context);
	expect(tools.map(({ name }) => name)).toEqual([
		"workflow_activate",
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
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});
