import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	BoundedToolCall,
	BoundedToolResult,
	getToolResultText,
	rejectPresentationExecution,
} from "./bounded.ts";

const CALL_VISUAL_LINE_LIMIT = 2;
const COLLAPSED_RESULT_VISUAL_LINE_LIMIT = 5;

/** Creates the bounded public default-shell definition for one unknown third-party tool. */
export function createUniversalToolDefinition(
	toolName: string,
): ToolDefinition {
	return {
		name: toolName,
		label: toolName,
		description: "Display an unknown third-party tool execution.",
		parameters: Type.Unknown(),
		renderShell: "default",
		renderCall(args, theme) {
			return new BoundedToolCall(toolName, args, theme, CALL_VISUAL_LINE_LIMIT);
		},
		renderResult(result, options, theme, context) {
			return new BoundedToolResult({
				text: getToolResultText(result),
				theme,
				isError: context.isError,
				expanded: options.expanded,
				collapsedLineLimit: COLLAPSED_RESULT_VISUAL_LINE_LIMIT,
				showHiddenLineHint: true,
				showExpandedErrorLabel: true,
			});
		},
		execute: rejectPresentationExecution,
	};
}
