import { describe, expect, test } from "bun:test";
import { readRemoteImageConfig } from "./environment.ts";

describe("readRemoteImageConfig", () => {
	test("enables remote mode with the default port", () => {
		// Purpose: remote pi needs a zero-configuration image port.
		// Input and expected output: remote mode without a port selects 18775.
		// Edge case: the optional port setting is absent.
		// Dependencies: none.
		expect(readRemoteImageConfig({ PI_AGENT_SUITE_MODE: "remote" })).toEqual({
			kind: "enabled",
			port: 18775,
		});
	});

	test("accepts a valid custom port", () => {
		// Purpose: users must be able to match a non-default helper port.
		// Input and expected output: a decimal port in range is returned as a number.
		// Edge case: the maximum TCP port is valid.
		// Dependencies: none.
		expect(
			readRemoteImageConfig({
				PI_AGENT_SUITE_MODE: "remote",
				PI_AGENT_SUITE_IMAGE_PORT: "65535",
			}),
		).toEqual({ kind: "enabled", port: 65535 });
	});

	test("rejects an invalid remote image port", () => {
		// Purpose: invalid ports must fail clearly instead of producing broken request URLs.
		// Input and expected output: a value above 65535 returns a configuration issue.
		// Edge case: upper-bound overflow.
		// Dependencies: none.
		expect(
			readRemoteImageConfig({
				PI_AGENT_SUITE_MODE: "remote",
				PI_AGENT_SUITE_IMAGE_PORT: "65536",
			}),
		).toEqual({
			kind: "invalid",
			issue: "PI_AGENT_SUITE_IMAGE_PORT must be an integer from 1 to 65535",
		});
	});

	test("disables all modes except remote", () => {
		// Purpose: local pi must retain native image paste behavior.
		// Input and expected output: local and missing mode values disable the extension.
		// Edge case: an unknown mode is not treated as remote.
		// Dependencies: none.
		expect(readRemoteImageConfig({})).toEqual({ kind: "disabled" });
		expect(readRemoteImageConfig({ PI_AGENT_SUITE_MODE: "local" })).toEqual({
			kind: "disabled",
		});
	});
});
