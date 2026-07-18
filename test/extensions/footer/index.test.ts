import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import footer, {
	SEGMENT_SEPARATOR,
} from "../../../pi-package/extensions/footer/index";
import { getAgentRuntimeComposition } from "../../../pi-package/shared/agent-runtime-composition";
import {
	addPendingProjectionSavings,
	resetPendingProjectionSavings,
} from "../../../pi-package/shared/context-projection";
import { HELPER_API_COST_CUSTOM_TYPE } from "../../../pi-package/shared/helper-api-cost";

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: unknown;
}

interface SessionContextFake {
	readonly installedFooters: unknown[];
	readonly cwd: string;
	readonly hasUI?: boolean;
	readonly sessionManager: {
		getSessionId(): string;
		getEntries(): readonly SessionEntryFake[];
	};
	readonly modelRegistry: {
		isUsingOAuth(model: SessionContextFake["model"]): boolean;
	};
	readonly ui: {
		setFooter(footerRenderer: unknown): void;
	};
	model: {
		id: string;
		provider: string;
		reasoning: boolean;
		contextWindow: number;
	};
	getContextUsage(): { tokens: number; contextWindow: number; percent: number };
}

interface SessionContextOptions {
	readonly cwd?: string;
	readonly hasUI?: boolean;
	readonly thinkingLevel?: string;
	readonly sessionId?: string;
	readonly contextUsage?: {
		readonly tokens: number;
		readonly contextWindow: number;
		readonly percent?: number;
	};
	readonly sessionEntries?: readonly SessionEntryFake[];
	readonly usingSubscription?: boolean;
}

interface SessionEntryFake {
	readonly type: string;
	readonly message?: {
		readonly role: string;
		readonly usage: {
			readonly cost: {
				readonly total: number;
			};
		};
	};
	readonly customType?: string;
	readonly data?: unknown;
}

interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
}

interface FooterDataFake {
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getGitBranch(): string | null;
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
const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";
const SGR_RESET = `${String.fromCharCode(27)}[0m`;

/** Runs a test with an isolated pi agent directory so footer config reads never touch real user files. */
async function withIsolatedAgentDir<T>(
	action: (agentDir: string) => Promise<T>,
): Promise<T> {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const previousAgentSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
	const agentDir = await mkdtemp(join(tmpdir(), "pi-footer-"));
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

/** Writes footer config into the isolated pi agent directory. */
async function writeFooterConfig(
	agentDir: string,
	config: unknown,
): Promise<void> {
	await writeConfig(agentDir, "footer.json", config);
}

interface PiSettingsConfig {
	readonly compaction?: {
		readonly enabled?: boolean;
		readonly reserveTokens?: number;
	};
}

/** Writes native pi settings into the isolated pi agent directory. */
async function writePiSettings(
	agentDir: string,
	config: PiSettingsConfig,
): Promise<void> {
	await writeFile(join(agentDir, "settings.json"), JSON.stringify(config));
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

/** Creates a session message entry with only the usage cost fields needed by footer rendering. */
function createMessageEntryFake(role: string, cost: number): SessionEntryFake {
	return {
		type: "message",
		message: {
			role,
			usage: {
				cost: {
					total: cost,
				},
			},
		},
	};
}

/** Creates an extension-owned helper API cost entry that stays outside LLM context. */
function createHelperApiCostEntryFake(
	source: string,
	cost: number,
): SessionEntryFake {
	return {
		type: "custom",
		customType: HELPER_API_COST_CUSTOM_TYPE,
		data: { source, cost },
	};
}

/** Creates the ExtensionAPI fake needed to observe events, resolve git roots, and read thinking level. */
function createExtensionApiFake(
	options: Pick<SessionContextOptions, "thinkingLevel"> = {},
): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];
	const eventListeners = new Map<string, Set<() => void>>();
	let currentActiveTools: string[] = [];

	return {
		handlers,
		events: {
			emit(eventName: string): void {
				for (const listener of eventListeners.get(eventName) ?? []) {
					listener();
				}
			},
			on(eventName: string, listener: () => void): () => void {
				const listeners =
					eventListeners.get(eventName) ?? new Set<() => void>();
				listeners.add(listener);
				eventListeners.set(eventName, listeners);
				return () => {
					listeners.delete(listener);
				};
			},
		},
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
		getActiveTools(): string[] {
			return [...currentActiveTools];
		},
		setActiveTools(toolNames: string[]): void {
			currentActiveTools = [...toolNames];
		},
		on(eventName: string, handler: unknown): void {
			handlers.push({ eventName, handler });
		},
	} as unknown as ExtensionApiFake;
}

/** Creates the session context fake needed to install a footer and expose session-owned display state. */
function createSessionContextFake(
	options: SessionContextOptions = {},
): SessionContextFake {
	const installedFooters: unknown[] = [];
	const rawContextUsage = options.contextUsage ?? {
		tokens: 42000,
		contextWindow: 200000,
	};
	const contextUsage = {
		...rawContextUsage,
		percent:
			rawContextUsage.percent ??
			(rawContextUsage.tokens / rawContextUsage.contextWindow) * 100,
	};

	return {
		installedFooters,
		cwd: options.cwd ?? "/workspace/pi-harness",
		...(options.hasUI !== undefined ? { hasUI: options.hasUI } : {}),
		sessionManager: {
			getSessionId(): string {
				return options.sessionId ?? "footer-test-session";
			},
			getEntries(): readonly SessionEntryFake[] {
				return options.sessionEntries ?? [];
			},
		},
		modelRegistry: {
			isUsingOAuth(model: SessionContextFake["model"]): boolean {
				return model === undefined
					? false
					: (options.usingSubscription ?? false);
			},
		},
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
	gitBranch: string | null = null,
): FooterDataFake {
	return {
		getExtensionStatuses() {
			return statuses;
		},
		getGitBranch() {
			return gitBranch;
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

	test("renders No agent when runtime composition has no main-agent contribution", async () => {
		// Purpose: the agent footer segment must reflect absence of the runtime main-agent contribution.
		// Input and expected output: undefined mainAgentContribution renders `No agent`.
		// Edge case: no legacy agent status is present in footerData.
		// Dependencies: this test uses in-memory extension, session, footer data, and TUI fakes.
		const { footerRenderer } = await installFooterTestHarness();
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(),
		);

		const renderedText = footerComponent.render(120).join("\n");

		expect(renderedText).toContain("No agent");
	});

	test("renders the main-agent ID from runtime composition", async () => {
		// Purpose: the agent footer segment must use the same in-memory contribution that prompt composition uses.
		// Input and expected output: runtime mainAgentContribution with agent id Sage renders `Sage`.
		// Edge case: contribution without custom tools still updates the agent segment.
		// Dependencies: this test uses shared runtime composition through the fake ExtensionAPI event bus.
		const { pi, footerRenderer } = await installFooterTestHarness();
		getAgentRuntimeComposition(pi).setMainAgentContribution({
			prompt: "Sage prompt",
			agent: { id: "Sage" },
		});
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(),
		);

		const renderedText = footerComponent.render(120).join("\n");

		expect(renderedText).toContain("Sage");
		expect(renderedText).not.toContain("No agent");
	});

	test("ignores legacy agent extension status when runtime composition has no main-agent contribution", async () => {
		// Purpose: stale ctx.ui.setStatus("agent") data must not become a second source of truth.
		// Input and expected output: footerData agent status Sage renders `No agent` because runtime composition is empty.
		// Edge case: stale status text matches a valid agent-like label.
		// Dependencies: this test uses footerData status without publishing a runtime contribution.
		const { footerRenderer } = await installFooterTestHarness();
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(new Map([["agent", "Sage"]])),
		);

		const renderedText = footerComponent.render(120).join("\n");

		expect(renderedText).toContain("No agent");
		expect(renderedText).not.toContain("Sage");
	});

	test("ignores a stale pre-reload runtime composition object", async () => {
		// Purpose: footer must not reuse runtime composition objects from older extension code after /reload.
		// Input and expected output: a stale V2 object with agent Stale exists, but the footer renders `No agent` from a new runtime composition.
		// Edge case: the stale property is non-configurable, matching previous runtime singleton storage.
		// Dependencies: this test uses the real runtime composition lookup with an in-memory event bus fake.
		const { pi, footerRenderer } = await installFooterTestHarness();
		Object.defineProperty(pi.events, "__piHarnessAgentRuntimeCompositionV2", {
			configurable: false,
			enumerable: false,
			value: {
				getMainAgentContribution: () => ({
					prompt: "Stale prompt",
					agent: { id: "Stale" },
				}),
			},
			writable: false,
		});
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(),
		);

		const renderedText = footerComponent.render(120).join("\n");

		expect(renderedText).toContain("No agent");
		expect(renderedText).not.toContain("Stale");
	});

	test("requests render after runtime main-agent contribution changes", async () => {
		// Purpose: /agent changes must redraw the footer even though agent status is no longer written through ctx.ui.setStatus.
		// Input and expected output: setting Sage after component creation triggers one render request and renders Sage.
		// Edge case: the footer component reads the latest runtime state at render time.
		// Dependencies: this test uses the runtime composition change listener and a TUI fake.
		const { pi, footerRenderer } = await installFooterTestHarness();
		const tui = createTuiFake();
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(),
			tui,
		);

		getAgentRuntimeComposition(pi).setMainAgentContribution({
			prompt: "Sage prompt",
			agent: { id: "Sage" },
		});

		expect(tui.requestRenderCalls).toHaveLength(1);
		expect(footerComponent.render(120).join("\n")).toContain("Sage");
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
		// Edge case: a zero-token context usage remains visible as `0/256k/272k`.
		// Dependencies: this test uses only in-memory extension, session, footer data, and TUI fakes.
		const { pi, footerRenderer } = await installFooterTestHarness({
			contextUsage: { tokens: 0, contextWindow: 272_000 },
		});
		getAgentRuntimeComposition(pi).setMainAgentContribution({
			prompt: "Coder prompt",
			agent: { id: "Coder" },
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
				"0/256k/272k",
			].join(SEGMENT_SEPARATOR),
		);
	});

	test("hides the git branch by default", async () => {
		// Purpose: the footer must preserve the compact project label unless branch display is enabled.
		// Input and expected output: project `pi-harness` with branch `main` renders without `(main)`.
		// Edge case: branch data is available from Pi even though the default configuration hides it.
		// Dependencies: this test uses only in-memory extension, session, footer data, and TUI fakes.
		const { footerRenderer } = await installFooterTestHarness();
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(new Map(), "main"),
		);

		const renderedText = footerComponent.render(120).join("\n");

		expect(renderedText).toContain("pi-harness");
		expect(renderedText).not.toContain("(main)");
	});

	test("shows the git branch and can disable the additional status line", async () => {
		// Purpose: both new footer settings must control their display areas independently.
		// Input and expected output: enabled branch display adds `(main)` without a preceding space, while a disabled additional line hides an unknown status.
		// Edge case: disabling the additional line must not disable or remove the primary footer line.
		// Dependencies: this test uses isolated configuration and in-memory footer data.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeFooterConfig(agentDir, {
				showGitBranch: true,
				showAdditionalStatusLine: false,
			});
			const { footerRenderer } = await installFooterTestHarness();
			const footerComponent = createFooterComponent(
				footerRenderer,
				createFooterDataFake(new Map([["review", "2 findings"]]), "main"),
			);

			const renderedLines = footerComponent.render(120);

			expect(renderedLines).toHaveLength(1);
			expect(renderedLines[0]).toContain("pi-harness(main)");
			expect(renderedLines[0]).not.toContain("2 findings");
		});
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
		const { pi, footerRenderer } = await installFooterTestHarness(
			"/workspace/customer-platform-with-a-very-long-service-name/src/extensions/footer",
		);
		getAgentRuntimeComposition(pi).setMainAgentContribution({
			prompt: "Coder prompt",
			agent: { id: "Coder" },
		});
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
		expect(renderedText).toContain("42k/184k/200k");
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
		// Purpose: model display defaults must expose provider, model, thinking level, and native compaction threshold in the footer.
		// Input and expected output: openai-codex gpt-5.4 with high thinking renders `openai-codex/gpt-5.4/high` and `42k/184k/200k`.
		// Edge case: provider, model, and thinking level render as one slash-delimited segment.
		// Dependencies: this test uses only in-memory extension, session, footer data, TUI fakes, and isolated pi settings.
		const { footerRenderer } = await installFooterTestHarness();
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(),
		);

		const renderedText = footerComponent.render(120).join("\n");

		expect(renderedText).toContain("openai-codex/gpt-5.4/high");
		expect(renderedText).toContain("42k/184k/200k");
	});

	test("renders a colored fast marker in the model display when Codex fast mode is enabled", async () => {
		// Purpose: the footer must expose fast mode without adding another footer segment.
		// Input and expected output: codex-fast enabled status renders `openai-codex/gpt-5.4/high-<accent>F</accent>`.
		// Edge case: only the `F` marker is colored; the dash stays in the normal model segment.
		// Dependencies: this test uses only in-memory extension, session, footer data, and TUI fakes.
		const { footerRenderer } = await installFooterTestHarness();
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(new Map([["codex-fast", "enabled"]])),
			createTuiFake(),
			true,
		);

		const renderedText = footerComponent.render(120).join("\n");

		expect(renderedText).toContain(
			"openai-codex/gpt-5.4/high-<accent>F</accent>",
		);
	});

	test("renders projection-aware context usage while provider usage is stale", async () => {
		// Purpose: footer context usage must match the projected provider payload after projection succeeds but provider usage is still stale.
		// Input and expected output: 48k pending projection savings turns raw `130k/262k/272k` into `82k/262k/272k`.
		// Edge case: the native compaction limit remains based on the full context window and is not reduced by projection.
		// Dependencies: shared in-memory projection state, pi settings, and footer renderer fake.
		await withIsolatedAgentDir(async (agentDir) => {
			await writePiSettings(agentDir, {
				compaction: { enabled: true, reserveTokens: 10_000 },
			});
			const sessionId = "footer-projection-aware-usage";
			resetPendingProjectionSavings(sessionId);
			addPendingProjectionSavings(sessionId, 48_000, {
				branchLeafId: "leaf-1",
				entryIds: ["entry-1"],
			});
			try {
				const { footerRenderer } = await installFooterTestHarness({
					sessionId,
					contextUsage: { tokens: 130_000, contextWindow: 272_000 },
				});
				const footerComponent = createFooterComponent(
					footerRenderer,
					createFooterDataFake(new Map([["context-projection", "~48k"]])),
				);

				const renderedText = footerComponent.render(120).join("\n");

				expect(renderedText).toContain("~48k");
				expect(renderedText).toContain("82k/262k/272k");
				expect(renderedText).not.toContain("130k/262k/272k");
			} finally {
				resetPendingProjectionSavings(sessionId);
			}
		});
	});

	test("omits the compaction limit when native compaction is disabled", async () => {
		// Purpose: footer context usage must keep the two-part format when native compaction is disabled.
		// Input and expected output: disabled native compaction renders `42k/200k`.
		// Edge case: footer itself stays enabled while native compaction is disabled.
		// Dependencies: this test uses isolated pi settings and in-memory fakes.
		await withIsolatedAgentDir(async (agentDir) => {
			await writePiSettings(agentDir, { compaction: { enabled: false } });
			const { footerRenderer } = await installFooterTestHarness();
			const footerComponent = createFooterComponent(
				footerRenderer,
				createFooterDataFake(),
			);

			const renderedText = footerComponent.render(120).join("\n");

			expect(renderedText).toContain("42k/200k");
			expect(renderedText).not.toContain("184k");
		});
	});

	test("uses the configured native compaction limit in context usage", async () => {
		// Purpose: footer context usage must show the configured native compaction threshold.
		// Input and expected output: reserveTokens 10000 with a 200000-token window renders `42k/190k/200k`.
		// Edge case: pi stores reserved tokens, while the footer displays the used-token threshold.
		// Dependencies: this test uses isolated pi settings and in-memory fakes.
		await withIsolatedAgentDir(async (agentDir) => {
			await writePiSettings(agentDir, {
				compaction: { reserveTokens: 10_000 },
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

	test("omits the compaction limit when native compaction settings are invalid", async () => {
		// Purpose: a pi settings error must not break footer rendering.
		// Input and expected output: invalid reserveTokens renders `42k/200k`.
		// Edge case: footer keeps rendering without showing a threshold from invalid settings.
		// Dependencies: this test uses isolated pi settings and in-memory fakes.
		await withIsolatedAgentDir(async (agentDir) => {
			await writePiSettings(agentDir, {
				compaction: { reserveTokens: -1 },
			});
			const { footerRenderer } = await installFooterTestHarness();
			const footerComponent = createFooterComponent(
				footerRenderer,
				createFooterDataFake(),
			);

			const renderedText = footerComponent.render(120).join("\n");

			expect(renderedText).toContain("42k/200k");
			expect(renderedText).not.toContain("184k");
		});
	});

	test("renders API cost by default after Codex quota", async () => {
		// Purpose: the custom footer must show the active-session API cost plus extension helper costs.
		// Input and expected output: assistant message costs 0.12 and 0.0034 plus helper cost 0.45 render `$0.573` after the Codex quota segment.
		// Edge case: non-assistant message entries do not affect the displayed API cost.
		// Dependencies: this test uses in-memory session entries instead of real session files.
		const { footerRenderer } = await installFooterTestHarness({
			sessionEntries: [
				createMessageEntryFake("assistant", 0.12),
				createMessageEntryFake("user", 100),
				createHelperApiCostEntryFake("consult-advisor", 0.45),
				createMessageEntryFake("assistant", 0.0034),
			],
		});
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(new Map([["codex-quota", "90%/2h"]])),
		);

		const renderedText = footerComponent.render(120).join("\n");

		expect(renderedText).toContain(
			["90%/2h", "$0.573", "No agent"].join(SEGMENT_SEPARATOR),
		);
	});

	test("omits API cost when explicitly disabled", async () => {
		// Purpose: showApiCost false must let users keep the footer layout free of API cost.
		// Input and expected output: a session with assistant cost renders no `$` cost segment.
		// Edge case: other model-display defaults remain enabled.
		// Dependencies: this test uses an isolated footer config and in-memory session entries.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeFooterConfig(agentDir, { showApiCost: false });
			const { footerRenderer } = await installFooterTestHarness({
				sessionEntries: [createMessageEntryFake("assistant", 0.12)],
			});
			const footerComponent = createFooterComponent(
				footerRenderer,
				createFooterDataFake(new Map([["codex-quota", "90%/2h"]])),
			);

			const renderedText = footerComponent.render(120).join("\n");

			expect(renderedText).toContain("90%/2h");
			expect(renderedText).not.toContain("$0.120");
		});
	});

	test.each([
		["showApiCost", "yes"],
		["showGitBranch", "yes"],
		["showAdditionalStatusLine", 1],
	])("does not install footer when %s config is invalid", async (key, value) => {
		// Purpose: footer config validation must reject non-boolean display settings.
		// Input and expected output: one invalid display value leaves the session without a custom footer renderer.
		// Edge case: all other config fields are omitted and would otherwise use defaults.
		// Dependencies: this test uses an isolated footer config file for each table row.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeFooterConfig(agentDir, { [key]: value });
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

	test("renders subscription API cost marker when OAuth subscription is active", async () => {
		// Purpose: subscription-backed models must expose the same `(sub)` marker as the standard pi footer.
		// Input and expected output: zero tracked cost with active subscription renders `$0.000 (sub)`.
		// Edge case: the cost segment remains visible even when no billable API cost has accumulated.
		// Dependencies: this test uses a model registry fake instead of real OAuth state.
		const { footerRenderer } = await installFooterTestHarness({
			usingSubscription: true,
		});
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(new Map([["codex-quota", "90%/2h"]])),
		);

		const renderedText = footerComponent.render(120).join("\n");

		expect(renderedText).toContain(
			["90%/2h", "$0.000 (sub)", "No agent"].join(SEGMENT_SEPARATOR),
		);
	});

	test("keeps API cost visible when the project name is long", async () => {
		// Purpose: API cost is financial status and must not be hidden by project or model text.
		// Input and expected output: a narrow footer with a long project keeps quota, API cost, agent, model, projection, and context segments.
		// Edge case: the project segment gets clipped before priority segments are removed.
		// Dependencies: this test uses in-memory session entries and extension statuses.
		const { pi, footerRenderer } = await installFooterTestHarness({
			cwd: "/workspace/customer-platform-with-a-very-long-service-name/src/extensions/footer",
			sessionEntries: [createMessageEntryFake("assistant", 12.345)],
		});
		getAgentRuntimeComposition(pi).setMainAgentContribution({
			prompt: "Coder prompt",
			agent: { id: "Coder" },
		});
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(
				new Map([
					["codex-quota", "93%/3h"],
					["context-projection", "~0"],
				]),
			),
		);

		const renderedText = footerComponent.render(90).join("\n");

		expect(renderedText).toContain("93%/3h");
		expect(renderedText).toContain("$12.345");
		expect(renderedText).toContain("Coder");
		expect(renderedText).toContain("openai-codex/gpt-5.4/high");
		expect(renderedText).toContain("~0");
		expect(renderedText).toContain("42k/184k/200k");
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
				["pi-harness", "No agent", "42k/184k/200k"].join(SEGMENT_SEPARATOR),
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
			{ tokens: 49_000, expectedText: "49k/84k/100k" },
			{ tokens: 50_000, expectedText: "<warning>50k/84k/100k</warning>" },
			{ tokens: 80_000, expectedText: "<error>80k/84k/100k</error>" },
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

	test("renders only unconsumed extension statuses on the additional line", async () => {
		// Purpose: the default additional line must expose unknown statuses without changing or duplicating the primary line.
		// Input and expected output: suite-owned statuses stay on line one, while unknown statuses appear on line two sorted by key.
		// Edge case: an MCP failure without English error keywords remains primary, and publication order differs from key order.
		// Dependencies: this test uses runtime agent composition and in-memory footer status data.
		const { pi, footerRenderer } = await installFooterTestHarness();
		getAgentRuntimeComposition(pi).setMainAgentContribution({
			prompt: "Architect prompt",
			agent: { id: "Architect" },
		});
		const primaryStatuses = new Map([
			["agent", "Legacy agent"],
			["codex-fast", "enabled"],
			["codex-quota", "41%/5d7h"],
			["context-projection", "~0"],
			[
				"mcp-files",
				"files: MCP tool name must contain ASCII letters or digits",
			],
			["mcp-github", "github error: token denied"],
		]);
		const primaryOnlyComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(primaryStatuses),
		);
		const additionalStatusComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(
				new Map([
					...primaryStatuses,
					["z-review", "2 findings"],
					["a-build", "Build ready"],
				]),
			),
		);

		const primaryOnlyLines = primaryOnlyComponent.render(200).map(stripAnsi);
		const renderedLines = additionalStatusComponent.render(200).map(stripAnsi);

		expect(primaryOnlyLines).toHaveLength(1);
		expect(renderedLines).toHaveLength(2);
		expect(renderedLines[0]).toBe(primaryOnlyLines[0]);
		expect(renderedLines[0]).toContain(
			"files: MCP tool name must contain ASCII letters or digits",
		);
		expect(renderedLines[1]).toBe("Build ready 2 findings");
		expect(renderedLines.join("\n")).not.toContain("Legacy agent");
		expect(renderedLines.join("\n")).not.toContain("enabled");
	});

	test("truncates styled additional statuses without breaking ANSI sequences", async () => {
		// Purpose: the additional line must use Pi's ANSI-aware width truncation for styled extension text.
		// Input and expected output: a true-color long status at width five renders two visible text cells plus an ellipsis.
		// Edge case: truncation must not cut inside the leading true-color SGR sequence.
		// Dependencies: this test uses a real terminal SGR sequence and Pi's visible-width implementation.
		const { footerRenderer } = await installFooterTestHarness();
		const red = `${String.fromCharCode(27)}[38;2;255;0;0m`;
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(
				new Map([["review", `${red}Long status text${SGR_RESET}`]]),
			),
		);

		const renderedLines = footerComponent.render(5);
		const visibleAdditionalStatus = renderedLines[1]
			?.replaceAll(red, "")
			.replaceAll(SGR_RESET, "");

		expect(renderedLines).toHaveLength(2);
		expect(visibleAdditionalStatus).toBe("Lo...");
		expect(visibleWidth(renderedLines[1] ?? "")).toBeLessThanOrEqual(5);
	});

	test("omits the additional line when no unconsumed status has text", async () => {
		// Purpose: the default additional-line setting must not create a blank footer row.
		// Input and expected output: consumed statuses and a whitespace-only unknown status produce exactly one line.
		// Edge case: sanitization removes all visible text from a present status-map entry.
		// Dependencies: this test uses only in-memory footer status data.
		const { footerRenderer } = await installFooterTestHarness();
		const footerComponent = createFooterComponent(
			footerRenderer,
			createFooterDataFake(
				new Map([
					["codex-quota", "41%/5d7h"],
					["context-projection", "~0"],
					["review", " \n\t "],
				]),
			),
		);

		const renderedLines = footerComponent.render(120);

		expect(renderedLines).toHaveLength(1);
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
		// Purpose: branch and additional-status text must not overflow Pi's fixed-width session UI.
		// Input and expected output: long project, branch, primary statuses, and unknown status produce two width-bounded lines.
		// Edge case: both the primary project label and the additional line require truncation.
		// Dependencies: this test uses isolated configuration and in-memory footer status data.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeFooterConfig(agentDir, { showGitBranch: true });
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
						[
							"review",
							"Review status with a very long diagnostic message that must be trimmed",
						],
					]),
					"feature/footer-with-a-very-long-branch-name",
				),
			);

			const renderedLines = footerComponent.render(40);

			expect(renderedLines).toHaveLength(2);
			for (const line of renderedLines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(40);
			}
		});
	});
});
