import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CHILD_AGENT_PROCESS_ENV,
	CHILD_AGENT_PROCESS_ENV_VALUE,
} from "../../shared/child-agent-environment";
import cmux from "./index";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";
const STARTED_AT = 1_000;

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: unknown;
}

interface ExecCall {
	readonly command: string;
	readonly args: readonly string[];
	readonly options: unknown;
}

interface ExecResultFake {
	readonly killed: boolean;
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
	readonly execCalls: ExecCall[];
}

interface Notification {
	readonly message: string;
	readonly type: string | undefined;
}

interface SessionContextFake {
	readonly hasUI: boolean;
	readonly notifications: Notification[];
	readonly ui: {
		notify(message: string, type: string | undefined): void;
	};
}

interface AssistantMessageFake {
	readonly role: "assistant";
	readonly stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
}

interface AgentEndEventFake {
	readonly type: "agent_end";
	readonly messages: readonly AssistantMessageFake[];
}

interface ToolResultEventFake {
	readonly toolName: string;
	readonly input: { readonly path?: string };
	readonly content: readonly { readonly type: "text"; readonly text: string }[];
	readonly isError: boolean;
}

/** Creates the minimal agent_end event needed to exercise completion semantics. */
function createAgentEndEvent(
	stopReason: AssistantMessageFake["stopReason"] = "stop",
): AgentEndEventFake {
	return {
		type: "agent_end",
		messages: [{ role: "assistant", stopReason }],
	};
}

/** Creates an agent_end event without assistant messages. */
function createAgentEndEventWithoutAssistant(): AgentEndEventFake {
	return {
		type: "agent_end",
		messages: [],
	};
}

/** Creates the minimal tool_result event needed by cmux run-state tracking. */
function createToolResultEvent(
	toolName: string,
	options?: { readonly path?: string; readonly isError?: boolean },
): ToolResultEventFake {
	return {
		toolName,
		input: options?.path === undefined ? {} : { path: options.path },
		content: [{ type: "text", text: "ok" }],
		isError: options?.isError ?? false,
	};
}

/** Creates the ExtensionAPI fake needed to invoke registered lifecycle handlers. */
function createExtensionApiFake(options?: {
	readonly execResult?: ExecResultFake;
}): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];
	const execCalls: ExecCall[] = [];
	const execResult = options?.execResult ?? {
		killed: false,
		code: 0,
		stdout: "",
		stderr: "",
	};

	return {
		handlers,
		execCalls,
		on(eventName: string, handler: unknown): void {
			handlers.push({ eventName, handler });
		},
		async exec(
			command: string,
			args: readonly string[],
			commandOptions?: unknown,
		): Promise<ExecResultFake> {
			execCalls.push({ command, args, options: commandOptions });
			return execResult;
		},
	} as ExtensionApiFake;
}

/** Creates a session context fake for invalid-config notifications. */
function createSessionContextFake(): SessionContextFake {
	const notifications: Notification[] = [];

	return {
		hasUI: true,
		notifications,
		ui: {
			notify(message: string, type: string | undefined): void {
				notifications.push({ message, type });
			},
		},
	};
}

/** Returns one registered event handler from the extension fake. */
function getRegisteredHandler(
	pi: ExtensionApiFake,
	eventName: string,
): (event: unknown, ctx: unknown) => Promise<void> | void {
	const handler = pi.handlers.find(
		(registeredHandler) => registeredHandler.eventName === eventName,
	)?.handler;
	if (typeof handler !== "function") {
		throw new Error(`expected ${eventName} handler to be registered`);
	}

	return handler as (event: unknown, ctx: unknown) => Promise<void> | void;
}

/** Runs a test with an isolated pi agent directory so config reads never touch real user files. */
async function withIsolatedAgentDir<T>(
	action: (agentDir: string) => Promise<T>,
): Promise<T> {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const previousAgentSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
	const agentDir = await mkdtemp(join(tmpdir(), "pi-cmux-"));

	process.env[AGENT_DIR_ENV] = agentDir;
	delete process.env[AGENT_SUITE_DIR_ENV];
	try {
		return await action(agentDir);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env[AGENT_DIR_ENV];
		} else {
			process.env[AGENT_DIR_ENV] = previousAgentDir;
		}
		if (previousAgentSuiteDir === undefined) {
			delete process.env[AGENT_SUITE_DIR_ENV];
		} else {
			process.env[AGENT_SUITE_DIR_ENV] = previousAgentSuiteDir;
		}
		await rm(agentDir, { recursive: true, force: true });
	}
}

/** Writes cmux config into the isolated pi agent directory. */
async function writeConfig(agentDir: string, config: unknown): Promise<void> {
	await mkdir(join(agentDir, "agent-suite", "cmux"), {
		recursive: true,
	});
	await writeFile(
		join(agentDir, "agent-suite", "cmux", "config.json"),
		JSON.stringify(config),
	);
}

/** Registers the cmux extension and starts one deterministic run. */
async function registerAndStartRun(options?: {
	readonly env?: NodeJS.ProcessEnv;
	readonly execResult?: ExecResultFake;
}): Promise<{
	readonly pi: ExtensionApiFake;
	readonly now: { current: number };
}> {
	const now = { current: STARTED_AT };
	const pi = createExtensionApiFake(
		options?.execResult === undefined
			? undefined
			: { execResult: options.execResult },
	);
	cmux(pi, { env: options?.env ?? {}, now: () => now.current });
	await getRegisteredHandler(pi, "agent_start")({}, createSessionContextFake());

	return { pi, now };
}

/** Runs a tool_result handler for one fake tool result. */
async function runToolResult(
	pi: ExtensionApiFake,
	event: ToolResultEventFake,
): Promise<void> {
	await getRegisteredHandler(pi, "tool_result")(
		event,
		createSessionContextFake(),
	);
}

/** Runs the agent_end handler for a successful completion at the requested timestamp. */
async function finishSuccessfulRun(
	pi: ExtensionApiFake,
	now: { current: number },
	finishedAt: number,
): Promise<void> {
	now.current = finishedAt;
	await getRegisteredHandler(pi, "agent_end")(
		createAgentEndEvent(),
		createSessionContextFake(),
	);
}

describe("cmux", () => {
	test("sends a cmux notification for successful top-level completion", async () => {
		// Purpose: successful top-level completion must produce one cmux notification.
		// Input and expected output: successful agent_end without config calls cmux notify with the default title, subtitle, and duration body.
		// Edge case: missing config enables the extension by default.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake, injected clock, and temp agent directory.
		await withIsolatedAgentDir(async () => {
			const { pi, now } = await registerAndStartRun();

			await finishSuccessfulRun(pi, now, STARTED_AT + 1_000);

			expect(pi.execCalls).toEqual([
				{
					command: "cmux",
					args: [
						"notify",
						"--title",
						"Pi",
						"--subtitle",
						"Task Complete",
						"--body",
						"Finished in 1s",
					],
					options: { timeout: 5_000 },
				},
			]);
		});
	});

	test("does not notify when the current process is a child agent process", async () => {
		// Purpose: child agent completion must not duplicate the top-level cmux indication.
		// Input and expected output: PI_AGENT_SUITE_CHILD_AGENT_PROCESS=1 suppresses cmux notify.
		// Edge case: suppression uses the shared child process marker value.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake, injected clock, and temp agent directory.
		await withIsolatedAgentDir(async () => {
			const { pi, now } = await registerAndStartRun({
				env: { [CHILD_AGENT_PROCESS_ENV]: CHILD_AGENT_PROCESS_ENV_VALUE },
			});

			await finishSuccessfulRun(pi, now, STARTED_AT + 1_000);

			expect(pi.execCalls).toEqual([]);
		});
	});

	test("does not notify when there is no completed assistant message", async () => {
		// Purpose: completion indication must require a final assistant message.
		// Input and expected output: agent_end with no assistant messages does not call cmux notify.
		// Edge case: tool results can exist without a completed assistant answer.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake, injected clock, and temp agent directory.
		await withIsolatedAgentDir(async () => {
			const { pi, now } = await registerAndStartRun();

			now.current = STARTED_AT + 1_000;
			await getRegisteredHandler(pi, "agent_end")(
				createAgentEndEventWithoutAssistant(),
				createSessionContextFake(),
			);

			expect(pi.execCalls).toEqual([]);
		});
	});

	test("does not notify for provider errors or aborted runs", async () => {
		// Purpose: failed or cancelled agent turns must not be reported as completed work.
		// Input and expected output: latest assistant stopReason error and aborted both suppress cmux notify.
		// Edge case: both terminal states emit agent_end but are not successful completions.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake, injected clock, and temp agent directory.
		await withIsolatedAgentDir(async () => {
			for (const stopReason of ["error", "aborted"] as const) {
				const { pi, now } = await registerAndStartRun();

				now.current = STARTED_AT + 1_000;
				await getRegisteredHandler(pi, "agent_end")(
					createAgentEndEvent(stopReason),
					createSessionContextFake(),
				);

				expect(pi.execCalls).toEqual([]);
			}
		});
	});

	test("uses changed-file summary before other run activity", async () => {
		// Purpose: changed files are the most useful completion summary and must win over reads and searches.
		// Input and expected output: write, read, and grep results produce an Updated package.json body.
		// Edge case: basename is used instead of the full path.
		// Dependencies: this test uses only tool_result fakes and no real files.
		await withIsolatedAgentDir(async () => {
			const { pi, now } = await registerAndStartRun();
			await runToolResult(
				pi,
				createToolResultEvent("write", { path: "/repo/package.json" }),
			);
			await runToolResult(
				pi,
				createToolResultEvent("read", { path: "/repo/README.md" }),
			);
			await runToolResult(pi, createToolResultEvent("grep"));

			await finishSuccessfulRun(pi, now, STARTED_AT + 1_000);

			expect(pi.execCalls[0]?.args).toContain("Updated package.json");
		});
	});

	test("summarizes multiple changed files", async () => {
		// Purpose: multi-file changes must avoid picking an arbitrary changed file name.
		// Input and expected output: edit and write results for two files produce Updated 2 files.
		// Edge case: duplicate paths count once because one file can be touched by multiple tools.
		// Dependencies: this test uses only tool_result fakes and no real files.
		await withIsolatedAgentDir(async () => {
			const { pi, now } = await registerAndStartRun();
			await runToolResult(pi, createToolResultEvent("edit", { path: "a.ts" }));
			await runToolResult(pi, createToolResultEvent("write", { path: "b.ts" }));
			await runToolResult(pi, createToolResultEvent("write", { path: "b.ts" }));

			await finishSuccessfulRun(pi, now, STARTED_AT + 1_000);

			expect(pi.execCalls[0]?.args).toContain("Updated 2 files");
		});
	});

	test("uses read-file summary when no files changed", async () => {
		// Purpose: review-only work should show the reviewed file in cmux.
		// Input and expected output: one read result produces Reviewed README.md.
		// Edge case: failed read results are not counted as reviewed files.
		// Dependencies: this test uses only tool_result fakes and no real files.
		await withIsolatedAgentDir(async () => {
			const { pi, now } = await registerAndStartRun();
			await runToolResult(
				pi,
				createToolResultEvent("read", { path: "/repo/README.md" }),
			);
			await runToolResult(
				pi,
				createToolResultEvent("read", {
					path: "/repo/broken.md",
					isError: true,
				}),
			);

			await finishSuccessfulRun(pi, now, STARTED_AT + 1_000);

			expect(pi.execCalls[0]?.args).toContain("Reviewed README.md");
		});
	});

	test("summarizes search and shell activity", async () => {
		// Purpose: non-file work still needs a useful completion body.
		// Input and expected output: grep plus two bash results produce Ran 1 search and 2 shell commands.
		// Edge case: pluralization differs for search and shell counts.
		// Dependencies: this test uses only tool_result fakes and no real shell commands.
		await withIsolatedAgentDir(async () => {
			const { pi, now } = await registerAndStartRun();
			await runToolResult(pi, createToolResultEvent("grep"));
			await runToolResult(pi, createToolResultEvent("bash"));
			await runToolResult(pi, createToolResultEvent("bash"));

			await finishSuccessfulRun(pi, now, STARTED_AT + 1_000);

			expect(pi.execCalls[0]?.args).toContain(
				"Ran 1 search and 2 shell commands",
			);
		});
	});

	test("summarizes search-only and shell-only activity", async () => {
		// Purpose: search-only and shell-only runs need stable body text.
		// Input and expected output: one grep gives Searched the codebase; two bash results give Ran 2 shell commands.
		// Edge case: one search uses a sentence instead of Ran 1 search.
		// Dependencies: this test uses only tool_result fakes and no real shell commands.
		await withIsolatedAgentDir(async () => {
			const searchRun = await registerAndStartRun();
			await runToolResult(searchRun.pi, createToolResultEvent("find"));
			await finishSuccessfulRun(
				searchRun.pi,
				searchRun.now,
				STARTED_AT + 1_000,
			);

			const shellRun = await registerAndStartRun();
			await runToolResult(shellRun.pi, createToolResultEvent("bash"));
			await runToolResult(shellRun.pi, createToolResultEvent("bash"));
			await finishSuccessfulRun(shellRun.pi, shellRun.now, STARTED_AT + 1_000);

			expect(searchRun.pi.execCalls[0]?.args).toContain(
				"Searched the codebase",
			);
			expect(shellRun.pi.execCalls[0]?.args).toContain("Ran 2 shell commands");
		});
	});

	test("appends duration after the fixed threshold", async () => {
		// Purpose: long completed work should show elapsed time in addition to the run summary.
		// Input and expected output: one changed file after 72 seconds produces Updated package.json in 1m 12s.
		// Edge case: duration uses minute-and-second formatting after crossing one minute.
		// Dependencies: this test uses injected clock only.
		await withIsolatedAgentDir(async () => {
			const { pi, now } = await registerAndStartRun();
			await runToolResult(
				pi,
				createToolResultEvent("write", { path: "/repo/package.json" }),
			);

			await finishSuccessfulRun(pi, now, STARTED_AT + 72_000);

			expect(pi.execCalls[0]?.args).toContain("Updated package.json in 1m 12s");
		});
	});

	test("disabled config suppresses all cmux notifications", async () => {
		// Purpose: enabled false must disable all behavior owned by this extension.
		// Input and expected output: enabled false config prevents cmux notify on successful completion.
		// Edge case: successful completed work still stays silent when disabled.
		// Dependencies: this test uses a temp config file and fake ExtensionAPI.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeConfig(agentDir, { enabled: false });
			const { pi, now } = await registerAndStartRun();

			await finishSuccessfulRun(pi, now, STARTED_AT + 1_000);

			expect(pi.execCalls).toEqual([]);
		});
	});

	test("invalid config fails closed and reports a warning", async () => {
		// Purpose: invalid config must not produce ambiguous runtime behavior.
		// Input and expected output: unsupported key and non-boolean enabled each report a warning and suppress cmux notify.
		// Edge case: invalid config is reported during session_start before agent completion.
		// Dependencies: this test uses temp config files and fake UI notifications.
		const cases = [
			{
				config: { title: "Custom" },
				message: "[cmux] config contains unsupported keys",
			},
			{
				config: { enabled: "yes" },
				message: "[cmux] enabled must be a boolean",
			},
		];

		for (const testCase of cases) {
			await withIsolatedAgentDir(async (agentDir) => {
				await writeConfig(agentDir, testCase.config);
				const now = { current: STARTED_AT };
				const pi = createExtensionApiFake();
				const ctx = createSessionContextFake();
				cmux(pi, { env: {}, now: () => now.current });

				await getRegisteredHandler(pi, "session_start")({}, ctx);
				await getRegisteredHandler(pi, "agent_start")({}, ctx);
				await finishSuccessfulRun(pi, now, STARTED_AT + 1_000);

				expect(pi.execCalls).toEqual([]);
				expect(ctx.notifications).toEqual([
					{
						message: testCase.message,
						type: "warning",
					},
				]);
			});
		}
	});

	test("cmux command failures and timeouts do not throw", async () => {
		// Purpose: a missing or stuck cmux CLI must not break pi in a normal terminal.
		// Input and expected output: non-zero cmux exit and killed cmux process resolve without throwing.
		// Edge case: outside cmux, the command can be absent or unavailable.
		// Dependencies: this test uses fake pi.exec results and never calls real cmux.
		for (const execResult of [
			{ killed: false, code: 127, stdout: "", stderr: "cmux not found" },
			{ killed: true, code: 0, stdout: "", stderr: "" },
		]) {
			await withIsolatedAgentDir(async () => {
				const { pi, now } = await registerAndStartRun({ execResult });

				await expect(
					finishSuccessfulRun(pi, now, STARTED_AT + 1_000),
				).resolves.toBeUndefined();
			});
		}
	});
});
