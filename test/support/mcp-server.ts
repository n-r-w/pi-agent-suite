export interface FixtureRequest {
	jsonrpc: "2.0";
	id?: number | string;
	method: string;
	params?: {
		cursor?: string;
		name?: string;
		arguments?: Record<string, unknown>;
	};
}

export function fixtureResponse(request: FixtureRequest): unknown {
	if (request.id === undefined || request.params?.name === "wait") {
		return undefined;
	}
	const reply = { jsonrpc: "2.0", id: request.id };
	if (request.method === "initialize") {
		return {
			...reply,
			result: {
				protocolVersion: "2025-11-25",
				capabilities: { tools: {} },
				serverInfo: { name: "isolated-fixture", version: "1.0.0" },
			},
		};
	}
	if (request.method === "tools/list") {
		const name = request.params?.cursor === "second" ? "second" : "echo";
		return {
			...reply,
			result: {
				tools: [{ name, inputSchema: { type: "object" } }],
				...(name === "echo" ? { nextCursor: "second" } : {}),
			},
		};
	}
	if (request.params?.name === "protocol-error") {
		return {
			...reply,
			error: { code: -32603, message: "Fixture server failure" },
		};
	}
	return {
		...reply,
		result: {
			content: [
				{
					type: "text",
					text: String(request.params?.arguments?.["text"] ?? "hello"),
				},
			],
			...(request.params?.name === "tool-error" ? { isError: true } : {}),
		},
	};
}
