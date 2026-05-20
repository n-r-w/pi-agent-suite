import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { AGENT_SUITE_DIR_ENV } from "../../shared/agent-suite-storage";
import projectRules from "./index";

const previousAgentSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
const tempDirs: string[] = [];

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: unknown;
}

interface Notification {
	readonly message: string;
	readonly type: string | undefined;
}

interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
}

interface ContextFake {
	readonly notifications: Notification[];
	readonly ctx: {
		readonly cwd: string;
		readonly hasUI?: boolean;
		readonly ui: {
			notify(message: string, type: string | undefined): void;
		};
	};
}

interface BeforeAgentStartEventFake {
	readonly type: "before_agent_start";
	readonly prompt: string;
	readonly images: readonly unknown[];
	readonly systemPrompt: string;
	readonly systemPromptOptions: BuildSystemPromptOptions;
}

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

describe("project-rules", () => {
	test("appends recursive non-empty Markdown rules in deterministic visible-path order", async () => {
		// Purpose: project rule files must become a separate prompt section after the existing system prompt.
		// Input and expected output: direct and nested Markdown files are sorted by their visible path and appended.
		// Edge case: empty, whitespace-only, and non-Markdown files do not create project_rule blocks.
		// Dependencies: this test uses temporary project files and in-memory lifecycle fakes.
		await withIsolatedSuiteDir(async () => {
			const projectDir = await createTempDir("project-rules-project-");
			const rulesDir = join(projectDir, ".pi");
			await mkdir(join(rulesDir, "nested"), { recursive: true });
			await writeFile(join(rulesDir, "z.md"), "Z rule");
			await writeFile(join(rulesDir, "nested", "a.md"), "A rule");
			await writeFile(join(rulesDir, "empty.md"), "");
			await writeFile(join(rulesDir, "space.md"), "  \n\t");
			await writeFile(join(rulesDir, "note.txt"), "Ignored");
			const pi = createExtensionApiFake();
			const context = createContextFake(projectDir);

			projectRules(pi);

			const prompt = await runBeforeAgentStartHandlers(
				pi,
				createBeforeAgentStartEvent(projectDir),
				context.ctx,
			);

			expect(prompt).toBe(
				[
					"Original pi prompt",
					"",
					"<project_rules>",
					'  <project_rule path=".pi/nested/a.md">',
					"A rule",
					"  </project_rule>",
					'  <project_rule path=".pi/z.md">',
					"Z rule",
					"  </project_rule>",
					"</project_rules>",
				].join("\n"),
			);
		});
	});

	test("follows symlinked rules directory, files, and subdirectories while avoiding directory cycles", async () => {
		// Purpose: approved symlink behavior must allow shared rule files outside the cwd.
		// Input and expected output: rulesDir symlink, file symlink, and directory symlink are followed once.
		// Edge case: a symlink cycle must not repeat files or loop forever.
		// Dependencies: this test uses filesystem symlinks in temporary directories.
		await withIsolatedSuiteDir(async () => {
			const projectDir = await createTempDir("project-rules-project-");
			const realRulesDir = await createTempDir("project-rules-real-");
			const externalDir = await createTempDir("project-rules-external-");
			await writeFile(join(realRulesDir, "root.md"), "Root rule");
			await writeFile(
				join(externalDir, "shared-source.txt"),
				"Linked file rule",
			);
			await mkdir(join(externalDir, "shared-dir"));
			await writeFile(
				join(externalDir, "shared-dir", "nested.md"),
				"Linked dir rule",
			);
			await symlink(realRulesDir, join(projectDir, ".pi"), "dir");
			await symlink(
				join(externalDir, "shared-source.txt"),
				join(realRulesDir, "shared.md"),
			);
			await symlink(
				join(externalDir, "shared-dir"),
				join(realRulesDir, "shared-dir"),
				"dir",
			);
			await symlink(realRulesDir, join(realRulesDir, "cycle"), "dir");
			const pi = createExtensionApiFake();
			const context = createContextFake(projectDir);

			projectRules(pi);

			const prompt = await runBeforeAgentStartHandlers(
				pi,
				createBeforeAgentStartEvent(projectDir),
				context.ctx,
			);

			expect(prompt).toContain('path=".pi/root.md"');
			expect(prompt).toContain("Root rule");
			expect(prompt).toContain('path=".pi/shared-dir/nested.md"');
			expect(prompt).toContain("Linked dir rule");
			expect(prompt).toContain('path=".pi/shared.md"');
			expect(prompt).toContain("Linked file rule");
			expect(prompt.match(/Root rule/g)).toHaveLength(1);
		});
	});

	test("uses the first visible symlinked directory path when targets repeat", async () => {
		// Purpose: duplicate symlinked directories must produce deterministic visible paths.
		// Input and expected output: two sorted links to one real directory include only the first visible path.
		// Edge case: directory cycle protection must not let filesystem timing choose the visible path.
		// Dependencies: this test uses filesystem symlinks in temporary directories.
		await withIsolatedSuiteDir(async () => {
			const projectDir = await createTempDir("project-rules-repeat-project-");
			const sharedDir = await createTempDir("project-rules-repeat-shared-");
			await mkdir(join(projectDir, ".pi"));
			await writeFile(join(sharedDir, "rule.md"), "Shared rule");
			await symlink(sharedDir, join(projectDir, ".pi", "a"), "dir");
			await symlink(sharedDir, join(projectDir, ".pi", "b"), "dir");

			const prompt = await renderPrompt(projectDir);

			expect(prompt).toContain('path=".pi/a/rule.md"');
			expect(prompt).not.toContain('path=".pi/b/rule.md"');
			expect(prompt.match(/Shared rule/g)).toHaveLength(1);
		});
	});

	test("does not append project_rules when disabled, missing, empty, or only empty files", async () => {
		// Purpose: the extension must avoid empty prompt wrappers when no rule content is available.
		// Input and expected output: disabled config, missing rulesDir, and whitespace-only rules keep the original prompt.
		// Edge case: an existing rulesDir with no non-empty Markdown files behaves like no rules.
		// Dependencies: this test uses temporary suite and project directories.
		await withIsolatedSuiteDir(async (suiteDir) => {
			const disabledProjectDir = await createTempDir("project-rules-disabled-");
			await writeProjectRulesConfig(suiteDir, { enabled: false });
			expect(await renderPrompt(disabledProjectDir)).toBe("Original pi prompt");

			const missingProjectDir = await createTempDir("project-rules-missing-");
			await writeProjectRulesConfig(suiteDir, { enabled: true });
			expect(await renderPrompt(missingProjectDir)).toBe("Original pi prompt");

			const emptyProjectDir = await createTempDir("project-rules-empty-");
			await mkdir(join(emptyProjectDir, ".pi"));
			await writeFile(join(emptyProjectDir, ".pi", "empty.md"), "\n\t ");
			expect(await renderPrompt(emptyProjectDir)).toBe("Original pi prompt");
		});
	});

	test("fails the whole section and warns when rulesDir itself is a broken symlink", async () => {
		// Purpose: a broken rulesDir symlink must not silently disable project rules.
		// Input and expected output: .pi points to a missing directory, so the prompt is unchanged and one warning is emitted.
		// Edge case: a genuinely missing .pi directory remains a no-op in a separate test.
		// Dependencies: this test uses a filesystem symlink in a temporary project directory.
		await withIsolatedSuiteDir(async () => {
			const projectDir = await createTempDir("project-rules-broken-root-");
			await symlink(join(projectDir, "missing-rules"), join(projectDir, ".pi"));
			const context = createContextFake(projectDir);

			expect(await renderPrompt(projectDir, context)).toBe(
				"Original pi prompt",
			);
			expect(context.notifications).toHaveLength(1);
		});
	});

	test("fails the whole section and warns when config or rule loading fails", async () => {
		// Purpose: partial project rules must not be appended when config or file loading is unreliable.
		// Input and expected output: invalid config and broken symlink keep the original prompt and warn.
		// Edge case: one broken rule prevents all project_rules output.
		// Dependencies: this test uses temporary suite storage, symlinks, and in-memory notifications.
		await withIsolatedSuiteDir(async (suiteDir) => {
			const invalidConfigProjectDir = await createTempDir(
				"project-rules-invalid-config-",
			);
			await writeProjectRulesConfig(suiteDir, { enabled: "true" });
			const invalidConfigContext = createContextFake(invalidConfigProjectDir);
			expect(
				await renderPrompt(invalidConfigProjectDir, invalidConfigContext),
			).toBe("Original pi prompt");
			expect(invalidConfigContext.notifications).toHaveLength(1);

			await writeProjectRulesConfig(suiteDir, { enabled: true });
			const brokenSymlinkProjectDir = await createTempDir(
				"project-rules-broken-symlink-",
			);
			await mkdir(join(brokenSymlinkProjectDir, ".pi"));
			await writeFile(
				join(brokenSymlinkProjectDir, ".pi", "valid.md"),
				"Valid",
			);
			await symlink(
				join(brokenSymlinkProjectDir, "missing.md"),
				join(brokenSymlinkProjectDir, ".pi", "broken.md"),
			);
			const brokenSymlinkContext = createContextFake(brokenSymlinkProjectDir);
			expect(
				await renderPrompt(brokenSymlinkProjectDir, brokenSymlinkContext),
			).toBe("Original pi prompt");
			expect(brokenSymlinkContext.notifications).toHaveLength(1);
		});
	});
});

function createExtensionApiFake(): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];

	return {
		handlers,
		on(eventName: string, handler: unknown): void {
			handlers.push({ eventName, handler });
		},
	} as ExtensionApiFake;
}

function createContextFake(cwd: string, hasUI?: boolean): ContextFake {
	const notifications: Notification[] = [];

	return {
		notifications,
		ctx: {
			cwd,
			...(hasUI !== undefined ? { hasUI } : {}),
			ui: {
				notify(message: string, type: string | undefined): void {
					notifications.push({ message, type });
				},
			},
		},
	};
}

async function runBeforeAgentStartHandlers(
	pi: ExtensionApiFake,
	event: BeforeAgentStartEventFake,
	ctx: ContextFake["ctx"],
): Promise<string> {
	let currentEvent = event;
	for (const item of pi.handlers.filter(
		(handler) => handler.eventName === "before_agent_start",
	)) {
		if (typeof item.handler !== "function") {
			continue;
		}

		const result = await item.handler(currentEvent, ctx);
		if (isPromptResult(result)) {
			currentEvent = { ...currentEvent, systemPrompt: result.systemPrompt };
		}
	}

	return currentEvent.systemPrompt;
}

function isPromptResult(
	value: unknown,
): value is { readonly systemPrompt: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"systemPrompt" in value &&
		typeof value.systemPrompt === "string"
	);
}

function createBeforeAgentStartEvent(cwd: string): BeforeAgentStartEventFake {
	return {
		type: "before_agent_start",
		prompt: "work",
		images: [],
		systemPrompt: "Original pi prompt",
		systemPromptOptions: { cwd },
	};
}

async function renderPrompt(
	projectDir: string,
	context = createContextFake(projectDir),
): Promise<string> {
	const pi = createExtensionApiFake();
	projectRules(pi);
	return runBeforeAgentStartHandlers(
		pi,
		createBeforeAgentStartEvent(projectDir),
		context.ctx,
	);
}

async function withIsolatedSuiteDir(
	testBody: (suiteDir: string) => Promise<void>,
): Promise<void> {
	const suiteDir = await createTempDir("project-rules-suite-");
	process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
	await testBody(suiteDir);
}

async function createTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function writeProjectRulesConfig(
	suiteDir: string,
	config: unknown,
): Promise<void> {
	const configDir = join(suiteDir, "project-rules");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "config.json"), JSON.stringify(config));
}
