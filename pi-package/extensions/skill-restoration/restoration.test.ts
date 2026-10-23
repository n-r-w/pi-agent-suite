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
	insertSelection,
	parseRestorationRecord,
	parseSelectionRecord,
	RESTORATION_TYPE,
	type RestorationSelection,
	SELECTION_TYPE,
	selectRestoration,
} from "./restoration";

/** Supplies a summary-bearing request without retained messages. */
const SUMMARY: AgentMessage = {
	role: "compactionSummary",
	summary: "fixture summary",
	tokensBefore: 10,
	timestamp: 1,
};

/** Returns a selection or fails the test when the request had no summary. */
function requireSelection(
	selection: RestorationSelection | undefined,
): RestorationSelection {
	if (!selection) {
		throw new Error("fixture request produced no selection");
	}
	return selection;
}

describe("restoration selection, insertion and replay", () => {
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
				const messages = [SUMMARY];
				const base = estimateSerializedInputTokens({
					messages: convertToLlm([systemHead, ...messages]),
				});
				const limit = base + 1000;
				const selection = await selectRestoration({
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
						messages: convertToLlm([
							systemHead,
							...insertSelection(messages, requireSelection(selection), 1),
						]),
					}),
				).toBeLessThanOrEqual(limit);
				expect(selection?.files).toEqual([]);
				expect(selection?.absent).toEqual([path]);
			} finally {
				temp.remove();
			}
		});
	}

	test("selects whole files in full, partial and zero space and skips missing files", async () => {
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
				SUMMARY,
				{ role: "user", content: "retained", timestamp: 2 },
			];
			const base = {
				record: createPathRecord([...paths]),
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
			const partial = await selectRestoration({ ...base, contextWindow: 900 });
			expect(partial?.files.map((file) => file.path)).toEqual([paths[1]]);
			expect(partial?.absent).toEqual([paths[0]]);
			expect(
				estimateSerializedInputTokens({
					messages: convertToLlm([
						base.systemHead,
						...insertSelection(messages, requireSelection(partial), 1),
					]),
				}),
			).toBeLessThanOrEqual(700);
			const all = await selectRestoration({ ...base, contextWindow: 10000 });
			expect(all?.files.map((file) => file.path)).toEqual(paths.slice(0, 2));
			expect(all?.absent).toEqual([]);
			const none = await selectRestoration({ ...base, contextWindow: 1 });
			expect(none?.files).toEqual([]);
			expect(none?.absent).toEqual(paths.slice(0, 2));
			expect(
				insertSelection(messages, requireSelection(none), 1).map(
					(message) => message.role,
				),
			).toEqual(["compactionSummary", "custom", "user"]);
			expect(
				await selectRestoration({
					...base,
					messages: [],
					contextWindow: 10000,
				}),
			).toBeUndefined();
		} finally {
			temp.remove();
		}
	});

	test("inserts every selected file after the latest summary whatever the request size", () => {
		const selection = {
			compactionId: "old",
			files: [{ path: "/skills/a/SKILL.md", content: "rules" }],
			absent: ["/skills/b/SKILL.md"],
		};
		const large: AgentMessage = {
			role: "user",
			content: "growth ".repeat(10000),
			timestamp: 3,
		};
		const inserted = insertSelection([SUMMARY, large], selection, 1);
		expect(inserted.map((message) => message.role)).toEqual([
			"compactionSummary",
			"custom",
			"user",
		]);
		expect(inserted[1]?.role === "custom" && inserted[1].details).toEqual({
			compactionId: "old",
			restoredPaths: ["/skills/a/SKILL.md"],
			absentPaths: ["/skills/b/SKILL.md"],
		});
		expect(insertSelection([large], selection, 1)).toEqual([large]);
		expect(
			insertSelection([SUMMARY], { ...selection, files: [], absent: [] }, 1),
		).toEqual([SUMMARY]);
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
			session.appendCustomEntry(RESTORATION_TYPE, firstRecord);
			const firstSelection = {
				compactionId: first,
				files: [{ path: "/skills/a/first", content: "first" }],
				absent: ["/skills/a/absent"],
			};
			const firstLeaf = session.appendCustomEntry(
				SELECTION_TYPE,
				firstSelection,
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
			expect(findBranchRestoration(reopened.getBranch())).toMatchObject({
				record: secondRecord,
				selection: undefined,
			});
			reopened.branch(firstLeaf);
			expect(findBranchRestoration(reopened.getBranch())).toMatchObject({
				record: firstRecord,
				selection: firstSelection,
			});
			session.appendCustomEntry(SELECTION_TYPE, {
				...firstSelection,
				compactionId: first,
			});
			expect(
				findBranchRestoration(session.getBranch())?.selection,
			).toBeUndefined();
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

	test("rejects malformed and content-bearing path records at the boundary", () => {
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

	test("rejects malformed selection records at the boundary", () => {
		const valid = {
			compactionId: "old",
			files: [{ path: "/skills/a/first", content: "" }],
			absent: ["/skills/a/absent"],
		};
		expect(parseSelectionRecord(valid)).toEqual(valid);
		for (const invalid of [
			null,
			[],
			{ ...valid, compactionId: "" },
			{ ...valid, extra: true },
			{ ...valid, files: null },
			{ ...valid, files: [{ path: "relative", content: "" }] },
			{ ...valid, files: [{ path: "/skills/a/first" }] },
			{ ...valid, files: [{ path: "/skills/a/first", content: 1 }] },
			{ ...valid, absent: ["relative"] },
			{ ...valid, absent: [...valid.absent, "/skills/a/first"] },
		]) {
			expect(parseSelectionRecord(invalid)).toBeUndefined();
		}
	});
});
