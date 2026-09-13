import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CHILD_AGENT_PROCESS_ENV,
	CHILD_AGENT_PROCESS_ENV_VALUE,
} from "../../shared/child-agent-environment";
import { USAGE_ROOT_COST_REQUEST_CHANNEL } from "../../shared/usage-read-broker";
import footer from "./index.ts";

const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: unknown;
}

interface ExtensionApiFake {
	readonly handlers: RegisteredHandler[];
	readonly events: {
		on(eventName: string, listener: (value: unknown) => void): () => void;
		emit(eventName: string, value: unknown): boolean;
	};
	on(eventName: string, handler: unknown): void;
	getThinkingLevel(): string;
	exec(): Promise<{ readonly code: number; readonly stdout: string }>;
}

interface FooterDataFake {
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getGitBranch(): string | null;
}

interface FooterThemeFake {
	fg(_color: "accent" | "warning" | "error", value: string): string;
}

interface FooterTuiFake {
	requestRender(): void;
}

interface FooterComponentFake {
	render(width: number): string[];
	invalidate(): void;
	dispose?(): void;
}

interface SessionContextFake {
	readonly cwd: string;
	readonly hasUI: true;
	readonly model: { readonly provider: string; readonly id: string };
	readonly sessionManager: {
		getSessionId(): string;
		getEntries(): unknown[];
	};
	readonly modelRegistry: {
		isUsingOAuth(): boolean;
	};
	getContextUsage(): undefined;
	readonly ui: {
		notify(message: string, type: "warning"): void;
		setFooter(
			factory: (
				tui: FooterTuiFake,
				theme: FooterThemeFake,
				footerData: FooterDataFake,
			) => FooterComponentFake,
		): void;
	};
}

const tempDirs: string[] = [];
const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
const previousChildProcess = process.env[CHILD_AGENT_PROCESS_ENV];

afterEach(async () => {
	if (previousSuiteDir === undefined) {
		delete process.env[AGENT_SUITE_DIR_ENV];
	} else {
		process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
	}
	if (previousChildProcess === undefined) {
		delete process.env[CHILD_AGENT_PROCESS_ENV];
	} else {
		process.env[CHILD_AGENT_PROCESS_ENV] = previousChildProcess;
	}

	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("footer", () => {
	test("caches and refreshes stored root-family usage every ten seconds", async () => {
		// Purpose: the active root footer must render only cached usage-store cost and tokens and refresh them on one fixed interval.
		// Inputs and expected output: the broker returns 1.25 and 10,000 tokens initially, then 2.5 and 20,000 tokens on the first fake tick.
		// Edge case: rendering does not request again, and a queued callback after disposal does not refresh.
		// Dependencies: an in-memory Pi event bus, fake interval functions, and an isolated footer config.
		await withIsolatedSuiteDir(async (suiteDir) => {
			await writeFooterConfig(suiteDir, {
				enabled: true,
				showApiCost: true,
				showCacheHitRate: false,
			});
			delete process.env[CHILD_AGENT_PROCESS_ENV];
			const pi = createExtensionApiFake();
			const requestedRoots: string[] = [];
			const totals = [
				{ cost: 1.25, tokens: 10_000 },
				{ cost: 2.5, tokens: 20_000 },
			];
			pi.events.on(USAGE_ROOT_COST_REQUEST_CHANNEL, (value) => {
				const request = value as {
					rootSessionId: string;
					cost?: number;
					tokens?: number;
				};
				requestedRoots.push(request.rootSessionId);
				const current = totals[requestedRoots.length - 1];
				if (current === undefined) {
					throw new Error("missing fake usage totals");
				}
				request.cost = current.cost;
				request.tokens = current.tokens;
			});
			let intervalCallback: (() => void) | undefined;
			const intervalHandle = 7 as unknown as ReturnType<typeof setInterval>;
			const setIntervalSpy = spyOn(
				globalThis,
				"setInterval",
			).mockImplementation(((callback: () => void, delay?: number) => {
				expect(delay).toBe(10_000);
				intervalCallback = callback;
				return intervalHandle;
			}) as typeof setInterval);
			const clearIntervalSpy = spyOn(
				globalThis,
				"clearInterval",
			).mockImplementation(() => undefined);
			try {
				let footerFactory:
					| ((
							tui: FooterTuiFake,
							theme: FooterThemeFake,
							footerData: FooterDataFake,
					  ) => FooterComponentFake)
					| undefined;
				const ctx = createSessionContextFake(
					(factory) => {
						footerFactory = factory;
					},
					[
						{
							type: "message",
							message: {
								role: "assistant",
								usage: { cost: { total: 99 } },
							},
						},
					],
				);
				footer(pi as unknown as ExtensionAPI);
				await getSessionStartHandler(pi)({}, ctx);
				expect(requestedRoots).toEqual(["session"]);
				if (footerFactory === undefined) {
					throw new Error("footer factory is not set");
				}
				let renderRequests = 0;
				const component = footerFactory(
					{
						requestRender() {
							renderRequests += 1;
						},
					},
					{ fg: (_color, value) => value },
					{
						getExtensionStatuses: () => new Map(),
						getGitBranch: () => null,
					},
				);

				expect(component.render(200)[0]).toContain("$1.250 · T10K");
				expect(component.render(200)[0]).toContain("$1.250 · T10K");
				expect(requestedRoots).toEqual(["session"]);
				intervalCallback?.();
				expect(requestedRoots).toEqual(["session", "session"]);
				expect(component.render(200)[0]).toContain("$2.500 · T20K");
				expect(renderRequests).toBe(1);
				component.dispose?.();
				expect(clearIntervalSpy).toHaveBeenCalledWith(intervalHandle);
				intervalCallback?.();
				expect(requestedRoots).toHaveLength(2);
			} finally {
				clearIntervalSpy.mockRestore();
				setIntervalSpy.mockRestore();
			}
		});
	});

	test("hides cached cost and warns once when later refreshes are unavailable", async () => {
		// Purpose: a footer that loses its usage broker must stop showing stale complete cost.
		// Inputs and expected output: an initial 1.25 result is followed by two unavailable fake-time refreshes and one warning.
		// Edge case: repeated unavailable refreshes keep the segment hidden without repeating the warning.
		// Dependencies: an in-memory Pi event bus, fake interval functions, and an isolated footer config.
		await withIsolatedSuiteDir(async (suiteDir) => {
			await writeFooterConfig(suiteDir, {
				enabled: true,
				showApiCost: true,
				showCacheHitRate: false,
			});
			delete process.env[CHILD_AGENT_PROCESS_ENV];
			const pi = createExtensionApiFake();
			let requestCount = 0;
			pi.events.on(USAGE_ROOT_COST_REQUEST_CHANNEL, (value) => {
				requestCount += 1;
				if (requestCount === 1) {
					const request = value as { cost?: number; tokens?: number };
					request.cost = 1.25;
					request.tokens = 10_000;
				}
			});
			let intervalCallback: (() => void) | undefined;
			const intervalHandle = 8 as unknown as ReturnType<typeof setInterval>;
			const setIntervalSpy = spyOn(
				globalThis,
				"setInterval",
			).mockImplementation(((callback: () => void, delay?: number) => {
				expect(delay).toBe(10_000);
				intervalCallback = callback;
				return intervalHandle;
			}) as typeof setInterval);
			const clearIntervalSpy = spyOn(
				globalThis,
				"clearInterval",
			).mockImplementation(() => undefined);
			const notifications: string[] = [];
			try {
				let footerFactory:
					| ((
							tui: FooterTuiFake,
							theme: FooterThemeFake,
							footerData: FooterDataFake,
					  ) => FooterComponentFake)
					| undefined;
				const ctx = createSessionContextFake(
					(factory) => {
						footerFactory = factory;
					},
					[],
					notifications,
					"refresh-failure-session",
				);
				footer(pi as unknown as ExtensionAPI);
				await getSessionStartHandler(pi)({}, ctx);
				if (footerFactory === undefined) {
					throw new Error("footer factory is not set");
				}
				const component = footerFactory(
					{ requestRender() {} },
					{ fg: (_color, value) => value },
					{
						getExtensionStatuses: () => new Map(),
						getGitBranch: () => null,
					},
				);
				expect(component.render(200)[0]).toContain("$1.250 · T10K");

				intervalCallback?.();
				expect(component.render(200)[0]).not.toContain("$");
				expect(component.render(200)[0]).not.toContain("T10K");
				expect(notifications).toHaveLength(1);
				intervalCallback?.();
				expect(notifications).toHaveLength(1);
				expect(requestCount).toBe(3);
				component.dispose?.();
				expect(clearIntervalSpy).toHaveBeenCalledWith(intervalHandle);
			} finally {
				clearIntervalSpy.mockRestore();
				setIntervalSpy.mockRestore();
			}
		});
	});

	test("shows one warning and no cost when the usage broker is unavailable", async () => {
		// Purpose: an interactive root footer must fail closed when complete usage cost is unavailable.
		// Inputs and expected output: an enabled cost segment without a broker emits one warning and renders no dollar segment.
		// Edge case: component rendering and disposal do not repeat the warning or start a timer.
		// Dependencies: an isolated footer config and an in-memory Pi event bus without a usage listener.
		await withIsolatedSuiteDir(async (suiteDir) => {
			await writeFooterConfig(suiteDir, {
				enabled: true,
				showApiCost: true,
				showCacheHitRate: false,
			});
			delete process.env[CHILD_AGENT_PROCESS_ENV];
			const pi = createExtensionApiFake();
			const intervalSpy = spyOn(globalThis, "setInterval");
			const notifications: string[] = [];
			let footerFactory:
				| ((
						tui: FooterTuiFake,
						theme: FooterThemeFake,
						footerData: FooterDataFake,
				  ) => FooterComponentFake)
				| undefined;
			const ctx = createSessionContextFake(
				(factory) => {
					footerFactory = factory;
				},
				[],
				notifications,
			);
			try {
				footer(pi as unknown as ExtensionAPI);
				await getSessionStartHandler(pi)({}, ctx);
				await getSessionStartHandler(pi)({}, ctx);
				expect(notifications).toHaveLength(1);
				if (footerFactory === undefined) {
					throw new Error("footer factory is not set");
				}
				const component = footerFactory(
					{ requestRender() {} },
					{ fg: (_color, value) => value },
					{
						getExtensionStatuses: () => new Map(),
						getGitBranch: () => null,
					},
				);
				expect(component.render(200)[0]).not.toContain("$");
				expect(notifications).toHaveLength(1);
				expect(intervalSpy).not.toHaveBeenCalled();
				component.dispose?.();
			} finally {
				intervalSpy.mockRestore();
			}
		});
	});

	test("warns once across footer reloads for the same unavailable root", async () => {
		// Purpose: cache-free footer reloads must not duplicate one unavailable-usage warning in the same root session.
		// Inputs and expected output: two footer extension instances on one root event bus emit one warning in total.
		// Edge case: each extension instance owns separate session state.
		// Dependencies: an isolated footer config and one in-memory Pi event bus without a usage listener.
		await withIsolatedSuiteDir(async (suiteDir) => {
			await writeFooterConfig(suiteDir, {
				enabled: true,
				showApiCost: true,
				showCacheHitRate: false,
			});
			delete process.env[CHILD_AGENT_PROCESS_ENV];
			const pi = createExtensionApiFake();
			const notifications: string[] = [];
			const ctx = createSessionContextFake(
				() => {},
				[],
				notifications,
				"unavailable-reload-session",
			);

			footer(pi as unknown as ExtensionAPI);
			await getSessionStartHandler(pi, 0)({}, ctx);
			footer(pi as unknown as ExtensionAPI);
			await getSessionStartHandler(pi, 1)({}, ctx);

			expect(notifications).toHaveLength(1);
		});
	});

	test("does not request usage when both totals are hidden or in child sessions", async () => {
		// Purpose: usage reads, timers, and warnings must be limited to a root footer with cost or tokens enabled.
		// Inputs and expected output: both totals hidden in a root footer and both enabled in a child footer make zero broker requests and warnings.
		// Edge case: the unrelated footer still installs and renders for the child process.
		// Dependencies: isolated footer configs, the child-process marker, and an in-memory Pi event bus.
		for (const childProcess of [false, true]) {
			await withIsolatedSuiteDir(async (suiteDir) => {
				await writeFooterConfig(suiteDir, {
					enabled: true,
					showApiCost: childProcess,
					showApiTokens: childProcess,
					showCacheHitRate: false,
				});
				if (childProcess) {
					process.env[CHILD_AGENT_PROCESS_ENV] = CHILD_AGENT_PROCESS_ENV_VALUE;
				} else {
					delete process.env[CHILD_AGENT_PROCESS_ENV];
				}
				const pi = createExtensionApiFake();
				let requests = 0;
				pi.events.on(USAGE_ROOT_COST_REQUEST_CHANNEL, () => {
					requests += 1;
				});
				const notifications: string[] = [];
				let footerFactory:
					| ((
							tui: FooterTuiFake,
							theme: FooterThemeFake,
							footerData: FooterDataFake,
					  ) => FooterComponentFake)
					| undefined;
				const ctx = createSessionContextFake(
					(factory) => {
						footerFactory = factory;
					},
					[],
					notifications,
				);
				footer(pi as unknown as ExtensionAPI);
				await getSessionStartHandler(pi)({}, ctx);
				expect(footerFactory).toBeDefined();
				expect(requests).toBe(0);
				expect(notifications).toEqual([]);
			});
		}
	});

	test("does not request usage when the footer is disabled", async () => {
		// Purpose: a disabled footer must not activate any usage lifecycle work.
		// Inputs and expected output: disabled footer config produces no broker request, timer, warning, or footer factory.
		// Edge case: a usage broker listener is present and would answer a request.
		// Dependencies: an isolated footer config and in-memory Pi event bus.
		await withIsolatedSuiteDir(async (suiteDir) => {
			await writeFooterConfig(suiteDir, { enabled: false });
			delete process.env[CHILD_AGENT_PROCESS_ENV];
			const pi = createExtensionApiFake();
			let requests = 0;
			pi.events.on(USAGE_ROOT_COST_REQUEST_CHANNEL, () => {
				requests += 1;
			});
			const notifications: string[] = [];
			let footerFactory: unknown;
			const ctx = createSessionContextFake(
				(factory) => {
					footerFactory = factory;
				},
				[],
				notifications,
			);
			const intervalSpy = spyOn(globalThis, "setInterval");
			try {
				footer(pi as unknown as ExtensionAPI);
				await getSessionStartHandler(pi)({}, ctx);
				expect(footerFactory).toBeUndefined();
				expect(requests).toBe(0);
				expect(notifications).toEqual([]);
				expect(intervalSpy).not.toHaveBeenCalled();
			} finally {
				intervalSpy.mockRestore();
			}
		});
	});

	test("shows rounded cache hit rate by default and when explicitly enabled", async () => {
		// Purpose: footer must expose the latest prompt cache hit rate in the requested compact format.
		// Input and expected output: 874 cached tokens out of 1,000 prompt tokens render as CH87 with default and explicit enablement.
		// Edge case: the displayed value rounds to an integer and omits both the decimal fraction and percent sign.
		// Dependencies: isolated suite directories and in-memory ExtensionAPI/session context fakes.
		for (const showCacheHitRate of [undefined, true]) {
			await withIsolatedSuiteDir(async (suiteDir) => {
				await writeFooterConfig(suiteDir, {
					enabled: true,
					showApiCost: false,
					...(showCacheHitRate === undefined ? {} : { showCacheHitRate }),
				});

				const pi = createExtensionApiFake();
				let footerFactory:
					| ((
							tui: FooterTuiFake,
							theme: FooterThemeFake,
							footerData: FooterDataFake,
					  ) => FooterComponentFake)
					| undefined;
				const ctx = createSessionContextFake(
					(factory) => {
						footerFactory = factory;
					},
					[
						{
							type: "message",
							message: {
								role: "assistant",
								usage: {
									input: 126,
									cacheRead: 874,
									cacheWrite: 0,
									cost: { total: 0 },
								},
							},
						},
					],
				);

				footer(pi as unknown as ExtensionAPI);
				await getSessionStartHandler(pi)({}, ctx);
				expect(footerFactory).toBeDefined();
				if (footerFactory === undefined) {
					throw new Error("footer factory is not set");
				}

				const component = footerFactory(
					{ requestRender() {} },
					{
						fg(_color, value) {
							return value;
						},
					},
					{
						getExtensionStatuses: () => new Map([["context-projection", "~0"]]),
						getGitBranch: () => null,
					},
				);

				const segments = (component.render(200)[0] ?? "").split(" · ");
				expect(segments).toEqual([
					"footer-project",
					"No agent",
					"github-copilot/gpt-5.3-codex/medium",
					"CH87",
					"~0",
				]);
			});
		}
	});

	test("shows provider together with model and thinking even when showProvider is false", async () => {
		// Purpose: footer model segment must include provider when model and thinking are enabled.
		// Input and expected output: config with showProvider=false still renders provider/model/thinking.
		// Edge case: config keeps showApiCost disabled so only model formatting behavior is asserted.
		// Dependencies: isolated suite directory and in-memory ExtensionAPI/session context fakes.
		await withIsolatedSuiteDir(async (suiteDir) => {
			await writeFooterConfig(suiteDir, {
				enabled: true,
				showProvider: false,
				showModel: true,
				showThinkingLevel: true,
				showApiCost: false,
				showGitBranch: true,
				showAdditionalStatusLine: true,
			});

			const pi = createExtensionApiFake();
			let footerFactory:
				| ((
						tui: FooterTuiFake,
						theme: FooterThemeFake,
						footerData: FooterDataFake,
				  ) => FooterComponentFake)
				| undefined;
			const ctx = createSessionContextFake((factory) => {
				footerFactory = factory;
			});

			footer(pi as unknown as ExtensionAPI);
			await getSessionStartHandler(pi)({}, ctx);
			expect(footerFactory).toBeDefined();
			if (footerFactory === undefined) {
				throw new Error("footer factory is not set");
			}

			const component = footerFactory(
				{ requestRender() {} },
				{
					fg(_color, value) {
						return value;
					},
				},
				{
					getExtensionStatuses: () => new Map(),
					getGitBranch: () => "knowledge",
				},
			);

			const firstLine = component.render(200)[0] ?? "";
			expect(firstLine).toContain("github-copilot/gpt-5.3-codex/medium");
		});
	});
});

function createExtensionApiFake(): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];
	const eventListeners = new Map<string, Set<(value: unknown) => void>>();

	return {
		handlers,
		events: {
			on(eventName, listener): () => void {
				const listeners = eventListeners.get(eventName) ?? new Set();
				listeners.add(listener);
				eventListeners.set(eventName, listeners);
				return () => listeners.delete(listener);
			},
			emit(eventName, value): boolean {
				for (const listener of eventListeners.get(eventName) ?? []) {
					listener(value);
				}
				return true;
			},
		},
		on(eventName, handler): void {
			handlers.push({ eventName, handler });
		},
		getThinkingLevel(): string {
			return "medium";
		},
		exec(): Promise<{ readonly code: number; readonly stdout: string }> {
			return Promise.resolve({ code: 1, stdout: "" });
		},
	};
}

function createSessionContextFake(
	setFooterFactory: (
		factory: (
			tui: FooterTuiFake,
			theme: FooterThemeFake,
			footerData: FooterDataFake,
		) => FooterComponentFake,
	) => void,
	entries: unknown[] = [],
	notifications: string[] = [],
	sessionId = "session",
): SessionContextFake {
	return {
		cwd: "/tmp/footer-project",
		hasUI: true,
		model: {
			provider: "github-copilot",
			id: "gpt-5.3-codex",
		},
		sessionManager: {
			getSessionId(): string {
				return sessionId;
			},
			getEntries(): unknown[] {
				return entries;
			},
		},
		modelRegistry: {
			isUsingOAuth(): boolean {
				return false;
			},
		},
		getContextUsage(): undefined {
			return undefined;
		},
		ui: {
			notify(message): void {
				notifications.push(message);
			},
			setFooter(factory): void {
				setFooterFactory(factory);
			},
		},
	};
}

function getSessionStartHandler(pi: ExtensionApiFake, index = 0) {
	const handler = pi.handlers.filter(
		({ eventName }) => eventName === "session_start",
	)[index]?.handler;
	if (typeof handler !== "function") {
		throw new Error("session_start handler is not registered");
	}

	return handler as (
		event: unknown,
		ctx: SessionContextFake,
	) => void | Promise<void>;
}

async function withIsolatedSuiteDir(
	run: (suiteDir: string) => Promise<void>,
): Promise<void> {
	const suiteDir = await mkdtemp(join(tmpdir(), "footer-suite-"));
	tempDirs.push(suiteDir);
	process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
	await run(suiteDir);
}

async function writeFooterConfig(
	suiteDir: string,
	config: Record<string, unknown>,
): Promise<void> {
	const directory = join(suiteDir, "footer");
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "config.json"),
		JSON.stringify(config),
		"utf8",
	);
}
