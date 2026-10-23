import {
	getCurrentSystemMessage,
	type SystemMessage,
} from "@earendil-works/pi-ai";
import type {
	BeforeAgentStartEvent,
	EntryRenderer,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { estimateTextTokens } from "../../shared/context-size";
import { readNativeCompactionSettings } from "../../shared/native-compaction-settings";
import { readRestorationConfig } from "./config";
import {
	findBranchRestoration,
	formatRestoration,
	insertSelection,
	parseRestorationRecord,
	parseSelectionRecord,
	RESTORATION_TYPE,
	SELECTION_TYPE,
	selectRestoration,
} from "./restoration";
import { collectSkillCandidates, collectSkillRoots } from "./selection";

/** Renders the paths that a compaction tracks. */
const renderRecord: EntryRenderer = (entry, options, theme) => {
	const record = parseRestorationRecord(entry.data);
	if (!record) {
		return renderInvalid(theme);
	}
	const lines = [
		`[skill-restoration] Tracking ${record.candidates.length} skill files`,
		...(options.expanded
			? record.candidates.map((path) => `Tracked: ${path}`)
			: []),
	];
	return new Text(theme.fg("muted", lines.join("\n")), 0, 0);
};

/** Renders the restored and absent files that a compaction selected. */
const renderSelection: EntryRenderer = (entry, options, theme) => {
	const selection = parseSelectionRecord(entry.data);
	if (!selection) {
		return renderInvalid(theme);
	}
	const tokens = estimateTextTokens(formatRestoration(selection));
	const lines = [
		`[skill-restoration] Restored ${selection.files.length} skill files (~${tokens} tokens); ${selection.absent.length} files did not fit`,
		...(options.expanded
			? [
					...selection.files.map((file) => `Restored: ${file.path}`),
					...selection.absent.map((path) => `Absent: ${path}`),
				]
			: []),
	];
	return new Text(theme.fg("muted", lines.join("\n")), 0, 0);
};

/** Renders a restoration entry whose data failed validation. */
function renderInvalid(theme: Parameters<EntryRenderer>[2]): Text {
	return new Text(
		theme.fg("warning", "[skill-restoration] Invalid restoration record"),
		0,
		0,
	);
}

/** Persists candidate paths at compaction, selects files once per compaction and restores them in every request. */
export default function skillRestoration(pi: ExtensionAPI): void {
	let warned = false;
	// Pi mutates the shared options after later before_agent_start handlers return.
	let runPromptOptions:
		| BeforeAgentStartEvent["systemPromptOptions"]
		| undefined;
	const isEnabled = async (ctx: ExtensionContext): Promise<boolean> => {
		const config = await readRestorationConfig();
		if (config.kind === "valid") {
			return config.enabled;
		}
		if (!warned) {
			warned = true;
			ctx.ui.notify(
				"[skill-restoration] Invalid configuration; restoration is disabled.",
				"warning",
			);
		}
		return false;
	};
	pi.registerEntryRenderer(RESTORATION_TYPE, renderRecord);
	pi.registerEntryRenderer(SELECTION_TYPE, renderSelection);
	pi.on("before_agent_start", (event) => {
		runPromptOptions = event.systemPromptOptions;
	});
	pi.on("session_shutdown", () => {
		runPromptOptions = undefined;
	});
	pi.on("session_start", async (_event, ctx) => {
		runPromptOptions = undefined;
		await isEnabled(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		await isEnabled(ctx);
	});
	pi.on("session_compact", async (_event, ctx) => {
		if (await isEnabled(ctx)) {
			trackCompactedPaths(pi, ctx);
		}
	});
	pi.on("context", async (event, ctx) => {
		if (!(await isEnabled(ctx))) {
			return;
		}
		const latest = findBranchRestoration(ctx.sessionManager.getBranch());
		if (!latest?.record) {
			return;
		}
		const timestamp = Date.parse(latest.compaction.timestamp);
		let selection = latest.selection;
		if (!selection) {
			if (!ctx.model) {
				return;
			}
			const settings = readNativeCompactionSettings(ctx.cwd, ctx.model);
			if (settings.status === "invalid") {
				return;
			}
			selection = await selectRestoration({
				record: latest.record,
				messages: event.messages,
				timestamp,
				systemHead: getRequestSystemHead(
					ctx,
					runPromptOptions?.forceSystemPrompt,
				),
				contextWindow: ctx.model.contextWindow,
				reserveTokens: settings.reserveTokens,
				keepRecentTokens: settings.keepRecentTokens,
			});
			if (!selection) {
				return;
			}
			pi.appendEntry(SELECTION_TYPE, selection);
		}
		return { messages: insertSelection(event.messages, selection, timestamp) };
	});
}

/** Selects the native or forced system head for the request estimate. */
function getRequestSystemHead(
	ctx: ExtensionContext,
	forcedPrompt: string | undefined,
): SystemMessage | undefined {
	const current = getCurrentSystemMessage(
		ctx.sessionManager.buildSessionProjection().messages,
	);
	if (forcedPrompt === undefined) {
		return current;
	}
	return {
		role: "system",
		content: forcedPrompt,
		...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
		timestamp: current?.timestamp ?? Date.now(),
	};
}

/** Persists ordered candidate paths for the latest branch compaction. */
function trackCompactedPaths(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const branch = ctx.sessionManager.getBranch();
	const latest = findBranchRestoration(branch);
	if (!latest) {
		return;
	}
	const index = branch.findIndex((entry) => entry.id === latest.compaction.id);
	if (
		branch
			.slice(index + 1)
			.some(
				(entry) =>
					entry.type === "custom" && entry.customType === RESTORATION_TYPE,
			)
	) {
		return;
	}
	const prefix = branch.slice(0, index);
	const candidates = collectSkillCandidates({
		branch: prefix,
		firstKeptEntryId: latest.compaction.firstKeptEntryId,
		roots: collectSkillRoots(pi, ctx.cwd),
		cwd: ctx.cwd,
		previous: findBranchRestoration(prefix)?.record,
	});
	pi.appendEntry(RESTORATION_TYPE, {
		compactionId: latest.compaction.id,
		candidates,
	});
}
