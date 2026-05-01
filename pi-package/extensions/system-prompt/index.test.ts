import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import systemPrompt from "./index";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";
const DATE_LINE_PATTERN = /Date: \d{4}-\d{2}-\d{2}/;

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

/** Creates an ExtensionAPI fake that records lifecycle handlers registered by system-prompt. */
function createExtensionApiFake(): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];

	return {
		handlers,
		on(eventName: string, handler: unknown): void {
			handlers.push({ eventName, handler });
		},
	} as ExtensionApiFake;
}

/** Creates the session context fake needed to observe startup warnings. */
function createContextFake(cwd = "/tmp/project", hasUI?: boolean): ContextFake {
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

/** Runs a test with isolated pi agent and suite directories so real user config is never read. */
async function withIsolatedAgentDir<T>(
	action: (paths: {
		readonly agentDir: string;
		readonly suiteDir: string;
	}) => Promise<T>,
): Promise<T> {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const previousAgentSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
	const agentDir = await mkdtemp(join(tmpdir(), "pi-system-prompt-agent-"));
	const suiteDir = await mkdtemp(join(tmpdir(), "pi-system-prompt-suite-"));

	process.env[AGENT_DIR_ENV] = agentDir;
	process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
	try {
		return await action({ agentDir, suiteDir });
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
		await rm(suiteDir, { recursive: true, force: true });
	}
}

/** Writes a suite-owned config file for system-prompt in the isolated suite directory. */
async function writeSuiteConfig(
	suiteDir: string,
	config: unknown,
): Promise<void> {
	const configDir = join(suiteDir, "system-prompt");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "config.json"), JSON.stringify(config));
}

/** Writes the legacy config path that system-prompt must ignore. */
async function writeLegacyConfig(
	agentDir: string,
	config: unknown,
): Promise<void> {
	const configDir = join(agentDir, "config");
	await mkdir(configDir, { recursive: true });
	await writeFile(
		join(configDir, "system-prompt.json"),
		JSON.stringify(config),
	);
}

/** Returns one registered event handler from the extension fake. */
function getRegisteredHandler(
	pi: ExtensionApiFake,
	eventName: string,
): (event: unknown, ctx: unknown) => Promise<unknown> | unknown {
	const handler = pi.handlers.find(
		(item) => item.eventName === eventName,
	)?.handler;
	if (typeof handler !== "function") {
		throw new Error(`expected ${eventName} handler to be registered`);
	}

	return handler as (
		event: unknown,
		ctx: unknown,
	) => Promise<unknown> | unknown;
}

/** Runs registered before_agent_start handlers in the same chained order as pi. */
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

/** Detects before_agent_start results that replace the chained system prompt. */
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

/** Creates a before_agent_start event fixture with every dynamic prompt input populated. */
function createBeforeAgentStartEvent(
	overrides: Partial<BuildSystemPromptOptions> = {},
): BeforeAgentStartEventFake {
	return {
		type: "before_agent_start",
		prompt: "work",
		images: [],
		systemPrompt: "Original pi prompt",
		systemPromptOptions: {
			cwd: "/tmp/project",
			selectedTools: ["read", "bash", "hidden"],
			toolSnippets: {
				read: "Read file contents",
				bash: "Execute shell commands",
			},
			promptGuidelines: [
				"Use read before editing files.",
				"  ",
				"Use bash only when command output is needed.",
			],
			appendSystemPrompt: "Append text",
			contextFiles: [
				{ path: "AGENTS.md", content: "Project rules" },
				{ path: "CLAUDE.md", content: "Extra rules" },
			],
			skills: [
				{
					name: "typescript",
					description: "TypeScript rules",
					filePath: "/skills/typescript/SKILL.md",
					baseDir: "/skills/typescript",
					sourceInfo: {
						path: "/skills/typescript/SKILL.md",
						source: "test",
						scope: "temporary",
						origin: "top-level",
					},
					disableModelInvocation: false,
				},
			],
			...overrides,
		},
	};
}

interface BeforeAgentStartEventFake {
	readonly type: "before_agent_start";
	readonly prompt: string;
	readonly images: readonly unknown[];
	readonly systemPrompt: string;
	readonly systemPromptOptions: BuildSystemPromptOptions;
}

describe("system-prompt", () => {
	test("renders only requested dynamic variables from the Markdown template", async () => {
		// Purpose: a template must own all static prose while variables inject only runtime values.
		// Input and expected output: a custom template references every supported variable plus one unknown placeholder.
		// Edge case: tools without prompt snippets, blank tool guidelines, and unknown placeholders are omitted.
		// Dependencies: this test uses isolated temp config/template files and in-memory pi lifecycle fakes.
		await withIsolatedAgentDir(async ({ suiteDir }) => {
			const templateFile = join(suiteDir, "template.md");
			await writeFile(
				templateFile,
				[
					"Static header",
					"Date: {{date}}",
					"CWD: {{cwd}}",
					"Tools:",
					"{{tools}}",
					"Tool guidelines:",
					"{{toolGuidelines}}",
					"Append:",
					"{{appendSystemPrompt}}",
					"Context:",
					"{{contextFiles}}",
					"Skills:",
					"{{skills}}",
					"Unknown: {{typo}}",
				].join("\n"),
			);
			await writeSuiteConfig(suiteDir, { templateFile });
			const pi = createExtensionApiFake();
			const context = createContextFake();

			systemPrompt(pi);
			await getRegisteredHandler(pi, "session_start")(
				{ type: "session_start", reason: "startup" },
				context.ctx,
			);
			expect(context.notifications).toEqual([
				{
					message:
						"[system-prompt] removed unsupported template variable(s): typo",
					type: "warning",
				},
			]);
			const prompt = await runBeforeAgentStartHandlers(
				pi,
				createBeforeAgentStartEvent(),
				context.ctx,
			);

			expect(prompt).toContain("Static header");
			expect(prompt).toMatch(DATE_LINE_PATTERN);
			expect(prompt).toContain("CWD: /tmp/project");
			expect(prompt).toContain("- read: Read file contents");
			expect(prompt).toContain("- bash: Execute shell commands");
			expect(prompt).not.toContain("hidden");
			expect(prompt).toContain("- Use read before editing files.");
			expect(prompt).toContain(
				"- Use bash only when command output is needed.",
			);
			expect(prompt).toContain("Append text");
			expect(prompt).toContain("<project_specific_instructions>");
			expect(prompt).toContain(
				'<project_specific_instruction path="AGENTS.md">\nProject rules\n  </project_specific_instruction>',
			);
			expect(prompt).toContain(
				'<project_specific_instruction path="CLAUDE.md">\nExtra rules\n  </project_specific_instruction>',
			);
			expect(prompt).toContain("</project_specific_instructions>");
			expect(prompt).not.toContain("## AGENTS.md");
			expect(prompt).toContain("typescript");
			expect(prompt).not.toContain("{{typo}}");
			expect(prompt).toContain("Unknown: ");

			await getRegisteredHandler(pi, "session_start")(
				{ type: "session_start", reason: "reload" },
				context.ctx,
			);
			expect(context.notifications).toEqual([
				{
					message:
						"[system-prompt] removed unsupported template variable(s): typo",
					type: "warning",
				},
				{
					message:
						"[system-prompt] removed unsupported template variable(s): typo",
					type: "warning",
				},
			]);
		});
	});

	test("removes unsupported placeholder names with non-alphanumeric characters", async () => {
		// Purpose: every unsupported {{...}} placeholder must be removed and reported, not only simple identifier-like names.
		// Input and expected output: underscore and hyphen placeholder names warn at startup and render as empty strings.
		// Edge case: supported variables still render next to unsupported placeholder forms.
		// Dependencies: this test uses isolated temp config/template files and in-memory pi lifecycle fakes.
		await withIsolatedAgentDir(async ({ suiteDir }) => {
			const templateFile = join(suiteDir, "template.md");
			await writeFile(templateFile, "{{date}} {{foo_bar}} {{tool-guidelines}}");
			await writeSuiteConfig(suiteDir, { templateFile });
			const pi = createExtensionApiFake();
			const context = createContextFake();

			systemPrompt(pi);
			await getRegisteredHandler(pi, "session_start")(
				{ type: "session_start", reason: "startup" },
				context.ctx,
			);

			expect(context.notifications).toEqual([
				{
					message:
						"[system-prompt] removed unsupported template variable(s): foo_bar, tool-guidelines",
					type: "warning",
				},
			]);
			expect(
				await runBeforeAgentStartHandlers(
					pi,
					createBeforeAgentStartEvent(),
					context.ctx,
				),
			).not.toContain("{{");
		});
	});

	test("does not append dynamic values whose variables are absent", async () => {
		// Purpose: absent variables must not recreate pi's automatic prompt sections behind the template author's back.
		// Input and expected output: a static-only template replaces the base prompt without tools, context, skills, append text, date, or cwd.
		// Edge case: every runtime source is populated but no variable references it.
		// Dependencies: this test uses isolated temp config/template files and in-memory pi lifecycle fakes.
		await withIsolatedAgentDir(async ({ suiteDir }) => {
			const templateFile = join(suiteDir, "template.md");
			await writeFile(templateFile, "Static prompt only");
			await writeSuiteConfig(suiteDir, { templateFile });
			const pi = createExtensionApiFake();
			const context = createContextFake();

			systemPrompt(pi);
			await getRegisteredHandler(pi, "session_start")(
				{ type: "session_start", reason: "startup" },
				context.ctx,
			);

			expect(
				await runBeforeAgentStartHandlers(
					pi,
					createBeforeAgentStartEvent(),
					context.ctx,
				),
			).toBe("Static prompt only");
			expect(context.notifications).toEqual([]);
		});
	});

	test("keeps the original prompt when disabled, invalid, or unreadable", async () => {
		// Purpose: config/template failures must not replace pi's original system prompt with partial output.
		// Input and expected output: disabled config returns the original prompt silently; invalid or missing template returns it with a warning.
		// Edge case: relative templateFile is rejected even though it could be resolved from the config directory.
		// Dependencies: this test uses isolated suite config files and in-memory pi lifecycle fakes.
		await withIsolatedAgentDir(async ({ suiteDir }) => {
			const disabledPi = createExtensionApiFake();
			const disabledContext = createContextFake();
			await writeSuiteConfig(suiteDir, { enabled: false });
			systemPrompt(disabledPi);
			await getRegisteredHandler(disabledPi, "session_start")(
				{ type: "session_start", reason: "startup" },
				disabledContext.ctx,
			);
			expect(
				await runBeforeAgentStartHandlers(
					disabledPi,
					createBeforeAgentStartEvent(),
					disabledContext.ctx,
				),
			).toBe("Original pi prompt");
			expect(disabledContext.notifications).toEqual([]);

			const relativePi = createExtensionApiFake();
			const relativeContext = createContextFake();
			expect(isAbsolute("relative.md")).toBe(false);
			await writeSuiteConfig(suiteDir, { templateFile: "relative.md" });
			systemPrompt(relativePi);
			await getRegisteredHandler(relativePi, "session_start")(
				{ type: "session_start", reason: "startup" },
				relativeContext.ctx,
			);
			expect(
				await runBeforeAgentStartHandlers(
					relativePi,
					createBeforeAgentStartEvent(),
					relativeContext.ctx,
				),
			).toBe("Original pi prompt");
			expect(relativeContext.notifications).toEqual([
				{
					message: "[system-prompt] templateFile must be an absolute path",
					type: "warning",
				},
			]);

			const missingPi = createExtensionApiFake();
			const missingContext = createContextFake();
			await writeSuiteConfig(suiteDir, {
				templateFile: join(suiteDir, "missing.md"),
			});
			systemPrompt(missingPi);
			await getRegisteredHandler(missingPi, "session_start")(
				{ type: "session_start", reason: "startup" },
				missingContext.ctx,
			);
			expect(
				await runBeforeAgentStartHandlers(
					missingPi,
					createBeforeAgentStartEvent(),
					missingContext.ctx,
				),
			).toBe("Original pi prompt");
			expect(missingContext.notifications).toHaveLength(1);
			expect(missingContext.notifications[0]?.type).toBe("warning");
			expect(
				missingContext.notifications[0]?.message.startsWith(
					"[system-prompt] failed to read template:",
				),
			).toBe(true);
		});
	});

	test("ignores legacy config and validates the bundled default template", async () => {
		// Purpose: system-prompt must use only the suite-owned config path and still be enabled when config is missing.
		// Input and expected output: a legacy config points to a custom template, but missing suite config uses the bundled Markdown template.
		// Edge case: the bundled prompt path is internal, so the test checks behavior rather than repository layout.
		// Dependencies: this test uses isolated agent/suite directories and in-memory pi lifecycle fakes.
		await withIsolatedAgentDir(async ({ agentDir, suiteDir }) => {
			const legacyTemplateFile = join(agentDir, "legacy-template.md");
			await writeFile(legacyTemplateFile, "Legacy prompt");
			await writeLegacyConfig(agentDir, { templateFile: legacyTemplateFile });
			const pi = createExtensionApiFake();
			const context = createContextFake();

			systemPrompt(pi);
			await getRegisteredHandler(pi, "session_start")(
				{ type: "session_start", reason: "startup" },
				context.ctx,
			);
			const prompt = await runBeforeAgentStartHandlers(
				pi,
				createBeforeAgentStartEvent({ cwd: suiteDir }),
				context.ctx,
			);

			expect(prompt).not.toBe("Legacy prompt");
			expect(prompt).not.toBe("Original pi prompt");
			expect(prompt).toContain(suiteDir.replace(/\\/g, "/"));
			expect(context.notifications).toEqual([]);
		});
	});

	test("preserves later runtime prompt contributions in chained handler order", async () => {
		// Purpose: system-prompt may replace only the base prompt layer, not later package-owned runtime contributions.
		// Input and expected output: a later before_agent_start handler appends agent guidance after the template is rendered.
		// Edge case: the template handler must run before the contribution handler in registration order.
		// Dependencies: this test uses in-memory lifecycle fakes and a temp Markdown template.
		await withIsolatedAgentDir(async ({ suiteDir }) => {
			const templateFile = join(suiteDir, "template.md");
			await writeFile(templateFile, "Template base");
			await writeSuiteConfig(suiteDir, { templateFile });
			const pi = createExtensionApiFake();
			const context = createContextFake();

			systemPrompt(pi);
			pi.on("before_agent_start", (event: unknown) => {
				const currentPrompt = (event as { readonly systemPrompt: string })
					.systemPrompt;
				return { systemPrompt: `${currentPrompt}\n\nAgent contribution` };
			});
			await getRegisteredHandler(pi, "session_start")(
				{ type: "session_start", reason: "startup" },
				context.ctx,
			);

			expect(
				await runBeforeAgentStartHandlers(
					pi,
					createBeforeAgentStartEvent(),
					context.ctx,
				),
			).toBe("Template base\n\nAgent contribution");
		});
	});
});
