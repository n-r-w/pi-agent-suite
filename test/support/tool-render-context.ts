import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

type ToolRenderContext = Parameters<
	NonNullable<ToolDefinition["renderCall"]>
>[2];

/** Creates one complete deterministic context for public tool renderers. */
export function createToolRenderContext(options: {
	readonly args: unknown;
	readonly expanded: boolean;
	readonly isError: boolean;
}): ToolRenderContext {
	return {
		args: options.args,
		toolCallId: "tool-call-1",
		invalidate(): void {},
		lastComponent: undefined,
		state: {},
		cwd: "/tmp",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: options.expanded,
		showImages: false,
		isError: options.isError,
	};
}
