import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { estimateSerializedInputTokens } from "../../pi-package/shared/context-size";
import type { RestorationHarness } from "./skill-restoration-harness";

/** Controls text growth in disk, prompt, and tool fixtures. */
const CHANGED_REPEATS = 1000;
/** Controls file size to force a partial fit in priority replay fixtures. */
const LARGE_REPEATS = 10000;

/** Captures path and token outcomes while excluding model-message text. */
function captureRequest(
	harness: RestorationHarness,
	messages: AgentMessage[],
): Record<string, unknown> {
	const inserted = messages.find(
		(message) =>
			message.role === "custom" && message.customType === "skill-restoration",
	);
	const details =
		inserted?.role === "custom"
			? (inserted.details as Record<string, unknown>)
			: undefined;
	const head = getCurrentSystemMessage(
		harness.session.buildSessionProjection().messages,
	);
	return {
		restoredPaths: details?.["restoredPaths"] ?? [],
		absentPaths: details?.["absentPaths"] ?? [],
		requestTokens: estimateSerializedInputTokens({
			messages: convertToLlm(head ? [head, ...messages] : messages),
		}),
	};
}

/** Exercises disk changes, reopen and temporary deletion without comparing prompt text. */
async function changingFiles(harness: RestorationHarness): Promise<unknown> {
	const first = captureRequest(harness, await harness.prepareContext());
	const changedContent = "changed ".repeat(CHANGED_REPEATS);
	writeFileSync(harness.asset, changedContent);
	const changed = captureRequest(harness, await harness.prepareContext());
	harness.reopen();
	await harness.emit("session_start");
	const reopenedContent = changedContent.repeat(2);
	writeFileSync(harness.asset, reopenedContent);
	const reopened = captureRequest(harness, await harness.prepareContext());
	unlinkSync(harness.asset);
	const deleted = captureRequest(harness, await harness.prepareContext());
	writeFileSync(harness.asset, reopenedContent);
	const reappeared = captureRequest(harness, await harness.prepareContext());
	return {
		first,
		changed,
		reopened,
		deleted,
		reappeared,
		records: harness.getRecords().map((entry) => entry.data),
		skill: harness.skill,
		asset: harness.asset,
	};
}

/** Exercises exact whole-request boundaries and changing runtime prompt/tool/model inputs. */
async function changingBudget(harness: RestorationHarness): Promise<unknown> {
	const first = captureRequest(harness, await harness.prepareContext());
	const fullTokens = first["requestTokens"] as number;
	const headroom = 200;
	Object.assign(harness.ctx.model ?? {}, {
		contextWindow: fullTokens + headroom,
	});
	const exact = captureRequest(harness, await harness.prepareContext());
	Object.assign(harness.ctx.model ?? {}, {
		contextWindow: fullTokens + headroom - 1,
	});
	const below = captureRequest(harness, await harness.prepareContext());
	Object.assign(harness.ctx.model ?? {}, {
		contextWindow: fullTokens + headroom,
	});
	Object.assign(harness.ctx, {
		getSystemPrompt: () => "runtime ".repeat(CHANGED_REPEATS),
	});
	const largerPrompt = captureRequest(harness, await harness.prepareContext());
	Object.assign(harness.ctx, { getSystemPrompt: () => "system fixture" });
	Object.assign(harness.pi, {
		getAllTools: () => [
			{
				name: "read",
				description: "tool data ".repeat(CHANGED_REPEATS),
				parameters: { type: "object", properties: {} },
			},
		],
	});
	const largerTools = captureRequest(harness, await harness.prepareContext());
	Object.assign(harness.ctx.model ?? {}, { contextWindow: 10000 });
	const largerWindow = captureRequest(harness, await harness.prepareContext());
	return {
		first,
		exact,
		below,
		largerPrompt,
		largerTools,
		largerWindow,
		fullTokens,
	};
}

/** Exercises persisted interleaved priority across reopening and another equal-summary compaction. */
async function interleaved(harness: RestorationHarness): Promise<unknown> {
	const dir = join(harness.ctx.cwd, "skills", "sample");
	const paths = [join(dir, "first"), join(dir, "second"), join(dir, "third")];
	for (const [index, path] of paths.entries()) {
		writeFileSync(
			path,
			index === 1 ? "large ".repeat(LARGE_REPEATS) : "small fixture",
		);
		harness.session.appendMessage({
			role: "user",
			content: `<skill location="${path}">fixture</skill>`,
			timestamp: 10,
		});
	}
	const id = harness.session.appendCompaction("identical", null, 10);
	await harness.emit("session_compact", {
		compactionEntry: harness.session.getEntry(id),
	});
	Object.assign(harness.ctx.model ?? {}, { contextWindow: 1000 });
	const first = captureRequest(harness, await harness.prepareContext());
	const firstRecord = harness.getRecords().at(-1)?.data;
	harness.reopen();
	await harness.emit("session_start");
	const reopened = captureRequest(harness, await harness.prepareContext());
	const next = harness.session.appendCompaction("identical", null, 10);
	await harness.emit("session_compact", {
		compactionEntry: harness.session.getEntry(id),
	});
	const repeated = captureRequest(harness, await harness.prepareContext());
	return {
		first,
		reopened,
		repeated,
		firstRecord,
		latest: harness.getRecords().at(-1)?.data,
		paths: [...paths].reverse(),
		next,
		skill: harness.skill,
		asset: harness.asset,
	};
}

/** Dispatches disk-change, budget and priority replay scenarios. */
export async function runRequestScenario(
	harness: RestorationHarness,
	name: string,
): Promise<unknown> {
	if (name === "changes") {
		return changingFiles(harness);
	}
	if (name === "budgets") {
		return changingBudget(harness);
	}
	return interleaved(harness);
}
