import { describe, expect, test } from "bun:test";
import type {
	AssistantMessage,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createPathRecord } from "../../../test/support/skill-restoration-fixtures";
import { collectSkillCandidates } from "./selection";

/** Supplies deterministic read tool calls for candidate-selection fixtures. */
function createAssistant(
	calls: { id: string; path: string }[],
): AssistantMessage {
	return {
		role: "assistant",
		content: calls.map(({ id, path }) => ({
			type: "toolCall",
			id,
			name: "read",
			arguments: { path },
		})),
		api: "openai-completions",
		provider: "fake",
		model: "fake",
		stopReason: "toolUse",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/** Supplies successful and failed read results independently from their calls. */
function createReadResult(id: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: "fixture data" }],
		isError,
		timestamp: 2,
	};
}

describe("skill candidate selection", () => {
	test("retains previously tracked paths when a missing skill disappears from the current catalog", () => {
		const session = SessionManager.inMemory("/project");
		session.appendMessage(
			createAssistant([{ id: "unlisted", path: "/unlisted/SKILL.md" }]),
		);
		session.appendMessage(createReadResult("unlisted"));
		const previous = createPathRecord([
			"/skills/a/SKILL.md",
			"/skills/a/asset.md",
		]);
		expect(
			collectSkillCandidates({
				branch: session.getBranch(),
				firstKeptEntryId: null,
				roots: [],
				cwd: "/project",
				previous,
			}),
		).toEqual(["/skills/a/SKILL.md", "/skills/a/asset.md"]);
	});
	test("uses a replaced call location and excludes an omitted successful result independently of suffix loads", () => {
		const session = SessionManager.inMemory("/project");
		const edited = session.appendMessage(
			createAssistant([{ id: "edited", path: "/skills/a/original" }]),
		);
		session.appendMessage(createReadResult("edited"));
		session.appendContextEdit(edited, {
			content: [
				{
					type: "toolCall",
					id: "edited",
					name: "read",
					arguments: { path: "/skills/a/replacement" },
				},
			],
		});
		session.appendMessage(
			createAssistant([
				{ id: "removed-result", path: "/skills/a/removed-result" },
			]),
		);
		const omitted = session.appendMessage(createReadResult("removed-result"));
		session.appendContextEdit(omitted, null);
		expect(
			collectSkillCandidates({
				branch: session.getBranch(),
				firstKeptEntryId: null,
				roots: ["/skills/a"],
				cwd: "/project",
				previous: undefined,
			}),
		).toEqual(["/skills/a/replacement"]);
	});
	test("uses effective successful loads, commands, ownership, suffix exclusion and recency", () => {
		const session = SessionManager.inMemory("/project");
		const old = session.appendMessage(
			createAssistant([{ id: "old", path: "/skills/a/old.md" }]),
		);
		session.appendMessage(createReadResult("old"));
		session.appendContextEdit(old, {
			content: [
				{
					type: "toolCall",
					id: "old",
					name: "read",
					arguments: { file_path: "@/skills/a/replaced.md" },
				},
			],
		});
		const omitted = session.appendMessage(
			createAssistant([{ id: "omit", path: "/skills/a/omit.md" }]),
		);
		session.appendMessage(createReadResult("omit"));
		session.appendContextEdit(omitted, null);
		session.appendMessage(
			createAssistant([
				{ id: "failed", path: "/skills/a/failed.md" },
				{ id: "outside", path: "/project/SKILL.md" },
				{ id: "pending", path: "/skills/a/pending.md" },
				{ id: "asset", path: "/skills/a/assets/..notes.md" },
			]),
		);
		session.appendMessage(createReadResult("failed", true));
		session.appendMessage(createReadResult("outside"));
		session.appendMessage(createReadResult("asset"));
		session.appendMessage({
			role: "user",
			content: '<skill name="a" location="/skills/a/SKILL.md">fixture</skill>',
			timestamp: 3,
		});
		const kept = session.appendMessage(
			createAssistant([{ id: "kept", path: "/skills/a/replaced.md" }]),
		);
		session.appendMessage(createReadResult("kept"));
		const paths = collectSkillCandidates({
			branch: session.getBranch(),
			firstKeptEntryId: kept,
			roots: ["/skills/a"],
			cwd: "/project",
			previous: createPathRecord([
				"/skills/a/previous.md",
				"/skills/a/absent.md",
			]),
		});
		expect(paths).toEqual([
			"/skills/a/SKILL.md",
			"/skills/a/assets/..notes.md",
			"/skills/a/previous.md",
			"/skills/a/absent.md",
		]);
	});

	test("keeps previous interleaved priority and promotes a newer successful load", () => {
		const session = SessionManager.inMemory("/project");
		session.appendMessage(
			createAssistant([{ id: "again", path: "/skills/a/third" }]),
		);
		session.appendMessage(createReadResult("again"));
		expect(
			collectSkillCandidates({
				branch: session.getBranch(),
				firstKeptEntryId: null,
				roots: ["/skills/a"],
				cwd: "/project",
				previous: createPathRecord([
					"/skills/a/first",
					"/skills/a/second",
					"/skills/a/third",
				]),
			}),
		).toEqual(["/skills/a/third", "/skills/a/first", "/skills/a/second"]);
	});
});
