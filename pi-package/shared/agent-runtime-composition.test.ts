import { describe, expect, test } from "bun:test";
import {
	createEventBus,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { getAgentRuntimeComposition } from "./agent-runtime-composition.ts";

interface Handler {
	readonly name: string;
	readonly run: (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
}

function createPi(
	active: readonly string[],
	registered: readonly string[] = active,
): ExtensionAPI & { readonly handlers: Handler[] } {
	let activeTools = [...active];
	const handlers: Handler[] = [];
	return {
		handlers,
		events: createEventBus(),
		on(name: string, run: Handler["run"]): void {
			handlers.push({ name, run });
		},
		getActiveTools(): readonly string[] {
			return activeTools;
		},
		getAllTools() {
			return registered.map((name) => ({ name }));
		},
		setActiveTools(names: readonly string[]): void {
			activeTools = [...names];
		},
	} as unknown as ExtensionAPI & { readonly handlers: Handler[] };
}

describe("agent runtime composition", () => {
	/**
	 * Proves extension-loading publication records order without invoking active-tool actions.
	 * Input and expected output: a deferred tool stays inactive until runtime reconciliation, then appears after read.
	 * Edge case: publication occurs before the composition has captured a Pi active-tool baseline.
	 * Dependencies: lazy baseline initialization and stable registration ordering.
	 */
	test("defers published baseline tools until runtime reconciliation", () => {
		const pi = createPi(["read"]);
		const composition = getAgentRuntimeComposition(pi);

		composition.publishBaselineToolNames(["describe_image"]);
		expect(pi.getActiveTools()).toEqual(["read"]);

		composition.reconcileActiveTools();
		expect(pi.getActiveTools()).toEqual(["read", "describe_image"]);
	});

	test("publishes restrictive filters without invoking extension-loading actions", () => {
		let runtimeReady = false;
		let activeTools = ["read", "deferred_tool"];
		const pi = {
			events: createEventBus(),
			on() {},
			getActiveTools() {
				if (!runtimeReady) {
					throw new Error("Extension runtime not initialized");
				}
				return [...activeTools];
			},
			getAllTools() {
				return activeTools.map((name) => ({ name }));
			},
			setActiveTools(names: readonly string[]) {
				if (!runtimeReady) {
					throw new Error("Extension runtime not initialized");
				}
				activeTools = [...names];
			},
		} as unknown as ExtensionAPI;
		const composition = getAgentRuntimeComposition(pi);

		expect(() =>
			composition.publishRestrictiveToolFilter("deferred", (candidates) =>
				candidates.filter((name) => name !== "deferred_tool"),
			),
		).not.toThrow();
		runtimeReady = true;
		composition.reconcileActiveTools();
		expect(activeTools).toEqual(["read"]);
	});

	test("atomically replaces one owner's baseline tools", () => {
		// Purpose: dynamic providers must replace stale registered definitions without removing unrelated baseline tools.
		// Input and expected output: a provider changes old_tool to new_tool while read remains active.
		// Edge case: a restrictive filter is evaluated only against the replacement catalog.
		// Dependencies: lazy baseline capture and final composition reconciliation.
		const pi = createPi(["read", "old_tool"]);
		const composition = getAgentRuntimeComposition(pi);
		composition.replaceBaselineToolNames("provider", ["old_tool"]);
		composition.setRestrictiveToolFilter("provider-policy", (candidates) =>
			candidates.filter((name) => name !== "old_tool"),
		);

		composition.replaceBaselineToolNames("provider", ["new_tool"]);

		expect(pi.getActiveTools()).toEqual(["read", "new_tool"]);
	});

	test("preserves a late external activation across agent-start turns", async () => {
		const registered = ["read"];
		const pi = createPi(["read"], registered);
		getAgentRuntimeComposition(pi);
		const start = pi.handlers.find(
			(handler) => handler.name === "before_agent_start",
		);
		expect(start).toBeDefined();
		await start?.run({ systemPrompt: "" }, { cwd: "/tmp" });
		registered.push("room_tool");
		pi.setActiveTools(["read", "room_tool"]);
		await start?.run({ systemPrompt: "" }, { cwd: "/tmp" });
		await start?.run({ systemPrompt: "" }, { cwd: "/tmp" });
		expect(pi.getActiveTools()).toEqual(["read", "room_tool"]);
	});

	test("does not adopt unregistered external tool names", () => {
		const pi = createPi(["read"]);
		const composition = getAgentRuntimeComposition(pi);
		composition.reconcileActiveTools();
		pi.setActiveTools(["read", "disconnected_tool"]);
		composition.reconcileActiveTools();
		expect(pi.getActiveTools()).toEqual(["read"]);
	});

	test("does not restore an externally deactivated or disconnected tool", () => {
		const pi = createPi(["read", "room_tool"]);
		const composition = getAgentRuntimeComposition(pi);
		composition.reconcileActiveTools();
		pi.setActiveTools(["read"]);
		composition.reconcileActiveTools();
		composition.setRestrictiveToolNames("child", ["read", "room_tool"]);
		expect(pi.getActiveTools()).toEqual(["read"]);
	});

	test("filters late external activation and restores it when restrictions lift", () => {
		const pi = createPi(["read", "hidden"], ["read", "hidden", "room_tool"]);
		const composition = getAgentRuntimeComposition(pi);
		composition.setMainAgentContribution({
			prompt: "",
			tools: ["read", "room_tool"],
		});
		composition.setRestrictiveToolNames("child", ["read"]);
		composition.setRestrictiveToolFilter("deny-room", (names) =>
			names.filter((name) => name !== "room_tool"),
		);
		pi.setActiveTools(["read", "room_tool"]);
		composition.reconcileActiveTools();
		expect(pi.getActiveTools()).toEqual(["read"]);
		composition.setRestrictiveToolNames("child", undefined);
		composition.setRestrictiveToolFilter("deny-room", undefined);
		expect(pi.getActiveTools()).toEqual(["read", "room_tool"]);
		composition.clearMainAgentContribution();
		expect(pi.getActiveTools()).toEqual(["read", "hidden", "room_tool"]);
	});

	test("does not adopt a retired owner tool activated before staged replacement", () => {
		const pi = createPi(
			["read", "old_tool"],
			["read", "old_tool", "new_tool", "room_tool"],
		);
		const composition = getAgentRuntimeComposition(pi);
		composition.replaceBaselineToolNames("provider", ["old_tool"]);
		composition.setRestrictiveToolFilter("deferred", (names) =>
			names.filter((name) => name !== "old_tool"),
		);
		pi.setActiveTools(["read", "old_tool", "room_tool"]);
		composition.stageBaselineToolNames("provider", ["new_tool"]);
		composition.setRestrictiveToolFilter("deferred", (names) => names);
		expect(pi.getActiveTools()).toEqual(["read", "new_tool", "room_tool"]);
		composition.reconcileActiveTools();
		expect(pi.getActiveTools()).toEqual(["read", "new_tool", "room_tool"]);
		pi.setActiveTools(["read", "new_tool", "room_tool", "old_tool"]);
		composition.reconcileActiveTools();
		expect(pi.getActiveTools()).toEqual(["read", "new_tool", "room_tool"]);
		composition.stageBaselineToolNames("provider", ["old_tool"]);
		composition.reconcileActiveTools();
		expect(pi.getActiveTools()).toEqual(["read", "room_tool", "old_tool"]);
	});

	test("retires the active old owner tool when replacing its catalog", () => {
		const pi = createPi(["read", "old_tool"]);
		const composition = getAgentRuntimeComposition(pi);
		composition.replaceBaselineToolNames("provider", ["old_tool"]);
		composition.replaceBaselineToolNames("provider", ["new_tool"]);
		composition.reconcileActiveTools();
		expect(pi.getActiveTools()).toEqual(["read", "new_tool"]);
	});

	test("does not re-add an externally deactivated owner tool during replacement", () => {
		const pi = createPi(["read", "old_tool"]);
		const composition = getAgentRuntimeComposition(pi);
		composition.replaceBaselineToolNames("provider", ["old_tool"]);
		pi.setActiveTools(["read"]);
		composition.replaceBaselineToolNames("provider", ["new_tool"]);
		expect(pi.getActiveTools()).toEqual(["read", "new_tool"]);
	});

	test("keeps added baseline tools subject to restrictive allowlists", () => {
		const pi = createPi(["read"]);
		const composition = getAgentRuntimeComposition(pi);
		composition.setRestrictiveToolNames("child", ["read"]);
		composition.addBaselineToolNames(["grep"]);

		expect(pi.getActiveTools()).toEqual(["read"]);
	});

	/**
	 * Proves named dynamic restrictions are re-evaluated by the sole active-tool owner.
	 * Input and expected output: a depth filter removes a subagent tool and cannot grant an unknown name.
	 * Edge case: a later baseline addition remains filtered instead of restoring the restricted tool.
	 * Dependencies: stable baseline publication and named restrictive composition layers.
	 */
	test("keeps named restrictive filters enforced across later reconciliation", () => {
		const pi = createPi(["read", "subagent_start"]);
		const composition = getAgentRuntimeComposition(pi);
		composition.setRestrictiveToolFilter("subagent-depth", (candidates) => [
			...candidates.filter((name) => name !== "subagent_start"),
			"forbidden_tool",
		]);

		composition.addBaselineToolNames(["grep"]);

		expect(pi.getActiveTools()).toEqual(["read", "grep"]);
	});

	/**
	 * Proves every main-agent tool policy is a remove-only filter of the stable baseline.
	 * Input and expected output: a reordered allowlist with registered baseline-external write preserves [read, edit]; clearing a narrower policy restores read under the child restriction.
	 * Edge case: write is registered but absent from the baseline, so the policy cannot grant it.
	 * Dependencies: main-agent contribution updates and named restrictive layers both trigger composition reconciliation.
	 */
	test("treats main-agent tools as a baseline-ordered remove-only filter", () => {
		const pi = createPi(
			["read", "grep", "edit"],
			["read", "grep", "edit", "write"],
		);
		const composition = getAgentRuntimeComposition(pi);
		composition.setRestrictiveToolNames("child", ["read", "edit"]);
		composition.setMainAgentContribution({
			prompt: "Main-agent prompt",
			tools: ["edit", "write", "read"],
		});

		expect(pi.getActiveTools()).toEqual(["read", "edit"]);

		composition.setMainAgentContribution({
			prompt: "Main-agent prompt",
			tools: ["edit"],
		});
		expect(pi.getActiveTools()).toEqual(["edit"]);

		composition.clearMainAgentContribution();
		expect(pi.getActiveTools()).toEqual(["read", "edit"]);
	});

	test("restores eligible tools at their stable baseline positions", () => {
		const pi = createPi(["read", "workflow_transition", "workflow_create"]);
		const composition = getAgentRuntimeComposition(pi);
		composition.setRestrictiveToolNames("workflow", [
			"read",
			"workflow_create",
		]);
		expect(pi.getActiveTools()).toEqual(["read", "workflow_create"]);

		composition.setRestrictiveToolNames("workflow", [
			"read",
			"workflow_transition",
			"workflow_create",
		]);

		expect(pi.getActiveTools()).toEqual([
			"read",
			"workflow_transition",
			"workflow_create",
		]);
	});
});
