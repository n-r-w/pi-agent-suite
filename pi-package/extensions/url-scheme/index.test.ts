import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withChildAgentProcessMarker } from "../../shared/child-agent-environment";
import urlScheme from "./index";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: unknown;
}

interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
}

interface Notification {
	readonly message: string;
	readonly type: string | undefined;
}

interface SessionContextFake {
	readonly cwd: string;
	readonly hasUI: boolean;
	readonly notifications: Notification[];
	readonly ui: {
		notify(message: string, type: string | undefined): void;
	};
}

interface TextContentFake {
	readonly type: "text";
	readonly text: string;
	readonly textSignature?: string;
}

interface ToolCallContentFake {
	readonly type: "toolCall";
	readonly id: string;
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

interface AssistantMessageFake {
	readonly role: "assistant";
	readonly content: readonly (TextContentFake | ToolCallContentFake)[];
	readonly stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
	readonly api: "test";
	readonly provider: "test";
	readonly model: "test";
	readonly usage: {
		readonly input: 0;
		readonly output: 0;
		readonly cacheRead: 0;
		readonly cacheWrite: 0;
		readonly totalTokens: 0;
		readonly cost: {
			readonly input: 0;
			readonly output: 0;
			readonly cacheRead: 0;
			readonly cacheWrite: 0;
			readonly total: 0;
		};
	};
	readonly timestamp: 1;
}

interface MessageEndEventFake {
	readonly type: "message_end";
	readonly message: AssistantMessageFake;
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

/** Creates a session context fake with a deterministic cwd and notification capture. */
function createSessionContextFake(cwd: string): SessionContextFake {
	const notifications: Notification[] = [];

	return {
		cwd,
		hasUI: true,
		notifications,
		ui: {
			notify(message: string, type: string | undefined): void {
				notifications.push({ message, type });
			},
		},
	};
}

/** Returns one registered event handler from the extension fake. */
function getRegisteredHandler(
	pi: ExtensionApiFake,
	eventName: string,
): (event: unknown, ctx: unknown) => Promise<unknown> | unknown {
	const handler = pi.handlers.find(
		(registeredHandler) => registeredHandler.eventName === eventName,
	)?.handler;
	if (typeof handler !== "function") {
		throw new Error(`expected ${eventName} handler to be registered`);
	}

	return handler as (
		event: unknown,
		ctx: unknown,
	) => Promise<unknown> | unknown;
}

/** Runs a test with isolated pi storage and working directory. */
async function withIsolatedAgentDir<T>(
	action: (paths: {
		readonly agentDir: string;
		readonly cwd: string;
	}) => Promise<T>,
): Promise<T> {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const previousAgentSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
	const agentDir = await mkdtemp(join(tmpdir(), "pi-url-scheme-agent-"));
	const cwd = await mkdtemp(join(tmpdir(), "pi-url-scheme-cwd-"));

	process.env[AGENT_DIR_ENV] = agentDir;
	delete process.env[AGENT_SUITE_DIR_ENV];
	try {
		return await action({ agentDir, cwd });
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
		await rm(cwd, { recursive: true, force: true });
	}
}

/** Writes url-scheme config into isolated suite storage. */
async function writeConfig(agentDir: string, config: unknown): Promise<void> {
	await mkdir(join(agentDir, "agent-suite", "url-scheme"), {
		recursive: true,
	});
	await writeFile(
		join(agentDir, "agent-suite", "url-scheme", "config.json"),
		JSON.stringify(config),
	);
}

/** Creates a file under cwd and returns both relative and absolute paths. */
async function createProjectFile(
	cwd: string,
	relativePath: string,
): Promise<{ readonly relativePath: string; readonly absolutePath: string }> {
	const absolutePath = resolve(cwd, relativePath);
	await mkdir(resolve(absolutePath, ".."), { recursive: true });
	await writeFile(absolutePath, "content");
	return { relativePath, absolutePath };
}

/** Creates a minimal assistant message_end event for one text block. */
function createAssistantMessageEndEvent(
	text: string,
	options?: {
		readonly stopReason?: AssistantMessageFake["stopReason"];
		readonly textSignature?: string;
	},
): MessageEndEventFake {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text,
					...(options?.textSignature === undefined
						? {}
						: { textSignature: options.textSignature }),
				},
			],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: options?.stopReason ?? "stop",
			timestamp: 1,
		},
	};
}

/** Runs url-scheme message_end conversion and returns replacement text when present. */
async function runMessageEnd(options: {
	readonly cwd: string;
	readonly event: MessageEndEventFake;
	readonly fileExists?: (path: string) => boolean;
	readonly env?: NodeJS.ProcessEnv;
}): Promise<{ readonly text: string | undefined; readonly result: unknown }> {
	const pi = createExtensionApiFake();
	const dependencies =
		options.fileExists === undefined && options.env === undefined
			? undefined
			: {
					...(options.fileExists === undefined
						? {}
						: { fileExists: options.fileExists }),
					...(options.env === undefined ? {} : { env: options.env }),
				};
	urlScheme(pi, dependencies);
	const result = await getRegisteredHandler(pi, "message_end")(
		options.event,
		createSessionContextFake(options.cwd),
	);
	const message = (
		result as { readonly message?: AssistantMessageFake } | undefined
	)?.message;
	const textBlock = message?.content[0];

	return {
		text: textBlock?.type === "text" ? textBlock.text : undefined,
		result,
	};
}

/** Encodes an editor URL path while preserving URL path separators. */
function encodePathForExpectedUrl(path: string): string {
	return path
		.replaceAll("\\", "/")
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
}

describe("url-scheme", () => {
	test("stays disabled when config is missing or explicitly disabled", async () => {
		// Purpose: url-scheme must not rewrite chat output unless the user enables it.
		// Input and expected output: missing config and enabled=false both return no replacement for an existing file reference.
		// Edge case: missing config is a normal disabled state, not an invalid config warning.
		// Dependencies: isolated suite storage, real temporary file, and in-memory ExtensionAPI fake.
		await withIsolatedAgentDir(async ({ agentDir, cwd }) => {
			const file = await createProjectFile(cwd, "packages/foo/src/bar.ts");
			const event = createAssistantMessageEndEvent(`See ${file.relativePath}`);

			expect(await runMessageEnd({ cwd, event })).toEqual({
				result: undefined,
				text: undefined,
			});

			await writeConfig(agentDir, { enabled: false });

			expect(await runMessageEnd({ cwd, event })).toEqual({
				result: undefined,
				text: undefined,
			});
		});
	});

	test("rewrites only final assistant stop and length messages", async () => {
		// Purpose: intermediate tool-use turns and unsuccessful endings must stay unchanged.
		// Input and expected output: stop and length produce replacements, while toolUse, error, and aborted do not.
		// Edge case: toolUse assistant messages can contain tool calls and are not final user-visible answers.
		// Dependencies: isolated suite config, real temporary file, and message_end handler return value.
		await withIsolatedAgentDir(async ({ agentDir, cwd }) => {
			await writeConfig(agentDir, { enabled: true });
			const file = await createProjectFile(cwd, "packages/foo/src/bar.ts");
			const expectedLink = `[${file.relativePath}](vscode://file${encodePathForExpectedUrl(file.absolutePath)})`;

			for (const stopReason of ["stop", "length"] as const) {
				const result = await runMessageEnd({
					cwd,
					event: createAssistantMessageEndEvent(`See ${file.relativePath}`, {
						stopReason,
					}),
				});

				expect(result.text).toBe(`See ${expectedLink}`);
			}

			for (const stopReason of ["toolUse", "error", "aborted"] as const) {
				const result = await runMessageEnd({
					cwd,
					event: createAssistantMessageEndEvent(`See ${file.relativePath}`, {
						stopReason,
					}),
				});

				expect(result.result).toBeUndefined();
			}
		});
	});

	test("skips marked child processes", async () => {
		// Purpose: child Pi processes must not convert child assistant answers.
		// Input and expected output: a marked child environment returns no replacement for an enabled final assistant answer.
		// Edge case: invalid config in a marked child process must not create a url-scheme warning.
		// Dependencies: isolated suite config, real temporary file, injected child environment, and fake UI notification capture.
		await withIsolatedAgentDir(async ({ agentDir, cwd }) => {
			await writeConfig(agentDir, { enabled: true });
			const file = await createProjectFile(cwd, "packages/foo/src/bar.ts");
			const childEnv = withChildAgentProcessMarker({});

			expect(
				await runMessageEnd({
					cwd,
					event: createAssistantMessageEndEvent(`See ${file.relativePath}`),
					env: childEnv,
				}),
			).toEqual({ result: undefined, text: undefined });

			await writeConfig(agentDir, { enabled: true, scheme: "sublime" });
			const pi = createExtensionApiFake();
			const ctx = createSessionContextFake(cwd);
			urlScheme(pi, { env: childEnv });

			const result = await getRegisteredHandler(pi, "message_end")(
				createAssistantMessageEndEvent(`See ${file.relativePath}`),
				ctx,
			);

			expect(result).toBeUndefined();
			expect(ctx.notifications).toEqual([]);
		});
	});

	test("does not partially rewrite references with invalid line suffixes", async () => {
		// Purpose: invalid line and column suffixes must keep the whole reference unchanged.
		// Input and expected output: package.json:0, package.json:1:0, and package.json:abc stay as plain text.
		// Edge case: the converter must not link only the file prefix before an invalid suffix.
		// Dependencies: isolated suite config, real temporary file, and deterministic cwd.
		await withIsolatedAgentDir(async ({ agentDir, cwd }) => {
			await writeConfig(agentDir, { enabled: true });
			await createProjectFile(cwd, "package.json");
			const text =
				"Open package.json:0, package.json:1:0, package.json:abc, package.json:1-0, package.json:1-abc and package.json:1-2-3";

			const result = await runMessageEnd({
				cwd,
				event: createAssistantMessageEndEvent(text),
			});

			expect(result.result).toBeUndefined();
		});
	});

	test("supports root-level relative references with optional line and column", async () => {
		// Purpose: relative file references in the current directory must be linkified even without path separators.
		// Input and expected output: package.json, package.json:1, and package.json:1:1 become Markdown links.
		// Edge case: root-level references rely on file existence and file-like names instead of a path separator.
		// Dependencies: isolated suite config, real temporary file, and deterministic cwd.
		await withIsolatedAgentDir(async ({ agentDir, cwd }) => {
			await writeConfig(agentDir, { enabled: true });
			const file = await createProjectFile(cwd, "package.json");
			const expectedUrl = `vscode://file${encodePathForExpectedUrl(file.absolutePath)}`;

			const result = await runMessageEnd({
				cwd,
				event: createAssistantMessageEndEvent(
					`Open ${file.relativePath}, ${file.relativePath}:1 and ${file.relativePath}:1:1`,
				),
			});

			expect(result.text).toBe(
				`Open [${file.relativePath}](${expectedUrl}), [${file.relativePath}:1](${expectedUrl}:1) and [${file.relativePath}:1:1](${expectedUrl}:1:1)`,
			);
		});
	});

	test("supports relative and absolute references with optional line and column", async () => {
		// Purpose: file references must resolve relative to ctx.cwd or preserve already absolute targets.
		// Input and expected output: relative path, absolute path, path:line, and path:line:column become Markdown links.
		// Edge case: file existence is checked before numeric suffixes are added to editor URLs.
		// Dependencies: isolated suite config, real temporary files, and deterministic cwd.
		await withIsolatedAgentDir(async ({ agentDir, cwd }) => {
			await writeConfig(agentDir, { enabled: true });
			const first = await createProjectFile(cwd, "packages/foo/src/bar.ts");
			const second = await createProjectFile(cwd, "packages/foo/src/baz.ts");
			const text = `Open ${first.relativePath}, ${first.relativePath}:12, ${first.relativePath}:12:5 and ${second.absolutePath}`;
			const expectedFirstUrl = `vscode://file${encodePathForExpectedUrl(first.absolutePath)}`;
			const expectedSecondUrl = `vscode://file${encodePathForExpectedUrl(second.absolutePath)}`;

			const result = await runMessageEnd({
				cwd,
				event: createAssistantMessageEndEvent(text),
			});

			expect(result.text).toBe(
				`Open [${first.relativePath}](${expectedFirstUrl}), [${first.relativePath}:12](${expectedFirstUrl}:12), [${first.relativePath}:12:5](${expectedFirstUrl}:12:5) and [${second.absolutePath}](${expectedSecondUrl})`,
			);
		});
	});

	test("supports line range references by opening the start line", async () => {
		// Purpose: line range references must be clickable even when editor schemes only support one target line.
		// Input and expected output: path:line-endLine keeps the full label and opens the start line.
		// Edge case: the converter must not expose unsupported editor-specific range syntax.
		// Dependencies: isolated suite config, real temporary file, and deterministic cwd.
		await withIsolatedAgentDir(async ({ agentDir, cwd }) => {
			await writeConfig(agentDir, { enabled: true });
			const file = await createProjectFile(cwd, "packages/foo/src/bar.ts");
			const expectedUrl = `vscode://file${encodePathForExpectedUrl(file.absolutePath)}`;

			const result = await runMessageEnd({
				cwd,
				event: createAssistantMessageEndEvent(
					`Open ${file.relativePath}:16-18 and ${file.relativePath}:16-16`,
				),
			});

			expect(result.text).toBe(
				`Open [${file.relativePath}:16-18](${expectedUrl}:16) and [${file.relativePath}:16-16](${expectedUrl}:16)`,
			);
		});
	});

	test("skips missing files, fenced code blocks, and Markdown images", async () => {
		// Purpose: conversion must not alter unsafe or non-link Markdown regions.
		// Input and expected output: missing files, fenced code, and images stay unchanged.
		// Edge case: a valid reference outside protected Markdown ranges is still converted.
		// Dependencies: isolated suite config, real temporary file, and protected-range parsing.
		await withIsolatedAgentDir(async ({ agentDir, cwd }) => {
			await writeConfig(agentDir, { enabled: true });
			const file = await createProjectFile(cwd, "packages/foo/src/bar.ts");
			const missingPath = "packages/foo/src/missing.ts";
			const protectedText = [
				"```ts",
				file.relativePath,
				"```",
				`Image ![${file.relativePath}](${file.relativePath})`,
				`Missing ${missingPath}`,
				`Valid ${file.relativePath}`,
			].join("\n");
			const expectedUrl = `vscode://file${encodePathForExpectedUrl(file.absolutePath)}`;

			const result = await runMessageEnd({
				cwd,
				event: createAssistantMessageEndEvent(protectedText),
			});

			expect(result.text).toBe(
				[
					"```ts",
					file.relativePath,
					"```",
					`Image ![${file.relativePath}](${file.relativePath})`,
					`Missing ${missingPath}`,
					`Valid [${file.relativePath}](${expectedUrl})`,
				].join("\n"),
			);
		});
	});

	test("removes single backticks around converted file references", async () => {
		// Purpose: single backticks are emphasis in assistant prose and must not block file links.
		// Input and expected output: a backticked file reference is converted and the surrounding backticks are removed.
		// Edge case: backticked directories remain unchanged because only files are valid targets.
		// Dependencies: isolated suite config, real temporary file and directory, and deterministic cwd.
		await withIsolatedAgentDir(async ({ agentDir, cwd }) => {
			await writeConfig(agentDir, { enabled: true });
			const file = await createProjectFile(cwd, "internal/domain/model.go");
			await mkdir(resolve(cwd, "internal/domain-only-dir"), {
				recursive: true,
			});
			const expectedUrl = `vscode://file${encodePathForExpectedUrl(file.absolutePath)}`;

			const result = await runMessageEnd({
				cwd,
				event: createAssistantMessageEndEvent(
					`File \`${file.relativePath}:12\`, range \`${file.relativePath}:16-18\`, directory \`internal/domain-only-dir\``,
				),
			});

			expect(result.text).toBe(
				`File [${file.relativePath}:12](${expectedUrl}:12), range [${file.relativePath}:16-18](${expectedUrl}:16), directory \`internal/domain-only-dir\``,
			);
		});
	});

	test("rewrites existing Markdown links that point to files", async () => {
		// Purpose: authored Markdown links should keep their label while file targets become editor URLs.
		// Input and expected output: file link destinations are rewritten, while URLs, anchors, missing files, and images stay unchanged.
		// Edge case: path line suffixes in Markdown link targets are preserved in the editor URL.
		// Dependencies: isolated suite config, real temporary file, and Markdown link parsing.
		await withIsolatedAgentDir(async ({ agentDir, cwd }) => {
			await writeConfig(agentDir, { enabled: true });
			const file = await createProjectFile(cwd, "packages/foo/src/bar.ts");
			const expectedUrl = `vscode://file${encodePathForExpectedUrl(file.absolutePath)}`;
			const text = [
				`File [${file.relativePath}](${file.relativePath})`,
				`Line [custom label](${file.relativePath}:12)`,
				`Range [range label](${file.relativePath}:16-18)`,
				"URL [site](https://example.com/package.json)",
				"Anchor [section](#section)",
				"Missing [missing](does/not/exist.ts)",
				`Image ![${file.relativePath}](${file.relativePath})`,
			].join("\n");

			const result = await runMessageEnd({
				cwd,
				event: createAssistantMessageEndEvent(text),
			});

			expect(result.text).toBe(
				[
					`File [${file.relativePath}](${expectedUrl})`,
					`Line [custom label](${expectedUrl}:12)`,
					`Range [range label](${expectedUrl}:16)`,
					"URL [site](https://example.com/package.json)",
					"Anchor [section](#section)",
					"Missing [missing](does/not/exist.ts)",
					`Image ![${file.relativePath}](${file.relativePath})`,
				].join("\n"),
			);
		});
	});

	test("removes textSignature from signed text blocks only when rewritten", async () => {
		// Purpose: changed final text blocks must not keep stale provider signatures.
		// Input and expected output: signed text with an existing file is rewritten and loses textSignature; signed text without changes is preserved.
		// Edge case: provider replay metadata is removed only from blocks whose text changed.
		// Dependencies: isolated suite config, real temporary file, and message_end replacement shape.
		await withIsolatedAgentDir(async ({ agentDir, cwd }) => {
			await writeConfig(agentDir, { enabled: true });
			const file = await createProjectFile(cwd, "packages/foo/src/bar.ts");
			const expectedUrl = `vscode://file${encodePathForExpectedUrl(file.absolutePath)}`;

			const signedResult = await runMessageEnd({
				cwd,
				event: createAssistantMessageEndEvent(`See ${file.relativePath}`, {
					textSignature: "signed",
				}),
			});

			expect(signedResult.text).toBe(
				`See [${file.relativePath}](${expectedUrl})`,
			);
			expect(
				(signedResult.result as { readonly message: AssistantMessageFake })
					.message.content[0],
			).not.toHaveProperty("textSignature");

			const unchangedResult = await runMessageEnd({
				cwd,
				event: createAssistantMessageEndEvent("No file reference", {
					textSignature: "signed",
				}),
			});

			expect(unchangedResult.result).toBeUndefined();
		});
	});

	test("uses configured schemes and percent-encodes paths and query parameters", async () => {
		// Purpose: every supported editor scheme must format URLs with safe percent-encoding.
		// Input and expected output: special characters, spaces, Unicode, and query-sensitive characters are encoded.
		// Edge case: JetBrains-style query strings must encode file values before adding line and column parameters.
		// Dependencies: isolated suite config, real temporary file with special characters, and scheme formatter.
		await withIsolatedAgentDir(async ({ agentDir, cwd }) => {
			const file = await createProjectFile(cwd, "dir with space/файл#?&.ts");
			const lineReference = `${file.absolutePath}:12:5`;
			const encodedPath = encodePathForExpectedUrl(file.absolutePath);
			const queryPath = encodeURIComponent(file.absolutePath);
			const expectedByScheme = {
				vscode: `vscode://file${encodedPath}:12:5`,
				cursor: `cursor://file${encodedPath}:12:5`,
				webstorm: `webstorm://open?file=${queryPath}&line=12&column=5`,
				idea: `idea://open?file=${queryPath}&line=12&column=5`,
				pycharm: `pycharm://open?file=${queryPath}&line=12&column=5`,
				phpstorm: `phpstorm://open?file=${queryPath}&line=12&column=5`,
				txmt: `txmt://open?url=${encodeURIComponent(`file://${file.absolutePath}`)}&line=12&column=5`,
				bbedit: `x-bbedit://open?url=${encodeURIComponent(`file://${file.absolutePath}`)}&line=12&column=5`,
			} as const;

			for (const [scheme, expectedUrl] of Object.entries(expectedByScheme)) {
				await writeConfig(agentDir, { enabled: true, scheme });

				const result = await runMessageEnd({
					cwd,
					event: createAssistantMessageEndEvent(`Open ${lineReference}`),
				});

				expect(result.text).toBe(`Open [${lineReference}](${expectedUrl})`);
			}
		});
	});

	test("formats Windows absolute paths without host OS path assumptions", async () => {
		// Purpose: Windows references must be recognized as absolute paths even when tests run on another OS.
		// Input and expected output: a Windows drive path is formatted as a Cursor URL after fake existence approval.
		// Edge case: backslashes are normalized to URL path separators and drive colons are percent-encoded.
		// Dependencies: isolated suite config, injected file existence check, and cross-OS path classification.
		await withIsolatedAgentDir(async ({ agentDir, cwd }) => {
			await writeConfig(agentDir, { enabled: true, scheme: "cursor" });
			const windowsPath = String.raw`C:\Users\Jane Doe\project\src\файл#?.ts`;
			const reference = `${windowsPath}:12`;

			const result = await runMessageEnd({
				cwd,
				event: createAssistantMessageEndEvent(`Open ${reference}`),
				fileExists: (path) => path === windowsPath,
			});

			expect(result.text).toBe(
				`Open [${reference}](cursor://file/${encodePathForExpectedUrl(windowsPath)}:12)`,
			);
		});
	});

	test("returns message_end replacement synchronously", async () => {
		// Purpose: message_end conversion must not await before using Pi handler context.
		// Input and expected output: enabled config and an existing relative file return a plain object, not a Promise.
		// Edge case: Pi marks event contexts stale across async boundaries.
		// Dependencies: isolated suite config, real temporary file, and in-memory ExtensionAPI fake.
		await withIsolatedAgentDir(async ({ agentDir, cwd }) => {
			await writeConfig(agentDir, { enabled: true });
			const file = await createProjectFile(cwd, "packages/foo/src/bar.ts");
			const pi = createExtensionApiFake();
			urlScheme(pi);

			const result = getRegisteredHandler(pi, "message_end")(
				createAssistantMessageEndEvent(`See ${file.relativePath}`),
				createSessionContextFake(cwd),
			);

			expect(result).not.toBeInstanceOf(Promise);
		});
	});

	test("fails closed and reports invalid config", async () => {
		// Purpose: invalid config must not partially enable URL rewriting with guessed defaults.
		// Input and expected output: unsupported scheme returns no replacement and reports one warning in UI mode.
		// Edge case: invalid config should be scoped to url-scheme and not throw from the message handler.
		// Dependencies: isolated suite config, fake UI notification capture, and strict config validation.
		await withIsolatedAgentDir(async ({ agentDir, cwd }) => {
			await writeConfig(agentDir, { enabled: true, scheme: "sublime" });
			const file = await createProjectFile(cwd, "packages/foo/src/bar.ts");
			const pi = createExtensionApiFake();
			const ctx = createSessionContextFake(cwd);
			urlScheme(pi);

			const result = await getRegisteredHandler(pi, "message_end")(
				createAssistantMessageEndEvent(`See ${file.relativePath}`),
				ctx,
			);

			expect(result).toBeUndefined();
			expect(ctx.notifications).toEqual([
				{
					message:
						"[url-scheme] scheme must be one of: vscode, cursor, webstorm, idea, pycharm, phpstorm, txmt, bbedit",
					type: "warning",
				},
			]);
		});
	});
});
