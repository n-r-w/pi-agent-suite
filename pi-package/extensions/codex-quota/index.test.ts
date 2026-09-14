import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codexQuota from "./index.ts";

const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";
const previousSuiteDir = process.env[AGENT_SUITE_DIR_ENV];
const temporaryDirectories: string[] = [];

afterEach(async () => {
	if (previousSuiteDir === undefined) {
		delete process.env[AGENT_SUITE_DIR_ENV];
	} else {
		process.env[AGENT_SUITE_DIR_ENV] = previousSuiteDir;
	}
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("codex quota", () => {
	test("does not publish an unchanged status after a background refresh", async () => {
		// Purpose: repeated quota results must not request a global render through setStatus.
		// Inputs and expected output: two refreshes without Codex authentication publish loading and one unavailable status only.
		// Edge case: the second refresh returns the same visible failure state as the first refresh.
		// Dependencies: isolated config, fake lifecycle handlers, fake interval, and no model registry.
		const suiteDirectory = await mkdtemp(join(tmpdir(), "codex-quota-"));
		temporaryDirectories.push(suiteDirectory);
		process.env[AGENT_SUITE_DIR_ENV] = suiteDirectory;
		const extensionDirectory = join(suiteDirectory, "codex-quota");
		await mkdir(extensionDirectory, { recursive: true });
		await writeFile(
			join(extensionDirectory, "config.json"),
			JSON.stringify({ enabled: true, refreshInterval: 10 }),
			"utf8",
		);

		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		const pi = {
			on(eventName: string, handler: (...args: unknown[]) => unknown): void {
				handlers.set(eventName, handler);
			},
		} as unknown as ExtensionAPI;
		const statuses: Array<string | undefined> = [];
		const session = {
			hasUI: true,
			modelRegistry: undefined,
			ui: {
				theme: { fg: (_color: string, value: string) => value },
				setStatus: (_key: string, value: string | undefined) => {
					statuses.push(value);
				},
				notify: () => undefined,
			},
		};
		let refresh: (() => void) | undefined;
		const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((
			handler: () => void,
		) => {
			refresh = handler;
			return 1 as unknown as ReturnType<typeof setInterval>;
		}) as typeof setInterval);
		try {
			codexQuota(pi);
			await handlers.get("session_start")?.({}, session);
			await flushMicrotasks();
			refresh?.();
			await flushMicrotasks();

			expect(statuses).toHaveLength(2);
			expect(statuses[0]).not.toBe(statuses[1]);
		} finally {
			intervalSpy.mockRestore();
		}
	});
});

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 5; index += 1) {
		await Promise.resolve();
	}
}
