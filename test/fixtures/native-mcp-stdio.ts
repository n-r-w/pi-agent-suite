/** Serves native MCP tools and resources over local stdio for child-process tests. */
import { createInterface } from "node:readline";
import { type FixtureRequest, fixtureResponse } from "../support/mcp-server";

/** Reads one JSON-RPC request per line. */
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const request = JSON.parse(line) as FixtureRequest;
	if (request.id === undefined) {
		return;
	}
	let response: unknown;
	switch (request.method) {
		case "initialize":
			response = {
				jsonrpc: "2.0",
				id: request.id,
				result: {
					protocolVersion: "2025-11-25",
					capabilities: { tools: {}, resources: {} },
					serverInfo: { name: "native-fixture", version: "1.0.0" },
				},
			};
			break;
		case "resources/list":
			response = {
				jsonrpc: "2.0",
				id: request.id,
				result: {
					resources: [
						{ uri: "fixture://note", name: "note", mimeType: "text/plain" },
					],
				},
			};
			break;
		case "resources/templates/list":
			response = {
				jsonrpc: "2.0",
				id: request.id,
				result: { resourceTemplates: [] },
			};
			break;
		case "resources/read":
			response = {
				jsonrpc: "2.0",
				id: request.id,
				result: {
					contents: [
						{
							uri: "fixture://note",
							mimeType: "text/plain",
							text: "resource-marker",
						},
					],
				},
			};
			break;
		default:
			response = fixtureResponse(request);
	}
	if (response !== undefined) {
		process.stdout.write(`${JSON.stringify(response)}\n`);
	}
});
