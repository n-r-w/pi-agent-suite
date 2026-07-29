import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { getToolResultText } from "../../shared/tool-presentation/bounded.ts";
import {
	formatDuration,
	renderClippedTextRow,
	renderError,
	renderFormattedText,
	renderHeader,
	SemanticComponent,
} from "./semantic-layout.ts";

type ToolRenderContext = Parameters<
	NonNullable<ToolDefinition["renderCall"]>
>[2];

interface QueryRenderState {
	phase?: "error";
	settled?: {
		readonly answer: string;
		readonly elapsedMs: number;
	};
}

/** Renders one saved-session query as a pending or settled semantic card. */
export const renderSubagentQueryCall: NonNullable<
	ToolDefinition["renderCall"]
> = (args, theme, context) =>
	new SemanticComponent((width) => {
		const sessionId = readPositiveInteger(args, "sessionId");
		const question = readString(args, "question") ?? "";
		const state = renderState(context);
		let status: string | undefined;
		if (state.settled !== undefined) {
			status = formatDuration(state.settled.elapsedMs);
		} else if (state.phase !== "error") {
			status = "querying…";
		}
		const lines = [
			renderHeader(
				"subagent_query",
				[
					{
						value: sessionId === undefined ? undefined : `#${sessionId}`,
						role: "primary",
					},
					{ value: status, role: "metadata" },
				],
				width,
				theme,
			),
		];
		if (state.phase === "error") {
			return lines;
		}
		if (state.settled !== undefined) {
			if (context.expanded) {
				lines.push(
					...renderFormattedText({
						label: "Question:",
						sectionName: "Question",
						text: question,
						width,
						theme,
						expanded: true,
					}),
				);
			} else {
				lines.push(renderClippedTextRow("Question:", question, width, theme));
			}
			lines.push(
				...renderFormattedText({
					label: "Answer:",
					sectionName: "Answer",
					text: state.settled.answer,
					width,
					theme,
					expanded: context.expanded,
				}),
			);
			return lines;
		}
		lines.push(
			...renderFormattedText({
				label: "Question:",
				sectionName: "Question",
				text: question,
				width,
				theme,
				expanded: context.expanded,
			}),
		);
		return lines;
	});

/** Updates the semantic query card after completion or renders one tool error. */
export const renderSubagentQueryResult: NonNullable<
	ToolDefinition["renderResult"]
> = (result, options, theme, context) => {
	const state = renderState(context);
	if (context.isError) {
		state.phase = "error";
		return renderError(getToolResultText(result), options.expanded, theme);
	}
	const presentation = readQueryPresentation(result.details);
	if (presentation === undefined) {
		state.phase = "error";
		return renderError("Query result is unavailable", options.expanded, theme);
	}
	state.settled = presentation;
	return new Container();
};

/** Reads row-local semantic state shared by Pi's call and result renderers. */
function renderState(context: ToolRenderContext): QueryRenderState {
	return context.state as QueryRenderState;
}

/** Reads the closed query presentation contract from non-model-visible details. */
function readQueryPresentation(
	value: unknown,
): QueryRenderState["settled"] | undefined {
	const answer = readString(value, "answer");
	const elapsedMs = readNonNegativeFiniteNumber(value, "elapsedMs");
	return answer === undefined || elapsedMs === undefined
		? undefined
		: { answer, elapsedMs };
}

/** Reads one string field from an unknown presentation boundary. */
function readString(value: unknown, key: string): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const field = Reflect.get(value, key);
	return typeof field === "string" ? field : undefined;
}

/** Reads one positive integer field from an unknown presentation boundary. */
function readPositiveInteger(value: unknown, key: string): number | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const field = Reflect.get(value, key);
	return typeof field === "number" && Number.isInteger(field) && field > 0
		? field
		: undefined;
}

/** Reads one finite non-negative duration from an unknown presentation boundary. */
function readNonNegativeFiniteNumber(
	value: unknown,
	key: string,
): number | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const field = Reflect.get(value, key);
	return typeof field === "number" && Number.isFinite(field) && field >= 0
		? field
		: undefined;
}
