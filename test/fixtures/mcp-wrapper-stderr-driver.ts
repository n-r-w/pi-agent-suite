import { resolve } from "node:path";
import { createSdkMcpClient } from "../../pi-package/extensions/mcp-wrapper/sdk-client-factory.ts";

const client = createSdkMcpClient("fixture", {
	type: "stdio",
	command: process.execPath,
	args: [resolve("test/fixtures/mcp-stdio.ts")],
	env: {
		MCP_STDERR_DIAGNOSTIC: "stdio startup diagnostic",
		MCP_STDERR_CONNECTED_DIAGNOSTIC: "stdio connected diagnostic",
	},
});

try {
	await client.connect();
	await client.listTools();
} finally {
	await client.close();
}
