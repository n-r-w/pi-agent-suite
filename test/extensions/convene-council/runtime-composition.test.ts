import { describe, expect, test } from "bun:test";
import conveneCouncil from "../../../pi-package/extensions/convene-council/index";
import {
	withIsolatedAgentDir,
	writeConfig,
	writeRawConfig,
} from "./support/env";
import { createExtensionApiFake, type ExtensionApiFake } from "./support/fakes";

/** Emits before-agent-start handlers in registration order and returns the latest non-empty result. */
async function emitBeforeAgentStartHandlers(
	pi: ExtensionApiFake,
	event: { readonly systemPrompt: string },
): Promise<unknown> {
	let result: unknown;
	for (const handler of pi.handlers
		.filter((item) => item.eventName === "before_agent_start")
		.map((item) => item.handler)) {
		if (typeof handler !== "function") {
			continue;
		}
		const nextResult = await handler(event, {});
		if (nextResult !== undefined) {
			result = nextResult;
		}
	}
	return result;
}

describe("convene-council runtime composition", () => {
	test("adds runtime guidance only when convene_council is active", async () => {
		// Purpose: main prompt guidance must be tool-gated and come from the real extension contribution.
		// Input and expected output: active convene_council appends guidance, inactive tool omits it.
		// Edge case: the extension registers its own before_agent_start handler before runtime composition resolves prompts.
		// Dependencies: in-memory ExtensionAPI fake and isolated prompt-file loading.
		await withIsolatedAgentDir(async () => {
			const pi = createExtensionApiFake();
			conveneCouncil(pi);

			pi.setActiveTools([]);
			expect(
				await emitBeforeAgentStartHandlers(pi, { systemPrompt: "Base" }),
			).toBeUndefined();

			pi.setActiveTools(["convene_council"]);
			const result = (await emitBeforeAgentStartHandlers(pi, {
				systemPrompt: "Base",
			})) as { readonly systemPrompt: string };

			expect(result.systemPrompt).toStartWith("Base\n\n");
			expect(result.systemPrompt.length).toBeGreaterThan("Base\n\n".length);
		});
	});

	test("does not add runtime guidance when config is invalid", async () => {
		// Purpose: invalid config must not publish guidance for a tool that will fail at execution.
		// Input and expected output: invalid parsed config and malformed JSON both produce no council guidance.
		// Edge case: active tools include convene_council, so config state is the only suppression reason.
		// Dependencies: isolated suite config and in-memory ExtensionAPI fake.
		const cases: ReadonlyArray<{
			readonly name: string;
			readonly write: (agentDir: string) => Promise<void>;
		}> = [
			{
				name: "invalid parsed config",
				write: (agentDir) => writeConfig(agentDir, { enabled: "yes" }),
			},
			{
				name: "malformed JSON",
				write: (agentDir) => writeRawConfig(agentDir, "{"),
			},
		];

		for (const testCase of cases) {
			await withIsolatedAgentDir(async (agentDir) => {
				await testCase.write(agentDir);
				const pi = createExtensionApiFake();

				conveneCouncil(pi);
				pi.setActiveTools(["convene_council"]);

				expect(
					await emitBeforeAgentStartHandlers(pi, {
						systemPrompt: `Base ${testCase.name}`,
					}),
				).toBeUndefined();
			});
		}
	});

	test("does not add runtime guidance when config disables the tool", async () => {
		// Purpose: disabled config must not leave prompt guidance for an unavailable tool.
		// Input and expected output: enabled false registers no contribution even if active tools include convene_council.
		// Edge case: active-tool state can be stale or externally forced in tests.
		// Dependencies: isolated suite config and in-memory ExtensionAPI fake.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { enabled: false });
			const pi = createExtensionApiFake();

			conveneCouncil(pi);
			pi.setActiveTools(["convene_council"]);

			expect(
				await emitBeforeAgentStartHandlers(pi, { systemPrompt: "Base" }),
			).toBeUndefined();
		});
	});
});
