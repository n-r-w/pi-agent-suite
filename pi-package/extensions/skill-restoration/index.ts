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
import { readNativeCompactionSettings } from "../../shared/native-compaction-settings";
import { readRestorationConfig } from "./config";
import {
	findBranchRestoration,
	insertRestoration,
	parseRestorationRecord,
	RESTORATION_TYPE,
	type RestorationDelivery,
} from "./restoration";
import { collectSkillCandidates, collectSkillRoots } from "./selection";

/** Renders tracked paths until request preparation supplies in-memory delivery counts. */
function createRenderer(
	deliveries: ReadonlyMap<string, RestorationDelivery>,
): EntryRenderer {
	return (entry, options, theme) => {
		const record = parseRestorationRecord(entry.data);
		if (!record) {
			return new Text(
				theme.fg("warning", "[skill-restoration] Invalid restoration record"),
				0,
				0,
			);
		}
		const text = new Text("", 0, 0);
		return {
			render(width) {
				const delivery = deliveries.get(record.compactionId);
				const lines = [
					delivery
						? `[skill-restoration] Prepared ${delivery.restoredPaths.length} skill files (~${delivery.estimatedTokens} tokens); ${delivery.absentPaths.length} files did not fit`
						: `[skill-restoration] Tracking ${record.candidates.length} skill files`,
				];
				if (options.expanded) {
					if (delivery) {
						lines.push(
							...delivery.restoredPaths.map((path) => `Prepared: ${path}`),
							...delivery.absentPaths.map((path) => `Absent: ${path}`),
						);
					} else {
						lines.push(...record.candidates.map((path) => `Tracked: ${path}`));
					}
				}
				text.setText(theme.fg("muted", lines.join("\n")));
				return text.render(width);
			},
			invalidate() {
				text.invalidate();
			},
		};
	};
}

/** Persists candidate paths and prepares fresh disk-backed restoration on every request. */
export default function skillRestoration(pi: ExtensionAPI): void {
	let warned = false;
	// Pi mutates the shared options after later before_agent_start handlers return.
	let runPromptOptions:
		| BeforeAgentStartEvent["systemPromptOptions"]
		| undefined;
	const deliveries = new Map<string, RestorationDelivery>();
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
	pi.registerEntryRenderer(RESTORATION_TYPE, createRenderer(deliveries));
	pi.on("before_agent_start", (event) => {
		runPromptOptions = event.systemPromptOptions;
	});
	pi.on("session_shutdown", () => {
		runPromptOptions = undefined;
	});
	pi.on("session_start", async (_event, ctx) => {
		deliveries.clear();
		runPromptOptions = undefined;
		await isEnabled(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		deliveries.clear();
		await isEnabled(ctx);
	});
	pi.on("session_compact", async (_event, ctx) => {
		if (await isEnabled(ctx)) {
			trackCompactedPaths(pi, ctx);
		}
	});
	pi.on("context", async (event, ctx) => {
		if (!(await isEnabled(ctx)) || !ctx.model) {
			return;
		}
		const latest = findBranchRestoration(ctx.sessionManager.getBranch());
		if (!latest?.record) {
			return;
		}
		const settings = readNativeCompactionSettings(ctx.cwd, ctx.model);
		if (settings.status === "invalid") {
			return;
		}
		const prepared = await insertRestoration({
			record: latest.record,
			messages: event.messages,
			timestamp: Date.parse(latest.compaction.timestamp),
			systemHead: getRequestSystemHead(
				ctx,
				runPromptOptions?.forceSystemPrompt,
			),
			contextWindow: ctx.model.contextWindow,
			reserveTokens: settings.reserveTokens,
			keepRecentTokens: settings.keepRecentTokens,
		});
		if (prepared.delivery) {
			deliveries.set(latest.compaction.id, prepared.delivery);
		}
		return { messages: prepared.messages };
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
