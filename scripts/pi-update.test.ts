import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createTempDir } from "../test/support/temp-dir.ts";

const PI_PACKAGES = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
] as const;

// Purpose: pi-update must synchronize the development and published-package Pi versions.
// Inputs: a temporary repository at 0.87.0, PI_VERSION=0.87.1, and fake package-manager commands.
// Expected: both manifests contain exact 0.87.1 versions and nested Bun uses peer dependency mode.
// Edges: all four Pi packages are updated together and a repeated invocation produces the same result.
// Dependencies: the Makefile target and the shared temporary-directory helper only.
test("pi-update synchronizes root and published-package Pi dependencies", () => {
	const fixture = createTempDir("pi-update-");
	try {
		const bin = join(fixture.path, "bin");
		const packageDirectory = join(fixture.path, "pi-package");
		const piBin = join(fixture.path, "node_modules", ".bin");
		mkdirSync(bin, { recursive: true });
		mkdirSync(packageDirectory, { recursive: true });
		mkdirSync(piBin, { recursive: true });
		copyFileSync(resolve("Makefile"), join(fixture.path, "Makefile"));

		const dependencies = Object.fromEntries(
			PI_PACKAGES.map((name) => [name, "0.87.0"]),
		);
		writeFileSync(
			join(fixture.path, "package.json"),
			JSON.stringify({ version: "0.0.0", devDependencies: dependencies }),
		);
		writeFileSync(
			join(packageDirectory, "package.json"),
			JSON.stringify({
				version: "1.0.0",
				peerDependencies: { ...dependencies, typebox: "*" },
			}),
		);

		const commandLog = join(fixture.path, "commands.log");
		writeExecutable(
			join(bin, "npm"),
			`#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commandLog)}, args.join(" ") + " cwd=" + process.cwd() + "\\n");
if (args[0] === "view") {
  process.stdout.write(args[1].slice(args[1].lastIndexOf("@") + 1) + "\\n");
}
if (args[0] === "pkg" && args[1] === "set") {
  const manifestPath = path.join(process.cwd(), "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.peerDependencies ??= {};
  for (const assignment of args.slice(2)) {
    const separator = assignment.indexOf("=");
    const key = assignment.slice(0, separator).replace("peerDependencies.", "");
    manifest.peerDependencies[key] = assignment.slice(separator + 1);
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
}
`,
		);
		writeExecutable(
			join(bin, "bun"),
			`#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commandLog)}, "bun " + args.join(" ") + " cwd=" + process.cwd() + "\\n");
if (args[0] !== "add") process.exit(0);
const manifestPath = path.join(process.cwd(), "package.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const field = args.includes("--peer") ? "peerDependencies" : "devDependencies";
manifest[field] ??= {};
for (const value of args) {
  if (!value.startsWith("@earendil-works/")) continue;
  const separator = value.lastIndexOf("@");
  manifest[field][value.slice(0, separator)] = value.slice(separator + 1);
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest));
`,
		);
		writeExecutable(join(piBin, "pi"), "#!/bin/sh\nexit 0\n");

		for (let invocation = 0; invocation < 2; invocation += 1) {
			const result = spawnSync("make", ["pi-update", "PI_VERSION=0.87.1"], {
				cwd: fixture.path,
				env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}` },
				encoding: "utf8",
			});
			expect(result.status, result.stderr).toBe(0);
		}

		const rootManifest = readJson<{
			devDependencies: Record<string, string>;
		}>(join(fixture.path, "package.json"));
		const packageManifest = readJson<{
			peerDependencies: Record<string, string>;
		}>(join(packageDirectory, "package.json"));
		for (const name of PI_PACKAGES) {
			expect(rootManifest.devDependencies[name]).toBe("0.87.1");
			expect(packageManifest.peerDependencies[name]).toBe("0.87.1");
		}
		const commands = readFileSync(commandLog, "utf8");
		expect(commands.match(/pkg set peerDependencies\./g)).toHaveLength(2);
		expect(commands).toContain("bun install");
		expect(commands).toContain(
			`install --package-lock-only --ignore-scripts --legacy-peer-deps cwd=${packageDirectory}`,
		);
	} finally {
		fixture.remove();
	}
});

function writeExecutable(path: string, content: string): void {
	writeFileSync(path, content);
	chmodSync(path, 0o755);
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}
