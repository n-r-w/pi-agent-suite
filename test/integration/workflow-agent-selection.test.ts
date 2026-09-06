import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

interface Probe {
	readonly requests: readonly { model: string; tools: readonly string[] }[];
	readonly activeAgent: string;
	readonly activeTools: readonly string[];
	readonly model: string;
	readonly thinking: string;
	readonly branch: readonly { type: string; details?: { kind?: string } }[];
}

/** Creates only isolated configuration and fake-provider files for the real CLI. */
function createFixture(): {
	root: string;
	project: string;
	state: string;
	debug: string;
	dump: string;
} {
	const root = mkdtempSync(join(tmpdir(), "pi-workflow-selection-"));
	const project = join(root, "project");
	const state = join(root, "state");
	const debug = join(root, "debug.ts");
	const dump = join(root, "probe.json");
	mkdirSync(project);
	const agents = join(state, "agent-suite", "agent-selection", "agents");
	const workflows = join(state, "agent-suite", "workflow", "workflows");
	mkdirSync(agents, { recursive: true });
	mkdirSync(workflows, { recursive: true });
	for (const id of ["a", "b", "c"]) {
		writeFileSync(
			join(agents, `${id}.md`),
			[
				"---",
				`description: ${id}`,
				"type: main",
				`tools: ${JSON.stringify(id === "a" ? ["read", "workflow_activate"] : ["bash"])}`,
				"model:",
				`  id: selection-test/${id}`,
				`  thinking: ${id === "a" ? "low" : "high"}`,
				"---",
				`Agent ${id}`,
			].join("\n"),
		);
	}
	writeFileSync(
		join(workflows, "delivery.yaml"),
		"description: Delivery\nstages:\n  - id: start\n    description: Start\n    prompt: Work\n    initial: true\n    final: true\ntransitions: []\n",
	);
	const fixture = pathToFileURL(
		join(process.cwd(), "test/fixtures/workflow-agent-selection.ts"),
	).href;
	writeFileSync(
		debug,
		`import { selectionProbe } from ${JSON.stringify(fixture)}; export default (pi) => selectionProbe(pi, ${JSON.stringify(dump)});`,
	);
	return { root, project, state, debug, dump };
}

test("real Pi defers busy agent selection and appends workflow options only for actual runs", async () => {
	// Purpose: prove CLI ordering, durable append-only publication, and no steering-induced extra request.
	// Input/output: run A, select B and C while its provider waits, then run C with only one replacement record.
	// Edge cases: idle A -> B -> A, repeated unchanged runs, and the old run's tools/model/thinking remain intact.
	// Dependencies: real Pi RPC and package loading, isolated state, and an in-process fake provider without network.
	const fixture = createFixture();
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: fixture.state,
		PI_AGENT_SUITE_DIR: join(fixture.state, "agent-suite"),
	};
	for (const key of [
		"PI_SUBAGENT_AGENT_ID",
		"PI_SUBAGENT_DEPTH",
		"PI_SUBAGENT_TOOL_PATTERNS",
		"PI_SUBAGENT_WORKFLOW_IDS",
		"PI_AGENT_SUITE_CHILD_AGENT_PROCESS",
	]) {
		Reflect.deleteProperty(env, key);
	}
	const child = spawn(
		"pi",
		[
			"--no-session",
			"--no-extensions",
			"--mode",
			"rpc",
			"--model",
			"selection-test/a",
			"--agent",
			"a",
			"-e",
			join(process.cwd(), "pi-package"),
			"-e",
			fixture.debug,
		],
		{ cwd: fixture.project, env, stdio: "pipe" },
	);
	const events: Record<string, unknown>[] = [];
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const reader = createInterface({ input: child.stdout });
	reader.on("line", (line) => {
		try {
			events.push(JSON.parse(line) as Record<string, unknown>);
		} catch {
			/* Non-RPC terminal output is not an event. */
		}
	});
	const exited = new Promise<void>((resolve) =>
		child.on("exit", () => resolve()),
	);
	let nextId = 0;
	const waitFor = async (
		predicate: (event: Record<string, unknown>) => boolean,
		start = 0,
	): Promise<Record<string, unknown>> => {
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			const event = events.slice(start).find(predicate);
			if (event !== undefined) {
				return event;
			}
			if (child.exitCode !== null) {
				throw new Error(`Pi exited: ${stderr}`);
			}
			await Bun.sleep(10);
		}
		throw new Error(`Pi event timed out: ${stderr}`);
	};
	const command = async (message: string) => {
		const id = String(nextId++);
		child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
		const response = await waitFor(
			(event) => event["type"] === "response" && event["id"] === id,
		);
		expect(response["success"]).toBe(true);
	};
	const probe = async (): Promise<Probe> => {
		await command("/probe");
		return JSON.parse(readFileSync(fixture.dump, "utf8")) as Probe;
	};
	const options = (state: Probe) =>
		state.branch.filter(
			(entry) =>
				entry.type === "custom_message" &&
				entry.details?.kind === "activation_options",
		);
	try {
		await command("/agent b");
		await command("/agent a");
		expect(options(await probe())).toHaveLength(0);
		await command("first fixture request");
		// The provider can start after RPC preflight accepts the prompt.
		const deadline = Date.now() + 15000;
		let initial = await probe();
		while (initial.requests.length === 0 && Date.now() < deadline) {
			await Bun.sleep(10);
			initial = await probe();
		}
		expect(initial.requests).toHaveLength(1);
		expect(options(initial)).toHaveLength(1);
		await command("/agent b");
		await command("/agent c");
		const busy = await probe();
		expect(busy.activeAgent).toBe("a");
		expect(busy.model).toBe("a");
		expect(busy.thinking).toBe("low");
		expect(busy.branch).toEqual(initial.branch);
		expect(busy.activeTools).toEqual(initial.activeTools);
		const settleStart = events.length;
		await command("/release");
		await waitFor((event) => event["type"] === "agent_settled", settleStart);
		const settled = await probe();
		expect(settled.requests).toHaveLength(1);
		const nextStart = events.length;
		await command("second fixture request");
		await waitFor((event) => event["type"] === "agent_settled", nextStart);
		const next = await probe();
		expect(next.activeAgent).toBe("c");
		expect(next.model).toBe("c");
		expect(next.thinking).toBe("high");
		expect(next.requests.map(({ model }) => model)).toEqual(["a", "c"]);
		expect(next.requests[1]?.tools).toEqual(["bash"]);
		expect(options(next)).toHaveLength(2);
		expect(next.branch.slice(0, settled.branch.length)).toEqual([
			...settled.branch,
		]);
		const repeatStart = events.length;
		await command("third fixture request");
		await waitFor((event) => event["type"] === "agent_settled", repeatStart);
		expect(options(await probe())).toHaveLength(2);
	} finally {
		child.kill("SIGKILL");
		await exited;
		reader.close();
		rmSync(fixture.root, { recursive: true, force: true });
	}
}, 60000);
