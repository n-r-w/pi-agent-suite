import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import codexVerbosity from "../../../pi-package/extensions/codex-verbosity/index";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: unknown;
}

interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
}

/** Creates the ExtensionAPI fake needed to observe provider request hooks. */
function createExtensionApiFake(): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];

	return {
		handlers,
		on(eventName: string, handler: unknown): void {
			handlers.push({ eventName, handler });
		},
	} as ExtensionApiFake;
}

/** Runs a test with an isolated pi agent directory so config reads never touch real user files. */
async function withIsolatedAgentDir<T>(
	action: (agentDir: string) => Promise<T>,
): Promise<T> {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const agentDir = await mkdtemp(join(tmpdir(), "pi-codex-verbosity-"));

	process.env[AGENT_DIR_ENV] = agentDir;
	try {
		return await action(agentDir);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env[AGENT_DIR_ENV];
		} else {
			process.env[AGENT_DIR_ENV] = previousAgentDir;
		}
		await rm(agentDir, { recursive: true, force: true });
	}
}

/** Returns the registered before-provider-request handler from the extension fake. */
function getBeforeProviderRequestHandler(pi: ExtensionApiFake): unknown {
	return pi.handlers.find(
		(handler) => handler.eventName === "before_provider_request",
	)?.handler;
}

describe("codex-verbosity", () => {
	test("stays disabled without warnings when enabled is omitted", async () => {
		// Purpose: omitted config fields must use defaults instead of producing provider-request warnings.
		// Input and expected output: verbosity without enabled returns no replacement payload and no warning.
		// Edge case: a valid non-enabled field is present, so only enabled is omitted.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake, temp config file, and fake UI notification sink.
		await withIsolatedAgentDir(async (agentDir) => {
			const pi = createExtensionApiFake();
			const notifications: { message: string; type: string | undefined }[] = [];
			codexVerbosity(pi);
			const handler = getBeforeProviderRequestHandler(pi);

			expect(handler).toEqual(expect.any(Function));
			await mkdir(join(agentDir, "config"));
			await writeFile(
				join(agentDir, "config", "codex-verbosity.json"),
				JSON.stringify({ verbosity: "high" }),
			);

			const result = await (
				handler as (event: unknown, ctx: unknown) => Promise<unknown> | unknown
			)(
				{ type: "before_provider_request", payload: { input: "hello" } },
				{
					model: {
						provider: "openai",
						api: "openai-codex-responses",
					},
					ui: {
						notify(message: string, type: string | undefined): void {
							notifications.push({ message, type });
						},
					},
				},
			);

			expect(result).toBeUndefined();
			expect(notifications).toEqual([]);
		});
	});

	test("leaves OpenAI Codex provider request unchanged when config file is missing", async () => {
		// Purpose: missing config must disable verbosity injection without blocking provider requests.
		// Input and expected output: OpenAI Codex payload without a config file returns no replacement payload.
		// Edge case: the config directory exists, but codex-verbosity.json does not.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake and a temp agent directory.
		await withIsolatedAgentDir(async (agentDir) => {
			const pi = createExtensionApiFake();
			const payload = {
				input: "hello",
				text: {
					format: "plain",
				},
			};

			codexVerbosity(pi);
			const handler = getBeforeProviderRequestHandler(pi);

			expect(handler).toEqual(expect.any(Function));
			await mkdir(join(agentDir, "config"));
			const result = await (
				handler as (event: unknown, ctx: unknown) => Promise<unknown> | unknown
			)(
				{ type: "before_provider_request", payload },
				{
					model: {
						provider: "openai",
						api: "openai-codex-responses",
					},
				},
			);

			expect(result).toBeUndefined();
			expect(payload).toEqual({ input: "hello", text: { format: "plain" } });
		});
	});

	test("injects default medium verbosity when enabled config omits verbosity", async () => {
		// Purpose: enabled codex-verbosity config must have default parameters when verbosity is omitted.
		// Input and expected output: enabled true with no verbosity injects text.verbosity medium and reports no warning.
		// Edge case: the config file exists with only the required enabled property.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake, temp config file, and fake UI notification sink.
		await withIsolatedAgentDir(async (agentDir) => {
			const pi = createExtensionApiFake();
			const notifications: { message: string; type: string | undefined }[] = [];
			codexVerbosity(pi);
			const handler = getBeforeProviderRequestHandler(pi);

			expect(handler).toEqual(expect.any(Function));
			await mkdir(join(agentDir, "config"));
			await writeFile(
				join(agentDir, "config", "codex-verbosity.json"),
				JSON.stringify({ enabled: true }),
			);

			const result = await (
				handler as (event: unknown, ctx: unknown) => Promise<unknown> | unknown
			)(
				{ type: "before_provider_request", payload: { input: "hello" } },
				{
					model: {
						provider: "openai",
						api: "openai-codex-responses",
					},
					ui: {
						notify(message: string, type: string | undefined): void {
							notifications.push({ message, type });
						},
					},
				},
			);

			expect(result).toEqual({ input: "hello", text: { verbosity: "medium" } });
			expect(notifications).toEqual([]);
		});
	});

	test("injects configured verbosity values while preserving existing text payload fields", async () => {
		// Purpose: valid config must map directly to OpenAI Codex text.verbosity.
		// Input and expected output: low, medium, and high produce replacement payloads with matching text.verbosity.
		// Edge case: existing text payload fields must survive the injection.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake and a temp config file.
		await withIsolatedAgentDir(async (agentDir) => {
			const pi = createExtensionApiFake();
			codexVerbosity(pi);
			const handler = getBeforeProviderRequestHandler(pi);

			expect(handler).toEqual(expect.any(Function));
			await mkdir(join(agentDir, "config"));

			for (const verbosity of ["low", "medium", "high"] as const) {
				await writeFile(
					join(agentDir, "config", "codex-verbosity.json"),
					JSON.stringify({ enabled: true, verbosity }),
				);

				const result = await (
					handler as (
						event: unknown,
						ctx: unknown,
					) => Promise<unknown> | unknown
				)(
					{
						type: "before_provider_request",
						payload: {
							input: "hello",
							text: {
								format: "plain",
							},
						},
					},
					{
						model: {
							provider: "openai",
							api: "openai-codex-responses",
						},
					},
				);

				expect(result).toEqual({
					input: "hello",
					text: {
						format: "plain",
						verbosity,
					},
				});
			}
		});
	});

	test("leaves non-OpenAI Codex provider requests unchanged", async () => {
		// Purpose: codex-verbosity must not affect providers outside the OpenAI Codex API.
		// Input and expected output: Anthropic request with valid codex config returns no replacement payload.
		// Edge case: valid verbosity config exists but must not be applied to another provider.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake and a temp config file.
		await withIsolatedAgentDir(async (agentDir) => {
			const pi = createExtensionApiFake();
			codexVerbosity(pi);
			const handler = getBeforeProviderRequestHandler(pi);

			expect(handler).toEqual(expect.any(Function));
			await mkdir(join(agentDir, "config"));
			await writeFile(
				join(agentDir, "config", "codex-verbosity.json"),
				JSON.stringify({ enabled: true, verbosity: "high" }),
			);

			const payload = { input: "hello" };
			const result = await (
				handler as (event: unknown, ctx: unknown) => Promise<unknown> | unknown
			)(
				{ type: "before_provider_request", payload },
				{
					model: {
						provider: "anthropic",
						api: "anthropic-messages",
					},
				},
			);

			expect(result).toBeUndefined();
			expect(payload).toEqual({ input: "hello" });
		});
	});

	test("rejects unsupported config keys without changing the provider request", async () => {
		// Purpose: unsupported config keys must fail closed inside codex-verbosity.
		// Input and expected output: configs with valid verbosity plus an extra key return no replacement payload and report one warning each.
		// Edge case: both truthy and empty-string unsupported keys must be rejected.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake, temp config file, and fake UI notification sinks.
		await withIsolatedAgentDir(async (agentDir) => {
			const pi = createExtensionApiFake();
			codexVerbosity(pi);
			const handler = getBeforeProviderRequestHandler(pi);

			expect(handler).toEqual(expect.any(Function));
			await mkdir(join(agentDir, "config"));

			for (const unsupportedKey of ["extra", ""] as const) {
				const notifications: { message: string; type: string | undefined }[] =
					[];
				await writeFile(
					join(agentDir, "config", "codex-verbosity.json"),
					JSON.stringify({
						enabled: true,
						verbosity: "low",
						[unsupportedKey]: true,
					}),
				);

				const result = await (
					handler as (
						event: unknown,
						ctx: unknown,
					) => Promise<unknown> | unknown
				)(
					{
						type: "before_provider_request",
						payload: { input: "hello" },
					},
					{
						model: {
							provider: "openai",
							api: "openai-codex-responses",
						},
						ui: {
							notify(message: string, type: string | undefined): void {
								notifications.push({ message, type });
							},
						},
					},
				);

				expect(result).toBeUndefined();
				expect(notifications).toHaveLength(1);
				expect(notifications[0]?.type).toBe("warning");
				expect(notifications[0]?.message).toContain("codex-verbosity");
				expect(notifications[0]?.message).toContain("unsupported key");
			}
		});
	});

	test("does not notify invalid config when UI is unavailable", async () => {
		// Purpose: non-interactive pi modes must not receive codex-verbosity warning notifications.
		// Input and expected output: unsupported config key with hasUI false returns no replacement payload and no notification.
		// Edge case: the UI object still has notify, but hasUI is the authoritative mode signal.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake, temp config file, and fake UI notification sink.
		await withIsolatedAgentDir(async (agentDir) => {
			const pi = createExtensionApiFake();
			const notifications: { message: string; type: string | undefined }[] = [];
			codexVerbosity(pi);
			const handler = getBeforeProviderRequestHandler(pi);

			expect(handler).toEqual(expect.any(Function));
			await mkdir(join(agentDir, "config"));
			await writeFile(
				join(agentDir, "config", "codex-verbosity.json"),
				JSON.stringify({ enabled: true, verbosity: "low", extra: true }),
			);

			const result = await (
				handler as (event: unknown, ctx: unknown) => Promise<unknown> | unknown
			)(
				{ type: "before_provider_request", payload: { input: "hello" } },
				{
					hasUI: false,
					model: {
						provider: "openai",
						api: "openai-codex-responses",
					},
					ui: {
						notify(message: string, type: string | undefined): void {
							notifications.push({ message, type });
						},
					},
				},
			);

			expect(result).toBeUndefined();
			expect(notifications).toEqual([]);
		});
	});

	test("rejects malformed verbosity config without changing the provider request", async () => {
		// Purpose: malformed config must fail closed and stay isolated to codex-verbosity.
		// Input and expected output: invalid JSON, unsupported verbosity, and non-string verbosity return no payload and report warnings.
		// Edge case: each malformed config is tested independently so one issue cannot mask another.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake, temp config files, and fake UI notification sinks.
		await withIsolatedAgentDir(async (agentDir) => {
			const pi = createExtensionApiFake();
			codexVerbosity(pi);
			const handler = getBeforeProviderRequestHandler(pi);

			expect(handler).toEqual(expect.any(Function));
			await mkdir(join(agentDir, "config"));

			const malformedConfigs = [
				{ content: "{", expectedMessage: "failed to parse" },
				{
					content: JSON.stringify({ enabled: true, verbosity: "verbose" }),
					expectedMessage: "must be one of",
				},
				{
					content: JSON.stringify({ enabled: true, verbosity: true }),
					expectedMessage: "must be one of",
				},
			] as const;

			for (const { content, expectedMessage } of malformedConfigs) {
				const notifications: { message: string; type: string | undefined }[] =
					[];
				await writeFile(
					join(agentDir, "config", "codex-verbosity.json"),
					content,
				);

				const result = await (
					handler as (
						event: unknown,
						ctx: unknown,
					) => Promise<unknown> | unknown
				)(
					{ type: "before_provider_request", payload: { input: "hello" } },
					{
						model: {
							provider: "openai",
							api: "openai-codex-responses",
						},
						ui: {
							notify(message: string, type: string | undefined): void {
								notifications.push({ message, type });
							},
						},
					},
				);

				expect(result).toBeUndefined();
				expect(notifications).toHaveLength(1);
				expect(notifications[0]?.type).toBe("warning");
				expect(notifications[0]?.message).toContain("codex-verbosity");
				expect(notifications[0]?.message).toContain(expectedMessage);
			}
		});
	});
});
