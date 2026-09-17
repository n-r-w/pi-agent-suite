import { env } from "node:process";
import { createInterface } from "node:readline";
import { type FixtureRequest, fixtureResponse } from "../support/mcp-server.ts";

const startupDiagnostic = env["MCP_STDERR_DIAGNOSTIC"];
if (startupDiagnostic !== undefined) {
	process.stderr.write(`${startupDiagnostic}\n`);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const request: FixtureRequest = JSON.parse(line);
	if (request.method === "tools/list") {
		const connectedDiagnostic = env["MCP_STDERR_CONNECTED_DIAGNOSTIC"];
		if (connectedDiagnostic !== undefined) {
			process.stderr.write(`${connectedDiagnostic}\n`);
		}
	}
	const response = fixtureResponse(request);
	if (response !== undefined) {
		process.stdout.write(`${JSON.stringify(response)}\n`);
	}
});
