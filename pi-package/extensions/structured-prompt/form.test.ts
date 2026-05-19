import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	StructuredPromptForm,
	type StructuredPromptFormResult,
} from "./form.ts";
import { PROMPT_SECTIONS } from "./formatter.ts";

const ENTER = "\r";
const ESCAPE = "\x1b";
const ARROW_DOWN = "\x1b[B";
const PAGE_DOWN = "\x1b[6~";
const HOME = "\x1b[H";
const CTRL_T = "\x14";
const CTRL_Y = "\x19";

describe("structured-prompt form", () => {
	test("submits entered section values from the review screen", () => {
		// Purpose: users must review the generated prompt before it can be submitted.
		// Input and expected output: text entered in Goal is submitted only after the review confirmation.
		// Edge case: empty later sections are allowed and are returned for formatter filtering.
		// Dependencies: this test uses the form component with fake TUI and theme dependencies.
		const observedResults: StructuredPromptFormResult[] = [];
		const form = createForm((result) => observedResults.push(result));

		typeText(form, "Create structured requests");
		for (const _section of PROMPT_SECTIONS) {
			form.handleInput(ENTER);
		}
		expect(observedResults).toEqual([]);

		form.handleInput(ENTER);

		expect(observedResults).toEqual([
			{
				kind: "submitted",
				values: [
					{ sectionId: "goal", value: "Create structured requests" },
					{ sectionId: "task", value: "" },
					{ sectionId: "context", value: "" },
					{ sectionId: "criteria", value: "" },
					{ sectionId: "constraints", value: "" },
					{ sectionId: "work-order", value: "" },
				],
			},
		]);
	});

	test("preserves pasted multi-line text in a section", () => {
		// Purpose: request sections must support multi-line content.
		// Input and expected output: one pasted chunk with a newline is submitted unchanged for the active section.
		// Edge case: the newline is part of section content and does not advance the wizard.
		// Dependencies: this test uses the form component with fake TUI and theme dependencies.
		const observedResults: StructuredPromptFormResult[] = [];
		const form = createForm((result) => observedResults.push(result));

		typeText(form, "Line one\nLine two");
		for (const _section of PROMPT_SECTIONS) {
			form.handleInput(ENTER);
		}
		form.handleInput(ENTER);

		expect(observedResults[0]).toEqual({
			kind: "submitted",
			values: expect.arrayContaining([
				{ sectionId: "goal", value: "Line one\nLine two" },
			]),
		});
	});

	test("does not insert navigation escape sequences into section text", () => {
		// Purpose: terminal navigation keys must remain editor controls, not prompt content.
		// Input and expected output: arrow-up after typed text is not submitted as section text.
		// Edge case: the arrow key is a multi-byte terminal sequence.
		// Dependencies: this test uses the form component with fake TUI and theme dependencies.
		const observedResults: StructuredPromptFormResult[] = [];
		const form = createForm((result) => observedResults.push(result));

		typeText(form, "Goal text");
		form.handleInput("\x1b[A");
		for (const _section of PROMPT_SECTIONS) {
			form.handleInput(ENTER);
		}
		form.handleInput(ENTER);

		expect(observedResults[0]).toEqual({
			kind: "submitted",
			values: expect.arrayContaining([
				{ sectionId: "goal", value: "Goal text" },
			]),
		});
	});

	test("cancels without submitting values", () => {
		// Purpose: users need an explicit no-send exit path.
		// Input and expected output: Escape reports cancellation and no submitted values.
		// Edge case: cancellation works after editing has started.
		// Dependencies: this test uses the form component with fake TUI and theme dependencies.
		const observedResults: StructuredPromptFormResult[] = [];
		const form = createForm((result) => observedResults.push(result));

		typeText(form, "Draft text");
		form.handleInput(ESCAPE);

		expect(observedResults).toEqual([{ kind: "cancelled" }]);
	});

	test("renders the form inside a bright outer border", () => {
		// Purpose: the prompt dialog must be visually separated from the chat background.
		// Input and expected output: rendered rows include a full outer border.
		// Edge case: the frame is present before any section text is entered.
		// Dependencies: this test uses structural border checks and visible width measurement.
		const form = createForm(() => {});
		const rows = form.render(48);

		expect(rows.length).toBeGreaterThan(2);
		expect(rows[0]).toContain("┏");
		expect(rows[0]).toContain("┓");
		expect(rows.at(-1)).toContain("┗");
		expect(rows.at(-1)).toContain("┛");
		expect(rows.every((row) => visibleWidth(row) <= 48)).toBe(true);
	});

	test("keeps bordered rows within width when the theme emits ANSI colors", () => {
		// Purpose: real Pi themes add ANSI color sequences that must not break layout width.
		// Input and expected output: styled border and styled labels still fit within the requested width.
		// Edge case: border and content styling are both present.
		// Dependencies: this test uses public visible width measurement.
		const form = new StructuredPromptForm({
			tui: {
				terminal: { rows: 40 },
				requestRender(): void {},
			} as never,
			theme: {
				fg: (_color, value) => `\u001b[96m${value}\u001b[39m`,
				bold: (value) => `\u001b[1m${value}\u001b[22m`,
			},
			sections: PROMPT_SECTIONS,
			onDone: () => {},
		});

		const rows = form.render(48);

		expect(rows.every((row) => visibleWidth(row) <= 48)).toBe(true);
	});

	test("bounds long review output to the terminal height", () => {
		// Purpose: long generated prompts must not overflow the terminal during review.
		// Input and expected output: a long review renders no more rows than the terminal height.
		// Edge case: wrapped frame, header, help, and preview rows all count against the limit.
		// Dependencies: this test uses the form component with a small fake terminal height.
		const form = createForm(() => {}, { rows: 12 });
		openReviewWithGoal(form, numberedLines(80));

		const rows = form.render(64);

		expect(rows.length).toBeLessThanOrEqual(12);
		expect(rows.join("\n")).toContain("line-001");
		expect(rows.join("\n")).not.toContain("line-080");
	});

	test("scrolls the long review preview without moving the frame", () => {
		// Purpose: users must be able to inspect long generated prompts before sending.
		// Input and expected output: Down and PageDown change visible preview lines, Home returns to the start.
		// Edge case: scrolling affects only the review preview area.
		// Dependencies: this test uses terminal escape sequences for navigation keys.
		const form = createForm(() => {}, { rows: 12 });
		openReviewWithGoal(form, numberedLines(80));

		const initialRows = form.render(64).join("\n");
		form.handleInput(ARROW_DOWN);
		const downRows = form.render(64).join("\n");
		form.handleInput(PAGE_DOWN);
		const pageRows = form.render(64).join("\n");
		form.handleInput(HOME);
		const homeRows = form.render(64).join("\n");

		expect(initialRows).toContain("line-001");
		expect(downRows).not.toBe(initialRows);
		expect(pageRows).not.toBe(downRows);
		expect(homeRows).toBe(initialRows);
	});

	test("can scroll to the bottom of a wrapped narrow review", () => {
		// Purpose: narrow terminals wrap preview lines and must still allow reaching the end.
		// Input and expected output: repeated PageDown reaches the final visual content.
		// Edge case: scroll limits use the current rendered width, not a fixed width.
		// Dependencies: this test renders before scrolling so the component can measure the viewport.
		const form = createForm(() => {}, { rows: 12 });
		const longGoal = Array.from(
			{ length: 30 },
			(_value, index) =>
				`line-${String(index + 1).padStart(3, "0")} has a long wrapped suffix`,
		).join("\n");
		openReviewWithGoal(form, longGoal);
		form.render(32);

		for (let index = 0; index < 20; index += 1) {
			form.handleInput(PAGE_DOWN);
		}

		const rows = form.render(32).join("\n");

		expect(rows).toContain("line-030");
	});

	test("submits the full generated prompt after review scrolling", () => {
		// Purpose: review scrolling must not truncate the message sent to the agent.
		// Input and expected output: after scrolling, submit returns the complete section value.
		// Edge case: the submitted value contains lines that were not visible in the review viewport.
		// Dependencies: this test uses the form component result instead of Pi delivery.
		const observedResults: StructuredPromptFormResult[] = [];
		const form = createForm((result) => observedResults.push(result), {
			rows: 12,
		});
		const longGoal = numberedLines(80);
		openReviewWithGoal(form, longGoal);

		form.handleInput(PAGE_DOWN);
		form.handleInput(ENTER);

		expect(observedResults).toEqual([
			{
				kind: "submitted",
				values: expect.arrayContaining([
					{ sectionId: "goal", value: longGoal },
				]),
			},
		]);
	});

	test("copies the full generated prompt from review without closing it", async () => {
		// Purpose: users must be able to copy the generated prompt before deciding whether to send.
		// Input and expected output: Ctrl+Y reports the full formatted prompt and Enter can still submit.
		// Edge case: the copied text contains rows that are outside the current review viewport.
		// Dependencies: this test uses a callback fake for the clipboard action.
		const observedResults: StructuredPromptFormResult[] = [];
		const copiedPrompts: string[] = [];
		const form = createForm((result) => observedResults.push(result), {
			onCopyPrompt: (promptText) => copiedPrompts.push(promptText),
			rows: 12,
		});
		const longGoal = numberedLines(80);
		openReviewWithGoal(form, longGoal);

		form.handleInput(PAGE_DOWN);
		form.handleInput(CTRL_Y);
		await waitForCopySettlement();
		form.handleInput(ENTER);

		expect(copiedPrompts).toEqual([["## Goal", longGoal].join("\n")]);
		expect(observedResults).toEqual([
			{
				kind: "submitted",
				values: expect.arrayContaining([
					{ sectionId: "goal", value: longGoal },
				]),
			},
		]);
	});

	test("waits for review copy before allowing submit", async () => {
		// Purpose: copying before sending must not race with an immediate Enter press.
		// Input and expected output: Enter is ignored while Ctrl+Y copy is still pending, then works after copy finishes.
		// Edge case: the clipboard callback is asynchronous.
		// Dependencies: this test uses a deferred callback fake for the clipboard action.
		const observedResults: StructuredPromptFormResult[] = [];
		const copy = createDeferred();
		const form = createForm((result) => observedResults.push(result), {
			onCopyPrompt: () => copy.promise,
			rows: 12,
		});
		const longGoal = numberedLines(80);
		openReviewWithGoal(form, longGoal);

		form.handleInput(CTRL_Y);
		form.handleInput(ENTER);
		expect(observedResults).toEqual([]);

		copy.resolve();
		await copy.promise;
		await waitForCopySettlement();
		form.handleInput(ENTER);

		expect(observedResults).toEqual([
			{
				kind: "submitted",
				values: expect.arrayContaining([
					{ sectionId: "goal", value: longGoal },
				]),
			},
		]);
	});

	test("unblocks submit after a synchronous review copy failure", async () => {
		// Purpose: a clipboard callback defect must not leave review actions blocked.
		// Input and expected output: a synchronous copy failure is swallowed and a later Enter submits.
		// Edge case: the callback throws before returning a Promise.
		// Dependencies: this test uses a throwing callback fake for the clipboard action.
		const observedResults: StructuredPromptFormResult[] = [];
		const form = createForm((result) => observedResults.push(result), {
			onCopyPrompt: () => {
				throw new Error("copy callback failed");
			},
			rows: 12,
		});
		const longGoal = numberedLines(80);
		openReviewWithGoal(form, longGoal);

		form.handleInput(CTRL_Y);
		await waitForCopySettlement();
		form.handleInput(ENTER);

		expect(observedResults).toEqual([
			{
				kind: "submitted",
				values: expect.arrayContaining([
					{ sectionId: "goal", value: longGoal },
				]),
			},
		]);
	});

	test("returns the full generated prompt for input placement without submitting", () => {
		// Purpose: users must be able to place the generated prompt in the main input instead of sending it.
		// Input and expected output: Ctrl+T returns an inserted result with all section values.
		// Edge case: Enter after Ctrl+T does not create a later submit result because the form is closed.
		// Dependencies: this test uses the form component result instead of Pi editor integration.
		const observedResults: StructuredPromptFormResult[] = [];
		const form = createForm((result) => observedResults.push(result), {
			rows: 12,
		});
		const longGoal = numberedLines(80);
		openReviewWithGoal(form, longGoal);

		form.handleInput(PAGE_DOWN);
		form.handleInput(CTRL_T);
		form.handleInput(ENTER);

		expect(observedResults).toEqual([
			{
				kind: "inserted",
				values: expect.arrayContaining([
					{ sectionId: "goal", value: longGoal },
				]),
			},
		]);
	});

	test("keeps rendered rows within the requested width", () => {
		// Purpose: the custom overlay must honor the TUI render width contract.
		// Input and expected output: narrow and normal widths produce rows within those widths.
		// Edge case: long entered text is present before rendering.
		// Dependencies: this test uses public visible width measurement.
		const form = createForm(() => {});
		typeText(
			form,
			"A very long goal that must be wrapped or clipped inside the structured prompt form overlay",
		);

		for (const width of [32, 80]) {
			const rows = form.render(width);
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
		}
	});
});

function createForm(
	onDone: (result: StructuredPromptFormResult) => void,
	options: {
		readonly onCopyPrompt?: (promptText: string) => void;
		readonly rows?: number;
	} = {},
): StructuredPromptForm {
	return new StructuredPromptForm({
		tui: {
			terminal: { rows: options.rows ?? 40 },
			requestRender(): void {},
		} as never,
		theme: {
			fg: (_color, value) => value,
			bold: (value) => value,
		},
		sections: PROMPT_SECTIONS,
		onCopyPrompt: options.onCopyPrompt,
		onDone,
	});
}

function openReviewWithGoal(form: StructuredPromptForm, goal: string): void {
	typeText(form, goal);
	for (const _section of PROMPT_SECTIONS) {
		form.handleInput(ENTER);
	}
}

function numberedLines(count: number): string {
	return Array.from(
		{ length: count },
		(_value, index) => `line-${String(index + 1).padStart(3, "0")}`,
	).join("\n");
}

function typeText(form: StructuredPromptForm, value: string): void {
	form.handleInput(value);
}

async function waitForCopySettlement(): Promise<void> {
	for (let index = 0; index < 5; index += 1) {
		await Promise.resolve();
	}
}

function createDeferred(): {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
} {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	if (resolvePromise === undefined) {
		throw new Error("deferred promise resolver was not initialized");
	}
	return { promise, resolve: resolvePromise };
}
