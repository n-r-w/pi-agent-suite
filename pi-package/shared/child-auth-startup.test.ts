import { describe, expect, test } from "bun:test";
import {
	ChildAuthStartupRetryError,
	createChildAuthStartupRetryError,
	normalizeChildPrompt,
} from "./child-auth-startup";

const NO_OPENAI_API_KEY_ERROR = `No API key found for openai.\n\nUse /login to log into a provider via OAuth or API key.`;

describe("child auth startup recovery", () => {
	test("normalizes leading command markers before child prompt delivery", () => {
		// Purpose: child tasks must never enter Pi's extension-command path.
		// Input and expected output: every contiguous leading slash is removed while other content stays unchanged.
		// Edge case: slash characters after the first non-slash character are preserved.
		// Dependencies: prompt normalization is a pure shared boundary function.
		expect(normalizeChildPrompt("///review /tmp/input")).toBe(
			"review /tmp/input",
		);
		expect(normalizeChildPrompt(" review /tmp/input")).toBe(
			" review /tmp/input",
		);
		expect(() => normalizeChildPrompt("///")).toThrow(
			"child prompt must contain text after leading '/' characters",
		);
		expect(() => normalizeChildPrompt("/// \n\t")).toThrow(
			"child prompt must contain text after leading '/' characters",
		);
		expect(normalizeChildPrompt("///  review")).toBe("  review");
	});

	test("classifies only a verified prompt rejection without child activity", () => {
		// Purpose: every launcher must use the same lifecycle-based retry decision.
		// Input and expected output: only a provider-matching RPC rejection after parent auth is retryable.
		// Edge case: raw child activity, missing parent verification, and unrelated errors prevent retry.
		// Dependencies: shared error matching and retry marker creation.
		const failure = new Error(NO_OPENAI_API_KEY_ERROR);
		const retryable = createChildAuthStartupRetryError({
			activityObserved: false,
			failure,
			parentAuthVerified: true,
			provider: "openai",
		});

		expect(retryable).toBeInstanceOf(ChildAuthStartupRetryError);
		expect(retryable?.failure).toBe(failure);
		expect(
			createChildAuthStartupRetryError({
				activityObserved: true,
				failure,
				parentAuthVerified: true,
				provider: "openai",
			}),
		).toBeUndefined();
		expect(
			createChildAuthStartupRetryError({
				activityObserved: false,
				failure,
				parentAuthVerified: false,
				provider: "openai",
			}),
		).toBeUndefined();
		expect(
			createChildAuthStartupRetryError({
				activityObserved: false,
				failure: new Error("prompt rejected"),
				parentAuthVerified: true,
				provider: "openai",
			}),
		).toBeUndefined();
	});
});
