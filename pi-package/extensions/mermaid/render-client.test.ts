import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import {
	createMermaidRenderClient,
	type MermaidRenderClientDependencies,
} from "./render-client.js";
import type { MermaidSourceBlock } from "./types.js";

/** Captures worker stdin without touching a real process. */
class FakeWritable extends EventEmitter {
	public input = "";

	/** Records the complete one-request worker payload. */
	public end(value: string): void {
		this.input = value;
	}
}

/** Provides the data-event subset used by bounded worker output capture. */
class FakeReadable extends EventEmitter {}

/** Models one child lifecycle while recording termination requests. */
class FakeChild extends EventEmitter {
	public readonly stdin = new FakeWritable();
	public readonly stdout = new FakeReadable();
	public readonly stderr = new FakeReadable();
	public readonly killSignals: string[] = [];

	/** Records process termination without invoking the operating system. */
	public kill(signal: string): boolean {
		this.killSignals.push(signal);
		return true;
	}
}

/** Creates one accepted source block for render-client tests. */
function createBlock(sourceHash = "hash"): MermaidSourceBlock {
	return {
		diagramType: "flowchart",
		source: "flowchart TD\nA --> B",
		sourceHash,
	};
}

/** Creates deterministic child and timer dependencies. */
function createHarness(): {
	child: FakeChild;
	dependencies: MermaidRenderClientDependencies;
	fireTimeout: () => void;
} {
	const child = new FakeChild();
	let timeoutCallback: (() => void) | undefined;
	return {
		child,
		dependencies: {
			spawnWorker: () => child,
			scheduleTimeout: (callback) => {
				timeoutCallback = callback;
				return "timer";
			},
			clearScheduledTimeout: () => {},
		},
		fireTimeout: () => timeoutCallback?.(),
	};
}

/** Covers the bounded isolated renderer process boundary. */
describe("Mermaid render client", () => {
	/** Validates and sanitizes one successful worker response. */
	test("returns sanitized variants from a valid response", async () => {
		// Arrange
		const harness = createHarness();
		const client = createMermaidRenderClient(harness.dependencies);

		// Act
		const pending = client.render([createBlock()]);
		harness.child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					results: [
						{
							status: "rendered",
							compatibilityWarnings: ["circle_edge_omission"],
							sourceHash: "hash",
							variants: {
								default: { text: "  \u001b[31mA --> B\u001b[0m  " },
								tight: { text: "A-->B" },
							},
						},
					],
				}),
			),
		);
		harness.child.emit("close", 0, null);
		const result = await pending;

		// Assert
		expect(JSON.parse(harness.child.stdin.input)).toMatchObject({
			blocks: [{ sourceHash: "hash", source: "flowchart TD\nA --> B" }],
		});
		expect(result).toMatchObject({
			status: "completed",
			results: [
				{
					status: "rendered",
					compatibilityWarnings: ["circle_edge_omission"],
					variants: {
						default: { text: "  A --> B  ", maxLineWidth: 11 },
					},
				},
			],
		});
	});

	/** Rejects unknown and duplicate structural warning codes from the worker. */
	test("rejects invalid structural warning codes", async () => {
		// Arrange
		const warningLists = [
			["unknown_warning"],
			["circle_edge_omission", "circle_edge_omission"],
		];
		const operations = warningLists.map(async (compatibilityWarnings) => {
			const harness = createHarness();
			const client = createMermaidRenderClient(harness.dependencies);

			// Act
			const pending = client.render([createBlock()]);
			harness.child.stdout.emit(
				"data",
				Buffer.from(
					JSON.stringify({
						results: [
							{
								status: "rendered",
								compatibilityWarnings,
								sourceHash: "hash",
								variants: {
									default: { text: "A" },
									tight: { text: "A" },
								},
							},
						],
					}),
				),
			);
			harness.child.emit("close", 0, null);
			return pending;
		});

		// Assert
		for (const result of await Promise.all(operations)) {
			expect(result).toMatchObject({
				results: [{ diagnosticCode: "invalid_worker_response" }],
			});
		}
	});

	/** Rejects a worker response that reports a blank successful preview. */
	test("rejects empty rendered variants", async () => {
		// Arrange
		const harness = createHarness();
		const client = createMermaidRenderClient(harness.dependencies);

		// Act
		const pending = client.render([createBlock()]);
		harness.child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					results: [
						{
							status: "rendered",
							compatibilityWarnings: [],
							sourceHash: "hash",
							variants: {
								default: { text: "" },
								tight: { text: "   " },
							},
						},
					],
				}),
			),
		);
		harness.child.emit("close", 0, null);
		const result = await pending;

		// Assert
		expect(result).toMatchObject({
			results: [{ diagnosticCode: "invalid_worker_response" }],
		});
	});

	/** Preserves finite worker failures while sanitizing their explanation. */
	test("returns a validated worker syntax failure", async () => {
		// Arrange
		const harness = createHarness();
		const client = createMermaidRenderClient(harness.dependencies);

		// Act
		const pending = client.render([createBlock()]);
		harness.child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					results: [
						{
							status: "failed",
							sourceHash: "hash",
							diagnosticCode: "invalid_syntax",
							explanation: "\u001b[31mInvalid syntax\u001b[0m",
						},
					],
				}),
			),
		);
		harness.child.emit("close", 0, null);
		const result = await pending;

		// Assert
		expect(result).toMatchObject({
			results: [
				{
					status: "failed",
					diagnosticCode: "invalid_syntax",
					explanation: "Invalid syntax",
				},
			],
		});
	});

	/** Rejects a response whose result identity does not match the request. */
	test("rejects mismatched worker result identity", async () => {
		// Arrange
		const harness = createHarness();
		const client = createMermaidRenderClient(harness.dependencies);

		// Act
		const pending = client.render([createBlock()]);
		harness.child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					results: [
						{
							status: "rendered",
							compatibilityWarnings: [],
							sourceHash: "other",
							variants: {
								default: { text: "A" },
								tight: { text: "A" },
							},
						},
					],
				}),
			),
		);
		harness.child.emit("close", 0, null);
		const result = await pending;

		// Assert
		expect(result).toMatchObject({
			results: [{ diagnosticCode: "invalid_worker_response" }],
		});
	});

	/** Contains asynchronous worker stdin failures inside the process boundary. */
	test("maps worker stdin errors without uncaught events", async () => {
		// Arrange
		const harness = createHarness();
		const client = createMermaidRenderClient(harness.dependencies);

		// Act
		const pending = client.render([createBlock()]);
		harness.child.stdin.emit("error", new Error("EPIPE"));
		harness.child.emit("close", 1, null);
		const result = await pending;

		// Assert
		expect(harness.child.killSignals).toEqual(["SIGKILL"]);
		expect(result).toMatchObject({
			results: [{ diagnosticCode: "render_process_failed" }],
		});
	});

	/** Maps the deterministic timeout callback to failures and terminates the child. */
	test("terminates timed out rendering", async () => {
		// Arrange
		const harness = createHarness();
		const client = createMermaidRenderClient(harness.dependencies);
		const block = createBlock();

		// Act
		const pending = client.render([block]);
		harness.fireTimeout();
		const result = await pending;

		// Assert
		expect(harness.child.killSignals).toEqual(["SIGKILL"]);
		expect(result).toMatchObject({
			status: "completed",
			results: [{ status: "failed", diagnosticCode: "render_timeout" }],
		});
	});

	/** Treats user cancellation as an aborted operation with no failure result. */
	test("aborts rendering without producing block failures", async () => {
		// Arrange
		const harness = createHarness();
		const client = createMermaidRenderClient(harness.dependencies);
		const controller = new AbortController();

		// Act
		const pending = client.render([createBlock()], controller.signal);
		controller.abort();
		const result = await pending;

		// Assert
		expect(harness.child.killSignals).toEqual(["SIGKILL"]);
		expect(result).toEqual({ status: "aborted" });
	});

	/** Rejects malformed JSON and excessive captured output without retaining partial data. */
	test("maps malformed and excessive output to finite failures", async () => {
		// Arrange
		const malformedHarness = createHarness();
		const malformedClient = createMermaidRenderClient(
			malformedHarness.dependencies,
		);
		const overflowHarness = createHarness();
		const overflowClient = createMermaidRenderClient(
			overflowHarness.dependencies,
		);

		// Act
		const malformedPending = malformedClient.render([createBlock("malformed")]);
		malformedHarness.child.stdout.emit("data", Buffer.from("not-json"));
		malformedHarness.child.emit("close", 0, null);
		const overflowPending = overflowClient.render([createBlock("overflow")]);
		overflowHarness.child.stdout.emit("data", Buffer.alloc(1_300_000, "x"));
		const [malformed, overflow] = await Promise.all([
			malformedPending,
			overflowPending,
		]);

		// Assert
		expect(malformed).toMatchObject({
			results: [{ diagnosticCode: "invalid_worker_response" }],
		});
		expect(overflowHarness.child.killSignals).toEqual(["SIGKILL"]);
		expect(overflow).toMatchObject({
			results: [{ diagnosticCode: "output_limit_exceeded" }],
		});
	});

	/** Classifies V8 heap exhaustion independently from ordinary process failures. */
	test("maps memory exhaustion and process errors to distinct failures", async () => {
		// Arrange
		const memoryHarness = createHarness();
		const memoryClient = createMermaidRenderClient(memoryHarness.dependencies);
		const errorHarness = createHarness();
		const errorClient = createMermaidRenderClient(errorHarness.dependencies);

		// Act
		const memoryPending = memoryClient.render([createBlock("memory")]);
		memoryHarness.child.stderr.emit(
			"data",
			Buffer.from("FATAL ERROR: heap out of memory"),
		);
		memoryHarness.child.emit("close", 134, "SIGABRT");
		const errorPending = errorClient.render([createBlock("process")]);
		errorHarness.child.emit("error", new Error("spawn failed"));
		const [memoryResult, processResult] = await Promise.all([
			memoryPending,
			errorPending,
		]);

		// Assert
		expect(memoryResult).toMatchObject({
			results: [{ diagnosticCode: "render_memory_limit" }],
		});
		expect(processResult).toMatchObject({
			results: [{ diagnosticCode: "render_process_failed" }],
		});
	});

	/** Rejects a worker variant that exceeds its persisted-output contract. */
	test("maps oversized rendered variants to the output limit", async () => {
		// Arrange
		const harness = createHarness();
		const client = createMermaidRenderClient(harness.dependencies);
		const oversizedText = "x".repeat(100_001);

		// Act
		const pending = client.render([createBlock()]);
		harness.child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					results: [
						{
							status: "rendered",
							compatibilityWarnings: [],
							sourceHash: "hash",
							variants: {
								default: { text: oversizedText },
								tight: { text: "A" },
							},
						},
					],
				}),
			),
		);
		harness.child.emit("close", 0, null);
		const result = await pending;

		// Assert
		expect(result).toMatchObject({
			results: [{ diagnosticCode: "output_limit_exceeded" }],
		});
	});

	/** Rejects work before spawning when its signal is already aborted. */
	test("does not spawn for an already-aborted operation", async () => {
		// Arrange
		const harness = createHarness();
		const controller = new AbortController();
		controller.abort();
		let spawnCalls = 0;
		const client = createMermaidRenderClient({
			...harness.dependencies,
			spawnWorker: () => {
				spawnCalls += 1;
				return harness.child;
			},
		});

		// Act
		const result = await client.render([createBlock()], controller.signal);

		// Assert
		expect(spawnCalls).toBe(0);
		expect(result).toEqual({ status: "aborted" });
	});

	/** Terminates active children when the extension session shuts down. */
	test("disposes active rendering as an aborted operation", async () => {
		// Arrange
		const harness = createHarness();
		const client = createMermaidRenderClient(harness.dependencies);

		// Act
		const pending = client.render([createBlock()]);
		client.dispose();
		const result = await pending;

		// Assert
		expect(harness.child.killSignals).toEqual(["SIGKILL"]);
		expect(result).toEqual({ status: "aborted" });
	});
});
