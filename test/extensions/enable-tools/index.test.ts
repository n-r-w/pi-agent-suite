import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import enableTools from "../../../pi-package/extensions/enable-tools/index";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: unknown;
}

interface ToolFake {
	readonly name: string;
}

interface ActiveToolSetCall {
	readonly names: readonly string[];
}

interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
	readonly setActiveToolsCalls: ActiveToolSetCall[];
	availableTools: readonly ToolFake[];
	activeTools: readonly string[];
}

interface Notification {
	readonly message: string;
	readonly type: string | undefined;
}

interface SessionContextFake {
	readonly hasUI: boolean;
	readonly notifications: Notification[];
	readonly ui: {
		notify(message: string, type: string | undefined): void;
	};
}

/** Creates the ExtensionAPI fake needed to observe active-tool updates. */
function createExtensionApiFake(options?: {
	readonly availableTools?: readonly ToolFake[];
	readonly activeTools?: readonly string[];
}): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];
	const setActiveToolsCalls: ActiveToolSetCall[] = [];

	return {
		handlers,
		setActiveToolsCalls,
		availableTools: options?.availableTools ?? [],
		activeTools: options?.activeTools ?? [],
		on(eventName: string, handler: unknown): void {
			handlers.push({ eventName, handler });
		},
		getAllTools(): readonly ToolFake[] {
			return this.availableTools;
		},
		getActiveTools(): readonly string[] {
			return this.activeTools;
		},
		setActiveTools(names: readonly string[]): void {
			setActiveToolsCalls.push({ names });
			this.activeTools = names;
		},
	} as ExtensionApiFake;
}

/** Creates a session context fake for invalid-config notifications. */
function createSessionContextFake(): SessionContextFake {
	const notifications: Notification[] = [];

	return {
		hasUI: true,
		notifications,
		ui: {
			notify(message: string, type: string | undefined): void {
				notifications.push({ message, type });
			},
		},
	};
}

/** Runs a test with an isolated pi agent directory so config reads never touch real user files. */
async function withIsolatedAgentDir<T>(
	action: (agentDir: string) => Promise<T>,
): Promise<T> {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const agentDir = await mkdtemp(join(tmpdir(), "pi-enable-tools-"));

	process.env[AGENT_DIR_ENV] = agentDir;
	try {
		return await action(agentDir);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env[AGENT_DIR_ENV];
		} else {
			process.env[AGENT_DIR_ENV] = previousAgentDir;
		}
		await rm(agentDir, { recursive: true, force: true });
	}
}

/** Writes enable-tools config into the isolated pi agent directory. */
async function writeConfig(agentDir: string, config: unknown): Promise<void> {
	await mkdir(join(agentDir, "config"), { recursive: true });
	await writeFile(
		join(agentDir, "config", "enable-tools.json"),
		JSON.stringify(config),
	);
}

/** Returns one registered event handler from the extension fake. */
function getRegisteredHandler(
	pi: ExtensionApiFake,
	eventName: string,
): (event: unknown, ctx: unknown) => Promise<void> | void {
	const handler = pi.handlers.find(
		(registeredHandler) => registeredHandler.eventName === eventName,
	)?.handler;
	if (typeof handler !== "function") {
		throw new Error(`expected ${eventName} handler to be registered`);
	}

	return handler as (event: unknown, ctx: unknown) => Promise<void> | void;
}

describe("enable-tools", () => {
	test("enables default search tools on session start while preserving active tools", async () => {
		// Purpose: missing config must keep the extension useful with default search tools.
		// Input and expected output: registered grep, find, and ls are appended to the existing active tool list.
		// Edge case: an unrelated registered tool stays inactive unless it was already active.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake and a temp agent directory.
		await withIsolatedAgentDir(async () => {
			const pi = createExtensionApiFake({
				availableTools: [
					{ name: "read" },
					{ name: "grep" },
					{ name: "find" },
					{ name: "ls" },
				],
				activeTools: ["read"],
			});
			enableTools(pi);

			await getRegisteredHandler(pi, "session_start")(
				{},
				createSessionContextFake(),
			);

			expect(pi.setActiveToolsCalls).toEqual([
				{ names: ["read", "grep", "find", "ls"] },
			]);
		});
	});

	test("applies configured include and exclude lists with exclude taking precedence", async () => {
		// Purpose: include and exclude must let users choose exactly which registered tools this extension enables.
		// Input and expected output: include read, grep, ls and exclude ls results in read and grep being active.
		// Edge case: exclude wins over include for the same tool name.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake, temp config file, and temp agent directory.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				include: ["read", "grep", "ls"],
				exclude: ["ls"],
			});
			const pi = createExtensionApiFake({
				availableTools: [
					{ name: "read" },
					{ name: "grep" },
					{ name: "find" },
					{ name: "ls" },
				],
				activeTools: [],
			});
			enableTools(pi);

			await getRegisteredHandler(pi, "session_start")(
				{},
				createSessionContextFake(),
			);

			expect(pi.setActiveToolsCalls).toEqual([{ names: ["read", "grep"] }]);
		});
	});

	test("does not change active tools when disabled", async () => {
		// Purpose: enabled false must let users disable all behavior owned by this extension.
		// Input and expected output: a disabled config leaves active tools unchanged and does not call setActiveTools.
		// Edge case: registered search tools are available but must not be enabled.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake, temp config file, and temp agent directory.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { enabled: false });
			const pi = createExtensionApiFake({
				availableTools: [{ name: "grep" }, { name: "find" }, { name: "ls" }],
				activeTools: [],
			});
			enableTools(pi);

			await getRegisteredHandler(pi, "session_start")(
				{},
				createSessionContextFake(),
			);

			expect(pi.setActiveToolsCalls).toEqual([]);
		});
	});

	test("fails closed and reports invalid config", async () => {
		// Purpose: invalid config must not enable extra tools and must show an isolated extension warning.
		// Input and expected output: unsupported keys leave active tools unchanged and notify the user.
		// Edge case: config parsing succeeds but strict key validation fails.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake, temp config file, and fake UI notification sink.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { enabled: true, tools: ["grep"] });
			const pi = createExtensionApiFake({
				availableTools: [{ name: "grep" }],
				activeTools: [],
			});
			const ctx = createSessionContextFake();
			enableTools(pi);

			await getRegisteredHandler(pi, "session_start")({}, ctx);

			expect(pi.setActiveToolsCalls).toEqual([]);
			expect(ctx.notifications).toEqual([
				{
					message: "[enable-tools] config contains unsupported keys",
					type: "warning",
				},
			]);
		});
	});
});
