import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { env as processEnv } from "node:process";
import { createTempDir } from "../test/support/temp-dir.ts";

type Scenario = "SCN-02" | "SCN-03";
const root = resolve(import.meta.dir, "..");
const auditArgs = ["audit", "--omit=dev", "--audit-level=low", "--json"];
const PI_EXTENSION_ERROR =
	/Failed to load extension|Extension error|Error loading extension/i;
const MAX_COMMAND_OUTPUT = 10_485_760;

function report(message: string): void {
	process.stdout.write(`${message}\n`);
}

function command(
	executable: string,
	args: readonly string[],
	cwd: string,
	options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {},
): { status: number; stdout: string; stderr: string } {
	const result = spawnSync(executable, args, {
		cwd,
		env: options.env,
		encoding: "utf8",
		timeout: 180_000,
		maxBuffer: MAX_COMMAND_OUTPUT,
	});
	if (
		result.error ||
		result.status === null ||
		(!options.allowFailure && result.status !== 0)
	) {
		throw new Error(
			`${executable} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
			{
				cause: result.error,
			},
		);
	}
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

function readJson(path: string) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function buildCandidate(scratch: string): string {
	const staging = join(scratch, "package");
	mkdirSync(staging);
	const packageDir = join(root, "pi-package");
	const manifest = readJson(join(packageDir, "package.json"));
	for (const entry of manifest.files as string[]) {
		cpSync(
			join(entry === "README.md" ? root : packageDir, entry),
			join(staging, entry),
			{ recursive: true },
		);
	}
	command("npm", ["pack", "--pack-destination", scratch], staging);
	const archive = readdirSync(scratch).find((name) => name.endsWith(".tgz"));
	if (!archive) {
		throw new Error("npm pack produced no archive");
	}
	return join(scratch, archive);
}

function prepareBaseline(consumer: string): void {
	for (const file of ["package.json", "package-lock.json"]) {
		cpSync(
			join(root, "test/fixtures/mcp-upgrade-consumer", file),
			join(consumer, file),
		);
	}
	command("npm", ["ci", "--legacy-peer-deps"], consumer);
	const installed = readJson(join(consumer, "node_modules/qs/package.json"));
	const lock = readJson(join(consumer, "package-lock.json"));
	if (
		installed.version !== "6.15.3" ||
		lock.packages["node_modules/qs"].version !== "6.15.3"
	) {
		throw new Error("Upgrade baseline must install and lock qs@6.15.3");
	}
	const result = command("npm", auditArgs, consumer, { allowFailure: true });
	const audit = JSON.parse(result.stdout);
	if (
		result.status !== 1 ||
		!audit.vulnerabilities?.qs?.via?.some(
			(via: { url?: string } | string) =>
				typeof via !== "string" &&
				(via.url?.endsWith("GHSA-x5fp-wj9c-mxmx") ||
					via.url?.endsWith("GHSA-4mjr-xmp4-gh2g")),
		)
	) {
		throw new Error(
			`Baseline did not reproduce the reported qs advisory\n${result.stdout}`,
		);
	}
	report(
		`SCN-03 baseline: qs@6.15.3 installed and locked; audit exit ${result.status}`,
	);
	report(JSON.stringify(audit.metadata.vulnerabilities));
}

function loadPackage(consumer: string, scratch: string): void {
	const agentDir = join(scratch, "agent");
	const project = join(scratch, "project");
	mkdirSync(agentDir);
	mkdirSync(project);
	writeFileSync(join(agentDir, "settings.json"), "{}");
	const env = { ...processEnv };
	for (const name of Object.keys(env)) {
		if (name.startsWith("PI_")) {
			delete env[name];
		}
	}
	env["PI_CODING_AGENT_DIR"] = agentDir;
	env["PI_AGENT_SUITE_DIR"] = join(agentDir, "agent-suite");
	const result = command(
		"node",
		[
			join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
			"--no-session",
			"--no-extensions",
			"--offline",
			"-p",
			"-e",
			join(consumer, "node_modules/pi-agent-suite"),
		],
		project,
		{ env },
	);
	if (PI_EXTENSION_ERROR.test(`${result.stdout}\n${result.stderr}`)) {
		throw new Error(
			`Pi package loading failed\n${result.stdout}\n${result.stderr}`,
		);
	}
}

export function checkConsumer(scenario: Scenario, candidate?: string): void {
	const scratch = createTempDir("pi-release-consumer-");
	try {
		const archive = candidate ?? buildCandidate(scratch.path);
		const consumer = join(scratch.path, "consumer");
		mkdirSync(consumer);
		if (scenario === "SCN-03") {
			prepareBaseline(consumer);
		} else {
			writeFileSync(
				join(consumer, "package.json"),
				JSON.stringify({
					name: "mcp-clean-consumer",
					version: "1.0.0",
					private: true,
				}),
			);
		}
		// Same npm peer policy as Pi's getNpmInstallArgs. No repair between these steps.
		command(
			"npm",
			["install", archive, "--prefix", consumer, "--legacy-peer-deps"],
			consumer,
		);
		const audit = command("npm", auditArgs, consumer);
		report(
			`${scenario}: installation passed; production audit exit ${audit.status}`,
		);
		report(JSON.stringify(JSON.parse(audit.stdout).metadata.vulnerabilities));
		const lock = readJson(join(consumer, "package-lock.json"));
		for (const name of [
			"@modelcontextprotocol/sdk",
			"express",
			"body-parser",
			"qs",
		]) {
			if (
				Object.keys(lock.packages).some((path) =>
					path.endsWith(`node_modules/${name}`),
				)
			) {
				throw new Error(
					`Candidate mandatory dependency tree still contains ${name}`,
				);
			}
		}
		loadPackage(consumer, scratch.path);
		report(
			`${scenario}: Pi offline package loading passed; v1 server dependency chain absent`,
		);
	} catch (error) {
		throw new Error(`${scenario} consumer check failed`, { cause: error });
	} finally {
		scratch.remove();
	}
}

if (import.meta.main) {
	const scenario = process.argv[2];
	if (scenario === undefined) {
		checkConsumer("SCN-02");
		checkConsumer("SCN-03");
	} else if (scenario === "SCN-02" || scenario === "SCN-03") {
		checkConsumer(scenario);
	} else {
		throw new Error(`Unknown consumer scenario: ${scenario}`);
	}
}
