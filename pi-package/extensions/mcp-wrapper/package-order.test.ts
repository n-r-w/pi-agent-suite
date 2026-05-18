import { describe, expect, test } from "bun:test";
import packageJson from "../../package.json" with { type: "json" };

const SYSTEM_PROMPT_EXTENSION = "./extensions/system-prompt/index.ts";
const MCP_WRAPPER_EXTENSION = "./extensions/mcp-wrapper/index.ts";
const ENABLE_TOOLS_EXTENSION = "./extensions/enable-tools/index.ts";
const MAIN_AGENT_SELECTION_EXTENSION =
	"./extensions/main-agent-selection/index.ts";

describe("mcp-wrapper package order", () => {
	test("loads after system-prompt and before extensions that resolve active tool policies", () => {
		const extensions = packageJson.pi.extensions;
		expect(extensions.indexOf(SYSTEM_PROMPT_EXTENSION)).toBeLessThan(
			extensions.indexOf(MCP_WRAPPER_EXTENSION),
		);
		expect(extensions.indexOf(MCP_WRAPPER_EXTENSION)).toBeLessThan(
			extensions.indexOf(ENABLE_TOOLS_EXTENSION),
		);
		expect(extensions.indexOf(MCP_WRAPPER_EXTENSION)).toBeLessThan(
			extensions.indexOf(MAIN_AGENT_SELECTION_EXTENSION),
		);
	});
});
