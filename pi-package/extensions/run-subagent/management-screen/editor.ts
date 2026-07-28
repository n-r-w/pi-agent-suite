import {
	getSelectListTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type Focusable,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";
import { errorMessage } from "../error-message";

/** Describes one stable-key management submission outcome. */
type ManagementSubmissionResult =
	| { readonly accepted: true }
	| { readonly accepted: false; readonly error: string };

/** Routes editor text to one complete stable session identity. */
export interface ManagementMessageSubmission {
	submit(stableKey: string, text: string): Promise<ManagementSubmissionResult>;
}

/** Supplies public editor dependencies without positional callback ambiguity. */
interface ManagementMessageEditorOptions {
	readonly tui: TUI;
	readonly theme: Theme;
	readonly keybindings: KeybindingsManager;
	readonly submission: ManagementMessageSubmission;
	readonly selectedStableKey: () => string | null;
	readonly notify: (message: string) => void;
	readonly onAccepted: () => void;
}

/** Connects the public Pi editor to stable-key management submission. */
export class ManagementMessageEditor implements Component, Focusable {
	private readonly editor: Editor;
	private pendingSubmissionText = "";
	private generation = 0;
	private enabled = true;
	private submissionPending = false;
	private disposed = false;
	private _focused = false;

	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly submission: ManagementMessageSubmission;
	private readonly selectedStableKey: () => string | null;
	private readonly notify: (message: string) => void;
	private readonly onAccepted: () => void;

	public constructor(options: ManagementMessageEditorOptions) {
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.submission = options.submission;
		this.selectedStableKey = options.selectedStableKey;
		this.notify = options.notify;
		this.onAccepted = options.onAccepted;
		this.editor = new Editor(
			options.tui,
			{
				borderColor: (text) => this.editorBorder(text),
				selectList: getSelectListTheme(),
			},
			{ paddingX: 0 },
		);
		this.editor.onSubmit = () => {
			const text = this.pendingSubmissionText;
			this.pendingSubmissionText = "";
			this.startSubmission(text);
		};
	}

	/** Propagates focus so Pi can place the hardware cursor for IME input. */
	public get focused(): boolean {
		return this._focused;
	}

	public set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
		this.editor.invalidate();
	}

	/** Returns the current editor contents. */
	public getText(): string {
		return this.editor.getExpandedText();
	}

	/** Replaces editor contents without submitting them. */
	public setText(text: string): void {
		if (!this.disposed) {
			this.editor.setText(text);
		}
	}

	/** Enables submission and editing only while one logical session is selected. */
	public setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		this.editor.disableSubmit = !enabled || this.submissionPending;
	}

	/** Delegates standard editing and submission to Pi's editor. */
	public handleInput(data: string): void {
		if (this.disposed || !this.enabled) {
			return;
		}
		if (this.keybindings.matches(data, "tui.input.submit")) {
			// Pi clears before onSubmit; retaining the expanded value lets a rejection
			// restore the exact multiline or pasted submission.
			this.pendingSubmissionText = this.editor.getExpandedText();
		}
		this.editor.handleInput(data);
	}

	/** Renders Pi's editor with focus-specific boundary emphasis. */
	public render(width: number): string[] {
		return this.disposed ? [] : this.editor.render(width);
	}

	/** Invalidates the underlying public editor. */
	public invalidate(): void {
		this.editor.invalidate();
	}

	/** Prevents pending submission callbacks from touching a closed overlay. */
	public dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.generation += 1;
		this._focused = false;
		this.editor.focused = false;
		this.editor.onSubmit = () => undefined;
		this.editor.onChange = () => undefined;
	}

	/** Starts one asynchronous submission without exposing a floating promise. */
	private startSubmission(text: string): void {
		if (text.length === 0 || this.disposed) {
			return;
		}
		const stableKey = this.selectedStableKey();
		if (stableKey === null) {
			this.restoreRejectedText(text);
			return;
		}
		const generation = this.generation;
		this.submissionPending = true;
		this.editor.disableSubmit = true;
		this.submission
			.submit(stableKey, text)
			.then((result) => this.finishSubmission(generation, text, result))
			.catch((error: unknown) =>
				this.finishSubmission(generation, text, {
					accepted: false,
					error: errorMessage(error),
				}),
			);
	}

	/** Applies an accepted or rejected result only to the originating screen. */
	private finishSubmission(
		generation: number,
		text: string,
		result: ManagementSubmissionResult,
	): void {
		if (this.disposed || generation !== this.generation) {
			return;
		}
		this.submissionPending = false;
		this.editor.disableSubmit = !this.enabled;
		if (result.accepted) {
			// Pi already cleared the accepted text. Any text typed while awaiting
			// acceptance belongs to the next message and remains untouched.
			this.onAccepted();
			return;
		}
		this.restoreRejectedText(text);
		this.notify(result.error);
	}

	/** Restores submitted text before any text typed during coordination. */
	private restoreRejectedText(text: string): void {
		const current = this.editor.getExpandedText();
		this.editor.setText(`${text}${current}`);
	}

	/** Applies the focus invariant through the public editor border callback. */
	private editorBorder(text: string): string {
		return this.theme.fg(this.focused ? "borderAccent" : "borderMuted", text);
	}
}
