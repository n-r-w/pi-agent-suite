import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	registerTriggerAlgorithm,
	type TriggerAlgorithm,
} from "../../shared/algorithm-registry";
import {
	CHILD_AGENT_PROCESS_ENV,
	CHILD_AGENT_PROCESS_ENV_VALUE,
} from "../../shared/child-agent-environment";
import algorithmsExtension from "./index";

interface RegisteredCommandFake {
	readonly name: string;
	readonly description: string;
	readonly handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

interface ExtensionApiFake {
	readonly handlers: Map<string, (...args: unknown[]) => unknown>;
	readonly flagValues: Map<string, boolean | string>;
	readonly commands: RegisteredCommandFake[];
	readonly registeredFlags: string[];
	shutdownCalls: number;
}

/** Records stderr writes during one test. */
const stderrLines: string[] = [];
const originalStderrWrite = process.stderr.write;
const originalChildMarker = process.env[CHILD_AGENT_PROCESS_ENV];

beforeEach(() => {
	// CLI-path tests must never inherit the child-agent marker from the test runner.
	delete process.env[CHILD_AGENT_PROCESS_ENV];
});

afterEach(() => {
	process.stderr.write = originalStderrWrite;
	stderrLines.splice(0);
	if (originalChildMarker === undefined) {
		delete process.env[CHILD_AGENT_PROCESS_ENV];
	} else {
		process.env[CHILD_AGENT_PROCESS_ENV] = originalChildMarker;
	}
	// Failure tests set exitCode; reset it so the runner itself exits zero.
	process.exitCode = 0;
});

/** Builds a fake extension API with flag, command, and event capture. */
function createFake(): ExtensionApiFake & {
	readonly api: ExtensionAPI;
	readonly ctx: ExtensionContext;
} {
	const fake: ExtensionApiFake = {
		handlers: new Map(),
		flagValues: new Map(),
		commands: [],
		registeredFlags: [],
		shutdownCalls: 0,
	};
	const api = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			fake.handlers.set(event, handler);
		},
		registerFlag(
			name: string,
			_options: { readonly type: "boolean" | "string" },
		) {
			fake.registeredFlags.push(name);
		},
		getFlag(name: string) {
			return fake.flagValues.get(name);
		},
		registerCommand(
			name: string,
			options: {
				readonly description: string;
				readonly handler: (
					args: string,
					ctx: ExtensionContext,
				) => Promise<void>;
			},
		) {
			fake.commands.push({
				name,
				description: options.description,
				handler: options.handler,
			});
		},
		events: new EventEmitter(),
	};
	const ctx = {
		shutdown: () => {
			fake.shutdownCalls += 1;
		},
	} as unknown as ExtensionContext;
	Object.assign(fake, {
		api: api as unknown as ExtensionAPI,
		ctx,
	});
	return fake as ExtensionApiFake & {
		readonly api: ExtensionAPI;
		readonly ctx: ExtensionContext;
	};
}

/** Registers one runnable test algorithm. */
function registerAlgorithm(pi: ExtensionAPI, type: string): TriggerAlgorithm {
	const algorithm: TriggerAlgorithm = {
		type,
		description: `Runs ${type}`,
		async run() {
			return { ok: true };
		},
	};
	registerTriggerAlgorithm(pi, algorithm);
	return algorithm;
}

describe("algorithms extension lifecycle", () => {
	/**
	 * Proves the extension registers the --trigger CLI flag at load time.
	 * Inputs and expected outputs: extension load leaves the flag registered.
	 * Edge case: no session event is needed for flag registration.
	 * Dependencies: the extension entry point.
	 */
	test("registers the --trigger CLI flag", () => {
		const fake = createFake();
		algorithmsExtension(fake.api);
		expect(fake.registeredFlags).toEqual(["trigger"]);
	});

	/**
	 * Proves the session_start handler runs a registered algorithm from the shared registry and shuts down.
	 * Inputs and expected outputs: one registered algorithm runs exactly once and the session shuts down.
	 * Edge case: normal session initialization is skipped after the CLI run.
	 * Dependencies: the shared algorithm registry.
	 */
	test("runs the requested algorithm and shuts down", async () => {
		const fake = createFake();
		registerAlgorithm(fake.api, "local_knowledge_accumulation");
		algorithmsExtension(fake.api);
		fake.flagValues.set("trigger", "local_knowledge_accumulation");
		process.stderr.write = (chunk: string) => {
			stderrLines.push(chunk);
			return true;
		};

		const handler = fake.handlers.get("session_start");
		if (handler === undefined) {
			throw new Error("session_start handler missing");
		}
		await handler({ type: "session_start" }, fake.ctx);

		expect(stderrLines).toContain(
			"[trigger] running local_knowledge_accumulation...\n",
		);
		expect(stderrLines).toContain(
			"[trigger] local_knowledge_accumulation completed\n",
		);
		expect(fake.shutdownCalls).toBe(1);
		expect(fake.commands).toEqual([]);
	});

	/**
	 * Proves an unknown trigger type writes an error and shuts down without running.
	 * Inputs and expected outputs: one unknown flag value produces stderr and shutdown.
	 * Edge case: no algorithm run occurs for unknown types.
	 * Dependencies: registry lookup by exact type.
	 */
	test("reports unknown trigger types and shuts down", async () => {
		const fake = createFake();
		algorithmsExtension(fake.api);
		fake.flagValues.set("trigger", "unknown_trigger");
		process.stderr.write = (chunk: string) => {
			stderrLines.push(chunk);
			return true;
		};
		process.exitCode = 0;

		const handler = fake.handlers.get("session_start");
		if (handler === undefined) {
			throw new Error("session_start handler missing");
		}
		await handler({ type: "session_start" }, fake.ctx);

		expect(stderrLines).toEqual(["unknown trigger type: unknown_trigger\n"]);
		expect(process.exitCode).toBe(1);
		expect(fake.shutdownCalls).toBe(1);
	});

	/**
	 * Proves the extension registers one slash command per registered algorithm when no flag is set.
	 * Inputs and expected outputs: two registered algorithms produce two trigger:<type> commands.
	 * Edge case: the command name uses the skill-like colon syntax.
	 * Dependencies: the shared algorithm registry listing.
	 */
	test("registers slash commands for every registered algorithm", async () => {
		const fake = createFake();
		registerAlgorithm(fake.api, "local_knowledge_accumulation");
		registerAlgorithm(fake.api, "global_knowledge_accumulation");
		algorithmsExtension(fake.api);

		const handler = fake.handlers.get("session_start");
		if (handler === undefined) {
			throw new Error("session_start handler missing");
		}
		await handler({ type: "session_start" }, fake.ctx);

		expect(fake.commands.map(({ name }) => name)).toEqual([
			"trigger:local_knowledge_accumulation",
			"trigger:global_knowledge_accumulation",
		]);
		expect(fake.commands[0]?.description).toBe(
			"Runs local_knowledge_accumulation",
		);
		expect(fake.shutdownCalls).toBe(0);
	});

	/**
	 * Proves a registered slash command runs its algorithm without shutting down.
	 * Inputs and expected outputs: invoking the command handler runs the algorithm and leaves the session open.
	 * Edge case: the command is interactive and must not terminate the session.
	 * Dependencies: the command handler generated by the extension.
	 */
	test("runs the slash command algorithm without shutting down", async () => {
		const fake = createFake();
		registerAlgorithm(fake.api, "local_knowledge_accumulation");
		algorithmsExtension(fake.api);

		const handler = fake.handlers.get("session_start");
		if (handler === undefined) {
			throw new Error("session_start handler missing");
		}
		await handler({ type: "session_start" }, fake.ctx);

		expect(fake.commands).toHaveLength(1);
		await fake.commands[0]?.handler("", fake.ctx);
		expect(fake.shutdownCalls).toBe(0);
	});

	/**
	 * Proves a failed algorithm run reports failure and exits non-zero from the CLI.
	 * Inputs and expected outputs: one failing algorithm produces a failure line and exit code 1.
	 * Edge case: a failed manual run must not be reported as completed.
	 * Dependencies: the shared algorithm registry run result.
	 */
	test("reports a failed algorithm run and exits non-zero", async () => {
		const fake = createFake();
		registerTriggerAlgorithm(fake.api, {
			type: "failing_algorithm",
			description: "Always fails",
			async run() {
				return { ok: false };
			},
		});
		algorithmsExtension(fake.api);
		fake.flagValues.set("trigger", "failing_algorithm");
		process.stderr.write = (chunk: string) => {
			stderrLines.push(chunk);
			return true;
		};
		process.exitCode = 0;

		const handler = fake.handlers.get("session_start");
		if (handler === undefined) {
			throw new Error("session_start handler missing");
		}
		await handler({ type: "session_start" }, fake.ctx);

		expect(stderrLines).toEqual([
			"[trigger] running failing_algorithm...\n",
			"[trigger] failing_algorithm failed\n",
		]);
		expect(process.exitCode).toBe(1);
		expect(fake.shutdownCalls).toBe(1);
	});

	/**
	 * Proves a throwing algorithm run reports failure and exits non-zero from the CLI.
	 * Inputs and expected outputs: one throwing algorithm produces a failure line and exit code 1.
	 * Edge case: an unhandled throw must not be reported as a successful run.
	 * Dependencies: the shared algorithm registry run result.
	 */
	test("reports a throwing algorithm run and exits non-zero", async () => {
		const fake = createFake();
		registerTriggerAlgorithm(fake.api, {
			type: "throwing_algorithm",
			description: "Always throws",
			async run() {
				throw new Error("boom");
			},
		});
		algorithmsExtension(fake.api);
		fake.flagValues.set("trigger", "throwing_algorithm");
		process.stderr.write = (chunk: string) => {
			stderrLines.push(chunk);
			return true;
		};
		process.exitCode = 0;

		const handler = fake.handlers.get("session_start");
		if (handler === undefined) {
			throw new Error("session_start handler missing");
		}
		await handler({ type: "session_start" }, fake.ctx);

		expect(stderrLines).toEqual([
			"[trigger] running throwing_algorithm...\n",
			"[trigger] throwing_algorithm failed\n",
		]);
		expect(process.exitCode).toBe(1);
		expect(fake.shutdownCalls).toBe(1);
	});

	/**
	 * Proves child agent processes skip the CLI flag without shutting down.
	 * Inputs and expected outputs: a child marker with a trigger flag produces no run and no shutdown.
	 * Edge case: child processes do not expose CLI flags.
	 * Dependencies: the child process environment marker.
	 */
	test("ignores the CLI flag in child agent processes", async () => {
		const fake = createFake();
		registerAlgorithm(fake.api, "local_knowledge_accumulation");
		algorithmsExtension(fake.api);
		fake.flagValues.set("trigger", "local_knowledge_accumulation");
		process.env[CHILD_AGENT_PROCESS_ENV] = CHILD_AGENT_PROCESS_ENV_VALUE;
		try {
			const handler = fake.handlers.get("session_start");
			if (handler === undefined) {
				throw new Error("session_start handler missing");
			}
			await handler({ type: "session_start" }, fake.ctx);
		} finally {
			delete process.env[CHILD_AGENT_PROCESS_ENV];
		}

		expect(fake.shutdownCalls).toBe(0);
		expect(fake.commands).toHaveLength(1);
	});
});
