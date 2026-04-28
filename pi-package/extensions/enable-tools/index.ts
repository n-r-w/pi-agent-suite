import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const SEARCH_TOOLS = ["grep", "find", "ls"] as const;

export default function enableSearchTools(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		const availableToolNames = new Set(
			pi.getAllTools().map((tool) => tool.name),
		);
		const activeToolNames = new Set(pi.getActiveTools());

		for (const toolName of SEARCH_TOOLS) {
			if (availableToolNames.has(toolName)) {
				activeToolNames.add(toolName);
			}
		}

		pi.setActiveTools([...activeToolNames]);
	});
}
