import type { RemoteImageConfig } from "./index.ts";

const DEFAULT_IMAGE_PORT = 18_775;
const MIN_PORT = 1;
const MAX_PORT = 65_535;
const DECIMAL_INTEGER_PATTERN = /^\d+$/;

export function readRemoteImageConfig(
	environment: Readonly<Record<string, string | undefined>> = process.env,
): RemoteImageConfig {
	if (environment["PI_AGENT_SUITE_MODE"] !== "remote") {
		return { kind: "disabled" };
	}

	const configuredPort = environment["PI_AGENT_SUITE_IMAGE_PORT"];
	if (configuredPort === undefined || configuredPort.length === 0) {
		return { kind: "enabled", port: DEFAULT_IMAGE_PORT };
	}
	if (!DECIMAL_INTEGER_PATTERN.test(configuredPort)) {
		return invalidPort();
	}

	const port = Number(configuredPort);
	if (!Number.isSafeInteger(port) || port < MIN_PORT || port > MAX_PORT) {
		return invalidPort();
	}
	return { kind: "enabled", port };
}

function invalidPort(): RemoteImageConfig {
	return {
		kind: "invalid",
		issue: "PI_AGENT_SUITE_IMAGE_PORT must be an integer from 1 to 65535",
	};
}
