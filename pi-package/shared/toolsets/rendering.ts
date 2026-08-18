import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { truncateTextByWidth } from "../display-width.ts";
import type { ToolsetActivationPresentation } from "./contracts.ts";

const COLLAPSED_TOOL_PREVIEW_LIMIT = 2;

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
		if (this.expanded) {
			return new Text(this.expandedText(), 0, 0).render(width);
		}

		// Collapsed rows are semantic units: status, bounded names, then one expansion hint.
		const preview = this.activation.toolNames.slice(
			0,
			COLLAPSED_TOOL_PREVIEW_LIMIT,
		);
		const lines = [
			truncateTextByWidth(
				this.theme.fg("success", this.collapsedStatus()),
				width,
			),
			...preview.map((name) =>
				truncateTextByWidth(this.theme.fg("muted", `- ${name}`), width),
			),
		];
		const hiddenCount = this.activation.toolNames.length - preview.length;
		if (hiddenCount > 0) {
			lines.push(
				truncateTextByWidth(
					this.theme.fg(
						"dim",
						`... ${hiddenCount} more tools (${keyHint("app.tools.expand", "to expand")})`,
					),
					width,
				),
			);
		}
		return lines;
	}

	public invalidate(): void {}

	private collapsedStatus(): string {
		const status =
			this.activation.status === "activated"
				? `Activated "${this.activation.name}"`
				: `Already active "${this.activation.name}"`;
		return `${status} · ${this.activation.toolNames.length} tools`;
	}

	private expandedText(): string {
		const status =
			this.activation.status === "activated"
				? `Activated toolset "${this.activation.name}".`
				: `Toolset "${this.activation.name}" is already active.`;
		return `${status}\nAvailable tools (${this.activation.toolNames.length}):\n${this.activation.toolNames
			.map((name) => `- ${name}`)
			.join("\n")}`;
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
