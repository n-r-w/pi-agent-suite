import {
	getMarkdownTheme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	type Component,
	Editor,
	type EditorTheme,
	Key,
	Markdown,
	matchesKey,
	parseKey,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

export type AskQuestionDialogResult = string | undefined;

export interface AskDialogTheme {
	readonly fg: (color: ThemeColor, value: string) => string;
	readonly bold: (value: string) => string;
}

export interface AskQuestionDialogOptions {
	readonly tui: TUI;
	readonly theme: AskDialogTheme;
	readonly autocompleteProvider?: AutocompleteProvider;
	readonly onDone: (result: AskQuestionDialogResult) => void;
}

export interface AskAnswerDialogOptions {
	readonly tui: TUI;
	readonly theme: AskDialogTheme;
	readonly question: string;
	readonly answer: string;
	readonly onCopyAnswer: () => Promise<void> | void;
	readonly onDone: () => void;
}

const FRAME_SIDE_WIDTH = 2;
const FRAME_HORIZONTAL_PADDING = 2;
const FRAME_DECORATION_WIDTH = FRAME_SIDE_WIDTH + FRAME_HORIZONTAL_PADDING;
const QUESTION_NON_EDITOR_ROWS = 5;
const ANSWER_NON_CONTENT_ROWS = 7;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/** Shows pending ask progress inside the same framed dialog style as question and answer views. */
export class AskLoadingDialog implements Component {
	private readonly theme: AskDialogTheme;
	private readonly abortController = new AbortController();
	public onAbort: (() => void) | undefined;

	/** Creates the cancellable loading dialog. */
	public constructor(theme: AskDialogTheme) {
		this.theme = theme;
	}

	public get signal(): AbortSignal {
		return this.abortController.signal;
	}

	/** Renders pending request status inside a stable ask dialog frame. */
	public render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const contentWidth =
			safeWidth >= FRAME_DECORATION_WIDTH
				? safeWidth - FRAME_DECORATION_WIDTH
				: safeWidth;
		return renderBorderedPanel(
			[
				truncateToWidth(this.theme.bold("Asking LLM..."), contentWidth),
				truncateToWidth(
					this.theme.fg("dim", "Esc/Ctrl+C: cancel"),
					contentWidth,
				),
			],
			safeWidth,
			this.theme,
		);
	}

	/** Cancels the pending request when the user presses a cancel key. */
	public handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c")) {
			this.abortController.abort();
			this.onAbort?.();
		}
	}

	/** Clears cached rendering. */
	public invalidate(): void {}
}

/** Collects a one-off ask question inside a centered overlay dialog. */
export class AskQuestionDialog implements Component {
	private readonly tui: TUI;
	private readonly theme: AskDialogTheme;
	private readonly onDone: (result: AskQuestionDialogResult) => void;
	private readonly editor: Editor;
	private closed = false;
	private editorPasteInProgress = false;

	/** Creates the question dialog with Pi editor behavior and optional file autocomplete. */
	public constructor(options: AskQuestionDialogOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.onDone = options.onDone;
		this.editor = new Editor(this.tui, this.createEditorTheme());
		if (options.autocompleteProvider !== undefined) {
			this.editor.setAutocompleteProvider(options.autocompleteProvider);
		}
	}

	/** Renders the question editor without exceeding the terminal row budget. */
	public render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const contentWidth =
			safeWidth >= FRAME_DECORATION_WIDTH
				? safeWidth - FRAME_DECORATION_WIDTH
				: safeWidth;
		const editorRows = this.editor.render(contentWidth);
		const visibleEditorRows = editorRows.slice(-this.maxEditorRows());
		const content = [
			truncateToWidth(this.theme.bold("Ask LLM question"), contentWidth),
			truncateToWidth(
				this.theme.fg("dim", "Enter: ask • Shift+Enter: newline • Esc: cancel"),
				contentWidth,
			),
			...visibleEditorRows,
		];
		return renderBorderedPanel(content, safeWidth, this.theme);
	}

	/** Routes cancel and submit keys before passing text input to the editor. */
	public handleInput(data: string): void {
		if (this.closed) {
			return;
		}
		if (
			this.editor.isShowingAutocomplete() &&
			(matchesKey(data, Key.escape) || matchesKey(data, Key.enter))
		) {
			this.editor.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.finish(undefined);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const question = this.editor.getExpandedText().trim();
			this.finish(question.length > 0 ? question : undefined);
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

	/** Reserves space for frame, title, help, and at least one editor row. */
	private maxEditorRows(): number {
		return Math.max(1, this.tui.terminal.rows - QUESTION_NON_EDITOR_ROWS);
	}

	/** Closes the component and reports the submitted question once. */
	private finish(result: AskQuestionDialogResult): void {
		this.closed = true;
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

/** Shows the original question and model answer inside a scrollable overlay dialog. */
export class AskAnswerDialog implements Component {
	private readonly tui: TUI;
	private readonly theme: AskDialogTheme;
	private readonly question: string;
	private readonly answer: string;
	private readonly onCopyAnswer: () => Promise<void> | void;
	private readonly onDone: () => void;
	private scrollOffset = 0;
	private maxScrollOffset = 0;
	private pageRows = 1;
	private closed = false;

	/** Creates the answer dialog with copy and close handlers. */
	public constructor(options: AskAnswerDialogOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.question = options.question;
		this.answer = options.answer;
		this.onCopyAnswer = options.onCopyAnswer;
		this.onDone = options.onDone;
	}

	/** Renders visible question and answer rows within the terminal row budget. */
	public render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const contentWidth =
			safeWidth >= FRAME_DECORATION_WIDTH
				? safeWidth - FRAME_DECORATION_WIDTH
				: safeWidth;
		const body = [
			this.theme.fg("accent", this.theme.bold("Question")),
			...new Text(this.question, 0, 0).render(contentWidth),
			this.theme.fg("accent", this.theme.bold("Answer")),
			...new Markdown(this.answer, 0, 0, getMarkdownTheme()).render(
				contentWidth,
			),
		];
		const maxRows = this.maxBodyRows();
		this.pageRows = maxRows;
		this.maxScrollOffset = Math.max(0, body.length - maxRows);
		this.scrollOffset = Math.min(this.scrollOffset, this.maxScrollOffset);
		const visibleBody = body.slice(
			this.scrollOffset,
			this.scrollOffset + maxRows,
		);
		const scrollInfo = this.formatScrollInfo(body.length, visibleBody.length);
		const content = [
			truncateToWidth(this.theme.bold("Ask LLM"), contentWidth),
			truncateToWidth(
				this.theme.fg(
					"dim",
					"Ctrl+Y: copy answer • Enter/Esc: close • Up/Down: scroll",
				),
				contentWidth,
			),
			...visibleBody,
			...(scrollInfo === undefined
				? []
				: [truncateToWidth(this.theme.fg("dim", scrollInfo), contentWidth)]),
		];
		return renderBorderedPanel(content, safeWidth, this.theme);
	}

	/** Handles copy, close, and scroll keys for the result dialog. */
	public async handleInput(data: string): Promise<void> {
		if (this.closed) {
			return;
		}
		if (matchesKey(data, "ctrl+y")) {
			try {
				await this.onCopyAnswer();
			} finally {
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
			this.closed = true;
			this.onDone();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.scrollOffset = Math.min(this.maxScrollOffset, this.scrollOffset + 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollOffset = Math.min(
				this.maxScrollOffset,
				this.scrollOffset + this.pageRows,
			);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - this.pageRows);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.scrollOffset = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.scrollOffset = this.maxScrollOffset;
			this.tui.requestRender();
		}
	}

	/** Clears cached rendering. */
	public invalidate(): void {}

	/** Reserves space for frame, title, help, and optional scroll indicator. */
	private maxBodyRows(): number {
		return Math.max(1, this.tui.terminal.rows - ANSWER_NON_CONTENT_ROWS);
	}

	/** Reports which rendered body rows are visible when the dialog is scrollable. */
	private formatScrollInfo(
		totalRows: number,
		visibleRows: number,
	): string | undefined {
		if (totalRows <= visibleRows) {
			return undefined;
		}

		const firstVisibleRow = this.scrollOffset + 1;
		const lastVisibleRow = this.scrollOffset + visibleRows;
		return `Lines ${firstVisibleRow}-${lastVisibleRow} of ${totalRows}`;
	}
}

function renderBorderedPanel(
	lines: readonly string[],
	width: number,
	theme: AskDialogTheme,
): string[] {
	if (width < FRAME_DECORATION_WIDTH) {
		return lines.map((line) => truncateToWidth(line, width));
	}

	const innerWidth = width - FRAME_DECORATION_WIDTH;
	const horizontal = "━".repeat(innerWidth + FRAME_HORIZONTAL_PADDING);
	return [
		theme.fg("borderAccent", `┏${horizontal}┓`),
		...lines.map((line) => {
			const clippedLine = truncateToWidth(line, innerWidth);
			const padding = " ".repeat(
				Math.max(0, innerWidth - visibleWidth(clippedLine)),
			);
			return (
				theme.fg("borderAccent", "┃") +
				` ${clippedLine}${padding} ` +
				theme.fg("borderAccent", "┃")
			);
		}),
		theme.fg("borderAccent", `┗${horizontal}┛`),
	];
}
