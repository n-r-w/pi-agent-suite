import { expect, test } from "bun:test";
import packageManifest from "../../package.json";

test("registers usage after agent identity providers", () => {
	// Purpose: ensure usage observes main-agent and subagent identity initialization before it runs.
	// Inputs and expected output: the package extension list places usage after main-agent-selection and run-subagent.
	// Edge case: usage must still occur only once in package registration.
	// Dependencies: the published pi-package manifest.
	const extensions = packageManifest.pi.extensions;
	const usageIndex = extensions.indexOf("./extensions/usage/index.ts");

	expect(
		extensions.filter((entry) => entry === "./extensions/usage/index.ts"),
	).toHaveLength(1);
	expect(usageIndex).toBeGreaterThan(
		extensions.indexOf("./extensions/main-agent-selection/index.ts"),
	);
	expect(usageIndex).toBeGreaterThan(
		extensions.indexOf("./extensions/run-subagent/index.ts"),
	);
});
