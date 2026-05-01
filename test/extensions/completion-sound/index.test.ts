import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import completionSound from "../../../pi-package/extensions/completion-sound/index";
import {
	SUBAGENT_AGENT_ID_ENV,
	SUBAGENT_DEPTH_ENV,
} from "../../../pi-package/shared/subagent-environment";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: unknown;
}

interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
}

interface PlaybackCall {
	readonly command: string;
	readonly args: readonly string[];
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

/** Creates the ExtensionAPI fake needed to invoke registered lifecycle handlers. */
function createExtensionApiFake(): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];

	return {
		handlers,
		on(eventName: string, handler: unknown): void {
			handlers.push({ eventName, handler });
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
	const previousAgentSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
	const agentDir = await mkdtemp(join(tmpdir(), "pi-completion-sound-"));

	process.env[AGENT_DIR_ENV] = agentDir;
	delete process.env[AGENT_SUITE_DIR_ENV];
	try {
		return await action(agentDir);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env[AGENT_DIR_ENV];
		} else {
			process.env[AGENT_DIR_ENV] = previousAgentDir;
		}
		if (previousAgentSuiteDir === undefined) {
			delete process.env[AGENT_SUITE_DIR_ENV];
		} else {
			process.env[AGENT_SUITE_DIR_ENV] = previousAgentSuiteDir;
		}
		await rm(agentDir, { recursive: true, force: true });
	}
}

/** Writes completion-sound config into the isolated pi agent directory. */
async function writeConfig(agentDir: string, config: unknown): Promise<void> {
	await mkdir(join(agentDir, "agent-suite", "completion-sound"), {
		recursive: true,
	});
	await writeFile(
		join(agentDir, "agent-suite", "completion-sound", "config.json"),
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

/** Registers the extension with fake playback dependencies. */
function registerExtension(options: {
	readonly env: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly playbackCalls: PlaybackCall[];
}): ExtensionApiFake {
	const pi = createExtensionApiFake();
	completionSound(pi, {
		env: options.env,
		platform: options.platform ?? "darwin",
		play(command, args): void {
			options.playbackCalls.push({ command, args });
		},
	});

	return pi;
}

describe("completion-sound", () => {
	test("plays the default completion sound when the top-level agent ends", async () => {
		// Purpose: top-level agent completion must produce one audible notification.
		// Input and expected output: agent_end without subagent env plays the default macOS system sound.
		// Edge case: missing config still enables the extension with the platform default playback command.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake, fake playback sink, and temp agent directory.
		await withIsolatedAgentDir(async () => {
			const playbackCalls: PlaybackCall[] = [];
			const pi = registerExtension({ env: {}, playbackCalls });

			await getRegisteredHandler(pi, "agent_end")(
				{},
				createSessionContextFake(),
			);

			expect(playbackCalls).toEqual([
				{
					command: "afplay",
					args: ["/System/Library/Sounds/Glass.aiff"],
				},
			]);
		});
	});

	test("does not play when the current process has a subagent id", async () => {
		// Purpose: child subagent completion must not duplicate the top-level completion sound.
		// Input and expected output: PI_SUBAGENT_AGENT_ID suppresses playback.
		// Edge case: the env variable is present even if no depth value is present.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake, fake playback sink, and temp agent directory.
		await withIsolatedAgentDir(async () => {
			const playbackCalls: PlaybackCall[] = [];
			const pi = registerExtension({
				env: { [SUBAGENT_AGENT_ID_ENV]: "Reviewer" },
				playbackCalls,
			});

			await getRegisteredHandler(pi, "agent_end")(
				{},
				createSessionContextFake(),
			);

			expect(playbackCalls).toEqual([]);
		});
	});

	test("does not play when the current process has a subagent depth", async () => {
		// Purpose: child subagent completion must be suppressed even when only depth propagation is visible.
		// Input and expected output: PI_SUBAGENT_DEPTH suppresses playback.
		// Edge case: depth value zero is still a child-process marker when the variable exists.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake, fake playback sink, and temp agent directory.
		await withIsolatedAgentDir(async () => {
			const playbackCalls: PlaybackCall[] = [];
			const pi = registerExtension({
				env: { [SUBAGENT_DEPTH_ENV]: "0" },
				playbackCalls,
			});

			await getRegisteredHandler(pi, "agent_end")(
				{},
				createSessionContextFake(),
			);

			expect(playbackCalls).toEqual([]);
		});
	});

	test("uses configured playback command and arguments", async () => {
		// Purpose: users must be able to choose the sound player and sound file without changing code.
		// Input and expected output: configured command and args are passed to the playback dependency.
		// Edge case: custom config replaces the platform default command and default args.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake, temp config file, fake playback sink, and temp agent directory.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: true,
				command: "custom-player",
				args: ["--volume", "25", "/tmp/done.wav"],
			});
			const playbackCalls: PlaybackCall[] = [];
			const pi = registerExtension({ env: {}, playbackCalls });

			await getRegisteredHandler(pi, "agent_end")(
				{},
				createSessionContextFake(),
			);

			expect(playbackCalls).toEqual([
				{
					command: "custom-player",
					args: ["--volume", "25", "/tmp/done.wav"],
				},
			]);
		});
	});

	test("does not play when disabled", async () => {
		// Purpose: enabled false must let users disable all behavior owned by this extension.
		// Input and expected output: disabled config prevents playback on agent_end.
		// Edge case: command and args can be valid but still disabled by enabled false.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake, temp config file, fake playback sink, and temp agent directory.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, {
				enabled: false,
				command: "custom-player",
				args: ["/tmp/done.wav"],
			});
			const playbackCalls: PlaybackCall[] = [];
			const pi = registerExtension({ env: {}, playbackCalls });

			await getRegisteredHandler(pi, "agent_end")(
				{},
				createSessionContextFake(),
			);

			expect(playbackCalls).toEqual([]);
		});
	});

	test("does not throw when playback fails", async () => {
		// Purpose: sound playback failures must not interrupt the agent lifecycle.
		// Input and expected output: a throwing playback dependency is swallowed by the agent_end handler.
		// Edge case: the failure happens after valid config resolution and before the handler returns.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake, throwing playback dependency, and temp agent directory.
		await withIsolatedAgentDir(async () => {
			const pi = createExtensionApiFake();
			completionSound(pi, {
				env: {},
				platform: "darwin",
				play(): void {
					throw new Error("playback failed");
				},
			});

			await expect(
				getRegisteredHandler(pi, "agent_end")({}, createSessionContextFake()),
			).resolves.toBeUndefined();
		});
	});

	test("fails closed and reports invalid config on session start", async () => {
		// Purpose: invalid config must not play sound and must show an isolated extension warning.
		// Input and expected output: unsupported keys suppress playback and notify the user at session start.
		// Edge case: config parsing succeeds but strict key validation fails.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake, temp config file, fake playback sink, and fake UI notification sink.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { enabled: true, sound: "legacy" });
			const playbackCalls: PlaybackCall[] = [];
			const ctx = createSessionContextFake();
			const pi = registerExtension({ env: {}, playbackCalls });

			await getRegisteredHandler(pi, "session_start")({}, ctx);
			await getRegisteredHandler(pi, "agent_end")({}, ctx);

			expect(playbackCalls).toEqual([]);
			expect(ctx.notifications).toEqual([
				{
					message: "[completion-sound] config contains unsupported keys",
					type: "warning",
				},
			]);
		});
	});
});
