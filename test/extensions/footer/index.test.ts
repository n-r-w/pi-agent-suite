import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import footer, {
	SEGMENT_SEPARATOR,
} from "../../../pi-package/extensions/footer/index";

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: unknown;
}

interface SessionContextFake {
	readonly installedFooters: unknown[];
	readonly cwd: string;
	readonly hasUI?: boolean;
	readonly ui: {
		setFooter(footerRenderer: unknown): void;
	};
	model: {
		id: string;
		provider: string;
		reasoning: boolean;
		contextWindow: number;
	};
	getContextUsage(): { tokens: number; contextWindow: number };
}

interface SessionContextOptions {
	readonly cwd?: string;
	readonly hasUI?: boolean;
	readonly thinkingLevel?: string;
	readonly contextUsage?: {
		readonly tokens: number;
		readonly contextWindow: number;
	};
}

interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
}

interface FooterDataFake {
	getExtensionStatuses(): ReadonlyMap<string, string>;
}

interface TuiFake {
	readonly requestRenderCalls: unknown[];
	requestRender(): void;
}

interface FooterComponentFake {
	render(width: number): string[];
	dispose?: () => void;
}

interface FooterTestHarness {
	readonly pi: ExtensionApiFake;
	readonly ctx: SessionContextFake;
	readonly footerRenderer: unknown;
}

/** SGR reset sequence inserted by pi-tui truncation helpers. */
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const SGR_RESET = `${String.fromCharCode(27)}[0m`;

/** Runs a test with an isolated pi agent directory so footer config reads never touch real user files. */
async function withIsolatedAgentDir<T>(
	action: (agentDir: string) => Promise<T>,
): Promise<T> {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const agentDir = await mkdtemp(join(tmpdir(), "pi-footer-"));
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

/** Writes footer config into the isolated pi agent directory. */
async function writeFooterConfig(
	agentDir: string,
	config: unknown,
): Promise<void> {
	await writeConfig(agentDir, "footer.json", config);
}

/** Writes context-overflow config into the isolated pi agent directory. */
async function writeContextOverflowConfig(
	agentDir: string,
	config: unknown,
): Promise<void> {
	await writeConfig(agentDir, "context-overflow.json", config);
}

/** Writes one extension config into the isolated pi agent directory. */
async function writeConfig(
	agentDir: string,
	fileName: string,
	config: unknown,
): Promise<void> {
	await mkdir(join(agentDir, "config"), { recursive: true });
	await writeFile(join(agentDir, "config", fileName), JSON.stringify(config));
}

/** Removes SGR reset codes so assertions can target visible footer text. */
function stripAnsi(text: string): string {
	return text.replaceAll(SGR_RESET, "");
}

/** Creates the ExtensionAPI fake needed to observe events, resolve git roots, and read thinking level. */
function createExtensionApiFake(
	options: Pick<SessionContextOptions, "thinkingLevel"> = {},
): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];

	return {
		handlers,
		async exec(command: string, args: string[], options: { cwd?: string }) {
			expect(command).toBe("git");
			expect(args).toEqual(["rev-parse", "--show-toplevel"]);
			return {
				code: 0,
				stdout: `${options.cwd?.split("/src/")[0] ?? "/workspace/pi-harness"}\n`,
				stderr: "",
			};
		},
		getThinkingLevel(): string {
			return options.thinkingLevel ?? "high";
		},
		on(eventName: string, handler: unknown): void {
			handlers.push({ eventName, handler });
		},
	} as ExtensionApiFake;
}

/** Creates the session context fake needed to install a footer and expose session-owned display state. */
function createSessionContextFake(
	options: SessionContextOptions = {},
): SessionContextFake {
	const installedFooters: unknown[] = [];
	const contextUsage = options.contextUsage ?? {
		tokens: 42000,
		contextWindow: 200000,
	};

	return {
		installedFooters,
		cwd: options.cwd ?? "/workspace/pi-harness",
		...(options.hasUI !== undefined ? { hasUI: options.hasUI } : {}),
		ui: {
			setFooter(footerRenderer: unknown): void {
				installedFooters.push(footerRenderer);
			},
		},
		model: {
			id: "gpt-5.4",
			provider: "openai-codex",
			reasoning: true,
			contextWindow: 200000,
		},
		getContextUsage() {
			return contextUsage;
		},
	};
}

/** Creates the theme fake needed to render footer text without ANSI styling. */
function createThemeFake(colorized = false): unknown {
	return {
		fg(color: string, value: string): string {
			return colorized ? `<${color}>${value}</${color}>` : value;
		},
		bold(value: string): string {
			return value;
		},
	};
}

/** Creates the TUI fake needed to observe requested footer renders. */
function createTuiFake(): TuiFake {
	const requestRenderCalls: unknown[] = [];

	return {
		requestRenderCalls,
		requestRender(): void {
			requestRenderCalls.push({});
		},
	};
}

/** Creates the footer data fake needed to expose extension statuses. */
function createFooterDataFake(
	statuses: ReadonlyMap<string, string> = new Map(),
): FooterDataFake {
	return {
		getExtensionStatuses() {
			return statuses;
		},
	};
}

/** Installs the footer extension and returns the observable test harness. */
async function installFooterTestHarness(
	cwdOrOptions?: string | SessionContextOptions,
): Promise<FooterTestHarness> {
	if (process.env[AGENT_DIR_ENV] === undefined) {
		return withIsolatedAgentDir(async () =>
			installFooterTestHarnessInCurrentAgentDir(cwdOrOptions),
		);
	}

	return installFooterTestHarnessInCurrentAgentDir(cwdOrOptions);
}

/** Installs the footer extension using the currently configured pi agent directory. */
async function installFooterTestHarnessInCurrentAgentDir(
	cwdOrOptions?: string | SessionContextOptions,
): Promise<FooterTestHarness> {
	const options =
		typeof cwdOrOptions === "string" ? { cwd: cwdOrOptions } : cwdOrOptions;
	const pi = createExtensionApiFake(options);
	const ctx = createSessionContextFake(options);

	footer(pi);
	const sessionStartHandler = pi.handlers.find(
		(handler) => handler.eventName === "session_start",
	)?.handler;

	expect(sessionStartHandler).toEqual(expect.any(Function));
	await (
		sessionStartHandler as (
			event: unknown,
			ctx: unknown,
		) => Promise<void> | void
	)({}, ctx);

	expect(ctx.installedFooters).toHaveLength(1);
	expect(ctx.installedFooters[0]).toEqual(expect.any(Function));

	return { pi, ctx, footerRenderer: ctx.installedFooters[0] };
}

/** Creates a footer component from an installed footer renderer. */
function createFooterComponent(
	footerRenderer: unknown,
	footerData: FooterDataFake,
	tui: TuiFake = createTuiFake(),
	colorized = false,
): FooterComponentFake {
	return (
		footerRenderer as (
			tui: unknown,
			theme: unknown,
			footerData: unknown,
		) => FooterComponentFake
	)(tui, createThemeFake(colorized), footerData);
}

describe("footer", () => {
	test("installs a footer renderer on session start", async () => {
		// The footer must hook into session start because pi creates session UI per active session.
		await installFooterTestHarness();
	});

	test("does not install footer when explicitly disabled", async () => {
		// Purpose: footer must be disabled by config without affecting other extensions that call ctx.ui.setStatus.
		// Input and expected output: enabled false leaves the session without a custom footer renderer.
		// Edge case: UI is available, so disablement comes only from footer.json.
		// Dependencies: this test uses an isolated agent directory and in-memory fakes.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeFooterConfig(agentDir, { enabled: false });
			const pi = createExtensionApiFake();
			const ctx = createSessionContextFake();
			footer(pi);
			const sessionStartHandler = pi.handlers.find(
				(handler) => handler.eventName === "session_start",
			)?.handler;

			expect(sessionStartHandler).toEqual(expect.any(Function));
			await (
				sessionStartHandler as (
					event: unknown,
					ctx: unknown,
				) => Promise<void> | void
			)({}, ctx);

			expect(ctx.installedFooters).toEqual([]);
		});
	});

	test("does not install footer when UI is unavailable", async () => {
		// Purpose: non-interactive pi modes must not receive footer UI calls.
		// Input and expected output: session_start with hasUI false leaves installedFooters empty.
		// Edge case: the UI object still has setFooter, but hasUI is the authoritative mode signal.
		// Dependencies: this test uses only the footer ExtensionAPI and session context fakes.
		const pi = createExtensionApiFake();
		const ctx = createSessionContextFake({ hasUI: false });
		footer(pi);
		const sessionStartHandler = pi.handlers.find(
			(handler) => handler.eventName === "session_start",
		)?.handler;

		expect(sessionStartHandler).toEqual(expect.any(Function));
		await (
			sessionStartHandler as (
				event: unknown,
				ctx: unknown,
			) => Promise<void> | void
		)({}, ctx);

		expect(ctx.installedFooters).toEqual([]);
	});

	test("renders the compact footer segments in the requested order", async () => {
		// Purpose: the footer must keep the compact order requested for daily use.
		// Input and expected output: project, quota, agent, model display, context projection, and context usage render in one row.
		// Edge case: a zero-token context usage remains visible as `0/223k/272k`.
		// Dependencies: this test uses only in-memory extension, session, footer data, and TUI fakes.
		const { footerRenderer } = await installFooterTestHarness({
			contextUsage: { tokens: 0, contextWindow: 272_000 },
		});
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(
				new Map([
					["codex-quota", "90%/2h 71%/5d"],
					["agent", "Coder"],
					["context-projection", "~0"],
				]),
			),
		);

		const renderedText = stripAnsi(footerComponent.render(120).join("\n"));

		expect(renderedText).toBe(
			[
				"pi-harness",
				"90%/2h 71%/5d",
				"Coder",
				"openai-codex/gpt-5.4/high",
				"~0",
				"0/223k/272k",
			].join(SEGMENT_SEPARATOR),
		);
	});

	test("renders project name without a branch suffix", async () => {
		// Purpose: the footer must show the project directory label without branch noise.
		// Input and expected output: project `pi-harness` renders without `(main)` or branch text.
		// Edge case: session data still comes from the same footer data callback used by other statuses.
		// Dependencies: this test uses only in-memory extension, session, footer data, and TUI fakes.
		const { footerRenderer } = await installFooterTestHarness();
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(),
		);

		const renderedText = footerComponent.render(120).join("\n");

		expect(renderedText).toContain("pi-harness");
		expect(renderedText).not.toContain("(main)");
	});

	test("renders repository name when session starts from a nested working directory", async () => {
		// Purpose: the footer must label the repository, not the current subdirectory inside the repository.
		// Input and expected output: nested cwd inside `pi-harness` renders the repository name only.
		// Edge case: the repository label must stay free of branch suffixes.
		// Dependencies: this test uses only in-memory extension, session, footer data, and TUI fakes.
		const { footerRenderer } = await installFooterTestHarness(
			"/workspace/pi-harness/src/extensions/footer",
		);
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(),
		);

		const renderedText = footerComponent.render(120).join("\n");

		expect(renderedText).toContain("pi-harness");
		expect(renderedText).not.toContain("footer");
		expect(renderedText).not.toContain("(main)");
	});

	test("keeps priority segments when the project name is long", async () => {
		// Purpose: a long project label must not push quota, agent, reasoning, projection, or context data out of the footer.
		// Input and expected output: a long repository path renders with all non-project segments preserved.
		// Edge case: the project segment receives only the width left after higher-priority segments are reserved.
		// Dependencies: this test uses only in-memory extension, session, footer data, and TUI fakes.
		const { footerRenderer } = await installFooterTestHarness(
			"/workspace/customer-platform-with-a-very-long-service-name/src/extensions/footer",
		);
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(
				new Map([
					["codex-quota", "93%/3h 81%/5d"],
					["agent", "Coder"],
					["context-projection", "~0"],
				]),
			),
		);

		const renderedText = footerComponent.render(80).join("\n");

		expect(renderedText).toContain("93%/3h 81%/5d");
		expect(renderedText).toContain("Coder");
		expect(renderedText).toContain("openai-codex/gpt-5.4/high");
		expect(renderedText).toContain("~0");
		expect(renderedText).toContain("42k/151k/200k");
	});

	test("preserves priority segments when the project segment budget ends before an emoji variation sequence", async () => {
		// Purpose: footer project-label clipping must not consume width reserved for quota, reasoning, and context segments.
		// Input and expected output: a one-column project segment budget caused by project `⚠️` still preserves all priority segments at width 35.
		// Edge case: `⚠️` is a multi-code-point grapheme whose visible width is wider than the sum used by code-point slicing.
		// Dependencies: this test uses only in-memory extension, session, footer data, and TUI fakes.
		const { footerRenderer } = await installFooterTestHarness("/workspace/⚠️");
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(new Map([["codex-quota", "quota"]])),
		);

		const renderedLines = footerComponent.render(35);
		const renderedText = renderedLines.join("\n");

		expect(renderedLines).not.toHaveLength(0);
		expect(renderedText).toContain("quota");
		for (const line of renderedLines) {
			expect(line).not.toContain(SGR_RESET);
			expect(visibleWidth(line)).toBeLessThanOrEqual(35);
		}
	});

	test("renders provider, model, thinking level, and token context usage by default", async () => {
		// Purpose: model display defaults must expose provider, model, and thinking level in the footer.
		// Input and expected output: openai-codex gpt-5.4 with high thinking renders `openai-codex/gpt-5.4/high` and `42k/151k/200k`.
		// Edge case: provider, model, and thinking level render as one slash-delimited segment.
		// Dependencies: this test uses only in-memory extension, session, footer data, and TUI fakes.
		const { footerRenderer } = await installFooterTestHarness();
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(),
		);

		const renderedText = footerComponent.render(120).join("\n");

		expect(renderedText).toContain("openai-codex/gpt-5.4/high");
		expect(renderedText).toContain("42k/151k/200k");
	});

	test("omits the context-overflow limit when context-overflow is disabled", async () => {
		// Purpose: footer context usage must keep the old two-part format when context-overflow is disabled.
		// Input and expected output: disabled context-overflow config renders `42k/200k`.
		// Edge case: footer itself stays enabled while context-overflow is disabled.
		// Dependencies: this test uses isolated config files and in-memory fakes.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeContextOverflowConfig(agentDir, { enabled: false });
			const { footerRenderer } = await installFooterTestHarness();
			const footerComponent = createFooterComponent(
				footerRenderer,
				createFooterDataFake(),
			);

			const renderedText = footerComponent.render(120).join("\n");

			expect(renderedText).toContain("42k/200k");
			expect(renderedText).not.toContain("151k");
		});
	});

	test("uses the configured context-overflow limit in context usage", async () => {
		// Purpose: footer context usage must show the configured context-overflow compaction threshold.
		// Input and expected output: compactRemainingTokens 10000 with a 200000-token window renders `42k/190k/200k`.
		// Edge case: the config stores remaining tokens, while the footer displays the used-token threshold.
		// Dependencies: this test uses isolated config files and in-memory fakes.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeContextOverflowConfig(agentDir, {
				compactRemainingTokens: 10_000,
			});
			const { footerRenderer } = await installFooterTestHarness();
			const footerComponent = createFooterComponent(
				footerRenderer,
				createFooterDataFake(),
			);

			const renderedText = footerComponent.render(120).join("\n");

			expect(renderedText).toContain("42k/190k/200k");
		});
	});

	test("omits the context-overflow limit when context-overflow config is invalid", async () => {
		// Purpose: a context-overflow config error must not break footer rendering.
		// Input and expected output: invalid compactRemainingTokens renders `42k/200k`.
		// Edge case: footer does not report or render another extension's invalid config state.
		// Dependencies: this test uses isolated config files and in-memory fakes.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeContextOverflowConfig(agentDir, {
				compactRemainingTokens: -1,
			});
			const { footerRenderer } = await installFooterTestHarness();
			const footerComponent = createFooterComponent(
				footerRenderer,
				createFooterDataFake(),
			);

			const renderedText = footerComponent.render(120).join("\n");

			expect(renderedText).toContain("42k/200k");
			expect(renderedText).not.toContain("151k");
		});
	});

	test("customizes provider, model, and thinking level visibility independently", async () => {
		// Purpose: footer config must let users choose which model-display fields occupy footer space.
		// Input and expected output: disabling provider and thinking level leaves only `gpt-5.4` in the model segment.
		// Edge case: omitted showModel defaults to true while other explicit flags are false.
		// Dependencies: this test uses an isolated agent directory and in-memory fakes.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeFooterConfig(agentDir, {
				showProvider: false,
				showThinkingLevel: false,
			});
			const { footerRenderer } = await installFooterTestHarness();
			const footerComponent = createFooterComponent(
				footerRenderer,
				createFooterDataFake(),
			);

			const renderedText = footerComponent.render(120).join("\n");

			expect(renderedText).toContain("gpt-5.4");
			expect(renderedText).not.toContain("openai-codex");
			expect(renderedText).not.toContain("high");
		});
	});

	test("omits the model display segment when all model display fields are disabled", async () => {
		// Purpose: footer config must not render empty separators when the model display segment is fully disabled.
		// Input and expected output: all model-display flags false leave only project and context usage.
		// Edge case: the footer remains enabled while its model display segment is disabled.
		// Dependencies: this test uses an isolated agent directory and in-memory fakes.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeFooterConfig(agentDir, {
				showProvider: false,
				showModel: false,
				showThinkingLevel: false,
			});
			const { footerRenderer } = await installFooterTestHarness();
			const footerComponent = createFooterComponent(
				footerRenderer,
				createFooterDataFake(),
			);

			const renderedText = footerComponent.render(120).join("\n");

			expect(renderedText).toBe(
				["pi-harness", "42k/151k/200k"].join(SEGMENT_SEPARATOR),
			);
		});
	});

	test("colors reasoning levels by cost pressure", async () => {
		// Purpose: reasoning color must highlight expensive and unexpectedly low reasoning levels without coloring normal levels.
		// Input and expected output: xhigh is error, low/minimal/off are warning, and medium/high are plain text.
		// Edge case: lower-than-medium levels are grouped into the same warning state.
		// Dependencies: this test uses only in-memory extension, session, footer data, TUI fakes, and a colorized theme fake.
		const cases = [
			{ thinkingLevel: "xhigh", expectedSegment: "<error>xhigh</error>" },
			{ thinkingLevel: "high", expectedSegment: "high" },
			{ thinkingLevel: "medium", expectedSegment: "medium" },
			{ thinkingLevel: "low", expectedSegment: "<warning>low</warning>" },
			{
				thinkingLevel: "minimal",
				expectedSegment: "<warning>minimal</warning>",
			},
			{ thinkingLevel: "off", expectedSegment: "<warning>off</warning>" },
		] as const;

		for (const { thinkingLevel, expectedSegment } of cases) {
			const { footerRenderer } = await installFooterTestHarness({
				thinkingLevel,
			});
			const footerComponent = createFooterComponent(
				footerRenderer,
				createFooterDataFake(),
				createTuiFake(),
				true,
			);

			const renderedText = footerComponent.render(120).join("\n");

			expect(renderedText).toContain(`openai-codex/gpt-5.4/${expectedSegment}`);
		}
	});

	test("colors token context usage by used context percentage", async () => {
		// Purpose: context usage color must highlight only warning and error pressure in the compact footer.
		// Input and expected output: 49%, 50%, and 80% used context render as plain, warning, and error.
		// Edge cases: exact boundary values 50% and 80% are covered.
		// Dependencies: this test uses only in-memory extension, session, footer data, TUI fakes, and a colorized theme fake.
		const cases = [
			{ tokens: 49_000, expectedText: "49k/51k/100k" },
			{ tokens: 50_000, expectedText: "<warning>50k/51k/100k</warning>" },
			{ tokens: 80_000, expectedText: "<error>80k/51k/100k</error>" },
		] as const;

		for (const { tokens, expectedText } of cases) {
			const { footerRenderer } = await installFooterTestHarness({
				contextUsage: { tokens, contextWindow: 100_000 },
			});
			const footerComponent = createFooterComponent(
				footerRenderer,
				createFooterDataFake(),
				createTuiFake(),
				true,
			);

			const renderedText = footerComponent.render(120).join("\n");

			expect(renderedText).toContain(expectedText);
			expect(renderedText).not.toContain(`<muted>${expectedText}</muted>`);
		}
	});

	test("requests render after model selection and renders selected model display", async () => {
		// Purpose: model changes can affect the model-display segment and must request a footer redraw.
		// Input and expected output: selecting openai-codex gpt-5.5 triggers one render request and renders the selected model.
		// Edge case: the redraw request must come from model selection before the next footer render.
		// Dependencies: this test uses only in-memory extension, session, footer data, and TUI fakes.
		const { pi, footerRenderer } = await installFooterTestHarness();
		const tui = createTuiFake();
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(),
			tui,
		);
		const modelSelectHandler = pi.handlers.find(
			(handler) => handler.eventName === "model_select",
		)?.handler;

		expect(modelSelectHandler).toEqual(expect.any(Function));
		await (modelSelectHandler as (event: unknown) => Promise<void> | void)({
			model: {
				id: "gpt-5.5",
				provider: "openai-codex",
				reasoning: true,
				contextWindow: 300000,
			},
		});

		const renderedText = footerComponent.render(120).join("\n");

		expect(renderedText).toContain("openai-codex/gpt-5.5/high");
		expect(renderedText).not.toContain("gpt-5.4");
		expect(tui.requestRenderCalls).toHaveLength(1);
	});

	test("renders only MCP statuses that mean an error", async () => {
		// The footer must suppress healthy MCP statuses and show only MCP statuses that need user action.
		const { footerRenderer } = await installFooterTestHarness();
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(
				new Map([
					["mcp", "connected"],
					["mcp-github", "github error: token denied"],
					["mcp-files", "files available"],
				]),
			),
		);

		const renderedText = footerComponent.render(120).join("\n");

		expect(renderedText).toContain("github error: token denied");
		expect(renderedText).not.toContain("connected");
		expect(renderedText).not.toContain("files available");
	});

	test("keeps compact context projection statuses within terminal width", async () => {
		// Purpose: context-projection status must fit narrow footers without custom Unicode handling.
		// Input and expected output: CP!, ~0, and approximate saved-token statuses render without exceeding a narrow footer width.
		// Edge case: status styling must not affect visible width checks.
		// Dependencies: this test uses the existing footer renderer and pi-tui visible width calculation.
		const { footerRenderer } = await installFooterTestHarness();
		const statuses = ["<error>CP!</error>", "~0", "<warning>~20k</warning>"];

		for (const status of statuses) {
			const footerComponent = createFooterComponent(
				footerRenderer,
				createFooterDataFake(new Map([["context-projection", status]])),
			);
			const renderedLines = footerComponent.render(35);

			expect(renderedLines).not.toHaveLength(0);
			expect(renderedLines.join("\n")).toContain(status);
			for (const line of renderedLines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(35);
			}
		}
	});

	test("keeps rendered footer lines within terminal width", async () => {
		// The footer must not overflow the terminal because pi renders it inside the fixed-width session UI.
		const { footerRenderer } = await installFooterTestHarness();
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(
				new Map([
					["agent", "SubAgentSageWithVeryLongDisplayName"],
					[
						"codex-quota",
						"Codex quota status with a very long reset explanation",
					],
					[
						"mcp-github",
						"github error with a very long diagnostic message that must be trimmed",
					],
				]),
			),
		);

		const renderedLines = footerComponent.render(40);

		expect(renderedLines).not.toHaveLength(0);
		for (const line of renderedLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}
	});
});
