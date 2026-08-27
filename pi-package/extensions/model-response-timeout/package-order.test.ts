import { describe, expect, test } from "bun:test";
import packageJson from "../../package.json" with { type: "json" };

const MODEL_RESPONSE_TIMEOUT_EXTENSION =
	"./extensions/model-response-timeout/index.ts";

describe("model response timeout package registration", () => {
	test("loads the global timeout extension exactly once", () => {
		// Purpose: prove that main and child Pi package loads share one timeout registration.
		// Input and expected output: the package extension list contains the timeout entry once.
		// Edge case: duplicate registration would create competing timers and duplicate timeout handling.
		// Dependencies: Pi package extension registration.
		expect(
			packageJson.pi.extensions.filter(
				(extension) => extension === MODEL_RESPONSE_TIMEOUT_EXTENSION,
			),
		).toHaveLength(1);
	});
});
