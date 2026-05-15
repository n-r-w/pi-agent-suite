import { env as processEnv } from "node:process";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isChildAgentProcess } from "../../shared/child-agent-environment";
import { readUrlSchemeConfig } from "./config";
import {
	convertAssistantContent,
	defaultFileExists,
	type FileExists,
} from "./link-converter";

/** Assistant stop reasons that represent final user-visible answers. */
const FINAL_ASSISTANT_STOP_REASONS = ["stop", "length"] as const;

type FinalAssistantStopReason = (typeof FINAL_ASSISTANT_STOP_REASONS)[number];

/** Optional side-effect dependencies for deterministic tests. */
export interface UrlSchemeDependencies {
	readonly fileExists?: FileExists;
	readonly env?: NodeJS.ProcessEnv;
}

/** Minimal object shape needed before reading dynamic fields. */
type UnknownRecord = Record<string, unknown>;

/** Assistant message shape that can be safely rewritten. */
interface AssistantMessageForConversion extends UnknownRecord {
	readonly role: "assistant";
	readonly content: readonly unknown[];
	readonly stopReason: FinalAssistantStopReason;
}

/** Registers final assistant file-link conversion handlers. */
export default function urlScheme(
	pi: ExtensionAPI,
	dependencies?: UrlSchemeDependencies,
): void {
	const fileExists = dependencies?.fileExists ?? defaultFileExists;
	const runtimeEnv = dependencies?.env ?? processEnv;
	let reportedInvalidConfigIssue: string | undefined;

	pi.on("message_end", (event, ctx) => {
		if (isChildAgentProcess(runtimeEnv)) {
			return undefined;
		}

		const config = readUrlSchemeConfig();
		if (config.kind === "invalid") {
			if (reportedInvalidConfigIssue !== config.issue) {
				reportConfigIssue(ctx, config.issue);
				reportedInvalidConfigIssue = config.issue;
			}
			return undefined;
		}

		reportedInvalidConfigIssue = undefined;
		if (!config.config.enabled || !isFinalAssistantMessage(event.message)) {
			return undefined;
		}

		const replacementContent = convertAssistantContent({
			content: event.message.content,
			cwd: ctx.cwd,
			scheme: config.config.scheme,
			fileExists,
		});
		if (replacementContent === undefined) {
			return undefined;
		}

		return {
			message: {
				...event.message,
				content: replacementContent,
			} as typeof event.message,
		};
	});
}

/** Returns true only for assistant messages that are final user-visible answers. */
function isFinalAssistantMessage(
	message: unknown,
): message is AssistantMessageForConversion {
	return (
		isRecord(message) &&
		message["role"] === "assistant" &&
		Array.isArray(message["content"]) &&
		isFinalAssistantStopReason(message["stopReason"])
	);
}

/** Returns true when a stop reason should be visible as the final answer. */
function isFinalAssistantStopReason(
	stopReason: unknown,
): stopReason is FinalAssistantStopReason {
	return FINAL_ASSISTANT_STOP_REASONS.includes(
		stopReason as FinalAssistantStopReason,
	);
}

/** Reports invalid config without interrupting other extensions. */
function reportConfigIssue(ctx: ExtensionContext, issue: string): void {
	if (ctx.hasUI === false) {
		return;
	}

	ctx.ui?.notify(`[url-scheme] ${issue}`, "warning");
}

/** Returns true when an unknown value is safe for dynamic property reads. */
function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null;
}
