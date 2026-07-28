import { describe, expect, test } from "bun:test";
import { readCancellationError } from "./cancellation-reason";

describe("readCancellationError", () => {
	test("preserves Error identity and wraps non-Error or absent reasons", () => {
		// Purpose: every runtime cancellation path must expose one normalization rule.
		// Input and expected output: Error remains identical; string and absent reasons use the stable message and cause.
		// Edge case: optional signal support must preserve the coordinator's undefined-reason behavior.
		// Dependencies: AbortController and the shared production cancellation owner.
		const identityController = new AbortController();
		const identityReason = new Error("identity reason");
		identityController.abort(identityReason);
		const stringController = new AbortController();
		stringController.abort("string reason");
		const stringResult = readCancellationError(stringController.signal);
		const absentResult = readCancellationError();

		expect({
			identity:
				readCancellationError(identityController.signal) === identityReason,
			stringMessage: stringResult.message,
			stringCause: stringResult.cause,
			absentMessage: absentResult.message,
			absentCause: absentResult.cause,
		}).toEqual({
			identity: true,
			stringMessage: "Pi operation was aborted",
			stringCause: "string reason",
			absentMessage: "Pi operation was aborted",
			absentCause: undefined,
		});
	});
});
