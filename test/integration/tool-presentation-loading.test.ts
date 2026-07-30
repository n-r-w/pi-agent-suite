import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Writes independently loaded producer and consumer extensions for the presentation registry. */
function writePresentationExtensions(
	directory: string,
	registryPath: string,
): { readonly consumer: string; readonly producer: string } {
	const producer = join(directory, "presentation-producer.ts");
	const consumer = join(directory, "presentation-consumer.ts");
	const registrySpecifier = JSON.stringify(registryPath);
	writeFileSync(
		producer,
		[
			`import { registerPackageToolPresentation } from ${registrySpecifier};`,
			"",
			"// Defines the renderer references that must cross Pi extension isolation.",
			"const presentation = {",
			'\tname: "isolated_package_tool",',
			'\tlabel: "Isolated package tool",',
			'\trenderCall: () => ({ render: () => ["package call"], invalidate() {} }),',
			'\trenderResult: () => ({ render: () => ["package result"], invalidate() {} }),',
			"};",
			"",
			"/** Publishes one package presentation from its isolated extension module. */",
			"export default function presentationProducer(pi) {",
			"\tregisterPackageToolPresentation(pi, presentation);",
			"}",
		].join("\n"),
	);
	writeFileSync(
		consumer,
		[
			'import { writeFileSync } from "node:fs";',
			`import { getPackageToolPresentation } from ${registrySpecifier};`,
			"",
			"/** Resolves the producer presentation from another isolated extension module. */",
			"export default function presentationConsumer(pi) {",
			"\tconst output = process.env.PI_PRESENTATION_DUMP_FILE;",
			'\tif (output === undefined) throw new Error("PI_PRESENTATION_DUMP_FILE is required");',
			'\tconst presentation = getPackageToolPresentation(pi.events, "isolated_package_tool");',
			'\twriteFileSync(output, presentation === undefined ? "unknown" : "package");',
			"}",
		].join("\n"),
	);
	return { consumer, producer };
}

test("shares package tool presentations across Pi extension module isolation", () => {
	// Purpose: package tools must retain their exact renderers when producer and consumer extensions are loaded by separate Jiti instances.
	// Input and expected output: a producer publishes one presentation and a later consumer resolves it through Pi's shared event bus.
	// Edge case: both extensions import independent instances of the registry module because Pi disables Jiti's module cache.
	// Dependencies: the real Pi extension loader, offline mode, and isolated temporary files.
	const repositoryDir = process.cwd();
	const scratchDir = mkdtempSync(join(tmpdir(), "pi-tool-presentation-"));
	const agentDir = join(scratchDir, "agent");
	const outputFile = join(scratchDir, "presentation.txt");
	mkdirSync(agentDir, { recursive: true });
	const extensions = writePresentationExtensions(
		scratchDir,
		join(
			repositoryDir,
			"pi-package",
			"shared",
			"tool-presentation",
			"registry.ts",
		),
	);

	try {
		const result = spawnSync(
			"pi",
			[
				"--no-session",
				"--no-extensions",
				"--offline",
				"-p",
				"-e",
				extensions.producer,
				"-e",
				extensions.consumer,
			],
			{
				cwd: scratchDir,
				encoding: "utf8",
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: agentDir,
					PI_PRESENTATION_DUMP_FILE: outputFile,
				},
				timeout: 30_000,
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.signal).toBeNull();
		expect(result.status).toBe(0);
		expect(readFileSync(outputFile, "utf8")).toBe("package");
	} finally {
		rmSync(scratchDir, { recursive: true, force: true });
		expect(existsSync(scratchDir)).toBeFalse();
	}
});
