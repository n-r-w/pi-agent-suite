import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createTempDir } from "../../../test/support/temp-dir";

/** Recognizes a positive displayed token count without fixing the estimator result. */
const POSITIVE_TOKEN_COUNT = /~[1-9]\d* tokens/;

/** Runs the extension harness with only temporary state and child-local environment overrides. */
function runScenario(name: string): Record<string, unknown> {
	const temp = createTempDir("skill-extension-");
	try {
		const env = Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) => !key.startsWith("PI_SUBAGENT_"),
			),
		);
		const child = spawnSync(
			"bun",
			["run", "test/support/skill-restoration.ts", temp.path, name],
			{
				cwd: process.cwd(),
				env: {
					...env,
					PI_CODING_AGENT_DIR: join(temp.path, "agent"),
					PI_AGENT_SUITE_DIR: join(temp.path, "suite"),
				},
				encoding: "utf8",
				timeout: 30000,
			},
		);
		if (child.status !== 0) {
			throw new Error(child.stderr || child.error?.message || "harness failed");
		}
		return JSON.parse(child.stdout) as Record<string, unknown>;
	} finally {
		temp.remove();
	}
}

for (const mode of ["native", "custom"]) {
	test(`${mode} compaction tracks paths and inserts fitting files once after summary with expanded path rendering`, () => {
		const output = runScenario(mode);
		expect(output["records"]).toBe(1);
		expect(output["warnings"]).toBe(0);
		expect(output["roles"]).toEqual(["compactionSummary", "custom", "user"]);
		expect(output["stable"]).toBe(true);
		const record = output["firstRecord"] as { candidates: string[] };
		expect(record.candidates).toEqual([
			output["skill"] as string,
			output["asset"] as string,
		]);
		expect((output["beforeLines"] as string[]).join("\n")).toContain(
			"Tracking 2 skill files",
		);
		expect((output["compactLines"] as string[]).length).toBe(1);
		expect((output["expandedLines"] as string[]).join("\n")).toContain(
			output["skill"] as string,
		);
		expect((output["expandedLines"] as string[]).join("\n")).toContain(
			output["asset"] as string,
		);
	});
}

test("retained renderer components refresh counts and paths after requests and tree navigation", () => {
	const output = runScenario("renderer-live");
	const text = (name: string): string => (output[name] as string[]).join("\n");
	expect(text("beforeLines")).toContain("Tracking 2 skill files");
	expect(text("preparedLines")).toContain("Prepared 2 skill files");
	expect(text("preparedLines")).toContain("0 files did not fit");
	expect(text("preparedLines")).toMatch(POSITIVE_TOKEN_COUNT);
	expect(text("absentLines")).toContain("Prepared 0 skill files");
	expect(text("absentLines")).toContain("2 files did not fit");
	for (const path of [output["skill"], output["asset"]]) {
		expect(text("preparedPaths")).toContain(`Prepared: ${path}`);
		expect(text("absentPaths")).toContain(`Absent: ${path}`);
		expect(text("resetPaths")).toContain(`Tracked: ${path}`);
	}
	expect(text("resetLines")).toContain("Tracking 2 skill files");
});

test("invalid config disables and warns once across repeated callbacks", () => {
	const output = runScenario("invalid");
	expect(output["records"]).toBe(0);
	expect(output["warnings"]).toBe(1);
});

test("disabled config prevents persisted records and insertion", () => {
	const output = runScenario("disabled");
	expect(output["records"]).toBe(0);
	expect(output["warnings"]).toBe(0);
});

test("repeat compaction preserves absent candidates and priority despite an older event entry", () => {
	const output = runScenario("repeat");
	const first = output["firstRecord"] as { candidates: string[] };
	const latest = output["latest"] as {
		compactionId: string;
		candidates: string[];
	};
	expect(latest.compactionId).toBe(output["next"] as string);
	expect(latest.candidates).toEqual(first.candidates);
});

test("session reopen and tree switch replay branch-associated restoration", () => {
	const output = runScenario("replay");
	expect(output["record"]).toEqual(output["firstRecord"]);
	expect(output["replay"]).toHaveLength(1);
	expect(output["first"]).not.toBe(output["other"]);
});

test("malformed latest records insert nothing", () => {
	expect(runScenario("malformed")["inserted"]).toBe(0);
});

/** Describes request outcomes without exposing file text or model prompts. */
interface DeliverySnapshot {
	restoredPaths: string[];
	absentPaths: string[];
	requestTokens: number;
}

test("persists only ordered candidate paths", () => {
	const output = runScenario("changes");
	const records = output["records"] as Record<string, unknown>[];
	expect(records).toHaveLength(1);
	expect(Object.keys(records[0] ?? {}).sort()).toEqual([
		"candidates",
		"compactionId",
	]);
	expect(records[0]?.["candidates"]).toEqual([
		output["skill"],
		output["asset"],
	]);
});

test("rereads changed disk contents between requests and after reopening", () => {
	const output = runScenario("changes");
	const first = output["first"] as DeliverySnapshot;
	const changed = output["changed"] as DeliverySnapshot;
	expect(changed.requestTokens).toBeGreaterThan(first.requestTokens);
	expect(
		(output["reopened"] as DeliverySnapshot).requestTokens,
	).toBeGreaterThan(changed.requestTokens);
});

test("skips deleted files and restores them when they reappear without losing tracked paths", () => {
	const output = runScenario("changes");
	const deleted = output["deleted"] as DeliverySnapshot;
	expect(deleted.restoredPaths).toEqual([output["skill"] as string]);
	expect(deleted.absentPaths).toEqual([]);
	expect(output["reappeared"]).toEqual(output["reopened"]);
	const records = output["records"] as { candidates: string[] }[];
	expect(records[0]?.candidates).toEqual([
		output["skill"] as string,
		output["asset"] as string,
	]);
});

test("fits at the complete request estimator boundary and repacks below it", () => {
	const output = runScenario("budgets");
	const exact = output["exact"] as DeliverySnapshot;
	const below = output["below"] as DeliverySnapshot;
	expect(exact.restoredPaths).toHaveLength(2);
	expect(exact.requestTokens).toBe(output["fullTokens"] as number);
	expect(below.restoredPaths.length).toBeLessThan(exact.restoredPaths.length);
	expect(below.absentPaths.length).toBeGreaterThan(0);
});

test("larger runtime prompts and tools reduce the fitting subset and a larger model restores room", () => {
	const output = runScenario("budgets");
	const first = output["first"] as DeliverySnapshot;
	for (const name of ["largerPrompt", "largerTools"]) {
		expect(
			(output[name] as DeliverySnapshot).restoredPaths.length,
		).toBeLessThan(first.restoredPaths.length);
	}
	expect(
		(output["largerWindow"] as DeliverySnapshot).restoredPaths,
	).toHaveLength(2);
});

test("preserves interleaved returned and absent priority through reopening and repeated compaction", () => {
	const output = runScenario("interleaved");
	const first = output["first"] as DeliverySnapshot;
	const paths = output["paths"] as string[];
	expect(first.restoredPaths.slice(0, 2)).toEqual([
		paths[0] as string,
		paths[2] as string,
	]);
	expect(first.absentPaths).toEqual([paths[1] as string]);
	expect(output["reopened"]).toEqual(first);
	const firstRecord = output["firstRecord"] as { candidates: string[] };
	const latest = output["latest"] as {
		compactionId: string;
		candidates: string[];
	};
	expect(firstRecord.candidates).toEqual([
		...paths,
		output["skill"] as string,
		output["asset"] as string,
	]);
	expect(latest).toEqual({
		compactionId: output["next"] as string,
		candidates: firstRecord.candidates,
	});
	expect(output["repeated"]).toEqual(first);
});
