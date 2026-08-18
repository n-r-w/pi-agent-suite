import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getAgentRuntimeComposition } from "../../shared/agent-runtime-composition";
import vision, { isMultimodal } from "./index";

type Handler = (...args: never[]) => unknown;

function createPi(activeTools: string[] = ["read"]): ExtensionAPI & {
	readonly tools: ToolDefinition[];
	readonly handlers: Map<string, Handler[]>;
	readonly notifications: Array<{
		readonly message: string;
		readonly type: string;
	}>;
} {
	const tools: ToolDefinition[] = [];
	const handlers = new Map<string, Handler[]>();
	const notifications: Array<{
		readonly message: string;
		readonly type: string;
	}> = [];
	return {
		tools,
		handlers,
		notifications,
		on(event: string, handler: Handler) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools.splice(0, activeTools.length, ...names);
		},
		getThinkingLevel: () => "off",
		events: { emit() {}, on: () => () => {} },
	} as unknown as ExtensionAPI & {
		readonly tools: ToolDefinition[];
		readonly handlers: Map<string, Handler[]>;
		readonly notifications: Array<{
			readonly message: string;
			readonly type: string;
		}>;
	};
}

function context(model: { readonly input: readonly string[] }) {
	return {
		cwd: "/tmp",
		model,
		ui: {
			notify(_message: string, _type: string) {
				return undefined;
			},
		},
		modelRegistry: {
			find: () =>
				({
					provider: "p",
					id: "m",
					input: ["text", "image"],
					contextWindow: 100_000,
				}) as never,
			getApiKeyAndHeaders: async () => ({ ok: true }),
		},
	};
}

function configuredFile() {
	return {
		kind: "found" as const,
		file: {
			content: '{"enabled":true,"model":{"id":"p/m"}}',
			path: "/tmp/config.json",
			displayPath: "/tmp/config.json",
			directory: "/tmp",
		},
	};
}

async function startConfiguredTextOnlyTool(
	completeSimple?: NonNullable<Parameters<typeof vision>[1]>["completeSimple"],
) {
	const pi = createPi();
	vision(pi, {
		readConfigFile: async () => configuredFile(),
		...(completeSimple === undefined ? {} : { completeSimple }),
	});
	await pi.handlers.get("session_start")?.[0]?.(
		{} as never,
		context({ input: ["text"] }) as never,
	);
	const tool = pi.tools[0];
	if (tool === undefined) {
		throw new Error("tool was not registered");
	}
	return tool;
}

describe("vision extension", () => {
	test("identifies image-capable models", () => {
		expect(isMultimodal({ input: ["text", "image"] })).toBe(true);
		expect(isMultimodal({ input: ["text"] })).toBe(false);
	});

	test("shows the tool only for configured text-only models while preserving other tools", async () => {
		const pi = createPi();
		vision(pi, { readConfigFile: async () => configuredFile() });
		const start = pi.handlers.get("session_start")?.[0];
		await start?.({} as never, context({ input: ["text"] }) as never);
		expect(pi.getActiveTools()).toEqual(["read", "describe_image"]);
		const select = pi.handlers.get("model_select")?.[0];
		select?.({ model: { input: ["text", "image"] } } as never, {} as never);
		expect(pi.getActiveTools()).toEqual(["read"]);
	});

	/**
	 * Proves text-only model availability remains subordinate to upstream restrictions.
	 * Input and expected output: configured vision is eligible, while an upstream layer permits only read.
	 * Edge case: the later model lifecycle event must not restore the restricted vision tool.
	 * Dependencies: shared active-tool composition and vision model synchronization.
	 */
	test("keeps the text-only model tool behind upstream restrictions", async () => {
		const pi = createPi();
		vision(pi, { readConfigFile: async () => configuredFile() });
		getAgentRuntimeComposition(pi).setRestrictiveToolNames("upstream", [
			"read",
		]);

		await pi.handlers.get("session_start")?.[0]?.(
			{} as never,
			context({ input: ["text"] }) as never,
		);

		expect(pi.getActiveTools()).toEqual(["read"]);
	});

	test("hides the tool and stays silent when configuration is missing", async () => {
		const pi = createPi(["read", "describe_image"]);
		vision(pi, { readConfigFile: async () => ({ kind: "missing" }) });
		const ui = {
			notify(message: string, type: string) {
				pi.notifications.push({ message, type });
			},
		};
		await pi.handlers.get("session_start")?.[0]?.(
			{} as never,
			{ ...context({ input: ["text"] }), ui } as never,
		);
		expect(pi.getActiveTools()).toEqual(["read"]);
		expect(pi.notifications).toEqual([]);
	});

	test("warns and hides the tool when explicitly enabled without a model ID", async () => {
		const pi = createPi(["read", "describe_image"]);
		vision(pi, {
			readConfigFile: async () => ({
				...configuredFile(),
				file: { ...configuredFile().file, content: '{"enabled":true}' },
			}),
		});
		const ui = {
			notify(message: string, type: string) {
				pi.notifications.push({ message, type });
			},
		};
		await pi.handlers.get("session_start")?.[0]?.(
			{} as never,
			{ ...context({ input: ["text"] }), ui } as never,
		);
		expect(pi.getActiveTools()).toEqual(["read"]);
		expect(pi.notifications[0]?.message).toContain("model.id");
	});

	test("hides the tool when configuration disables it", async () => {
		const pi = createPi(["read", "describe_image"]);
		vision(pi, {
			readConfigFile: async () => ({
				...configuredFile(),
				file: {
					...configuredFile().file,
					content: '{"enabled":false,"model":{"id":"p/m"}}',
				},
			}),
		});
		await pi.handlers.get("session_start")?.[0]?.(
			{} as never,
			context({ input: ["text"] }) as never,
		);
		expect(pi.getActiveTools()).toEqual(["read"]);
	});

	test("warns and hides the tool for malformed configuration", async () => {
		const pi = createPi(["read", "describe_image"]);
		vision(pi, {
			readConfigFile: async () => ({
				...configuredFile(),
				file: { ...configuredFile().file, content: "{" },
			}),
		});
		const ui = {
			notify(message: string, type: string) {
				pi.notifications.push({ message, type });
			},
		};
		await pi.handlers.get("session_start")?.[0]?.(
			{} as never,
			{ ...context({ input: ["text"] }), ui } as never,
		);
		expect(pi.getActiveTools()).toEqual(["read"]);
		expect(pi.notifications[0]?.message).toContain("invalid JSON");
	});

	test("defines one required image path and prompt", async () => {
		// Purpose: the public tool contract accepts exactly one required image path.
		// Input and expected output: the registered TypeBox schema requires image_path and prompt with a non-empty path,
		// a documented description, and a bounded prompt.
		// Dependencies: the extension registration exposes the schema.
		const tool = await startConfiguredTextOnlyTool();
		const schema = tool.parameters as {
			readonly required?: readonly string[];
			readonly properties?: Record<
				string,
				{
					readonly minLength?: number;
					readonly maxLength?: number;
					readonly description?: string;
				}
			>;
		};
		expect(schema.required).toEqual(["image_path", "prompt"]);
		expect(schema.properties?.["image_path"]?.minLength).toBe(1);
		expect(
			schema.properties?.["image_path"]?.description?.length ?? 0,
		).toBeGreaterThan(0);
		expect(schema.properties?.["prompt"]?.minLength).toBe(1);
		expect(schema.properties?.["prompt"]?.maxLength).toBe(2048);
		expect(
			schema.properties?.["prompt"]?.description?.length ?? 0,
		).toBeGreaterThan(0);
	});

	test("describes one image and returns a load failure as text", async () => {
		// Purpose: a call performs one image delegation and preserves recoverable image errors in the result.
		// Input and expected output: a PNG file path returns the vision description; a missing path returns formatted error text.
		// Edge case: the provider is called once for one valid image and not called when loading fails.
		// Dependencies: the extension uses loadImage and describeImage through its public execute boundary.
		const directory = await mkdtemp(join(tmpdir(), "vision-index-"));
		await writeFile(
			join(directory, "test.png"),
			Buffer.from("iVBORw0KGgo=", "base64"),
		);
		let calls = 0;
		const tool = await startConfiguredTextOnlyTool(async () => {
			calls += 1;
			return {
				content: [{ type: "text", text: "a tiny PNG" }],
				stopReason: "stop",
			} as never;
		});
		const toolContext = {
			...context({ input: ["text"] }),
			cwd: directory,
		} as never;
		const success = await tool.execute(
			"id",
			{
				image_path: "test.png",
				prompt: "Describe it",
			},
			undefined,
			() => {},
			toolContext,
		);
		expect(success.content).toEqual([{ type: "text", text: "a tiny PNG" }]);
		expect(calls).toBe(1);
		const failure = await tool.execute(
			"id",
			{ image_path: "missing.png", prompt: "Describe it" },
			undefined,
			() => {},
			toolContext,
		);
		expect(failure.content).toEqual([
			{ type: "text", text: "[error: not_found — missing.png was not found]" },
		]);
		expect(calls).toBe(1);
	});

	test("throws global parameter errors and redirects multimodal calls", async () => {
		const pi = createPi();
		vision(pi, { readConfigFile: async () => ({ kind: "missing" }) });
		const tool = pi.tools[0];
		if (tool === undefined) {
			throw new Error("tool was not registered");
		}
		await expect(
			tool.execute(
				"id",
				{ image_path: "image.png", prompt: "x" },
				undefined,
				() => {},
				context({ input: ["text"] }) as never,
			),
		).rejects.toThrow("not_configured");
		const redirect = await tool.execute(
			"id",
			{ image_path: "image.png", prompt: "x" },
			undefined,
			() => {},
			context({ input: ["text", "image"] }) as never,
		);
		const redirectContent = redirect.content[0];
		expect(redirect.content).toHaveLength(1);
		expect(redirectContent?.type).toBe("text");
		expect(
			redirectContent?.type === "text" && redirectContent.text.length > 0,
		).toBe(true);
	});
});
