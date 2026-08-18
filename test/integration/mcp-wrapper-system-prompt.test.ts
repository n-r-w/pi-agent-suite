import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveCouncilToolArgsForNames } from "../../pi-package/extensions/convene-council/startup";
import type { ConveneCouncilConfig } from "../../pi-package/extensions/convene-council/types";
import type { McpClientManager } from "../../pi-package/extensions/mcp-wrapper/client-manager";
import mcpWrapper from "../../pi-package/extensions/mcp-wrapper/index";
import projectRules from "../../pi-package/extensions/project-rules/index";
import systemPrompt from "../../pi-package/extensions/system-prompt/index";
import { getAgentRuntimeComposition } from "../../pi-package/shared/agent-runtime-composition";

const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";
const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
const BASE_COUNCIL_CONFIG = {
	llm1: {},
	llm2: {},
	participantIterationLimit: 3,
	finalAnswerParticipant: "llm2",
	responseDefectRetries: 1,
	tools: undefined,
} satisfies ConveneCouncilConfig;

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: (
		event: unknown,
		ctx: ExtensionContext,
	) => Promise<unknown> | unknown;
}

interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
	readonly tools: ToolDefinition[];
}

function createExtensionApiFake(): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];
	const tools: ToolDefinition[] = [];
	let activeTools: readonly string[] = [];

	return {
		handlers,
		tools,
		events: {
			emit(): void {},
			on(): () => void {
				return () => {};
			},
		},
		on(eventName: string, handler: RegisteredHandler["handler"]): void {
			handlers.push({ eventName, handler });
		},
		registerTool(tool: ToolDefinition): void {
			tools.push(tool);
		},
		registerCommand(): void {},
		registerShortcut(): void {},
		registerFlag(): void {},
		getFlag(): undefined {
			return undefined;
		},
		registerCompletionProvider(): void {},
		registerResourceProvider(): void {},
		registerCustomProvider(): void {},
		getAllTools() {
			return [];
		},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(toolNames: readonly string[]): void {
			activeTools = [...toolNames];
		},
		getModel(): undefined {
			return undefined;
		},
		setModel(): void {},
		getThinkingLevel(): undefined {
			return undefined;
		},
		setThinkingLevel(): void {},
		appendEntry(): void {},
		getSessionHistory() {
			return [];
		},
		getSessionTree() {
			return undefined;
		},
		getActiveBranch() {
			return [];
		},
	} as unknown as ExtensionApiFake;
}

async function runSessionStart(pi: ExtensionApiFake): Promise<void> {
	const sessionManager = SessionManager.inMemory("/tmp/mcp-system-prompt");
	for (const item of pi.handlers.filter(
		(handler) => handler.eventName === "session_start",
	)) {
		await item.handler({ type: "session_start", reason: "startup" }, {
			hasUI: true,
			sessionManager,
			ui: {
				notify(): void {},
				setStatus(): void {},
			},
		} as unknown as ExtensionContext);
	}
}

function toolNamesFromArgs(args: readonly string[]): readonly string[] {
	const toolsFlagIndex = args.indexOf("--tools");
	const toolsValue =
		toolsFlagIndex === -1 ? undefined : args[toolsFlagIndex + 1];
	return toolsValue === undefined
		? []
		: toolsValue.split(",").filter((toolName) => toolName.length > 0);
}

async function runBeforeAgentStart(
	pi: ExtensionApiFake,
	cwd = "/tmp/project",
): Promise<string> {
	let currentPrompt = "Original prompt";
	for (const item of pi.handlers.filter(
		(handler) => handler.eventName === "before_agent_start",
	)) {
		const result = await item.handler(
			{
				type: "before_agent_start",
				prompt: "work",
				images: [],
				systemPrompt: currentPrompt,
				systemPromptOptions: {
					cwd,
					selectedTools: [],
					toolSnippets: {},
					promptGuidelines: [],
					contextFiles: [],
					skills: [],
				},
			},
			{} as ExtensionContext,
		);
		if (
			typeof result === "object" &&
			result !== null &&
			"systemPrompt" in result &&
			typeof result.systemPrompt === "string"
		) {
			currentPrompt = result.systemPrompt;
		}
	}

	return currentPrompt;
}

afterEach(() => {
	if (previousSuiteDir === undefined) {
		delete process.env[AGENT_SUITE_DIR_ENV];
	} else {
		process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
	}
});

describe("mcp-wrapper and system-prompt integration", () => {
	test("appends project rules and MCP instructions after system-prompt replaces the base prompt", async () => {
		// Purpose: project rules and MCP initialize instructions must survive the system-prompt template replacement.
		// Input and expected output: system-prompt renders a template, project-rules appends project_rules, then mcp-wrapper appends mcp_instructions.
		// Edge case: handler order must preserve the template output and append each later section once.
		// Dependencies: this test composes three extension entry points with in-memory fakes and temp suite config.
		const suiteDir = await mkdtemp(join(tmpdir(), "pi-mcp-system-prompt-"));
		const projectDir = await mkdtemp(join(tmpdir(), "pi-project-rules-order-"));
		try {
			process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
			const templateFile = join(suiteDir, "template.md");
			await writeFile(templateFile, "Suite template for {{cwd}}");
			await mkdir(join(suiteDir, "system-prompt"), { recursive: true });
			await writeFile(
				join(suiteDir, "system-prompt", "config.json"),
				JSON.stringify({ templateFile }),
			);
			await mkdir(join(projectDir, ".pi", "rules"), { recursive: true });
			await writeFile(
				join(projectDir, ".pi", "rules", "project.md"),
				"Project rule",
			);

			const pi = createExtensionApiFake();
			const manager = {
				discoverServers: async () => ({
					serverToolLists: [
						{
							serverKey: "fetch",
							tools: [{ name: "fetch", inputSchema: { type: "object" } }],
						},
					],
					serverInstructions: [
						{ serverKey: "fetch", instructions: "Use fetch for web pages." },
					],
					failures: [],
				}),
				callTool: async () => ({ content: [] }),
				closeAll: async () => {},
			} satisfies Pick<
				McpClientManager,
				"discoverServers" | "callTool" | "closeAll"
			>;

			systemPrompt(pi);
			projectRules(pi);
			mcpWrapper(pi, {
				readConfig: async () => ({
					kind: "valid",
					config: {
						enabled: true,
						timeouts: {
							startupSeconds: 30,
							listToolsSeconds: 15,
							callSeconds: 120,
							maxTotalSeconds: 180,
						},
						widgetLineBudget: 5,
						mcpServers: {
							fetch: { type: "stdio", command: "node", args: [], env: {} },
						},
					},
				}),
				createManager: () => manager,
			});

			await runSessionStart(pi);
			pi.setActiveTools(["fetch_fetch"]);

			expect(
				await runBeforeAgentStart(pi, projectDir),
			).toBe(`Suite template for ${projectDir}

<project_rules>
  <project_rule path=".pi/rules/project.md">
Project rule
  </project_rule>
</project_rules>

<mcp_instructions>
  <server name="fetch">
Use fetch for web pages.
  </server>
</mcp_instructions>`);
		} finally {
			await rm(suiteDir, { recursive: true, force: true });
			await rm(projectDir, { recursive: true, force: true });
		}
	});

	test("omits MCP instructions after system-prompt replacement when no MCP tool is active", async () => {
		// Purpose: MCP initialize instructions must not survive prompt composition when the active agent cannot call the MCP server.
		// Input and expected output: system-prompt renders a template, mcp-wrapper registers a fetch tool, active tools stay empty, and no mcp_instructions block appears.
		// Edge case: server registration and initialize instructions are present, but active tools do not expose any generated MCP tool.
		// Dependencies: this test composes both extension entry points with in-memory fakes and temp suite config.
		const suiteDir = await mkdtemp(join(tmpdir(), "pi-mcp-system-prompt-"));
		try {
			process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
			const templateFile = join(suiteDir, "template.md");
			await writeFile(templateFile, "Suite template for {{cwd}}");
			await mkdir(join(suiteDir, "system-prompt"), { recursive: true });
			await writeFile(
				join(suiteDir, "system-prompt", "config.json"),
				JSON.stringify({ templateFile }),
			);

			const pi = createExtensionApiFake();
			const manager = {
				discoverServers: async () => ({
					serverToolLists: [
						{
							serverKey: "fetch",
							tools: [{ name: "fetch", inputSchema: { type: "object" } }],
						},
					],
					serverInstructions: [
						{ serverKey: "fetch", instructions: "Use fetch for web pages." },
					],
					failures: [],
				}),
				callTool: async () => ({ content: [] }),
				closeAll: async () => {},
			} satisfies Pick<
				McpClientManager,
				"discoverServers" | "callTool" | "closeAll"
			>;

			systemPrompt(pi);
			mcpWrapper(pi, {
				readConfig: async () => ({
					kind: "valid",
					config: {
						enabled: true,
						timeouts: {
							startupSeconds: 30,
							listToolsSeconds: 15,
							callSeconds: 120,
							maxTotalSeconds: 180,
						},
						widgetLineBudget: 5,
						mcpServers: {
							fetch: { type: "stdio", command: "node", args: [], env: {} },
						},
					},
				}),
				createManager: () => manager,
			});

			await runSessionStart(pi);
			getAgentRuntimeComposition(pi).setRestrictiveToolNames("test-policy", []);

			expect(await runBeforeAgentStart(pi)).toBe(
				"Suite template for /tmp/project",
			);
		} finally {
			await rm(suiteDir, { recursive: true, force: true });
		}
	});

	test("uses convene-council participant tools when filtering MCP instructions", async () => {
		// Purpose: council participant tool policy must drive MCP instruction visibility through active tools.
		// Input and expected output: a read-only participant sees no MCP instructions, while a participant with fetch_fetch sees fetch instructions.
		// Edge case: read is mandatory for council participants and must not make MCP instructions visible by itself.
		// Dependencies: this test composes convene-council tool resolution with system-prompt and mcp-wrapper prompt handling.
		const cases: ReadonlyArray<{
			readonly name: string;
			readonly councilTools: readonly string[] | undefined;
			readonly expectedPrompt: string;
		}> = [
			{
				name: "read-only participant",
				councilTools: undefined,
				expectedPrompt: "Suite template for /tmp/project",
			},
			{
				name: "participant with fetch MCP tool",
				councilTools: ["fetch_fetch"],
				expectedPrompt: `Suite template for /tmp/project

<mcp_instructions>
  <server name="fetch">
Use fetch for web pages.
  </server>
</mcp_instructions>`,
			},
		];

		for (const testCase of cases) {
			const suiteDir = await mkdtemp(join(tmpdir(), "pi-mcp-council-"));
			try {
				process.env[AGENT_SUITE_DIR_ENV] = suiteDir;
				const templateFile = join(suiteDir, "template.md");
				await writeFile(templateFile, "Suite template for {{cwd}}");
				await mkdir(join(suiteDir, "system-prompt"), { recursive: true });
				await writeFile(
					join(suiteDir, "system-prompt", "config.json"),
					JSON.stringify({ templateFile }),
				);

				const toolArgs = resolveCouncilToolArgsForNames(
					{ ...BASE_COUNCIL_CONFIG, tools: testCase.councilTools },
					["read", "fetch_fetch"],
				);
				if ("issue" in toolArgs) {
					throw new Error(`${testCase.name}: ${toolArgs.issue}`);
				}

				const pi = createExtensionApiFake();
				const manager = {
					discoverServers: async () => ({
						serverToolLists: [
							{
								serverKey: "fetch",
								tools: [{ name: "fetch", inputSchema: { type: "object" } }],
							},
						],
						serverInstructions: [
							{
								serverKey: "fetch",
								instructions: "Use fetch for web pages.",
							},
						],
						failures: [],
					}),
					callTool: async () => ({ content: [] }),
					closeAll: async () => {},
				} satisfies Pick<
					McpClientManager,
					"discoverServers" | "callTool" | "closeAll"
				>;

				systemPrompt(pi);
				mcpWrapper(pi, {
					readConfig: async () => ({
						kind: "valid",
						config: {
							enabled: true,
							timeouts: {
								startupSeconds: 30,
								listToolsSeconds: 15,
								callSeconds: 120,
								maxTotalSeconds: 180,
							},
							widgetLineBudget: 5,
							mcpServers: {
								fetch: {
									type: "stdio",
									command: "node",
									args: [],
									env: {},
								},
							},
						},
					}),
					createManager: () => manager,
				});

				await runSessionStart(pi);
				getAgentRuntimeComposition(pi).setRestrictiveToolNames(
					"test-policy",
					toolNamesFromArgs(toolArgs.args),
				);

				expect(await runBeforeAgentStart(pi)).toBe(testCase.expectedPrompt);
			} finally {
				await rm(suiteDir, { recursive: true, force: true });
			}
		}
	});
});
