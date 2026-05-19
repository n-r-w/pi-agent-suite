import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	parseKey,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	formatStructuredPrompt,
	type PromptSection,
	type PromptSectionValue,
} from "./formatter.ts";

export type StructuredPromptFormResult =
	| {
			readonly kind: "submitted";
			readonly values: readonly PromptSectionValue[];
	  }
	| {
			readonly kind: "inserted";
			readonly values: readonly PromptSectionValue[];
	  }
	| { readonly kind: "cancelled" };

export interface PromptFormTheme {
	readonly fg: (color: ThemeColor, value: string) => string;
	readonly bold: (value: string) => string;
}

export interface StructuredPromptFormOptions {
	readonly tui: TUI;
	readonly theme: PromptFormTheme;
	readonly sections: readonly PromptSection[];
	readonly onCopyPrompt?:
		| ((promptText: string) => Promise<void> | void)
		| undefined;
	readonly onDone: (result: StructuredPromptFormResult) => void;
}

type PromptFormMode = "edit" | "review" | "closed";

const FRAME_SIDE_WIDTH = 2;
const FRAME_HORIZONTAL_PADDING = 2;
const FRAME_DECORATION_WIDTH = FRAME_SIDE_WIDTH + FRAME_HORIZONTAL_PADDING;
const REVIEW_NON_PREVIEW_ROWS = 6;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/** Captures section text first, then requires a review confirmation before submit. */
export class StructuredPromptForm implements Component {
	private readonly tui: TUI;
	private readonly theme: PromptFormTheme;
	private readonly sections: readonly PromptSection[];
	private readonly onCopyPrompt:
		| ((promptText: string) => Promise<void> | void)
		| undefined;
	private readonly onDone: (result: StructuredPromptFormResult) => void;
	private readonly values = new Map<string, string>();
	private readonly editor: Editor;
	private mode: PromptFormMode = "edit";
	private sectionIndex = 0;
	private reviewScrollOffset = 0;
	private reviewMaxScrollOffset = 0;
	private reviewPageRows = 1;
	private copyInProgress = false;
	private editorPasteInProgress = false;

	/** Creates the form with a Pi editor for multi-line section input. */
	public constructor(options: StructuredPromptFormOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.sections = options.sections;
		this.onCopyPrompt = options.onCopyPrompt;
		this.onDone = options.onDone;
		this.editor = new Editor(this.tui, this.createEditorTheme());
	}

	/** Renders either the active section editor or the final prompt preview. */
	public render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const contentWidth =
			safeWidth >= FRAME_DECORATION_WIDTH
				? safeWidth - FRAME_DECORATION_WIDTH
				: safeWidth;
		const content =
			this.mode === "review"
				? this.renderReview(contentWidth)
				: this.renderEditor(contentWidth);
		return this.renderBorderedPanel(content, safeWidth);
	}

	/** Routes cancel and step confirmation keys before passing text input to the editor. */
	public handleInput(data: string): void {
		if (this.mode === "closed") {
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.finish({ kind: "cancelled" });
			return;
		}
		if (
			this.mode === "review" &&
			this.copyInProgress &&
			matchesKey(data, Key.enter)
		) {
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.confirmCurrentMode();
			return;
		}
		if (this.mode === "review") {
			this.handleReviewInput(data);
			return;
		}

		if (this.shouldRouteToEditorPaste(data)) {
			this.editor.handleInput(data);
			this.updateEditorPasteState(data);
		} else if (data.length > 1 && parseKey(data) === undefined) {
			this.editor.insertTextAtCursor(data);
		} else {
			this.editor.handleInput(data);
		}
		this.tui.requestRender();
	}

	/** Clears cached rendering in the embedded editor. */
	public invalidate(): void {
		this.editor.invalidate();
	}

	/** Draws a bright outer frame that separates the overlay from the chat background. */
	private renderBorderedPanel(
		lines: readonly string[],
		width: number,
	): string[] {
		if (width < FRAME_DECORATION_WIDTH) {
			return lines.map((line) => truncateToWidth(line, width));
		}

		const innerWidth = width - FRAME_DECORATION_WIDTH;
		const horizontal = "━".repeat(innerWidth + FRAME_HORIZONTAL_PADDING);
		return [
			this.theme.fg("borderAccent", `┏${horizontal}┓`),
			...lines.map((line) => {
				const clippedLine = truncateToWidth(line, innerWidth);
				const padding = " ".repeat(
					Math.max(0, innerWidth - visibleWidth(clippedLine)),
				);
				return (
					this.theme.fg("borderAccent", "┃") +
					` ${clippedLine}${padding} ` +
					this.theme.fg("borderAccent", "┃")
				);
			}),
			this.theme.fg("borderAccent", `┗${horizontal}┛`),
		];
	}

	/** Shows the active section, editing help, and the embedded multi-line editor. */
	private renderEditor(width: number): string[] {
		const section = this.currentSection();
		if (section === undefined) {
			return this.renderReview(width);
		}

		return [
			truncateToWidth(this.theme.bold("Structured prompt"), width),
			truncateToWidth(
				`${this.sectionIndex + 1}/${this.sections.length}: ${section.title}`,
				width,
			),
			truncateToWidth(
				this.theme.fg(
					"dim",
					"Enter: next section • Shift+Enter: newline • Esc: cancel",
				),
				width,
			),
			...this.editor.render(width),
		];
	}

	/** Shows the generated prompt preview and requires explicit confirmation to send. */
	private renderReview(width: number): string[] {
		const prompt = formatStructuredPrompt(this.sections, this.collectValues());
		const previewText = prompt.length > 0 ? prompt : "No non-empty sections.";
		const preview = new Text(previewText, 0, 0);
		const previewLines = preview.render(width);
		const maxPreviewRows = this.maxReviewPreviewRows();
		this.reviewPageRows = maxPreviewRows;
		this.reviewMaxScrollOffset = Math.max(
			0,
			previewLines.length - maxPreviewRows,
		);
		this.reviewScrollOffset = Math.min(
			this.reviewScrollOffset,
			this.reviewMaxScrollOffset,
		);
		const visiblePreview = previewLines.slice(
			this.reviewScrollOffset,
			this.reviewScrollOffset + maxPreviewRows,
		);
		const scrollInfo = this.formatReviewScrollInfo(
			previewLines.length,
			visiblePreview.length,
		);
		return [
			truncateToWidth(this.theme.bold("Review prompt"), width),
			truncateToWidth(
				this.theme.fg(
					"dim",
					"Enter: send • Ctrl+Y: copy • Ctrl+T: place in input • Esc: cancel",
				),
				width,
			),
			truncateToWidth(
				this.theme.fg(
					"dim",
					"Up/Down: scroll • PageUp/PageDown: page • Home/End: jump",
				),
				width,
			),
			...visiblePreview,
			...(scrollInfo === undefined
				? []
				: [truncateToWidth(this.theme.fg("dim", scrollInfo), width)]),
		];
	}

	/** Handles review-only actions without changing the generated prompt. */
	private handleReviewInput(data: string): void {
		if (matchesKey(data, "ctrl+y")) {
			this.copyCurrentPrompt();
			return;
		}
		if (matchesKey(data, "ctrl+t")) {
			if (this.copyInProgress) {
				return;
			}
			this.finish({ kind: "inserted", values: this.collectValues() });
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.reviewScrollOffset = Math.min(
				this.reviewMaxScrollOffset,
				this.reviewScrollOffset + 1,
			);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.reviewScrollOffset = Math.max(0, this.reviewScrollOffset - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.reviewScrollOffset = Math.min(
				this.reviewMaxScrollOffset,
				this.reviewScrollOffset + this.reviewPageRows,
			);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.reviewScrollOffset = Math.max(
				0,
				this.reviewScrollOffset - this.reviewPageRows,
			);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.reviewScrollOffset = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.reviewScrollOffset = this.reviewMaxScrollOffset;
			this.tui.requestRender();
		}
	}

	/** Routes bracketed paste chunks through the editor so terminal control bytes are handled as paste metadata. */
	private shouldRouteToEditorPaste(data: string): boolean {
		return (
			this.editorPasteInProgress ||
			data.includes(BRACKETED_PASTE_START) ||
			data.includes(BRACKETED_PASTE_END)
		);
	}

	/** Tracks bracketed paste across terminal chunks until the paste end marker arrives. */
	private updateEditorPasteState(data: string): void {
		let cursor = 0;
		while (cursor < data.length) {
			const nextStart = data.indexOf(BRACKETED_PASTE_START, cursor);
			const nextEnd = data.indexOf(BRACKETED_PASTE_END, cursor);
			if (nextStart === -1 && nextEnd === -1) {
				break;
			}
			if (nextEnd === -1 || (nextStart !== -1 && nextStart < nextEnd)) {
				this.editorPasteInProgress = true;
				cursor = nextStart + BRACKETED_PASTE_START.length;
			} else {
				this.editorPasteInProgress = false;
				cursor = nextEnd + BRACKETED_PASTE_END.length;
			}
		}
	}

	/** Starts clipboard copy and blocks send actions until the copy attempt finishes. */
	private copyCurrentPrompt(): void {
		if (this.copyInProgress) {
			return;
		}

		const promptText = formatStructuredPrompt(
			this.sections,
			this.collectValues(),
		);
		this.copyInProgress = true;
		Promise.resolve()
			.then(() => this.onCopyPrompt?.(promptText))
			.catch(() => undefined)
			.finally(() => {
				this.copyInProgress = false;
				this.tui.requestRender();
			});
	}

	/** Advances from editing to review, or submits when the review screen is active. */
	private confirmCurrentMode(): void {
		if (this.mode === "review") {
			this.finish({ kind: "submitted", values: this.collectValues() });
			return;
		}

		const section = this.currentSection();
		if (section !== undefined) {
			this.values.set(section.id, this.editor.getExpandedText());
		}
		this.sectionIndex += 1;
		if (this.sectionIndex >= this.sections.length) {
			this.mode = "review";
			this.reviewScrollOffset = 0;
		} else {
			this.editor.setText(
				this.values.get(this.sections[this.sectionIndex]?.id ?? "") ?? "",
			);
		}
		this.tui.requestRender();
	}

	/** Reserves space for frame, title, help, and optional scroll indicator. */
	private maxReviewPreviewRows(): number {
		return Math.max(1, this.tui.terminal.rows - REVIEW_NON_PREVIEW_ROWS);
	}

	/** Reports which visual preview rows are visible when the prompt is scrollable. */
	private formatReviewScrollInfo(
		totalRows: number,
		visibleRows: number,
	): string | undefined {
		if (totalRows <= visibleRows) {
			return undefined;
		}

		const firstVisibleRow = this.reviewScrollOffset + 1;
		const lastVisibleRow = this.reviewScrollOffset + visibleRows;
		return `Lines ${firstVisibleRow}-${lastVisibleRow} of ${totalRows}`;
	}

	/** Returns values for every configured section so the formatter owns empty-section filtering. */
	private collectValues(): readonly PromptSectionValue[] {
		return this.sections.map((section) => ({
			sectionId: section.id,
			value: this.values.get(section.id) ?? "",
		}));
	}

	/** Returns the section currently controlled by the embedded editor. */
	private currentSection(): PromptSection | undefined {
		return this.sections[this.sectionIndex];
	}

	/** Closes the component and reports the terminal form result once. */
	private finish(result: StructuredPromptFormResult): void {
		this.mode = "closed";
		this.onDone(result);
	}

	/** Adapts the active Pi theme to the embedded editor contract. */
	private createEditorTheme(): EditorTheme {
		return {
			borderColor: (value) => this.theme.fg("accent", value),
			selectList: {
				selectedPrefix: (value) => this.theme.fg("accent", value),
				selectedText: (value) => this.theme.fg("accent", value),
				description: (value) => this.theme.fg("muted", value),
				scrollInfo: (value) => this.theme.fg("dim", value),
				noMatch: (value) => this.theme.fg("warning", value),
			},
		};
	}
}
