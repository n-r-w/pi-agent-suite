import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { truncateTextByWidth } from "../display-width.ts";
import type { ToolsetActivationPresentation } from "./contracts.ts";

const COLLAPSED_CONTENT_LINE_LIMIT = 2;

interface ActivationRenderResult {
	readonly content: readonly {
		readonly type: string;
		readonly text?: string;
	}[];
	readonly details?: unknown;
}

interface ActivationRenderOptions {
	readonly expanded: boolean;
	readonly isError?: boolean;
}

class SingleLineCall implements Component {
	public constructor(
		private readonly name: string,
		private readonly theme: Theme,
	) {}

	public render(width: number): string[] {
		const text =
			this.theme.fg("toolTitle", this.theme.bold("activate_toolset ")) +
			this.theme.fg("muted", this.name);
		return [truncateTextByWidth(text, width)];
	}

	public invalidate(): void {}
}

class ActivationResult implements Component {
	public constructor(
		private readonly activation: ToolsetActivationPresentation,
		private readonly expanded: boolean,
		private readonly theme: Theme,
	) {}

	public render(width: number): string[] {
		const wrappedLines = new Text(this.outputText(), 0, 0)
			.render(width)
			.map((line) => line.trimEnd());
		// Plain rows own truncation math while styled rows keep status and names in separate colors.
		const styledLines = new Text(this.styledOutputText(), 0, 0).render(width);
		if (this.expanded || wrappedLines.length <= COLLAPSED_CONTENT_LINE_LIMIT) {
			return styledLines;
		}

		const visibleLines = styledLines.slice(0, COLLAPSED_CONTENT_LINE_LIMIT);
		const lastVisibleIndex = visibleLines.length - 1;
		const lastVisibleLine = wrappedLines[lastVisibleIndex] ?? "";
		// The suffix signals truncation without letting a long wrapped row exceed the shell.
		visibleLines[lastVisibleIndex] = this.theme.fg(
			"muted",
			truncateTextByWidth(`${lastVisibleLine} ...`, width, " ..."),
		);
		const hiddenLineCount = wrappedLines.length - visibleLines.length;
		const hiddenLineLabel = hiddenLineCount === 1 ? "line" : "lines";
		const hint = `... ${hiddenLineCount} more ${hiddenLineLabel} (${keyHint("app.tools.expand", "to expand")})`;
		return [
			...visibleLines,
			this.theme.fg("dim", truncateTextByWidth(hint, width)),
		];
	}

	public invalidate(): void {}

	private outputText(): string {
		return `${this.statusLabel()}: ${this.activation.toolNames.join(", ")}`;
	}

	private styledOutputText(): string {
		const status = this.theme.fg("success", `${this.statusLabel()}:`);
		const toolNames = this.theme.fg(
			"muted",
			` ${this.activation.toolNames.join(", ")}`,
		);
		return `${status}${toolNames}`;
	}

	private statusLabel(): string {
		return this.activation.status === "activated"
			? "Activated"
			: "Already active";
	}
}

export function renderActivateToolsetCall(
	args: unknown,
	theme: Theme,
): Component {
	const name =
		isRecord(args) && typeof args["name"] === "string" ? args["name"] : "";
	return new SingleLineCall(name, theme);
}

export function renderActivateToolsetResult(
	result: ActivationRenderResult,
	options: ActivationRenderOptions,
	theme: Theme,
): Component {
	const activation = readActivationPresentation(result.details);
	if (activation !== undefined) {
		return new ActivationResult(activation, options.expanded, theme);
	}
	const text = result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.join("\n");
	return new Text(
		theme.fg(options.isError ? "error" : "toolOutput", text),
		0,
		0,
	);
}

function readActivationPresentation(
	details: unknown,
): ToolsetActivationPresentation | undefined {
	if (!isRecord(details) || !isRecord(details["activation"])) {
		return undefined;
	}
	const activation = details["activation"];
	if (
		typeof activation["name"] !== "string" ||
		(activation["status"] !== "activated" &&
			activation["status"] !== "already_active") ||
		!Array.isArray(activation["toolNames"]) ||
		!activation["toolNames"].every((name) => typeof name === "string")
	) {
		return undefined;
	}
	return {
		name: activation["name"],
		status: activation["status"],
		toolNames: activation["toolNames"],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
