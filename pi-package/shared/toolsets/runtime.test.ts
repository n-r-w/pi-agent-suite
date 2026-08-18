import { describe, expect, test } from "bun:test";
import {
	createEventBus,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { getAgentRuntimeComposition } from "../agent-runtime-composition.ts";
import { getToolsetRuntime } from "./runtime.ts";

type ToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];
type EventHandler = (event: unknown, ctx: unknown) => unknown;

interface FakePiControls {
	pi: ExtensionAPI;
	readonly definitions: Map<string, ToolDefinition>;
	readonly activeTools: string[];
	readonly notifications: string[];
	emit(event: string, value: unknown, ctx: unknown): Promise<void>;
	failSetActiveToolsWhen?: (names: readonly string[]) => boolean;
}

function createFakePi(initialTools: readonly string[]): FakePiControls {
	const handlers = new Map<string, EventHandler[]>();
	const definitions = new Map<string, ToolDefinition>();
	const activeTools = [...initialTools];
	const notifications: string[] = [];
	const controls = {
		definitions,
		activeTools,
		notifications,
		pi: undefined as unknown as ExtensionAPI,
		async emit(event: string, value: unknown, ctx: unknown) {
			for (const handler of handlers.get(event) ?? []) {
				await handler(value, ctx);
			}
		},
	} as FakePiControls;
	controls.pi = {
		events: createEventBus(),
		on(event: string, handler: EventHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(definition: ToolDefinition) {
			definitions.set(definition.name, definition);
			if (!activeTools.includes(definition.name)) {
				activeTools.push(definition.name);
			}
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names: string[]) {
			if (controls.failSetActiveToolsWhen?.(names)) {
				throw new Error("reconciliation failed");
			}
			activeTools.splice(0, activeTools.length, ...names);
		},
	} as unknown as ExtensionAPI;
	return controls;
}

function filesToolset(
	activate: () => Promise<readonly string[]> = async () => [
		"files_read",
		"files_write",
	],
): {
	providerId: string;
	name: string;
	description: string;
	toolNames: string[];
	activate: () => Promise<readonly string[]>;
} {
	return {
		providerId: "mcp",
		name: "files",
		description: "Read project files",
		toolNames: ["files_read", "files_write"],
		activate,
	};
}

describe("toolset runtime", () => {
	test("publishes its filter and provider catalog without extension-loading actions", async () => {
		let runtimeReady = false;
		let activeTools = ["read", "files_read"];
		const handlers = new Map<string, EventHandler[]>();
		const pi = {
			events: createEventBus(),
			on(event: string, handler: EventHandler) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool() {},
			getActiveTools() {
				if (!runtimeReady) {
					throw new Error("Extension runtime not initialized");
				}
				return [...activeTools];
			},
			setActiveTools(names: string[]) {
				if (!runtimeReady) {
					throw new Error("Extension runtime not initialized");
				}
				activeTools = [...names];
			},
		} as unknown as ExtensionAPI;
		let runtime: ReturnType<typeof getToolsetRuntime> | undefined;

		expect(() => {
			runtime = getToolsetRuntime(pi);
			runtime.replaceProvider("mcp", [filesToolset()]);
		}).not.toThrow();

		runtimeReady = true;
		for (const handler of handlers.get("session_start") ?? []) {
			await handler(
				{ type: "session_start" },
				{
					hasUI: false,
					sessionManager: { getBranch: () => [] },
					ui: { notify() {} },
				},
			);
		}
		expect(runtime).toBeDefined();
		expect(activeTools).toEqual(["read", "activate_toolset"]);
	});

	test("filters deferred tools and exposes activation only for eligible allowed toolsets", () => {
		const { pi, activeTools } = createFakePi([
			"read",
			"files_read",
			"files_write",
		]);
		const runtime = getToolsetRuntime(pi);
		const composition = getAgentRuntimeComposition(pi);
		runtime.replaceProvider("mcp", [filesToolset()]);
		composition.reconcileActiveTools();

		expect(activeTools).toEqual(["read", "activate_toolset"]);
		expect(runtime.getVisibleToolsets()).toEqual([
			{
				name: "files",
				description: "Read project files",
				toolNames: ["files_read", "files_write"],
			},
		]);

		composition.setRestrictiveToolNames("agent", ["read", "activate_toolset"]);
		expect(activeTools).toEqual(["read"]);

		composition.setRestrictiveToolNames("agent", ["read", "files_read"]);
		expect(activeTools).toEqual(["read"]);
		expect(runtime.getVisibleToolsets()).toHaveLength(1);

		composition.setRestrictiveToolNames("agent", [
			"read",
			"files_read",
			"activate_toolset",
		]);
		expect(activeTools).toEqual(["read", "activate_toolset"]);
	});

	test("activates only allowed tools and removes the final activation trigger", async () => {
		const { pi, definitions, activeTools } = createFakePi([
			"read",
			"files_read",
			"files_write",
		]);
		let providerActivated = false;
		const runtime = getToolsetRuntime(pi);
		runtime.replaceProvider("mcp", [
			filesToolset(async () => {
				providerActivated = true;
				return ["files_read", "files_write"];
			}),
		]);
		getAgentRuntimeComposition(pi).setRestrictiveToolNames("agent", [
			"read",
			"files_read",
			"activate_toolset",
		]);

		const definition = definitions.get("activate_toolset");
		expect(definition).toBeDefined();
		const result = await definition?.execute(
			"call-1",
			{ name: "files" },
			undefined,
			undefined,
			{} as never,
		);

		expect(providerActivated).toBe(true);
		expect(activeTools).toEqual(["read", "files_read"]);
		expect(result?.content).toEqual([
			{
				type: "text",
				text: 'Activated toolset "files".\nAvailable tools:\n- files_read',
			},
		]);
		expect(result?.details).toEqual({
			version: 1,
			activeToolsets: ["files"],
			activation: {
				name: "files",
				status: "activated",
				toolNames: ["files_read"],
			},
		});
	});

	test("keeps activation available until every eligible toolset is active", async () => {
		const controls = createFakePi(["files_read", "database_query"]);
		const runtime = getToolsetRuntime(controls.pi);
		runtime.replaceProvider("mcp", [
			filesToolset(),
			{
				providerId: "mcp",
				name: "database",
				description: "Query the database",
				toolNames: ["database_query"],
				activate: async () => ["database_query"],
			},
		]);
		getAgentRuntimeComposition(controls.pi).reconcileActiveTools();

		await runtime.activate("files");
		expect(controls.activeTools).toEqual(["files_read", "activate_toolset"]);
		const activationTool = controls.definitions.get("activate_toolset");
		const result = await activationTool?.execute(
			"call-2",
			{ name: "database" },
			undefined,
			undefined,
			{} as never,
		);
		expect(controls.activeTools).toEqual(["files_read", "database_query"]);
		expect(result?.details).toMatchObject({
			version: 1,
			activeToolsets: ["files", "database"],
		});
	});

	test("ignores caller candidates that could bypass upstream restrictions", async () => {
		const controls = createFakePi(["files_read", "files_write"]);
		const runtime = getToolsetRuntime(controls.pi);
		runtime.replaceProvider("mcp", [filesToolset()]);
		getAgentRuntimeComposition(controls.pi).setRestrictiveToolNames("agent", [
			"files_read",
			"activate_toolset",
		]);

		expect(await runtime.activate("files")).toMatchObject({
			toolNames: ["files_read"],
		});
		expect(controls.activeTools).toEqual(["files_read"]);
	});

	test("uses exact case-sensitive names and preserves state for unknown names", async () => {
		const controls = createFakePi(["files_read"]);
		const runtime = getToolsetRuntime(controls.pi);
		runtime.replaceProvider("mcp", [filesToolset()]);
		getAgentRuntimeComposition(controls.pi).reconcileActiveTools();

		await expect(runtime.activate("Files")).rejects.toThrow(
			"unknown toolset: Files",
		);
		expect(controls.activeTools).toEqual(["activate_toolset"]);
		expect(runtime.getVisibleToolsets()).toHaveLength(1);
	});

	test("returns complete currently allowed names for an idempotent activation", async () => {
		const controls = createFakePi(["files_read", "files_write"]);
		const runtime = getToolsetRuntime(controls.pi);
		runtime.replaceProvider("mcp", [filesToolset()]);

		getAgentRuntimeComposition(controls.pi).reconcileActiveTools();
		await runtime.activate("files");
		expect(await runtime.activate("files")).toEqual({
			name: "files",
			toolNames: ["files_read", "files_write"],
			alreadyActive: true,
		});

		const activationTool = controls.definitions.get("activate_toolset");
		const result = await activationTool?.execute(
			"call-repeat",
			{ name: "files" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result?.content).toEqual([
			{
				type: "text",
				text: 'Toolset "files" is already active.\nAvailable tools:\n- files_read\n- files_write',
			},
		]);
	});

	test("rejects a provider activation result that disagrees with its catalog", async () => {
		const controls = createFakePi(["files_read", "files_write"]);
		const runtime = getToolsetRuntime(controls.pi);
		runtime.replaceProvider("mcp", [filesToolset(async () => ["files_read"])]);
		getAgentRuntimeComposition(controls.pi).reconcileActiveTools();

		await expect(runtime.activate("files")).rejects.toThrow(
			"provider activation catalog mismatch: files",
		);
		expect(controls.activeTools).toEqual(["activate_toolset"]);
		expect(runtime.getVisibleToolsets()).toHaveLength(1);
	});

	test("keeps provider and reconciliation failures deferred and retryable", async () => {
		const providerFailure = createFakePi(["files_read"]);
		const failedProviderRuntime = getToolsetRuntime(providerFailure.pi);
		failedProviderRuntime.replaceProvider("mcp", [
			filesToolset(async () => {
				throw new Error("provider failed");
			}),
		]);
		getAgentRuntimeComposition(providerFailure.pi).reconcileActiveTools();

		await expect(failedProviderRuntime.activate("files")).rejects.toThrow(
			"provider failed",
		);
		expect(failedProviderRuntime.getVisibleToolsets()).toHaveLength(1);
		expect(providerFailure.activeTools).toEqual(["activate_toolset"]);

		const reconciliationFailure = createFakePi(["files_read"]);
		const failedReconciliationRuntime = getToolsetRuntime(
			reconciliationFailure.pi,
		);
		failedReconciliationRuntime.replaceProvider("mcp", [filesToolset()]);
		getAgentRuntimeComposition(reconciliationFailure.pi).reconcileActiveTools();
		reconciliationFailure.failSetActiveToolsWhen = (names) =>
			names.includes("files_read");

		await expect(failedReconciliationRuntime.activate("files")).rejects.toThrow(
			"reconciliation failed",
		);
		expect(failedReconciliationRuntime.getVisibleToolsets()).toHaveLength(1);
		expect(reconciliationFailure.activeTools).toEqual(["activate_toolset"]);
	});

	test("rejects duplicate provider catalogs without replacing the prior catalog", () => {
		const controls = createFakePi(["files_read"]);
		const runtime = getToolsetRuntime(controls.pi);
		runtime.replaceProvider("mcp", [filesToolset()]);
		getAgentRuntimeComposition(controls.pi).reconcileActiveTools();

		expect(() =>
			runtime.replaceProvider("mcp", [filesToolset(), filesToolset()]),
		).toThrow("duplicate toolset name: files");
		expect(runtime.getVisibleToolsets()).toHaveLength(1);
		expect(controls.activeTools).toEqual(["activate_toolset"]);
	});

	test("replaces a provider catalog atomically when reconciliation fails", () => {
		const controls = createFakePi(["files_read"]);
		const runtime = getToolsetRuntime(controls.pi);
		runtime.replaceProvider("mcp", [filesToolset()]);
		getAgentRuntimeComposition(controls.pi).reconcileActiveTools();
		controls.failSetActiveToolsWhen = (names) =>
			!names.includes("activate_toolset");

		expect(() => runtime.replaceProvider("mcp", [])).toThrow(
			"reconciliation failed",
		);
		expect(runtime.getVisibleToolsets().map(({ name }) => name)).toEqual([
			"files",
		]);
		expect(controls.activeTools).toEqual(["activate_toolset"]);
	});

	test("shares one runtime across extension APIs in the same Pi session", () => {
		// Purpose: provider and prompt extensions must observe one deferred catalog and one restrictive filter.
		// Input and expected output: distinct APIs share an event bus; the second lookup returns the provider runtime, trigger, and active list.
		// Edge case: creating the prompt-side view must not overwrite the provider filter with an empty catalog.
		// Dependencies: Pi-like dynamic registration auto-activates new definitions and composition is shared through the event bus.
		const provider = createFakePi(["read", "files_read", "files_write"]);
		const providerRuntime = getToolsetRuntime(provider.pi);
		providerRuntime.replaceProvider("mcp", [filesToolset()]);
		getAgentRuntimeComposition(provider.pi).reconcileActiveTools();
		const promptPi = {
			...provider.pi,
			events: provider.pi.events,
			on() {},
		} as unknown as ExtensionAPI;

		const promptRuntime = getToolsetRuntime(promptPi);

		expect(promptRuntime).toBe(providerRuntime);
		expect(provider.activeTools).toEqual(["read", "activate_toolset"]);
		expect(promptRuntime.getVisibleToolsets()).toEqual([
			{
				name: "files",
				description: "Read project files",
				toolNames: ["files_read", "files_write"],
			},
		]);
	});

	test("isolates catalogs and activation state by ExtensionAPI", async () => {
		const first = createFakePi(["files_read"]);
		const second = createFakePi(["files_read"]);
		const firstRuntime = getToolsetRuntime(first.pi);
		const secondRuntime = getToolsetRuntime(second.pi);
		firstRuntime.replaceProvider("mcp", [filesToolset()]);
		secondRuntime.replaceProvider("mcp", [filesToolset()]);

		getAgentRuntimeComposition(first.pi).reconcileActiveTools();
		getAgentRuntimeComposition(second.pi).reconcileActiveTools();
		await firstRuntime.activate("files");
		expect(firstRuntime.getVisibleToolsets()).toEqual([]);
		expect(secondRuntime.getVisibleToolsets()).toHaveLength(1);
	});

	test("restores only the last valid version-1 snapshot on the active branch", async () => {
		const controls = createFakePi(["files_read"]);
		const runtime = getToolsetRuntime(controls.pi);
		runtime.replaceProvider("mcp", [filesToolset()]);
		let branch = [
			activationResult({ version: 1, activeToolsets: ["files"] }),
			activationResult({ version: 1, activeToolsets: "files" }),
			activationResult({ version: 2, activeToolsets: [] }),
		];
		const ctx = historyContext(controls, () => branch);

		await controls.emit("session_start", { type: "session_start" }, ctx);
		expect(controls.activeTools).toEqual(["files_read"]);
		expect(runtime.getVisibleToolsets()).toEqual([]);

		branch = [];
		await controls.emit("session_tree", { type: "session_tree" }, ctx);
		expect(controls.activeTools).toEqual(["activate_toolset"]);
		expect(runtime.getVisibleToolsets()).toHaveLength(1);
	});

	test("warns for stale snapshot names without breaking valid restoration", async () => {
		const controls = createFakePi(["files_read"]);
		const runtime = getToolsetRuntime(controls.pi);
		runtime.replaceProvider("mcp", [filesToolset()]);
		const branch = [
			activationResult({
				version: 1,
				activeToolsets: ["removed", "files"],
			}),
		];

		await controls.emit(
			"session_start",
			{ type: "session_start" },
			historyContext(controls, () => branch),
		);

		expect(controls.activeTools).toEqual(["files_read"]);
		expect(controls.notifications).toEqual([
			"[toolsets] ignored stale activated toolsets: removed",
		]);
	});
});

function activationResult(details: unknown): unknown {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "activate_toolset",
			isError: false,
			details,
		},
	};
}

function historyContext(
	controls: FakePiControls,
	getBranch: () => readonly unknown[],
): unknown {
	return {
		hasUI: true,
		sessionManager: { getBranch },
		ui: {
			notify(message: string) {
				controls.notifications.push(message);
			},
		},
	};
}
