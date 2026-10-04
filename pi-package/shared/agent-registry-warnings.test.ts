import { describe, expect, spyOn, test } from "bun:test";
import {
	createEventBus,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentRegistryWarningContext,
	getAgentRegistryWarningReporter,
} from "./agent-registry-warnings";

/** Creates separate extension APIs that communicate through the same runtime bus. */
function createExtensionApis(): [ExtensionAPI, ExtensionAPI] {
	const events = createEventBus();
	return [{ events }, { events }] as unknown as [ExtensionAPI, ExtensionAPI];
}

/** Builds a notification context with an explicit session identity. */
function createContext(
	sessionId: string,
	hasUI = true,
): AgentRegistryWarningContext & { notifications: string[] } {
	const notifications: string[] = [];
	return {
		hasUI,
		notifications,
		ui: {
			notify(message, type) {
				expect(type).toBe("warning");
				notifications.push(message);
			},
		},
		sessionManager: { getSessionId: () => sessionId },
	};
}

describe("agent registry warning reporter", () => {
	test("reports the same warning once across two extensions and preserves distinct errors", () => {
		const [main, subagents] = createExtensionApis();
		const ctx = createContext("session");
		const first = getAgentRegistryWarningReporter(main, ctx);
		const second = getAgentRegistryWarningReporter(subagents, ctx);
		first("Broken.md: invalid tools");
		second("Broken.md: invalid tools");
		second("Broken.md: invalid model");
		expect(ctx.notifications).toHaveLength(2);
		expect(ctx.notifications[0]).toContain("invalid tools");
		expect(ctx.notifications[1]).toContain("invalid model");
	});

	test("reports independently for isolated Pi runtimes", () => {
		const [first] = createExtensionApis();
		const [second] = createExtensionApis();
		const firstContext = createContext("session");
		const secondContext = createContext("session");
		getAgentRegistryWarningReporter(first, firstContext)("Broken.md");
		getAgentRegistryWarningReporter(second, secondContext)("Broken.md");
		expect(firstContext.notifications).toHaveLength(1);
		expect(secondContext.notifications).toHaveLength(1);
	});

	test("reports the warning again in a new session and uses the latest context", () => {
		const [pi] = createExtensionApis();
		const first = createContext("first");
		const second = createContext("second");
		const report = getAgentRegistryWarningReporter(pi, first);
		report("Broken.md");
		getAgentRegistryWarningReporter(pi, second);
		report("Broken.md");
		getAgentRegistryWarningReporter(pi)("Broken.md");
		expect(first.notifications).toHaveLength(1);
		expect(second.notifications).toHaveLength(1);
	});

	test("writes one warning to stderr when only a non-interactive extension is loaded", () => {
		const [pi] = createExtensionApis();
		const ctx = createContext("session", false);
		const stderr = spyOn(process.stderr, "write").mockImplementation(
			() => true,
		);
		try {
			const report = getAgentRegistryWarningReporter(pi, ctx);
			report("Broken.md");
			report("Broken.md");
			expect(stderr).toHaveBeenCalledTimes(1);
			expect(stderr.mock.calls[0]?.[0]).toContain("Broken.md");
			expect(ctx.notifications).toEqual([]);
		} finally {
			stderr.mockRestore();
		}
	});
});
