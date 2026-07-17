import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createMermaidRenderClient } from "../../pi-package/extensions/mermaid/render-client.js";

/** Production worker resolved from the packaged extension source tree. */
const WORKER_PATH = fileURLToPath(
	new URL(
		"../../pi-package/extensions/mermaid/render-worker.js",
		import.meta.url,
	),
);
/** Node timeout that stays above the worker's own production limit. */
const PROCESS_TIMEOUT_MS = 7_000;
/** Bound integration output independently from the production client. */
const PROCESS_OUTPUT_LIMIT = 1_300_000;
/** Small valid diagrams covering every supported renderer family. */
const FAMILY_SOURCES = [
	"flowchart TD\nA --> B",
	"stateDiagram-v2\n[*] --> Idle\nIdle --> [*]",
	"sequenceDiagram\nAlice->>Bob: Hello",
	"classDiagram\nclass Animal\nAnimal : +name",
	"erDiagram\nCUSTOMER ||--o{ ORDER : places",
	'xychart-beta\nx-axis [Jan, Feb]\ny-axis "Sales" 0 --> 10\nbar [5, 8]',
];

/** Narrows JSON objects returned by the real worker process. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolves the Node executable required by production-worker integration tests. */
function requireNodeExecutable(): string {
	const executable = Bun.which("node");
	if (executable === null) {
		throw new Error(
			"Node executable is required for the Mermaid worker integration test",
		);
	}
	return executable;
}

/** Reads the result array after validating the integration protocol envelope. */
function parseResults(payload: string): Record<string, unknown>[] {
	const parsed: unknown = JSON.parse(payload);
	if (!isRecord(parsed) || !Array.isArray(parsed["results"])) {
		throw new Error("worker response does not contain a results array");
	}
	const results = parsed["results"];
	if (!results.every(isRecord)) {
		throw new Error("worker response contains a non-object result");
	}
	return results;
}

/** Starts one production-equivalent Node worker for an allowed block batch. */
function renderBatch(
	nodeExecutable: string,
	sources: readonly string[],
): Record<string, unknown>[] {
	const request = {
		blocks: sources.map((source, index) => ({
			source,
			sourceHash: `hash-${index}`,
		})),
	};
	const processResult = spawnSync(nodeExecutable, [WORKER_PATH], {
		encoding: "utf8",
		input: JSON.stringify(request),
		maxBuffer: PROCESS_OUTPUT_LIMIT,
		timeout: PROCESS_TIMEOUT_MS,
	});
	expect(processResult.error).toBeUndefined();
	expect(processResult.status).toBe(0);
	return parseResults(processResult.stdout);
}

/** Proves Node package loading and non-empty output for every supported family. */
test("Mermaid worker renders every supported diagram family", () => {
	// Arrange
	const nodeExecutable = requireNodeExecutable();

	// Act
	const results = renderBatch(nodeExecutable, FAMILY_SOURCES);

	// Assert
	expect(results).toHaveLength(FAMILY_SOURCES.length);
	for (const result of results) {
		expect(result["status"]).toBe("rendered");
		const variants = result["variants"];
		expect(isRecord(variants)).toBe(true);
		if (!isRecord(variants)) {
			continue;
		}
		for (const variantName of ["default", "tight"] as const) {
			const variant = variants[variantName];
			expect(isRecord(variant)).toBe(true);
			if (isRecord(variant)) {
				expect(typeof variant["text"]).toBe("string");
				expect((variant["text"] as string).length).toBeGreaterThan(0);
			}
		}
	}
});

/** Uses the pinned parser to classify structural defects without label false positives. */
test("Mermaid worker reports structural compatibility warnings", () => {
	// Arrange
	const nodeExecutable = requireNodeExecutable();
	const cases = [
		{
			source: "flowchart TD\nA[User's task] --o B",
			warnings: ["circle_edge_omission"],
		},
		{
			source: "flowchart TD\nA --x 1B",
			warnings: ["cross_edge_omission"],
		},
		{
			source: "flowchart TD\nA--o --> B",
			warnings: [],
		},
		{
			source: "flowchart TD\nA--x --> B",
			warnings: [],
		},
		{
			source: "flowchart TD\nsubgraph ONE[One]\nONE --> X\nend",
			warnings: [],
		},
		{
			source: "flowchart TD\nsubgraph ONE[One]\nX\nend\nONE --o B",
			warnings: ["circle_edge_omission", "subgraph_endpoint_phantom_node"],
		},
		{
			source: "flowchart TD\nsubgraph ONE[One]\nX\nend\nONE --x B",
			warnings: ["cross_edge_omission", "subgraph_endpoint_phantom_node"],
		},
		{
			source: "flowchart TD\nsubgraph ONE[One]\nX\nend\nA --o ONE",
			warnings: ["circle_edge_omission"],
		},
		{
			source: "flowchart TD\nsubgraph ONE[One]\nX\nend\nA --x ONE",
			warnings: ["cross_edge_omission"],
		},
		{
			source:
				"flowchart TD\nsubgraph OUTER[Outer]\nsubgraph INNER[Inner]\nX\nend\nend\nINNER --o B",
			warnings: ["circle_edge_omission", "subgraph_endpoint_phantom_node"],
		},
		{
			source: "flowchart TD\nsubgraph ONE[One]\nX\nend\nA & ONE --> B",
			warnings: ["subgraph_endpoint_phantom_node"],
		},
		{
			source: "flowchart TD\nsubgraph ONE[One]\nX\nend\nA --> B & ONE",
			warnings: ["subgraph_endpoint_phantom_node"],
		},
		{
			source: "flowchart TD\nsubgraph My Group\nX\nend\nMy_Group --> B",
			warnings: ["subgraph_endpoint_phantom_node"],
		},
		{
			source: "flowchart TD\nA -->|text --o B| C",
			warnings: [],
		},
		{
			source: "flowchart TD\nA -- --x B --> C",
			warnings: [],
		},
		{
			source: "flowchart TD\nA>label --o B] --> C",
			warnings: [],
		},
		{
			source: "flowchart TD\nsubgraph My Group\nX\nend\nMy --> B",
			warnings: [],
		},
	];

	// Act
	const results = renderBatch(
		nodeExecutable,
		cases.map(({ source }) => source),
	);

	// Assert
	expect(results).toHaveLength(cases.length);
	for (const [index, result] of results.entries()) {
		expect(result["status"]).toBe("rendered");
		expect(result["compatibilityWarnings"]).toEqual(cases[index]?.warnings);
	}
});

/** Confirms the pinned renderer handles HTML line-break labels without literals. */
test("Mermaid worker renders HTML line breaks", () => {
	// Arrange
	const nodeExecutable = requireNodeExecutable();

	// Act
	const [result] = renderBatch(nodeExecutable, [
		"flowchart TD\nA[Hello<br>World] --> B[Again<br/>Here]",
	]);
	const output = JSON.stringify(result);

	// Assert
	expect(result).toMatchObject({ status: "rendered" });
	expect(output).toContain("Hello");
	expect(output).toContain("World");
	expect(output).not.toContain("<br");
});

/** Maps dependency-produced blank output to finite render failures. */
test("Mermaid worker rejects empty rendered variants", () => {
	// Arrange
	const nodeExecutable = requireNodeExecutable();
	const malformedSources = [
		"sequenceDiagram\nAlice->>",
		"classDiagram\nclass",
		"erDiagram\nCUSTOMER ||--",
		"xychart-beta\nbar",
	];

	// Act
	const results = renderBatch(nodeExecutable, malformedSources);

	// Assert
	expect(results).toHaveLength(malformedSources.length);
	for (const result of results) {
		expect(result).toMatchObject({
			status: "failed",
			diagnosticCode: "render_failed",
		});
	}
});

/** Exercises the production launcher under the current Bun test runtime. */
test("Mermaid client launches the worker through Bun", async () => {
	// Arrange
	const client = createMermaidRenderClient();

	// Act
	const result = await client.render([
		{
			diagramType: "flowchart",
			source: "flowchart TD\nA --> B",
			sourceHash: "bun-runtime-hash",
		},
	]);

	// Assert
	expect(result).toMatchObject({
		status: "completed",
		results: [{ status: "rendered", sourceHash: "bun-runtime-hash" }],
	});
});

/** Preserves one UTF-8 label when its bytes cross standard-input chunks. */
test("Mermaid worker decodes split UTF-8 input", async () => {
	// Arrange
	const nodeExecutable = requireNodeExecutable();
	const request = Buffer.from(
		JSON.stringify({
			blocks: [
				{
					source: 'flowchart TD\nA["Launch 🚀"] --> B',
					sourceHash: "utf8-hash",
				},
			],
		}),
	);
	const emojiBytes = Buffer.from("🚀");
	const emojiOffset = request.indexOf(emojiBytes);
	if (emojiOffset === -1) {
		throw new Error("UTF-8 test request does not contain its emoji bytes");
	}

	// Act
	const child = spawn(nodeExecutable, [WORKER_PATH], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	const stdoutChunks: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
	const completion = new Promise<number | null>((resolve) => {
		child.once("close", resolve);
	});
	await new Promise<void>((resolve, reject) => {
		child.stdin.write(request.subarray(0, emojiOffset + 1), (error) => {
			if (error === null || error === undefined) {
				resolve();
				return;
			}
			reject(error);
		});
	});
	await Bun.sleep(25);
	child.stdin.end(request.subarray(emojiOffset + 1));
	const exitCode = await completion;
	const output = Buffer.concat(stdoutChunks).toString("utf8");

	// Assert
	expect(exitCode).toBe(0);
	expect(output).toContain("🚀");
	expect(output).not.toContain("�");
});
