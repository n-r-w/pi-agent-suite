import { expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type * as RuntimeCompositionModule from "../../pi-package/shared/agent-runtime-composition";

interface HandlerRecord {
	readonly event: "before_agent_start";
	readonly handler: (
		event: { readonly systemPrompt: string },
		ctx: unknown,
	) => unknown;
}

/** Creates the ExtensionAPI subset needed by runtime composition tests. */
function createCompositionApiFake(): {
	readonly pi: ExtensionAPI;
	readonly handlers: HandlerRecord[];
} {
	const handlers: HandlerRecord[] = [];
	const pi = {
		events: {
			emit() {},
			on() {
				return () => {};
			},
		},
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
	Object.defineProperty(pi.events, "__piHarnessAgentRuntimeCompositionV3", {
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
	expect(handlers).toHaveLength(1);
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
	expect(handlers).toHaveLength(1);
	expect(await handlers[0]?.handler({ systemPrompt: "Base" }, {})).toEqual({
		systemPrompt: "Base\n\nMain prompt\n\nhelper\n\nCouncil prompt",
	});
});
