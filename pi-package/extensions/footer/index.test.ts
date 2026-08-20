import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import footer from "./index.ts";

const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: unknown;
}

interface ExtensionApiFake {
	readonly handlers: RegisteredHandler[];
	readonly events: {
		on(eventName: string, listener: () => void): () => void;
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

afterEach(async () => {
	if (previousSuiteDir === undefined) {
		delete process.env[AGENT_SUITE_DIR_ENV];
	} else {
		process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
	}

	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("footer", () => {
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

	return {
		handlers,
		events: {
			on(_eventName: string, _listener: () => void): () => void {
				return () => {};
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
				return "session";
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
			setFooter(factory): void {
				setFooterFactory(factory);
			},
		},
	};
}

function getSessionStartHandler(pi: ExtensionApiFake) {
	const handler = pi.handlers.find(
		({ eventName }) => eventName === "session_start",
	)?.handler;
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
