import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { AGENT_SUITE_DIR_ENV } from "../../shared/agent-suite-storage.ts";
import type { StructuredPromptFormResult } from "./form.ts";
import prompt from "./index.ts";

interface RegisteredCommandFake {
	readonly name: string;
	readonly handler: (
		args: string,
		ctx: PromptCommandContextFake,
	) => Promise<void> | void;
}

interface RegisteredShortcutFake {
	readonly shortcut: string;
	readonly handler: (ctx: PromptCommandContextFake) => Promise<void> | void;
}

interface CommandRegistrationOptionsFake {
	readonly handler: (
		args: string,
		ctx: PromptCommandContextFake,
	) => Promise<void> | void;
}

interface ShortcutRegistrationOptionsFake {
	readonly handler: (ctx: PromptCommandContextFake) => Promise<void> | void;
}

interface SentUserMessageFake {
	readonly content: string;
	readonly options: { readonly deliverAs?: "followUp" } | undefined;
}

interface PromptExtensionApiFake {
	readonly commands: RegisteredCommandFake[];
	readonly shortcuts: RegisteredShortcutFake[];
	readonly sentUserMessages: SentUserMessageFake[];
}

interface StructuredPromptDependenciesFake {
	readonly copyToClipboard?: (text: string) => Promise<void>;
	readonly resolveFdPath?: () => string | null;
	readonly createAutocompleteProvider?: (
		cwd: string,
		fdPath: string | null,
	) => AutocompleteProvider | undefined;
}

interface CustomComponentFake {
	render(width: number): string[];
	handleInput(data: string): Promise<void> | void;
}

interface PromptCommandContextFake {
	readonly hasUI: boolean;
	readonly notifications: Array<{
		readonly message: string;
		readonly type: string | undefined;
	}>;
	readonly confirmations: Array<{
		readonly title: string;
		readonly message: string;
	}>;
	readonly customOptions: unknown[];
	readonly editorTexts: string[];
	readonly cwd: string;
	ui: {
		notify(message: string, type?: string): void;
		confirm(title: string, message: string): Promise<boolean>;
		custom<T>(factory: unknown, options?: unknown): Promise<T>;
		setEditorText(text: string): void;
	};
	isIdle(): boolean;
	getLastCustomComponent(): CustomComponentFake | undefined;
	waitForNextRender(): Promise<void>;
	triggerLastReviewCopy(): Promise<void>;
}

const ENTER = "\r";
const CTRL_Y = "\x19";
const previousAgentSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
const tempDirs: string[] = [];

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

describe("structured-prompt extension", () => {
	test("registers command and shortcut by default when config is missing", async () => {
		// Purpose: the extension must be usable without setup.
		// Input and expected output: missing config registers /prompt and the best-effort shortcut.
		// Edge case: the suite config directory is absent.
		// Dependencies: this test uses isolated temp storage and an in-memory ExtensionAPI fake.
		await withIsolatedSuiteDir(async () => {
			const pi = createExtensionApiFake();

			prompt(pi as unknown as ExtensionAPI);

			expect(pi.commands.map(({ name }) => name)).toEqual(["prompt"]);
			expect(pi.shortcuts.map(({ shortcut }) => shortcut)).toEqual([
				"ctrl+alt+p",
			]);
		});
	});

	test("does not register command or shortcut when disabled", async () => {
		// Purpose: enabled false must remove both public invocation paths.
		// Input and expected output: suite config with enabled false registers no command and no shortcut.
		// Edge case: no other config fields are needed for disablement.
		// Dependencies: this test uses isolated temp storage and an in-memory ExtensionAPI fake.
		await withIsolatedSuiteDir(async (suiteDir) => {
			await writePromptConfig(suiteDir, { enabled: false });
			const pi = createExtensionApiFake();

			prompt(pi as unknown as ExtensionAPI);

			expect(pi.commands).toEqual([]);
			expect(pi.shortcuts).toEqual([]);
		});
	});

	test("does not register command or shortcut when config is invalid", async () => {
		// Purpose: invalid config must fail closed instead of exposing partial behavior.
		// Input and expected output: malformed config registers no command and no shortcut.
		// Edge case: invalid config is detected during extension load.
		// Dependencies: this test uses isolated temp storage and an in-memory ExtensionAPI fake.
		await withIsolatedSuiteDir(async (suiteDir) => {
			await writePromptConfigText(suiteDir, "{");
			const pi = createExtensionApiFake();

			prompt(pi as unknown as ExtensionAPI);

			expect(pi.commands).toEqual([]);
			expect(pi.shortcuts).toEqual([]);
		});
	});

	test("command and shortcut use the same idle submit flow", async () => {
		// Purpose: /prompt and ctrl+alt+p must not drift in behavior.
		// Input and expected output: both handlers send the same generated prompt when idle.
		// Edge case: empty sections are omitted before delivery.
		// Dependencies: this test uses fake UI result and fake user-message delivery.
		await withIsolatedSuiteDir(async () => {
			const pi = createExtensionApiFake();
			const ctx = createCommandContextFake({
				formResult: submittedFormResult(),
				idle: true,
			});
			prompt(pi as unknown as ExtensionAPI);

			await getPromptCommand(pi).handler("", ctx);
			await getPromptShortcut(pi).handler(ctx);

			expect(pi.sentUserMessages).toEqual([
				{
					content: ["## Goal", "Create structured requests"].join("\n"),
					options: undefined,
				},
				{
					content: ["## Goal", "Create structured requests"].join("\n"),
					options: undefined,
				},
			]);
			expect(ctx.customOptions).toHaveLength(2);
			for (const options of ctx.customOptions) {
				expect(options).toMatchObject({
					overlay: true,
					overlayOptions: { anchor: "center" },
				});
			}
		});
	});

	test("does not send when UI is unavailable", async () => {
		// Purpose: the form requires interactive UI and must fail closed outside it.
		// Input and expected output: no UI reports a warning and sends no message.
		// Edge case: the form is not opened.
		// Dependencies: this test uses fake UI and fake user-message delivery.
		await withIsolatedSuiteDir(async () => {
			const pi = createExtensionApiFake();
			const ctx = createCommandContextFake({
				formResult: submittedFormResult(),
				hasUI: false,
				idle: true,
			});
			prompt(pi as unknown as ExtensionAPI);

			await getPromptCommand(pi).handler("", ctx);

			expect(pi.sentUserMessages).toEqual([]);
			expect(ctx.customOptions).toEqual([]);
			expect(ctx.notifications).toEqual([
				{ message: "Prompt form requires interactive mode.", type: "warning" },
			]);
		});
	});

	test("wires @ file autocomplete through the runtime fd path", async () => {
		// Purpose: the command must give the form the file autocomplete provider built from the resolved fd path.
		// Input and expected output: @ asks the provider for suggestions and renders README.md.
		// Edge case: slash commands are not part of the form provider because the provider is created with no commands.
		// Dependencies: this test uses a deterministic autocomplete provider fake and a captured custom component.
		await withIsolatedSuiteDir(async () => {
			const projectDir = await mkdtemp(
				join(tmpdir(), "structured-prompt-project-"),
			);
			tempDirs.push(projectDir);
			const fdPath = join(projectDir, "fd");
			let providerCwd: string | undefined;
			let providerFdPath: string | null | undefined;
			let resolveSuggestions: (() => void) | undefined;
			let releaseSuggestions: (() => void) | undefined;
			const suggestionsRequested = new Promise<void>((resolve) => {
				resolveSuggestions = resolve;
			});
			const suggestionsReleased = new Promise<void>((resolve) => {
				releaseSuggestions = resolve;
			});
			const autocompleteProvider = createAutocompleteProviderFake(
				() => resolveSuggestions?.(),
				suggestionsReleased,
			);
			const pi = createExtensionApiFake();
			const dependencies: StructuredPromptDependenciesFake = {
				resolveFdPath: () => fdPath,
				createAutocompleteProvider: (cwd, resolvedFdPath) => {
					providerCwd = cwd;
					providerFdPath = resolvedFdPath;
					return autocompleteProvider;
				},
			};
			const ctx = createCommandContextFake({
				cwd: projectDir,
				formResult: { kind: "cancelled" },
				idle: true,
			});
			prompt(pi as unknown as ExtensionAPI, dependencies);

			await getPromptCommand(pi).handler("", ctx);
			const component = ctx.getLastCustomComponent();
			expect(component).toBeDefined();
			if (component === undefined) {
				throw new Error("structured prompt form was not opened");
			}

			typeCharacters(component, "@");
			await suggestionsRequested;
			const renderAfterSuggestions = ctx.waitForNextRender();
			releaseSuggestions?.();
			await renderAfterSuggestions;

			expect(providerCwd).toBe(projectDir);
			expect(providerFdPath).toBe(fdPath);
			expect(component.render(80).join("\n")).toContain("README.md");
		});
	});

	test("keeps normal submission when runtime fd is unavailable", async () => {
		// Purpose: file autocomplete depends on fd, but prompt delivery must not depend on it.
		// Input and expected output: fd resolution returns null and the submitted form still sends the prompt.
		// Edge case: no autocomplete provider is passed to the form.
		// Dependencies: this test uses fake UI result and fake user-message delivery.
		await withIsolatedSuiteDir(async () => {
			const pi = createExtensionApiFake();
			const dependencies: StructuredPromptDependenciesFake = {
				resolveFdPath: () => null,
			};
			const ctx = createCommandContextFake({
				formResult: submittedFormResult(),
				idle: true,
			});
			prompt(pi as unknown as ExtensionAPI, dependencies);

			await getPromptCommand(pi).handler("", ctx);

			expect(pi.sentUserMessages).toEqual([
				{
					content: ["## Goal", "Create structured requests"].join("\n"),
					options: undefined,
				},
			]);
		});
	});

	test("keeps slash commands disabled inside the form editor", async () => {
		// Purpose: section text must not show command completion or consume Enter for slash commands.
		// Input and expected output: typing / then Enter moves from Goal to Task.
		// Edge case: the provider is fd-backed but has no command list.
		// Dependencies: this test uses a temporary fake fd executable and a captured custom component.
		await withIsolatedSuiteDir(async () => {
			const projectDir = await mkdtemp(
				join(tmpdir(), "structured-prompt-project-"),
			);
			tempDirs.push(projectDir);
			const binDir = await mkdtemp(join(tmpdir(), "structured-prompt-bin-"));
			tempDirs.push(binDir);
			const fdPath = join(binDir, "fd");
			await writeFile(fdPath, "#!/bin/sh\nprintf ''\n");
			await chmod(fdPath, 0o755);
			const pi = createExtensionApiFake();
			const dependencies: StructuredPromptDependenciesFake = {
				resolveFdPath: () => fdPath,
			};
			const ctx = createCommandContextFake({
				cwd: projectDir,
				formResult: { kind: "cancelled" },
				idle: true,
			});
			prompt(pi as unknown as ExtensionAPI, dependencies);

			await getPromptCommand(pi).handler("", ctx);
			const component = ctx.getLastCustomComponent();
			expect(component).toBeDefined();
			if (component === undefined) {
				throw new Error("structured prompt form was not opened");
			}

			typeCharacters(component, "/");
			await delay(30);
			component.handleInput(ENTER);

			expect(component.render(80).join("\n")).toContain("2/6: Task");
		});
	});

	test("cancel and empty submit do not send messages", async () => {
		// Purpose: closing the form or submitting only empty sections must not create an empty user message.
		// Input and expected output: cancelled and empty submitted results send no messages.
		// Edge case: all section values are whitespace.
		// Dependencies: this test uses fake UI and fake user-message delivery.
		await withIsolatedSuiteDir(async () => {
			const pi = createExtensionApiFake();
			const cancelCtx = createCommandContextFake({
				formResult: { kind: "cancelled" },
				idle: true,
			});
			const emptyCtx = createCommandContextFake({
				formResult: {
					kind: "submitted",
					values: [{ sectionId: "goal", value: "  " }],
				},
				idle: true,
			});
			prompt(pi as unknown as ExtensionAPI);

			await getPromptCommand(pi).handler("", cancelCtx);
			await getPromptCommand(pi).handler("", emptyCtx);

			expect(pi.sentUserMessages).toEqual([]);
			expect(emptyCtx.notifications).toEqual([
				{ message: "Prompt form is empty.", type: "warning" },
			]);
		});
	});

	test("asks before queuing a follow-up while the agent is busy", async () => {
		// Purpose: follow-up delivery changes timing and must be explicit.
		// Input and expected output: rejecting confirmation sends nothing; accepting queues follow-up.
		// Edge case: confirmation text states that the prompt will be queued.
		// Dependencies: this test uses fake confirmation and fake user-message delivery.
		await withIsolatedSuiteDir(async () => {
			const pi = createExtensionApiFake();
			const rejectCtx = createCommandContextFake({
				formResult: submittedFormResult(),
				idle: false,
				confirmResult: false,
			});
			const acceptCtx = createCommandContextFake({
				formResult: submittedFormResult(),
				idle: false,
				confirmResult: true,
			});
			prompt(pi as unknown as ExtensionAPI);

			await getPromptCommand(pi).handler("", rejectCtx);
			await getPromptCommand(pi).handler("", acceptCtx);

			expect(rejectCtx.confirmations).toEqual([
				{
					title: "Queue prompt as follow-up?",
					message:
						"The agent is busy. Queue this prompt to run after the current response finishes?",
				},
			]);
			expect(pi.sentUserMessages).toEqual([
				{
					content: ["## Goal", "Create structured requests"].join("\n"),
					options: { deliverAs: "followUp" },
				},
			]);
		});
	});

	test("places the generated prompt in the input field without sending", async () => {
		// Purpose: users must be able to review and then edit the generated prompt manually.
		// Input and expected output: inserted form result sets the main editor text and sends no message.
		// Edge case: the agent is busy, but no follow-up confirmation is requested because nothing is sent.
		// Dependencies: this test uses fake UI editor integration.
		await withIsolatedSuiteDir(async () => {
			const pi = createExtensionApiFake();
			const ctx = createCommandContextFake({
				formResult: insertedFormResult(),
				idle: false,
			});
			prompt(pi as unknown as ExtensionAPI);

			await getPromptCommand(pi).handler("", ctx);

			expect(ctx.editorTexts).toEqual([
				["## Goal", "Create structured requests"].join("\n"),
			]);
			expect(pi.sentUserMessages).toEqual([]);
			expect(ctx.confirmations).toEqual([]);
		});
	});

	test("copies the generated prompt from review without sending", async () => {
		// Purpose: users must be able to copy the generated prompt before deciding whether to send.
		// Input and expected output: Ctrl+Y copy callback copies the formatted prompt and sends no message.
		// Edge case: copy is a review action and does not finish the form by itself.
		// Dependencies: this test executes the custom UI factory with fake TUI and theme objects.
		await withIsolatedSuiteDir(async () => {
			const copiedPrompts: string[] = [];
			const pi = createExtensionApiFake();
			const ctx = createCommandContextFake({
				formResult: { kind: "cancelled" },
				idle: true,
			});
			prompt(pi as unknown as ExtensionAPI, {
				copyToClipboard: async (text) => {
					copiedPrompts.push(text);
				},
			} satisfies StructuredPromptDependenciesFake);

			await getPromptCommand(pi).handler("", ctx);
			await ctx.triggerLastReviewCopy();

			expect(copiedPrompts).toEqual([
				["## Goal", "Create structured requests"].join("\n"),
			]);
			expect(pi.sentUserMessages).toEqual([]);
			expect(ctx.notifications).toContainEqual({
				message: "Prompt copied to clipboard.",
				type: "info",
			});
		});
	});

	test("reports clipboard copy failures without sending", async () => {
		// Purpose: clipboard failures must be visible and must not submit a message.
		// Input and expected output: failed Ctrl+Y reports a warning while the command result remains cancelled.
		// Edge case: the copy dependency rejects while the review action is active.
		// Dependencies: this test executes the custom UI factory with fake TUI and theme objects.
		await withIsolatedSuiteDir(async () => {
			const pi = createExtensionApiFake();
			const ctx = createCommandContextFake({
				formResult: { kind: "cancelled" },
				idle: true,
			});
			prompt(pi as unknown as ExtensionAPI, {
				copyToClipboard: async () => {
					throw new Error("clipboard unavailable");
				},
			} satisfies StructuredPromptDependenciesFake);

			await getPromptCommand(pi).handler("", ctx);
			await ctx.triggerLastReviewCopy();

			expect(ctx.notifications).toContainEqual({
				message: "Failed to copy prompt to clipboard: clipboard unavailable",
				type: "warning",
			});
			expect(pi.sentUserMessages).toEqual([]);
		});
	});
});

function createExtensionApiFake(): PromptExtensionApiFake {
	const commands: RegisteredCommandFake[] = [];
	const shortcuts: RegisteredShortcutFake[] = [];
	const sentUserMessages: SentUserMessageFake[] = [];

	return {
		commands,
		shortcuts,
		sentUserMessages,
		registerCommand(
			name: string,
			options: CommandRegistrationOptionsFake,
		): void {
			commands.push({ name, handler: options.handler });
		},
		registerShortcut(
			shortcut: string,
			options: ShortcutRegistrationOptionsFake,
		): void {
			shortcuts.push({ shortcut, handler: options.handler });
		},
		sendUserMessage(
			content: string,
			options?: { deliverAs?: "followUp" },
		): void {
			sentUserMessages.push({ content, options });
		},
	} as unknown as PromptExtensionApiFake;
}

function createCommandContextFake(options: {
	readonly cwd?: string;
	readonly formResult: StructuredPromptFormResult;
	readonly hasUI?: boolean;
	readonly idle: boolean;
	readonly confirmResult?: boolean;
}): PromptCommandContextFake {
	const notifications: Array<{
		readonly message: string;
		readonly type: string | undefined;
	}> = [];
	const confirmations: Array<{
		readonly title: string;
		readonly message: string;
	}> = [];
	const customOptions: unknown[] = [];
	const editorTexts: string[] = [];
	let lastCustomComponent: CustomComponentFake | undefined;
	let resolveNextRender: (() => void) | undefined;
	return {
		hasUI: options.hasUI ?? true,
		notifications,
		confirmations,
		customOptions,
		editorTexts,
		cwd: options.cwd ?? process.cwd(),
		ui: {
			notify(message: string, type?: string): void {
				notifications.push({ message, type });
			},
			async confirm(title: string, message: string): Promise<boolean> {
				confirmations.push({ title, message });
				return options.confirmResult ?? false;
			},
			async custom<T>(
				factory: unknown,
				customOptionsValue?: unknown,
			): Promise<T> {
				customOptions.push(customOptionsValue);
				if (typeof factory === "function") {
					lastCustomComponent = factory(
						{
							terminal: { rows: 40 },
							requestRender(): void {
								resolveNextRender?.();
								resolveNextRender = undefined;
							},
						},
						{
							fg: (_color: string, value: string) => value,
							bold: (value: string) => value,
						},
						undefined,
						() => {},
					) as CustomComponentFake;
				}
				return options.formResult as T;
			},
			setEditorText(text: string): void {
				editorTexts.push(text);
			},
		},
		isIdle(): boolean {
			return options.idle;
		},
		getLastCustomComponent(): CustomComponentFake | undefined {
			return lastCustomComponent;
		},
		waitForNextRender(): Promise<void> {
			return new Promise((resolve) => {
				resolveNextRender = resolve;
			});
		},
		async triggerLastReviewCopy(): Promise<void> {
			if (lastCustomComponent === undefined) {
				throw new Error("custom form was not opened");
			}
			await lastCustomComponent.handleInput("Create structured requests");
			for (let index = 0; index < 6; index += 1) {
				await lastCustomComponent.handleInput(ENTER);
			}
			await lastCustomComponent.handleInput(CTRL_Y);
		},
	};
}

function submittedFormResult(): StructuredPromptFormResult {
	return {
		kind: "submitted",
		values: [
			{ sectionId: "goal", value: "Create structured requests" },
			{ sectionId: "task", value: "" },
		],
	};
}

function insertedFormResult(): StructuredPromptFormResult {
	return {
		kind: "inserted",
		values: [
			{ sectionId: "goal", value: "Create structured requests" },
			{ sectionId: "task", value: "" },
		],
	};
}

function getPromptCommand(pi: PromptExtensionApiFake): RegisteredCommandFake {
	const command = pi.commands.find(({ name }) => name === "prompt");
	if (command === undefined) {
		throw new Error("prompt command was not registered");
	}
	return command;
}

function getPromptShortcut(pi: PromptExtensionApiFake): RegisteredShortcutFake {
	const shortcut = pi.shortcuts.find(
		({ shortcut }) => shortcut === "ctrl+alt+p",
	);
	if (shortcut === undefined) {
		throw new Error("prompt shortcut was not registered");
	}
	return shortcut;
}

function typeCharacters(component: CustomComponentFake, value: string): void {
	for (const char of value) {
		component.handleInput(char);
	}
}

function createAutocompleteProviderFake(
	onSuggestionsRequested: () => void,
	suggestionsReleased: Promise<void>,
): AutocompleteProvider {
	return {
		async getSuggestions() {
			onSuggestionsRequested();
			await suggestionsReleased;
			return {
				prefix: "@",
				items: [{ value: "README.md", label: "README.md" }],
			};
		},
		applyCompletion(lines, cursorLine, cursorCol, item) {
			const completedLines = [...lines];
			completedLines[cursorLine] = item.value;
			return {
				lines: completedLines,
				cursorLine,
				cursorCol,
			};
		},
		shouldTriggerFileCompletion() {
			return true;
		},
	};
}

async function withIsolatedSuiteDir(
	testBody: (suiteDir: string) => Promise<void>,
): Promise<void> {
	const suiteDir = await mkdtemp(
		join(tmpdir(), "structured-prompt-extension-"),
	);
	tempDirs.push(suiteDir);
	process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
	await testBody(suiteDir);
}

async function writePromptConfig(
	suiteDir: string,
	config: unknown,
): Promise<void> {
	await writePromptConfigText(suiteDir, JSON.stringify(config));
}

async function writePromptConfigText(
	suiteDir: string,
	content: string,
): Promise<void> {
	const configDir = join(suiteDir, "structured-prompt");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "config.json"), content);
}
