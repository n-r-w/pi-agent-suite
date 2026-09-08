import { createInterface } from "node:readline";
import { fixtureResponse } from "../support/mcp-server.ts";

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const response = fixtureResponse(JSON.parse(line));
	if (response !== undefined) {
		process.stdout.write(`${JSON.stringify(response)}\n`);
	}
});
