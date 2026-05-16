import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { McpClientManager } from "../../pi-package/extensions/mcp-wrapper/client-manager";
import mcpWrapper from "../../pi-package/extensions/mcp-wrapper/index";
import systemPrompt from "../../pi-package/extensions/system-prompt/index";

const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";
const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];

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
			return [];
		},
		setActiveTools(): void {},
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
	for (const item of pi.handlers.filter(
		(handler) => handler.eventName === "session_start",
	)) {
		await item.handler({ type: "session_start", reason: "startup" }, {
			hasUI: true,
			ui: {
				notify(): void {},
				setStatus(): void {},
			},
		} as unknown as ExtensionContext);
	}
}

async function runBeforeAgentStart(pi: ExtensionApiFake): Promise<string> {
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
					cwd: "/tmp/project",
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
	test("appends MCP instructions after system-prompt replaces the base prompt", async () => {
		// Purpose: MCP initialize instructions must survive the system-prompt template replacement.
		// Input and expected output: system-prompt renders a template, then mcp-wrapper appends the approved mcp_instructions block.
		// Edge case: handler order must preserve the template output and append MCP instructions after it.
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
			} satisfies Pick<McpClientManager, "discoverServers" | "callTool">;

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
						mcpServers: {
							fetch: { type: "stdio", command: "node", args: [], env: {} },
						},
					},
				}),
				createManager: () => manager,
			});

			await runSessionStart(pi);

			expect(
				await runBeforeAgentStart(pi),
			).toBe(`Suite template for /tmp/project

<mcp_instructions>
  <server name="fetch">
Use fetch for web pages.
  </server>
</mcp_instructions>`);
		} finally {
			await rm(suiteDir, { recursive: true, force: true });
		}
	});
});
