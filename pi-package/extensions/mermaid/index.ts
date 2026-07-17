import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { detectCompatibilityWarnings } from "./compatibility.js";
import { extractMermaidBlocks } from "./extraction.js";
import {
	createMermaidRenderClient,
	type MermaidRenderClient,
} from "./render-client.js";
import { renderMermaidEntry } from "./rendering.js";
import type {
	MermaidBlockRenderResult,
	MermaidExtractionResult,
	MermaidRenderEntry,
	MermaidRenderOperationResult,
	MermaidSourceBlock,
} from "./types.js";

/** Durable custom entry type kept outside model context. */
const RENDER_ENTRY_TYPE = "mermaid-render";
/** Hidden custom message type delivered with the next user prompt. */
const DIAGNOSTIC_MESSAGE_TYPE = "mermaid-render-diagnostic";
/** Assistant outcomes that do not contain a final renderable response. */
const SKIPPED_STOP_REASONS = new Set(["toolUse", "error", "aborted"]);
/** Stable generic failure guidance sent to the model on the next user turn. */
const FAILED_MODEL_DIAGNOSTIC =
	"Mermaid rendering failed. Please simplify the diagram. Supported types: flowchart, state, sequence, class, er, xychart.";
/** Per-turn model guidance enabled with the Mermaid extension. */
const MERMAID_SYSTEM_PROMPT_GUIDANCE =
	"When replying to the user in chat, you may include simple flowchart, state, sequence, class, ER, or XY Mermaid diagrams in fenced mermaid blocks that contain no YAML frontmatter or backticks inside labels.";

interface MermaidExtensionDependencies {
	renderClient: MermaidRenderClient;
}

interface StagedResult {
	entries: MermaidRenderEntry[];
	hasFailure: boolean;
	warningExplanations: string[];
}

/** Registers Mermaid preview lifecycle, persistence, and rendering behavior. */
export default function mermaidExtension(
	pi: ExtensionAPI,
	dependencies?: MermaidExtensionDependencies,
): void {
	const renderClient =
		dependencies?.renderClient ?? createMermaidRenderClient();
	pi.registerEntryRenderer<unknown>(RENDER_ENTRY_TYPE, renderMermaidEntry);
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${MERMAID_SYSTEM_PROMPT_GUIDANCE}`,
	}));
	pi.on("turn_end", async (event, ctx) => {
		if (
			ctx.mode !== "tui" ||
			!isAssistantMessage(event.message) ||
			SKIPPED_STOP_REASONS.has(event.message.stopReason)
		) {
			return;
		}
		await processAssistantMessage(pi, renderClient, event.message, ctx.signal);
	});
	pi.on("session_shutdown", () => renderClient.dispose());
}

/** Extracts, renders, stages, then atomically exposes entry and diagnostic effects. */
async function processAssistantMessage(
	pi: ExtensionAPI,
	renderClient: MermaidRenderClient,
	message: AssistantMessage,
	signal: AbortSignal | undefined,
): Promise<void> {
	const extractionResults = extractMermaidBlocks(
		readAssistantTextParts(message),
	);
	if (extractionResults.length === 0) {
		return;
	}

	const acceptedBlocks = extractionResults.flatMap((result) =>
		result.status === "accepted" ? [result.block] : [],
	);
	const renderOperation: MermaidRenderOperationResult =
		acceptedBlocks.length === 0
			? { status: "completed", results: [] }
			: await renderClient.render(acceptedBlocks, signal);
	if (renderOperation.status === "aborted") {
		return;
	}

	const staged = stageResults(extractionResults, renderOperation.results);
	for (const entry of staged.entries) {
		pi.appendEntry(RENDER_ENTRY_TYPE, entry);
	}
	if (staged.hasFailure || staged.warningExplanations.length > 0) {
		pi.sendMessage(
			{
				customType: DIAGNOSTIC_MESSAGE_TYPE,
				content: formatDiagnosticMessage(
					staged.hasFailure,
					staged.warningExplanations,
				),
				display: false,
			},
			{ deliverAs: "nextTurn" },
		);
	}
}

/** Combines preflight, renderer, and compatibility outcomes in source order. */
function stageResults(
	extractionResults: readonly MermaidExtractionResult[],
	renderResults: readonly MermaidBlockRenderResult[],
): StagedResult {
	const entries: MermaidRenderEntry[] = [];
	const warningExplanations: string[] = [];
	let hasFailure = false;
	let renderIndex = 0;

	for (const extractionResult of extractionResults) {
		if (extractionResult.status === "failed") {
			entries.push({
				status: "failed",
				explanation: extractionResult.explanation,
			});
			hasFailure = true;
			continue;
		}

		const block = extractionResult.block;
		const renderResult = renderResults[renderIndex];
		renderIndex += 1;
		const entry = stageAcceptedBlock(block, renderResult);
		entries.push(entry);
		if (entry.status === "failed") {
			hasFailure = true;
		}
		if (entry.status === "warning") {
			warningExplanations.push(
				...entry.warnings.map(({ explanation }) => explanation),
			);
		}
	}
	return { entries, hasFailure, warningExplanations };
}

/** Creates a durable outcome for one accepted source block. */
function stageAcceptedBlock(
	block: MermaidSourceBlock,
	renderResult: MermaidBlockRenderResult | undefined,
): MermaidRenderEntry {
	if (renderResult === undefined) {
		return {
			status: "failed",
			explanation: "The renderer did not return a result for this block.",
		};
	}
	if (renderResult.status === "failed") {
		return { status: "failed", explanation: renderResult.explanation };
	}

	const warnings = detectCompatibilityWarnings(
		block,
		renderResult.compatibilityWarnings,
	);
	return warnings.length === 0
		? { status: "rendered", variants: renderResult.variants }
		: {
				status: "warning",
				variants: renderResult.variants,
				warnings,
			};
}

/** Formats diagnostics without including Mermaid source or renderer output. */
function formatDiagnosticMessage(
	hasFailure: boolean,
	warningExplanations: readonly string[],
): string {
	const lines = hasFailure ? [FAILED_MODEL_DIAGNOSTIC] : [];
	lines.push(...new Set(warningExplanations));
	return lines.join("\n");
}

/** Reads assistant text parts while preserving their message order. */
function readAssistantTextParts(message: AssistantMessage): string[] {
	return message.content.flatMap((part) =>
		part.type === "text" ? [part.text] : [],
	);
}

/** Narrows agent messages before reading assistant-only fields. */
function isAssistantMessage(
	message: AgentMessage,
): message is AssistantMessage {
	return message.role === "assistant";
}
