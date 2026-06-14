import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codexFast from "./index.ts";

const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";

type BeforeProviderRequestHandler = (
	event: ProviderRequestEventFake,
	ctx: ExtensionContextFake,
) => unknown;
type CommandHandler = (
	_args: string,
	ctx: ExtensionContextFake,
) => void | Promise<void>;
type ShortcutHandler = (ctx: ExtensionContextFake) => void | Promise<void>;
type SessionHandler = (
	_event: unknown,
	ctx: ExtensionContextFake,
) => void | Promise<void>;

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: unknown;
}

interface RegisteredCommandFake {
	readonly name: string;
	readonly handler: CommandHandler;
}

interface RegisteredShortcutFake {
	readonly shortcut: string;
	readonly handler: ShortcutHandler;
}

interface ExtensionApiFake {
	readonly handlers: RegisteredHandler[];
	readonly commands: RegisteredCommandFake[];
	readonly shortcuts: RegisteredShortcutFake[];
	registerCommand(
		name: string,
		options: { readonly handler: CommandHandler },
	): void;
	registerShortcut(
		shortcut: string,
		options: { readonly handler: ShortcutHandler },
	): void;
	on(eventName: string, handler: unknown): void;
}

interface ProviderRequestEventFake {
	readonly payload: unknown;
}

interface ExtensionContextFake {
	readonly hasUI?: boolean;
	readonly model?: {
		readonly provider?: string;
		readonly id?: string;
	};
	readonly ui: {
		readonly theme: {
			fg(color: string, value: string): string;
		};
		setStatus(key: string, value: string | undefined): void;
		notify(message: string, level: string): void;
	};
}

const tempDirs: string[] = [];
const previousAgentSuiteDir = process.env[AGENT_SUITE_DIR_ENV];

afterEach(async () => {
	if (previousAgentSuiteDir === undefined) {
		delete process.env[AGENT_SUITE_DIR_ENV];
	} else {
		process.env[AGENT_SUITE_DIR_ENV] = previousAgentSuiteDir;
	}

	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("codex-fast", () => {
	test("registers the fast command and Ctrl+Alt+F shortcut", () => {
		// Purpose: users must have both slash-command and keyboard access to fast mode.
		// Input and expected output: extension registration exposes `/fast` and `ctrl+alt+f`.
		// Edge case: registration succeeds without any existing state file.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake.
		const pi = createExtensionApiFake();

		codexFast(pi as unknown as ExtensionAPI);

		expect(pi.commands.map(({ name }) => name)).toEqual(["fast"]);
		expect(pi.shortcuts.map(({ shortcut }) => shortcut)).toEqual([
			"ctrl+alt+f",
		]);
	});

	test("keeps fast mode disabled by default", async () => {
		// Purpose: fast mode must not affect provider requests until the user enables it.
		// Input and expected output: supported Codex request before toggling returns undefined.
		// Edge case: missing persisted state means disabled.
		// Dependencies: this test uses isolated temp storage and in-memory fakes.
		await withIsolatedSuiteDir(async () => {
			const pi = createExtensionApiFake();
			codexFast(pi as unknown as ExtensionAPI);
			await getSessionStartHandler(pi)({}, createContextFake());

			const result = await getBeforeProviderRequestHandler(pi)(
				{ payload: { input: "hello" } },
				createContextFake(),
			);

			expect(result).toBeUndefined();
		});
	});

	test("toggles fast mode through command and injects priority service tier for supported Codex models", async () => {
		// Purpose: `/fast` must enable the provider payload change for supported Codex models.
		// Input and expected output: openai-codex/gpt-5.5 request receives service_tier priority.
		// Edge case: existing payload fields are preserved.
		// Dependencies: this test uses isolated temp storage and in-memory fakes.
		await withIsolatedSuiteDir(async () => {
			const pi = createExtensionApiFake();
			const ctx = createContextFake({ modelId: "gpt-5.5" });
			codexFast(pi as unknown as ExtensionAPI);

			await getFastCommand(pi).handler("", ctx);
			const result = await getBeforeProviderRequestHandler(pi)(
				{ payload: { input: "hello" } },
				ctx,
			);

			expect(result).toEqual({ input: "hello", service_tier: "priority" });
			expect(ctx.uiStatuses.at(-1)).toEqual(["codex-fast", "enabled"]);
		});
	});

	test("toggles fast mode through shortcut", async () => {
		// Purpose: the shortcut must use the same toggle behavior as `/fast`.
		// Input and expected output: Ctrl+Alt+F enables priority injection.
		// Edge case: shortcut receives only the command context.
		// Dependencies: this test uses isolated temp storage and in-memory fakes.
		await withIsolatedSuiteDir(async () => {
			const pi = createExtensionApiFake();
			const ctx = createContextFake();
			codexFast(pi as unknown as ExtensionAPI);

			await getFastShortcut(pi).handler(ctx);
			const result = await getBeforeProviderRequestHandler(pi)(
				{ payload: { input: "hello" } },
				ctx,
			);

			expect(result).toEqual({ input: "hello", service_tier: "priority" });
		});
	});

	test("does not inject priority service tier for unsupported models", async () => {
		// Purpose: fast mode must only alter requests for known priority-capable Codex models.
		// Input and expected output: enabled fast mode with openai-codex/gpt-5.3 returns undefined.
		// Edge case: enabled UI status does not imply provider payload support.
		// Dependencies: this test uses isolated temp storage and in-memory fakes.
		await withIsolatedSuiteDir(async () => {
			const pi = createExtensionApiFake();
			const ctx = createContextFake({ modelId: "gpt-5.3" });
			codexFast(pi as unknown as ExtensionAPI);

			await getFastCommand(pi).handler("", ctx);
			const result = await getBeforeProviderRequestHandler(pi)(
				{ payload: { input: "hello" } },
				ctx,
			);

			expect(result).toBeUndefined();
			expect(ctx.uiStatuses.at(-1)).toEqual(["codex-fast", "enabled"]);
		});
	});

	test("persists enabled state across extension instances", async () => {
		// Purpose: enabling fast mode once must survive pi reloads and restarts.
		// Input and expected output: second extension instance loads enabled state on session_start.
		// Edge case: state is loaded without reusing in-memory variables from the first instance.
		// Dependencies: this test uses isolated temp storage and in-memory fakes.
		await withIsolatedSuiteDir(async () => {
			const firstPi = createExtensionApiFake();
			const firstCtx = createContextFake();
			codexFast(firstPi as unknown as ExtensionAPI);
			await getFastCommand(firstPi).handler("", firstCtx);

			const secondPi = createExtensionApiFake();
			const secondCtx = createContextFake();
			codexFast(secondPi as unknown as ExtensionAPI);
			await getSessionStartHandler(secondPi)({}, secondCtx);

			const result = await getBeforeProviderRequestHandler(secondPi)(
				{ payload: { input: "hello" } },
				secondCtx,
			);
			expect(result).toEqual({ input: "hello", service_tier: "priority" });
			expect(secondCtx.uiStatuses.at(-1)).toEqual(["codex-fast", "enabled"]);
		});
	});
});

function createExtensionApiFake(): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];
	const commands: RegisteredCommandFake[] = [];
	const shortcuts: RegisteredShortcutFake[] = [];

	return {
		handlers,
		commands,
		shortcuts,
		registerCommand(name, options): void {
			commands.push({ name, handler: options.handler });
		},
		registerShortcut(shortcut, options): void {
			shortcuts.push({ shortcut, handler: options.handler });
		},
		on(eventName, handler): void {
			handlers.push({ eventName, handler });
		},
	};
}

function createContextFake(
	options: { readonly modelId?: string; readonly hasUI?: boolean } = {},
) {
	const uiStatuses: [string, string | undefined][] = [];
	const notifications: [string, string][] = [];
	return {
		uiStatuses,
		notifications,
		hasUI: options.hasUI ?? true,
		model: {
			provider: "openai-codex",
			id: options.modelId ?? "gpt-5.4",
		},
		ui: {
			theme: {
				fg(_color: string, value: string): string {
					return value;
				},
			},
			setStatus(key: string, value: string | undefined): void {
				uiStatuses.push([key, value]);
			},
			notify(message: string, level: string): void {
				notifications.push([message, level]);
			},
		},
	} as ExtensionContextFake & {
		readonly uiStatuses: [string, string | undefined][];
		readonly notifications: [string, string][];
	};
}

function getBeforeProviderRequestHandler(
	pi: ExtensionApiFake,
): BeforeProviderRequestHandler {
	const handler = pi.handlers.find(
		({ eventName }) => eventName === "before_provider_request",
	)?.handler;
	expect(handler).toBeFunction();
	return handler as BeforeProviderRequestHandler;
}

function getSessionStartHandler(pi: ExtensionApiFake): SessionHandler {
	const handler = pi.handlers.find(
		({ eventName }) => eventName === "session_start",
	)?.handler;
	expect(handler).toBeFunction();
	return handler as SessionHandler;
}

function getFastCommand(pi: ExtensionApiFake): RegisteredCommandFake {
	const command = pi.commands.find(({ name }) => name === "fast");
	expect(command).toBeDefined();
	return command as RegisteredCommandFake;
}

function getFastShortcut(pi: ExtensionApiFake): RegisteredShortcutFake {
	const shortcut = pi.shortcuts.find(
		({ shortcut }) => shortcut === "ctrl+alt+f",
	);
	expect(shortcut).toBeDefined();
	return shortcut as RegisteredShortcutFake;
}

async function withIsolatedSuiteDir(run: () => Promise<void>): Promise<void> {
	const suiteDir = await mkdtemp(join(tmpdir(), "pi-codex-fast-test-"));
	tempDirs.push(suiteDir);
	process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
	await run();
}
