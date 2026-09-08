import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
	type FixtureRequest,
	fixtureResponse,
} from "../../../test/support/mcp-server.ts";
import { createTempDir } from "../../../test/support/temp-dir.ts";
import { McpClientManager } from "./client-manager.ts";
import { mapMcpToolResult } from "./result-mapper.ts";
import { createSdkMcpClient } from "./sdk-client-factory.ts";

const TIMEOUT_ERROR = /timed out/i;

// Purpose: exercise published SDK signatures and transport behavior, not fake client methods.
// Inputs: two list pages, echo, tool error, protocol error, and a pending call.
// Expected: each tool once, mapped text/errors, cancellation/timeout rejection, closed transport.
// Edges: both transports; HTTP uses fake fetch, stdio uses an isolated local child fixture.
// Dependencies: real SDK, client manager, result mapper, and fixture helpers; no other tests or network.
describe.each([
	"stdio",
	"streamableHttp",
] as const)("SDK v2 over %s", (type) => {
	test("discovers all pages, maps calls, propagates failures, and closes", async () => {
		const fixture = createFixture(type);
		const manager = new McpClientManager({
			createClient: () => fixture.client,
			timeouts: {
				startupSeconds: 5,
				listToolsSeconds: 5,
				callSeconds: 5,
				maxTotalSeconds: 5,
			},
		});
		try {
			const discovery = await manager.discoverServers({
				fixture: fixture.config,
			});
			expect(discovery.failures).toEqual([]);
			expect(
				discovery.serverToolLists[0]?.tools.map((tool) => tool.name),
			).toEqual(["echo", "second"]);
			const singlePage = await fixture.client.listTools({ cursor: "second" });
			expect(singlePage.tools.map((tool) => tool.name)).toEqual(["second"]);
			for (const name of ["echo", "tool-error"]) {
				const raw = await fixture.client.callTool({
					name,
					arguments: { text: "hello" },
				});
				const mapped = await mapMcpToolResult(
					raw as Parameters<typeof mapMcpToolResult>[0],
				);
				expect(mapped.content).toEqual([{ type: "text", text: "hello" }]);
				expect(mapped.details.isError).toBe(name === "tool-error");
			}
			await expect(
				fixture.client.callTool({ name: "protocol-error", arguments: {} }),
			).rejects.toThrow("Fixture server failure");
		} finally {
			await manager.closeAll();
			fixture.remove();
		}
		expect(fixture.closed()).toBe(true);
	});

	test.each([
		"cancel",
		"timeout",
	] as const)("rejects a pending call on %s", async (mode) => {
		const fixture = createFixture(type);
		try {
			await fixture.client.connect({ timeout: 5000 });
			const controller = new AbortController();
			const pending = fixture.client.callTool(
				{ name: "wait", arguments: {} },
				{
					signal: controller.signal,
					timeout: mode === "timeout" ? 20 : 5000,
				},
			);
			if (mode === "cancel") {
				controller.abort(new Error("Fixture cancellation"));
			}
			await expect(pending).rejects.toThrow(
				mode === "cancel" ? "Fixture cancellation" : TIMEOUT_ERROR,
			);
		} finally {
			await fixture.client.close();
			fixture.remove();
		}
		expect(fixture.closed()).toBe(true);
	});
});

function createFixture(type: "stdio" | "streamableHttp") {
	const temp = createTempDir("pi-mcp-sdk-");
	let closed = false;
	class ObservedClient extends Client {
		constructor(...args: ConstructorParameters<typeof Client>) {
			super(...args);
			this.onclose = () => {
				closed = true;
			};
		}
	}
	class FixtureHttpTransport extends StreamableHTTPClientTransport {
		constructor(
			url: URL,
			options?: ConstructorParameters<typeof StreamableHTTPClientTransport>[1],
		) {
			super(url, {
				...options,
				fetch: async (_input, init) => {
					if (init?.method !== "POST") {
						return new Response(null, { status: 405 });
					}
					const request = JSON.parse(String(init.body)) as FixtureRequest;
					const response = fixtureResponse(request);
					return response === undefined
						? new Response(null, { status: 202 })
						: Response.json(response);
				},
			});
		}
	}
	const config =
		type === "stdio"
			? {
					type,
					command: process.execPath,
					args: [
						resolve(import.meta.dir, "../../../test/fixtures/mcp-stdio.ts"),
					],
					env: {},
					cwd: temp.path,
				}
			: {
					type,
					url: "https://fixture.invalid/mcp",
					headers: { "X-Fixture": "isolated" },
				};
	const client = createSdkMcpClient("fixture", config, {
		client: ObservedClient,
		stdioClientTransport: StdioClientTransport,
		streamableHttpClientTransport: FixtureHttpTransport,
	});
	return { client, config, closed: () => closed, remove: temp.remove };
}
