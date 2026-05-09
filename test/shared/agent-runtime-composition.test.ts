import { expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type * as RuntimeCompositionModule from "../../pi-package/shared/agent-runtime-composition";

interface HandlerRecord {
	readonly event: "before_agent_start";
	readonly handler: (
		event: { readonly systemPrompt: string },
		ctx: unknown,
	) => unknown;
}

/** Creates the ExtensionAPI subset needed by runtime composition tests. */
function createCompositionApiFake(
	events: ExtensionAPI["events"] = createEventBusFake(),
): {
	readonly pi: ExtensionAPI;
	readonly handlers: HandlerRecord[];
} {
	const handlers: HandlerRecord[] = [];
	const pi = {
		events,
		on(event: "before_agent_start", handler: HandlerRecord["handler"]) {
			handlers.push({ event, handler });
		},
		getActiveTools() {
			return [];
		},
		setActiveTools() {},
	} as unknown as ExtensionAPI;

	return { pi, handlers };
}

/** Creates the shared event bus surface used by isolated ExtensionAPI fakes. */
function createEventBusFake(): ExtensionAPI["events"] {
	return {
		emit() {},
		on() {
			return () => {};
		},
	} as ExtensionAPI["events"];
}

/** Imports a fresh module instance to reproduce pi package entry-point isolation. */
async function importIsolatedRuntimeCompositionModule(
	isolateId: string,
): Promise<typeof RuntimeCompositionModule> {
	const moduleUrl = pathToFileURL(
		join(process.cwd(), "pi-package/shared/agent-runtime-composition.ts"),
	).href;
	return (await import(
		`${moduleUrl}?runtime-composition-test=${isolateId}-${Date.now()}`
	)) as typeof RuntimeCompositionModule;
}

test("does not reuse stale runtime composition objects from previous reloads", async () => {
	// Purpose: /reload must not reuse an older runtime composition object that lacks newly added methods.
	// Input and expected output: an old singleton at the previous event-bus key is ignored and a new composition with council contribution support is created.
	// Edge case: the stale property may be non-configurable because previous versions stored it as a permanent event-bus property.
	// Dependencies: this test uses the real shared module and an ExtensionAPI fake.
	const { pi, handlers } = createCompositionApiFake();
	Object.defineProperty(pi.events, "__piHarnessAgentRuntimeCompositionV4", {
		configurable: false,
		enumerable: false,
		value: {
			setRunSubagentContribution() {},
		},
		writable: false,
	});

	const module = await importIsolatedRuntimeCompositionModule("stale");
	const composition = module.getAgentRuntimeComposition(pi);

	expect(typeof composition.setRunSubagentActiveToolFilter).toBe("function");
	expect(typeof composition.setConveneCouncilContribution).toBe("function");
	expect(
		handlers.filter((handler) => handler.event === "before_agent_start"),
	).toHaveLength(1);
});

test("creates a fresh runtime composition after shutdown marks the previous runtime stale", async () => {
	// Purpose: /reload must not reuse a composition whose before_agent_start handler belongs to the previous ExtensionAPI.
	// Input and expected output: after session_shutdown, a second ExtensionAPI fake sharing the same event bus receives a new handler and composes its own prompt.
	// Edge case: the first and second runtime objects use the same shared event bus object, matching the observed stale-storage failure.
	// Dependencies: this test uses only the shared runtime-composition module and in-memory ExtensionAPI fakes.
	const module = await importIsolatedRuntimeCompositionModule("reload");
	const events = createEventBusFake();
	const first = createCompositionApiFake(events);
	const second = createCompositionApiFake(events);

	const firstComposition = module.getAgentRuntimeComposition(first.pi);
	firstComposition.setMainAgentContribution({
		prompt: "Old main prompt",
		agent: { id: "old" },
	});
	module.markAgentRuntimeCompositionStale(first.pi);

	const secondComposition = module.getAgentRuntimeComposition(second.pi);
	secondComposition.setMainAgentContribution({
		prompt: "New main prompt",
		agent: { id: "new" },
	});

	expect(
		first.handlers.filter((handler) => handler.event === "before_agent_start"),
	).toHaveLength(1);
	expect(
		second.handlers.filter((handler) => handler.event === "before_agent_start"),
	).toHaveLength(1);
	expect(secondComposition.getMainAgentContribution()?.agent?.id).toBe("new");
	const secondPromptHandler = second.handlers.find(
		(handler) => handler.event === "before_agent_start",
	)?.handler;
	expect(await secondPromptHandler?.({ systemPrompt: "Base" }, {})).toEqual({
		systemPrompt: "Base\n\nNew main prompt",
	});
});

test("shares one runtime composition across isolated module instances", async () => {
	// Purpose: split pi package entry points must coordinate through one runtime composition even when the shared module is loaded more than once.
	// Input and expected output: isolated modules set main-agent, run-subagent, and council contributions, and one handler composes all.
	// Edge case: duplicate module instances must not create duplicate before_agent_start handlers with disconnected state.
	// Dependencies: this test uses Bun dynamic imports and an ExtensionAPI fake; it does not depend on extension load order.
	const moduleA = await importIsolatedRuntimeCompositionModule("a");
	const moduleB = await importIsolatedRuntimeCompositionModule("b");
	const { pi, handlers } = createCompositionApiFake();

	const compositionA = moduleA.getAgentRuntimeComposition(pi);
	const compositionB = moduleB.getAgentRuntimeComposition(pi);
	compositionA.setMainAgentContribution({
		prompt: "Main prompt",
		agent: { id: "main", agents: ["helper"] },
	});
	compositionB.setRunSubagentContribution({
		buildPrompt: () =>
			compositionB.getMainAgentContribution()?.agent?.agents?.join(","),
	});
	compositionB.setConveneCouncilContribution({ prompt: "Council prompt" });

	expect(compositionB.getMainAgentContribution()?.agent?.agents).toEqual([
		"helper",
	]);
	expect(
		handlers.filter((handler) => handler.event === "before_agent_start"),
	).toHaveLength(1);
	const promptHandler = handlers.find(
		(handler) => handler.event === "before_agent_start",
	)?.handler;
	expect(await promptHandler?.({ systemPrompt: "Base" }, {})).toEqual({
		systemPrompt: "Base\n\nMain prompt\n\nhelper\n\nCouncil prompt",
	});
});
