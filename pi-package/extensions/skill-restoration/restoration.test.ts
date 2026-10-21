import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { createPersistedSession } from "../../../test/support/persisted-session";
import { createPathRecord } from "../../../test/support/skill-restoration-fixtures";
import { createTempDir } from "../../../test/support/temp-dir";
import { estimateSerializedInputTokens } from "../../shared/context-size";
import {
	findBranchRestoration,
	insertRestoration,
	parseRestorationRecord,
	RESTORATION_TYPE,
} from "./restoration";

describe("restoration budgeting and replay", () => {
	for (const field of ["content", "sections", "tools"]) {
		test(`includes native system ${field} in complete-request fitting`, async () => {
			const temp = createTempDir("skill-system-field-");
			try {
				const path = join(temp.path, "skill.md");
				writeFileSync(path, "file ".repeat(2000));
				const data = "preserved ".repeat(3000);
				const systemHead: SystemMessage = {
					role: "system",
					content: field === "content" ? data : "",
					timestamp: 1,
					...(field === "sections" ? { sections: { checkpoint: data } } : {}),
					...(field === "tools"
						? {
								toolsAdded: [
									{
										name: "lookup",
										description: data,
										parameters: { type: "object", properties: {} },
									},
								],
							}
						: {}),
				};
				const messages: AgentMessage[] = [
					{
						role: "compactionSummary",
						summary: "fixture",
						tokensBefore: 10,
						timestamp: 2,
					},
				];
				const base = estimateSerializedInputTokens({
					messages: convertToLlm([systemHead, ...messages]),
				});
				const limit = base + 1000;
				const result = await insertRestoration({
					record: createPathRecord([path]),
					messages,
					timestamp: 1,
					systemHead,
					contextWindow: limit + 200,
					reserveTokens: 100,
					keepRecentTokens: 100,
				});
				expect(
					estimateSerializedInputTokens({
						messages: convertToLlm([systemHead, ...result.messages]),
					}),
				).toBeLessThanOrEqual(limit);
				expect(result.delivery?.restoredPaths).toEqual([]);
				expect(result.delivery?.absentPaths).toEqual([path]);
			} finally {
				temp.remove();
			}
		});
	}
	test("fits whole files in full, partial and zero space while keeping missing paths tracked", async () => {
		const temp = createTempDir("skill-budget-");
		try {
			const paths = [
				join(temp.path, "large"),
				join(temp.path, "small"),
				join(temp.path, "missing"),
			] as const;
			writeFileSync(paths[0], "large ".repeat(1000));
			writeFileSync(paths[1], "small fixture data");
			const messages: AgentMessage[] = [
				{
					role: "compactionSummary",
					summary: "fixture summary",
					tokensBefore: 10,
					timestamp: 1,
				},
				{ role: "user", content: "retained", timestamp: 2 },
			];
			const tracked = createPathRecord([...paths]);
			const base = {
				record: tracked,
				messages,
				timestamp: 1,
				systemHead: {
					role: "system" as const,
					content: "system fixture ".repeat(30),
					timestamp: 1,
					toolsAdded: [
						{
							name: "read",
							description: "fixture tool",
							parameters: {
								type: "object" as const,
								properties: { path: { type: "string" } },
							},
						},
					],
				},
				reserveTokens: 100,
				keepRecentTokens: 100,
			};
			const partial = await insertRestoration({ ...base, contextWindow: 900 });
			expect(partial.delivery?.restoredPaths).toEqual([paths[1]]);
			expect(partial.delivery?.absentPaths).toEqual([paths[0]]);
			expect(tracked.candidates).toEqual(paths);
			expect(
				estimateSerializedInputTokens({
					messages: convertToLlm([base.systemHead, ...partial.messages]),
				}),
			).toBeLessThanOrEqual(700);
			const all = await insertRestoration({ ...base, contextWindow: 10000 });
			expect(all.delivery?.restoredPaths).toEqual(paths.slice(0, 2));
			expect(all.delivery?.absentPaths).toEqual([]);
			const none = await insertRestoration({ ...base, contextWindow: 1 });
			expect(none.delivery?.restoredPaths).toEqual([]);
			expect(none.delivery?.absentPaths).toEqual(paths.slice(0, 2));
			expect(none.messages.map((message) => message.role)).toEqual([
				"compactionSummary",
				"custom",
				"user",
			]);
			const blocked = await insertRestoration({
				...base,
				messages: [],
				contextWindow: 10000,
			});
			expect(blocked.messages).toEqual([]);
			expect(blocked.delivery).toBeUndefined();
		} finally {
			temp.remove();
		}
	});

	test("selects the latest equal-summary compaction and validates reopened branch records", () => {
		const temp = createTempDir("skill-replay-");
		try {
			const session = createPersistedSession(temp.path);
			const first = session.appendCompaction("identical", null, 10);
			const firstRecord = {
				...createPathRecord(["/skills/a/first", "/skills/a/absent"]),
				compactionId: first,
			};
			const firstLeaf = session.appendCustomEntry(
				RESTORATION_TYPE,
				firstRecord,
			);
			const second = session.appendCompaction("identical", null, 10);
			const secondRecord = {
				...createPathRecord(["/skills/a/second"]),
				compactionId: second,
			};
			session.appendCustomEntry(RESTORATION_TYPE, secondRecord);
			const file = session.getSessionFile();
			if (!file) {
				throw new Error("fixture session was not persisted");
			}
			const reopened = SessionManager.open(file);
			expect(findBranchRestoration(reopened.getBranch())?.record).toEqual(
				secondRecord,
			);
			reopened.branch(firstLeaf);
			expect(findBranchRestoration(reopened.getBranch())?.record).toEqual(
				firstRecord,
			);
			session.appendCustomEntry(RESTORATION_TYPE, {
				...secondRecord,
				candidates: ["relative"],
			});
			expect(
				findBranchRestoration(session.getBranch())?.record,
			).toBeUndefined();
		} finally {
			temp.remove();
		}
	});

	test("rejects malformed and content-bearing persisted data at the boundary", () => {
		const valid = createPathRecord(["/skills/a/first", "/skills/a/absent"]);
		expect(parseRestorationRecord(valid)).toEqual(valid);
		for (const invalid of [
			null,
			{},
			[],
			{ ...valid, compactionId: "" },
			{ ...valid, compactionId: 1 },
			{ ...valid, files: [] },
			{ ...valid, content: "fixture" },
			{ ...valid, candidates: ["relative"] },
			{ ...valid, candidates: [...valid.candidates, valid.candidates[0]] },
			{ ...valid, candidates: [1] },
			{ ...valid, candidates: null },
		]) {
			expect(parseRestorationRecord(invalid)).toBeUndefined();
		}
	});
});
