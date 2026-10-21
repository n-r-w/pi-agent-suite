import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createTempDir } from "../support/temp-dir";

/** Describes final provider estimates and structured restoration metadata. */
interface SystemOutcome {
	readonly limit: number;
	readonly skill: string;
	readonly beforeStarts: number;
	readonly compactions: string[];
	readonly snapshots: {
		readonly requestTokens: number;
		readonly withoutRestorationTokens: number;
		readonly headContentTokens: number;
		readonly headSectionCount: number;
		readonly headTools: string[];
		readonly nativeTools: string[];
		readonly headToolTokens: number;
		readonly nativeToolTokens: number;
		readonly records: {
			restoredPaths: string[];
			absentPaths: string[];
			compactionId: string;
		}[];
	}[];
}

/** Runs one lifecycle scenario with child-only environment isolation. */
function runScenario(mode: string): SystemOutcome {
	const temp = createTempDir("skill-system-lifecycle-");
	try {
		const env = {
			...Object.fromEntries(
				Object.entries(process.env).filter(
					([key]) => !key.startsWith("PI_SUBAGENT_"),
				),
			),
			PI_CODING_AGENT_DIR: join(temp.path, "agent"),
			PI_AGENT_SUITE_DIR: join(temp.path, "suite"),
		};
		const child = spawnSync(
			"bun",
			["run", "test/support/skill-restoration-system.ts", temp.path, mode],
			{ env, encoding: "utf8", timeout: 30000 },
		);
		if (child.status !== 0) {
			throw new Error(`${child.stdout}\n${child.stderr}`);
		}
		return JSON.parse(child.stdout) as SystemOutcome;
	} finally {
		temp.remove();
	}
}

test("restoration includes native content, sections, and tools in the final-provider request estimate", () => {
	const output = runScenario("native");
	expect(output.snapshots).toHaveLength(1);
	const snapshot = output.snapshots[0];
	expect(snapshot?.headContentTokens ?? 0).toBeGreaterThan(0);
	expect(snapshot?.headSectionCount ?? 0).toBeGreaterThan(0);
	expect(snapshot?.headTools ?? []).toContain("read");
	expect(snapshot?.headTools).toEqual(snapshot?.nativeTools);
	expect(snapshot?.headToolTokens).toBe(snapshot?.nativeToolTokens);
	expect(snapshot?.withoutRestorationTokens ?? Infinity).toBeLessThan(
		output.limit,
	);
	expect(snapshot?.requestTokens ?? Infinity).toBeLessThanOrEqual(output.limit);
	expect(snapshot?.records[0]?.restoredPaths).toEqual([]);
	expect(snapshot?.records[0]?.absentPaths).toEqual([output.skill]);
});

for (const mode of ["later", "empty"]) {
	test(`restoration fits a file using a later handler's forced prompt (${mode})`, () => {
		const output = runScenario(mode);
		expect(output.beforeStarts).toBe(1);
		expect(output.snapshots).toHaveLength(1);
		const snapshot = output.snapshots[0];
		expect(snapshot?.requestTokens ?? Infinity).toBeLessThanOrEqual(
			output.limit,
		);
		expect(snapshot?.headSectionCount).toBe(0);
		expect(snapshot?.headTools).toEqual(snapshot?.nativeTools);
		expect(snapshot?.headToolTokens).toBe(snapshot?.nativeToolTokens);
		expect(snapshot?.records[0]?.restoredPaths).toEqual([output.skill]);
		expect(snapshot?.records[0]?.absentPaths).toEqual([]);
		if (mode === "empty") {
			expect(snapshot?.headContentTokens).toBe(0);
		}
	});
}

test("a new run uses native fitting after an earlier run's forced prompt", () => {
	const output = runScenario("replace");
	expect(output.beforeStarts).toBe(2);
	expect(output.snapshots).toHaveLength(2);
	expect(output.snapshots[0]?.records[0]?.restoredPaths).toEqual([
		output.skill,
	]);
	expect(output.snapshots[1]?.records[0]?.restoredPaths).toEqual([]);
	for (const snapshot of output.snapshots) {
		expect(snapshot.requestTokens).toBeLessThanOrEqual(output.limit);
		expect(snapshot.headTools).toEqual(snapshot.nativeTools);
		expect(snapshot.headToolTokens).toBe(snapshot.nativeToolTokens);
	}
});

test("overflow compaction retains forced-head fitting through continuation in the same run", () => {
	const output = runScenario("auto");
	expect(output.beforeStarts).toBe(1);
	expect(output.compactions).toEqual(["overflow"]);
	expect(output.snapshots).toHaveLength(2);
	for (const snapshot of output.snapshots) {
		expect(snapshot.requestTokens).toBeLessThanOrEqual(output.limit);
		expect(snapshot.headTools).toEqual(snapshot.nativeTools);
		expect(snapshot.headToolTokens).toBe(snapshot.nativeToolTokens);
		expect(snapshot.records[0]?.restoredPaths).toEqual([output.skill]);
	}
	expect(output.snapshots[0]?.records[0]?.compactionId).not.toBe(
		output.snapshots[1]?.records[0]?.compactionId,
	);
});
