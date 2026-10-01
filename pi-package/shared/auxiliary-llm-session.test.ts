import { expect, test } from "bun:test";
import { createAuxiliaryLlmSessionId } from "./auxiliary-llm-session";

const UUID_V7_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("creates a distinct UUIDv7 for each auxiliary LLM request", () => {
	const first = createAuxiliaryLlmSessionId();
	const second = createAuxiliaryLlmSessionId();

	expect(first).toMatch(UUID_V7_PATTERN);
	expect(second).toMatch(UUID_V7_PATTERN);
	expect(second).not.toBe(first);
});
