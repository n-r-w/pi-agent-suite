import { describe, expect, spyOn, test } from "bun:test";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionContext,
	SessionEntry,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	getMarkdownTheme,
	initTheme,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Terminal, TUI } from "@earendil-works/pi-tui";
import {
	CURSOR_MARKER,
	KeybindingsManager,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { SubagentCoordinator } from "../coordinator";
import type { LogicalSession, OwnerIdentity } from "../domain";
import type {
	InvocationAcceptance,
	InvocationControl,
} from "../invocation-contracts";
import { SUBAGENT_JOURNAL_CUSTOM_TYPE, V2SessionStore } from "../persistence";
import type {
	ConversationProjectionEntry,
	ManagementProjectionView,
	ProjectionNode,
} from "../projection";
import { SessionCatalog } from "../session-catalog";
import { createToolPresentationRegistry } from "../tool-rendering";
import { WaitCoordinator } from "../wait-coordinator";
import type { ManagementMessageSubmission } from "./editor";
import { ManagementProjectionRuntime } from "./runtime";
import {
	createManagementRetainedState,
	createManagementScreenFactory,
	findProjectionNode,
	type ManagementRetainedState,
	ManagementScreen,
	type ManagementViewSource,
	openManagementOverlay,
} from "./screen";

/** Splits returned strings into physical terminal rows. */
const PHYSICAL_ROW_BREAK = /\r\n|[\n\r]/;

/** Uses terminal input sequences rather than key identifier strings. */
const INPUT = {
	tab: "\t",
	shiftTab: "\u001b[Z",
	enter: "\r",
	escape: "\u001b",
	ctrlShiftG: "\u001b[103;6u",
	expandTools: "\u000f",
	down: "\u001b[B",
	pageUp: "\u001b[5~",
	pageDown: "\u001b[6~",
} as const;

/** Creates the minimal deterministic TUI used by the management component. */
function createTui(rows = 18): TUI & { readonly renderRequests: number } {
	let renderRequests = 0;
	return {
		terminal: { rows, columns: 80 } as Terminal,
		get renderRequests(): number {
			return renderRequests;
		},
		requestRender(): void {
			renderRequests += 1;
		},
		setFocus(): void {},
	} as unknown as TUI & { readonly renderRequests: number };
}

/** Provides configured application and TUI actions for screen input ownership. */
function createKeybindings(): KeybindingsManager {
	return new KeybindingsManager({
		"tui.input.submit": { defaultKeys: "enter" },
		"tui.select.up": { defaultKeys: "up" },
		"tui.select.down": { defaultKeys: "down" },
		"tui.select.pageUp": { defaultKeys: "pageUp" },
		"tui.select.pageDown": { defaultKeys: "pageDown" },
		"tui.select.confirm": { defaultKeys: "enter" },
		"app.tools.expand": { defaultKeys: "ctrl+o" },
	});
}

/** Provides marker-free screen colors while preserving Pi Theme method ownership. */
function createTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
}

/** Marks only focus-accent foreground spans for visual ownership assertions. */
function createFocusTheme(): Theme {
	return {
		fg: (color: string, text: string) => {
			if (color === "borderAccent") {
				return `\u001b[36m${text}\u001b[39m`;
			}
			if (color === "borderMuted") {
				return `\u001b[90m${text}\u001b[39m`;
			}
			if (color === "border") {
				return `\u001b[37m${text}\u001b[39m`;
			}
			if (color === "accent") {
				return `\u001b[35m${text}\u001b[39m`;
			}
			return text;
		},
		bg: (color: string, text: string) => {
			if (color === "selectedBg") {
				return `\u001b[44m${text}\u001b[49m`;
			}
			if (color === "toolPendingBg") {
				return `\u001b[40m${text}\u001b[49m`;
			}
			return text;
		},
		bold: (text: string) => text,
	} as Theme;
}

/** Creates one selected logical session for screen interactions. */
function selectedNode(): ProjectionNode {
	return {
		stableKey: "stable-descendant-key",
		key: { ownerPiSessionId: "nested-owner", ownerLocalSessionId: 1 },
		parentStableKey: null,
		childPiSessionId: "child-session",
		agentId: "SubAgentDeveloper",
		taskName: "Implement the selected descendant",
		creationOrder: 1,
		state: "active",
	};
}

/** Narrows the deterministic conversation fixture to its user-message role. */
type UserConversationEntry = Extract<
	SessionEntry,
	{ readonly type: "message" }
> & {
	readonly message: UserMessage;
};

/** Creates one projected public user message. */
function conversationEntry(text: string): UserConversationEntry {
	const message: UserMessage = { role: "user", content: text, timestamp: 1 };
	return {
		type: "message",
		id: `message-${text}`,
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message,
	} satisfies SessionEntry;
}

/** Creates one projected assistant message with model and context metadata. */
function assistantConversationEntry(): ConversationProjectionEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "assistant metadata" }],
		api: "openai-responses",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
	return {
		type: "message",
		id: "assistant-metadata",
		parentId: null,
		timestamp: new Date(2).toISOString(),
		message,
	} satisfies SessionEntry;
}

/** Publishes deterministic immutable views and tracks overlay subscriptions. */
class ViewSourceFake implements ManagementViewSource {
	public selected: string | null;
	public earlierCalls = 0;
	public refreshCalls = 0;
	public unsubscribeCalls = 0;
	private readonly listeners = new Set<
		(view: ManagementProjectionView) => void
	>();
	private view: ManagementProjectionView;

	/** Seeds one immutable selected-node revision for the screen under test. */
	public constructor(node: ProjectionNode = selectedNode()) {
		this.selected = node.stableKey;
		this.view = {
			revision: 1,
			nodes: [node],
			selectedStableKey: node.stableKey,
			selectedConversation: [conversationEntry("initial conversation")],
			selectedConversationComplete: true,
			affectedStableKeys: [node.stableKey],
		};
	}

	/** Returns the latest immutable projection revision. */
	public getView(): ManagementProjectionView {
		return this.view;
	}

	/** Records complete stable identity selection without changing orchestration. */
	public select(stableKey: string | null): void {
		this.selected = stableKey;
	}

	/** Records one viewport-driven request and reports that no further preview page exists. */
	public loadEarlierSelected(): boolean {
		this.earlierCalls += 1;
		return true;
	}

	/** Records selected-branch refresh requests after accepted submissions. */
	public refreshSelected(): void {
		this.refreshCalls += 1;
	}

	/** Registers one overlay-local revision listener. */
	public subscribe(
		listener: (view: ManagementProjectionView) => void,
	): () => void {
		this.listeners.add(listener);
		return () => {
			this.unsubscribeCalls += 1;
			this.listeners.delete(listener);
		};
	}

	/** Publishes one visible revision to current subscribers. */
	public publish(view: ManagementProjectionView): void {
		this.view = view;
		for (const listener of this.listeners) {
			listener(view);
		}
	}
}

/** Supplies active entry pages and emits selected invocation activity. */
class ActiveConversationSourceFake {
	public entries: readonly SessionEntry[] = [conversationEntry("active")];
	public error: Error | undefined;
	public readCalls = 0;
	public readonly sinceValues: Array<string | undefined> = [];
	private readonly listeners = new Set<(invocationId: string) => void>();

	/** Returns one deterministic append-order page for the selected active session. */
	public async readActiveEntries(
		_invocationId: string,
		since?: string,
	): Promise<{
		readonly entries: readonly SessionEntry[];
		readonly leafId: string | null;
	}> {
		this.readCalls += 1;
		this.sinceValues.push(since);
		if (this.error !== undefined) {
			throw this.error;
		}
		const sinceIndex =
			since === undefined
				? -1
				: this.entries.findIndex((entry) => entry.id === since);
		if (since !== undefined && sinceIndex === -1) {
			throw new Error(`unknown fake conversation entry: ${since}`);
		}
		return {
			entries:
				since === undefined ? this.entries : this.entries.slice(sinceIndex + 1),
			leafId: this.entries.at(-1)?.id ?? null,
		};
	}

	/** Registers one root-runtime activity listener. */
	public subscribeActivity(
		listener: (invocationId: string) => void,
	): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Emits one child session event for projection refresh. */
	public emit(invocationId: string): void {
		for (const listener of this.listeners) {
			listener(invocationId);
		}
	}
}

/** Creates one catalog session for projection-runtime subscription checks. */
function logicalSession(): LogicalSession {
	return {
		key: { ownerPiSessionId: "root-owner", ownerLocalSessionId: 1 },
		childPiSessionId: "child-session",
		childSessionDir: "/tmp/child-session",
		childSessionFile: "/tmp/child-session/session.jsonl",
		agentId: "SubAgentDeveloper",
		taskName: "Observe live projection",
		creationOrder: 1,
		invocationId: "active-invocation",
		runtimeLeaseId: "active-lease",
		invocationMetadata: { startedAtMs: 0, elapsedMs: 0 },
		state: "active",
	};
}

/** Records stable-key submissions and returns a configurable result. */
class SubmissionFake implements ManagementMessageSubmission {
	public readonly calls: { stableKey: string; text: string }[] = [];
	public error: Error | undefined;
	public result: Awaited<ReturnType<ManagementMessageSubmission["submit"]>> = {
		accepted: false,
		error: "selected descendant rejected the message",
	};

	/** Returns the configured coordinator-facing acceptance result. */
	public async submit(
		stableKey: string,
		text: string,
	): ReturnType<ManagementMessageSubmission["submit"]> {
		this.calls.push({ stableKey, text });
		if (this.error !== undefined) {
			throw this.error;
		}
		return this.result;
	}
}

/** Creates a screen whose only mutable dependencies are explicit fakes. */
function createScreen(
	options: {
		readonly node?: ProjectionNode;
		readonly retained?: ManagementRetainedState;
		readonly rows?: number;
		readonly toolsExpanded?: boolean;
		readonly theme?: Theme;
	} = {},
) {
	initTheme(undefined, false);
	const tui = createTui(options.rows);
	const theme = options.theme ?? createTheme();
	const keybindings = createKeybindings();
	const source = new ViewSourceFake(options.node);
	const submission = new SubmissionFake();
	const notifications: string[] = [];
	let closeCalls = 0;
	const retained = options.retained ?? createManagementRetainedState();
	if (options.retained === undefined) {
		retained.hierarchy = {
			expandedStableKeys: [],
			selectedStableKey: "stable-descendant-key",
			scrollTop: 0,
		};
	}
	const tools = createToolPresentationRegistry(
		"/tmp",
		SessionManager.inMemory("/tmp/subagents-v2-screen"),
	);
	const screen = new ManagementScreen({
		tui,
		theme,
		keybindings,
		cwd: "/tmp",
		source,
		tools,
		submission,
		retained,
		toolsExpanded: options.toolsExpanded ?? false,
		notify: (message) => notifications.push(message),
		close: () => {
			closeCalls += 1;
		},
	});
	return {
		screen,
		tui,
		source,
		submission,
		notifications,
		retained,
		getCloseCalls: () => closeCalls,
		markdownTheme: getMarkdownTheme(),
	};
}

/** Lets one queued async editor submission settle without timers. */
async function settleSubmission(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

/** Waits for one deterministic asynchronous projection condition without wall-clock timers. */
async function settleProjection(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (condition()) {
			return;
		}
		await Promise.resolve();
	}
	throw new Error("management projection did not settle");
}

describe("management screen", () => {
	test("preserves rejected editor input", async () => {
		// Purpose: submission must route by complete stable identity and preserve non-empty input when coordination rejects it.
		// Inputs and expected output: zero characters no-op, rejected text notifies once, and accepted text clears only after acceptance.
		// Edge case: the selected owner-local ID repeats elsewhere but never enters the submission port.
		// Dependencies: public Pi Editor behavior and a coordinator-facing stable-key submission port.
		// ARRANGE: focus the editor through the screen-owned Tab cycle.
		const fixture = createScreen();
		fixture.screen.handleInput(INPUT.tab);
		fixture.screen.handleInput(INPUT.tab);
		expect(fixture.screen.getFocusZone()).toBe("editor");

		// ACT: submit empty text, rejected text, then the same text after acceptance.
		fixture.screen.handleInput(INPUT.enter);
		await settleSubmission();
		fixture.screen.setEditorText("Continue this exact descendant");
		fixture.screen.handleInput(INPUT.enter);
		await settleSubmission();
		const rejectedText = fixture.screen.getEditorText();
		fixture.submission.result = { accepted: true };
		fixture.screen.handleInput(INPUT.enter);
		await settleSubmission();

		// ASSERT: zero input is ignored, rejection preserves and notifies, and acceptance clears and refreshes.
		expect({
			calls: fixture.submission.calls,
			rejectedText,
			notifications: fixture.notifications,
			acceptedText: fixture.screen.getEditorText(),
			refreshCalls: fixture.source.refreshCalls,
		}).toEqual({
			calls: [
				{
					stableKey: "stable-descendant-key",
					text: "Continue this exact descendant",
				},
				{
					stableKey: "stable-descendant-key",
					text: "Continue this exact descendant",
				},
			],
			rejectedText: "Continue this exact descendant",
			notifications: ["selected descendant rejected the message"],
			acceptedText: "",
			refreshCalls: 1,
		});
	});

	test("keeps a long pasted draft and cursor viewport through submission outcomes", async () => {
		// Purpose: screen row allocation must preserve Pi Editor's current multiline viewport instead of clipping its newest rows and cursor.
		// Inputs and expected output: a ten-line bracketed paste plus one edit remains visible after rejection and clears only after acceptance.
		// Edge case: every state retains the complete terminal height, cursor marker, and bottom editor boundary after the cursor-bearing row.
		// Dependencies: public Pi Editor paste, cursor marker, submission clearing, and rejection restoration behavior.
		// ARRANGE: focus the public editor and paste beyond the available three-row viewport.
		const fixture = createScreen({ rows: 12 });
		fixture.screen.focused = true;
		fixture.screen.handleInput(INPUT.tab);
		fixture.screen.handleInput(INPUT.tab);
		const draft = Array.from(
			{ length: 10 },
			(_unused, index) => `draft-${index + 1}`,
		).join("\n");
		fixture.screen.handleInput(`\u001b[200~${draft}\u001b[201~`);
		fixture.screen.handleInput("!");
		const editedText = `${draft}!`;
		const editedRows = fixture.screen.render(80);
		const editedCursorRow = editedRows.findIndex((line) =>
			line.includes(CURSOR_MARKER),
		);

		// ACT: reject the long draft once, then accept the restored draft.
		fixture.screen.handleInput(INPUT.enter);
		await settleSubmission();
		const rejectedRows = fixture.screen.render(80);
		const rejectedCursorRow = rejectedRows.findIndex((line) =>
			line.includes(CURSOR_MARKER),
		);
		const rejectedText = fixture.screen.getEditorText();
		fixture.submission.result = { accepted: true };
		fixture.screen.handleInput(INPUT.enter);
		await settleSubmission();
		const acceptedRows = fixture.screen.render(80);
		const acceptedCursorRow = acceptedRows.findIndex((line) =>
			line.includes(CURSOR_MARKER),
		);

		// ASSERT: newest text and cursor stay inside a bounded viewport after edit/rejection, while accepted clear keeps a valid empty editor.
		expect({
			editedText: fixture.submission.calls[0]?.text,
			editedNewestVisible: editedRows[editedCursorRow]?.includes("draft-10!"),
			editedBoundaryVisible:
				editedCursorRow >= 0 &&
				(editedRows[editedCursorRow + 1]?.includes("─") ?? false),
			editedRows: editedRows.length,
			editedRowsFit: editedRows.every((line) => visibleWidth(line) <= 80),
			rejectedText,
			rejectedNewestVisible:
				rejectedRows[rejectedCursorRow]?.includes("draft-10!"),
			rejectedBoundaryVisible:
				rejectedCursorRow >= 0 &&
				(rejectedRows[rejectedCursorRow + 1]?.includes("─") ?? false),
			rejectedRows: rejectedRows.length,
			acceptedText: fixture.screen.getEditorText(),
			acceptedCursorVisible: acceptedCursorRow >= 0,
			acceptedBoundaryVisible:
				acceptedCursorRow >= 0 &&
				(acceptedRows[acceptedCursorRow + 1]?.includes("─") ?? false),
			acceptedRows: acceptedRows.length,
			refreshCalls: fixture.source.refreshCalls,
		}).toEqual({
			editedText,
			editedNewestVisible: true,
			editedBoundaryVisible: true,
			editedRows: 12,
			editedRowsFit: true,
			rejectedText: editedText,
			rejectedNewestVisible: true,
			rejectedBoundaryVisible: true,
			rejectedRows: 12,
			acceptedText: "",
			acceptedCursorVisible: true,
			acceptedBoundaryVisible: true,
			acceptedRows: 12,
			refreshCalls: 1,
		});
	});

	test("restores input after an unexpected submission failure", async () => {
		// Purpose: infrastructure rejection must follow the same editor preservation and notification contract as a normal rejected result.
		// Inputs and expected output: a thrown coordinator failure restores the exact text and reports its safe Error message.
		// Edge case: no accepted refresh occurs after the thrown failure.
		// Dependencies: public Pi Editor submission callback and promise rejection handling.
		// ARRANGE: focus the editor and configure the submission port to reject its promise.
		const fixture = createScreen();
		fixture.screen.handleInput(INPUT.tab);
		fixture.screen.handleInput(INPUT.tab);
		fixture.submission.error = new Error("coordinator transport failed");
		fixture.screen.setEditorText("Preserve after thrown failure");

		// ACT: submit and let the rejection callback restore the cleared editor.
		fixture.screen.handleInput(INPUT.enter);
		await settleSubmission();

		// ASSERT: text and notification survive while accepted refresh remains untouched.
		expect({
			text: fixture.screen.getEditorText(),
			notifications: fixture.notifications,
			refreshCalls: fixture.source.refreshCalls,
		}).toEqual({
			text: "Preserve after thrown failure",
			notifications: ["coordinator transport failed"],
			refreshCalls: 0,
		});
	});

	test("switches to one pane below both pane minima", () => {
		// Purpose: responsive selection must preserve the exact 24/40 content minima beside two reserved scroll columns.
		// Inputs and expected output: total width 69 is wide, width 68 is one-pane hierarchy, and activation opens the selected conversation.
		// Edge case: Escape returns to hierarchy before closing and selection survives every transition.
		// Dependencies: fixed-width screen composition and screen-owned key handling.
		// ARRANGE: create one selected hierarchy and a terminal row budget.
		const fixture = createScreen();

		// ACT: cross the exact width boundary, activate the narrow selection, and apply two Escape presses.
		const wide = fixture.screen.layoutForWidth(69);
		const narrow = fixture.screen.layoutForWidth(68);
		const narrowRows = fixture.screen.render(68);
		fixture.screen.handleInput(INPUT.enter);
		const openedPane = fixture.screen.getNarrowPane();
		fixture.screen.handleInput(INPUT.escape);
		const returnedPane = fixture.screen.getNarrowPane();
		fixture.screen.handleInput(INPUT.escape);

		// ASSERT: width, row budget, pane sequence, selection, and close ownership match the contract.
		expect({
			wide,
			narrow,
			rows: narrowRows.length,
			openedPane,
			returnedPane,
			selected: fixture.screen.getSelectedStableKey(),
			closeCalls: fixture.getCloseCalls(),
		}).toEqual({
			wide: "wide",
			narrow: "one-pane",
			rows: 18,
			openedPane: "conversation",
			returnedPane: "hierarchy",
			selected: "stable-descendant-key",
			closeCalls: 1,
		});
	});

	test("reopens one-pane overlays on hierarchy with only approved state", () => {
		// Purpose: every overlay instance must start the one-pane state machine at hierarchy while retaining only hierarchy expansion and valid selection.
		// Inputs and expected output: narrow conversation, wide close, and narrow reopen reset pane, focus, and local tool expansion.
		// Edge case: the reopened overlay must still execute conversation-to-hierarchy-to-close through two exact Escape presses.
		// Dependencies: shared retained hierarchy state and separate disposable screen instances.
		// ARRANGE: seed approved hierarchy retention and move the first overlay to narrow conversation with local tools expanded.
		const retained = createManagementRetainedState();
		retained.hierarchy = {
			expandedStableKeys: ["stable-descendant-key"],
			selectedStableKey: "stable-descendant-key",
			scrollTop: 0,
		};
		const first = createScreen({ retained });
		first.screen.render(66);
		first.screen.handleInput(INPUT.enter);
		first.screen.handleInput(INPUT.expandTools);
		const firstConversationPane = first.screen.getNarrowPane();
		first.screen.render(80);
		first.screen.handleInput(INPUT.escape);
		first.screen.dispose();

		// ACT: create a new overlay from the retained state, render narrow, and run the complete open/back/close sequence.
		const reopened = createScreen({ retained });
		const reopenedPane = reopened.screen.getNarrowPane();
		const reopenedFocus = reopened.screen.getFocusZone();
		const reopenedToolsExpanded = reopened.screen.getToolsExpanded();
		reopened.screen.render(66);
		reopened.screen.handleInput(INPUT.enter);
		const openedPane = reopened.screen.getNarrowPane();
		reopened.screen.handleInput(INPUT.escape);
		const returnedPane = reopened.screen.getNarrowPane();
		reopened.screen.handleInput(INPUT.escape);

		// ASSERT: only hierarchy expansion and valid selection survive; each new overlay owns a fresh one-pane transition state.
		expect({
			firstConversationPane,
			firstCloseCalls: first.getCloseCalls(),
			retainedExpansion: retained.hierarchy.expandedStableKeys,
			reopenedPane,
			reopenedFocus,
			reopenedToolsExpanded,
			reopenedSelection: reopened.screen.getSelectedStableKey(),
			openedPane,
			returnedPane,
			reopenedCloseCalls: reopened.getCloseCalls(),
		}).toEqual({
			firstConversationPane: "conversation",
			firstCloseCalls: 1,
			retainedExpansion: ["stable-descendant-key"],
			reopenedPane: "hierarchy",
			reopenedFocus: "hierarchy",
			reopenedToolsExpanded: false,
			reopenedSelection: "stable-descendant-key",
			openedPane: "conversation",
			returnedPane: "hierarchy",
			reopenedCloseCalls: 1,
		});
		reopened.screen.dispose();
	});

	test("renders the wide selected pane and configured conversation hints", () => {
		// Purpose: wide mode must compose hierarchy, selected header, conversation, editor, and focus-specific hints within the terminal budget.
		// Inputs and expected output: one selected active session renders at 80 columns, conversation page keys remain local, and wide Escape closes once.
		// Edge case: a one-column render still returns exactly the terminal row budget without overflowing.
		// Dependencies: public Pi message/editor rendering, theme width utilities, and configured keybindings.
		// ARRANGE: focus the mounted screen and render its complete wide layout.
		const fixture = createScreen();
		fixture.screen.focused = true;
		fixture.source.publish({
			...fixture.source.getView(),
			revision: 2,
			selectedConversation: [conversationEntry("projected update")],
			affectedStableKeys: ["stable-descendant-key"],
		});
		const wideRows = fixture.screen.render(80);

		// ACT: focus the conversation, exercise both page directions, invalidate children, and close from wide mode.
		fixture.screen.handleInput(INPUT.tab);
		fixture.screen.handleInput(INPUT.pageUp);
		fixture.screen.handleInput(INPUT.pageDown);
		const conversationRows = fixture.screen.render(80);
		fixture.screen.invalidate();
		const tinyRows = fixture.screen.render(1);
		fixture.screen.render(80);
		fixture.screen.handleInput(INPUT.escape);

		// ASSERT: hierarchy and conversation remain width-bounded, no routing label leaks, and hints match conversation focus.
		expect({
			wideRowCount: wideRows.length,
			wideRowsFit: wideRows.every((line) => visibleWidth(line) <= 80),
			selectedHeader: wideRows.some((line) =>
				line.includes("SubAgentDeveloper #1"),
			),
			conversation: wideRows.some((line) => line.includes("projected update")),
			focused: fixture.screen.focused,
			conversationHint: conversationRows.some(
				(line) => line.includes("scroll") && line.includes("page"),
			),
			routingHidden: conversationRows.every(
				(line) =>
					!line.includes("stable-descendant-key") && !line.includes("Path:"),
			),
			tinyRows: tinyRows.length,
			tinyRowsFit: tinyRows.every((line) => visibleWidth(line) <= 1),
			closeCalls: fixture.getCloseCalls(),
		}).toEqual({
			wideRowCount: 18,
			wideRowsFit: true,
			selectedHeader: true,
			conversation: true,
			focused: true,
			conversationHint: true,
			routingHidden: true,
			tinyRows: 18,
			tinyRowsFit: true,
			closeCalls: 1,
		});
	});

	test("shows live context usage only for the active invocation model", () => {
		// Purpose: a selected active session must expose the latest trustworthy context usage before the invocation terminates.
		// Inputs and expected output: matching assistant and invocation models show 120/190k; a later model switch hides that stale usage.
		// Edge case: the conversation can retain an assistant response from the prior model while the invocation metadata already identifies the new model.
		// Dependencies: selected conversation metadata, invocation metadata, and selected-header rendering.
		// ARRANGE: mount one active invocation with a known context window and no terminal usage.
		const node = {
			...selectedNode(),
			invocationMetadata: {
				startedAtMs: 1_700_000_000_000,
				elapsedMs: 2_000,
				modelId: "openai-codex/gpt-5.6-sol",
				contextWindow: 190_000,
			},
		};
		const fixture = createScreen({ node });
		fixture.source.publish({
			...fixture.source.getView(),
			revision: 2,
			selectedConversation: [assistantConversationEntry()],
			affectedStableKeys: [node.stableKey],
		});

		// ACT: render matching live usage, then switch the active invocation to another model without replacing the conversation.
		const matchingRows = fixture.screen.render(120);
		fixture.source.publish({
			...fixture.source.getView(),
			revision: 3,
			nodes: [
				{
					...node,
					invocationMetadata: {
						...node.invocationMetadata,
						modelId: "anthropic/claude-sonnet-4",
					},
				},
			],
			affectedStableKeys: [node.stableKey],
		});
		const switchedRows = fixture.screen.render(120);

		// ASSERT: current-model usage appears live while usage from another model remains hidden.
		expect({
			matchingUsage: matchingRows.some((line) => line.includes("120/190k")),
			staleUsageHidden: switchedRows.every(
				(line) => !line.includes("120/190k"),
			),
		}).toEqual({
			matchingUsage: true,
			staleUsageHidden: true,
		});
		fixture.screen.dispose();
	});

	test("updates selected active elapsed time until the invocation terminates", () => {
		// Purpose: the selected header must advance elapsed time while work remains active without mutating invocation snapshots.
		// Inputs and expected output: a one-second accepted snapshot renders as three seconds after the presentation clock advances and as the fixed terminal duration after completion.
		// Edge case: terminal projection and screen disposal clear the refresh timer without changing the finalized elapsed value.
		// Dependencies: controlled wall clock and interval callbacks, projection publication, and selected-header rendering.
		const startedAtMs = 1_700_000_000_000;
		let nowMs = startedAtMs + 1_000;
		let refresh: (() => void) | undefined;
		const intervalHandle = 1 as unknown as ReturnType<typeof setInterval>;
		const nowSpy = spyOn(Date, "now").mockImplementation(() => nowMs);
		const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((
			handler: () => void,
		) => {
			refresh = handler;
			return intervalHandle;
		}) as typeof setInterval);
		const clearIntervalSpy = spyOn(
			globalThis,
			"clearInterval",
		).mockImplementation(() => undefined);
		let fixture: ReturnType<typeof createScreen> | undefined;

		try {
			// ARRANGE: open the wide screen on one active invocation with accepted elapsed metadata.
			const activeNode: ProjectionNode = {
				...selectedNode(),
				invocationMetadata: { startedAtMs, elapsedMs: 1_000 },
			};
			fixture = createScreen({ node: activeNode });
			const initialRows = fixture.screen.render(80);
			const renderRequestsBeforeTick = fixture.tui.renderRequests;

			// ACT: advance the presentation clock, fire one refresh, then publish the finalized terminal snapshot.
			nowMs += 2_000;
			expect(refresh).toBeDefined();
			if (refresh === undefined) {
				throw new Error("elapsed refresh timer was not scheduled");
			}
			refresh();
			const activeRows = fixture.screen.render(80);
			fixture.source.publish({
				...fixture.source.getView(),
				revision: 2,
				nodes: [
					{
						...activeNode,
						invocationMetadata: { startedAtMs, elapsedMs: 4_000 },
						state: "terminal-success",
					},
				],
				affectedStableKeys: [activeNode.stableKey],
			});
			nowMs += 10_000;
			const terminalRows = fixture.screen.render(80);
			fixture.screen.dispose();

			// ASSERT: active rendering follows time, terminal rendering stays fixed, and the owned timer is released once.
			expect({
				initialElapsed: initialRows.some((line) => line.includes("1s")),
				activeElapsed: activeRows.some((line) => line.includes("3s")),
				renderRequests: fixture.tui.renderRequests - renderRequestsBeforeTick,
				terminalElapsed: terminalRows.some((line) => line.includes("4s")),
				clearCalls: clearIntervalSpy.mock.calls.length,
			}).toEqual({
				initialElapsed: true,
				activeElapsed: true,
				renderRequests: 2,
				terminalElapsed: true,
				clearCalls: 1,
			});
		} finally {
			fixture?.screen.dispose();
			clearIntervalSpy.mockRestore();
			intervalSpy.mockRestore();
			nowSpy.mockRestore();
		}
	});

	test("shows every focus zone, one editor frame, and the safe close shortcut", () => {
		// Purpose: Tab focus ownership and the preferred close action must be visible without duplicate editor separators.
		// Inputs and expected output: hierarchy title, conversation identity, and both editor borders receive focus in sequence; Ctrl+Shift+G closes.
		// Edge case: Escape remains functional elsewhere but is not advertised as the primary close action.
		// Dependencies: screen-owned focus state, public Editor border rendering, and Kitty combined-key input.
		const fixture = createScreen({ theme: createFocusTheme() });
		fixture.screen.focused = true;
		const hierarchyRows = fixture.screen.render(80);
		fixture.screen.handleInput(INPUT.tab);
		const conversationRows = fixture.screen.render(80);
		fixture.screen.handleInput(INPUT.tab);
		const editorRows = fixture.screen.render(80);
		fixture.screen.handleInput(INPUT.ctrlShiftG);
		const isRuleRow = (line: string) => (line.match(/─/g)?.length ?? 0) >= 8;
		const editorRuleRows = editorRows.filter(
			(line) => line.includes("\u001b[36m") && isRuleRow(line),
		);
		const ruleRows = editorRows.map(isRuleRow);
		const adjacentRules = ruleRows.some(
			(isRule, index) => isRule && ruleRows[index + 1] === true,
		);
		const hierarchyHint = hierarchyRows.at(-2) ?? "";
		const conversationHint = conversationRows.at(-2) ?? "";
		const hint = editorRows.at(-2) ?? "";
		const mutedPaneBottom = hierarchyRows.at(-3) ?? "";
		const activePaneBottom = editorRows.at(-3) ?? "";
		const activeCursorRow = editorRows.findIndex((line) =>
			line.includes(CURSOR_MARKER),
		);
		const mutedEditorTop = hierarchyRows[activeCursorRow - 1] ?? "";
		const activeEditorTop = editorRows[activeCursorRow - 1] ?? "";

		expect({
			hierarchyFocus: hierarchyRows.some((line) =>
				line.includes("\u001b[36mAgents\u001b[39m"),
			),
			focusedSelection: hierarchyRows.some((line) =>
				line.includes("\u001b[44m"),
			),
			mutedSelection: conversationRows.some((line) =>
				line.includes("\u001b[40m"),
			),
			conversationFocus: conversationRows.some((line) =>
				line.includes("\u001b[36mSubAgentDeveloper #1\u001b[39m"),
			),
			mutedPaneBottom:
				mutedPaneBottom.startsWith("├") &&
				!mutedPaneBottom.includes("\u001b[90m") &&
				!mutedPaneBottom.includes("\u001b[36m"),
			activePaneBottom:
				activePaneBottom.startsWith("├") &&
				activePaneBottom.includes("┴\u001b[36m") &&
				!activePaneBottom.includes("\u001b[36m├") &&
				!activePaneBottom.includes("\u001b[36m┤"),
			mutedEditorTop:
				mutedEditorTop.startsWith("│") &&
				mutedEditorTop.includes("├─ Steer ") &&
				mutedEditorTop.endsWith("┤") &&
				!mutedEditorTop.includes("\u001b[90m") &&
				!mutedEditorTop.includes("\u001b[36m"),
			activeEditorTop:
				activeEditorTop.startsWith("│") &&
				activeEditorTop.includes("\u001b[36mSteer\u001b[39m") &&
				activeEditorTop.includes("├\u001b[36m") &&
				!activeEditorTop.includes("\u001b[36m├") &&
				!activeEditorTop.includes("\u001b[36m┤"),
			editorFocusBorders: editorRuleRows.length,
			adjacentRules,
			hierarchyNavigationHint:
				hierarchyHint.includes("up/down") &&
				hierarchyHint.includes("select") &&
				hierarchyHint.includes(" · "),
			conversationNavigationHint:
				conversationHint.includes(" · ") &&
				conversationHint.includes("up/down") &&
				conversationHint.includes("scroll") &&
				conversationHint.includes("pageUp/pageDown") &&
				conversationHint.includes("page"),
			editorSendHint:
				hint.includes("enter") && hint.includes("send") && hint.includes(" · "),
			preferredCloseHint:
				hint.includes("Ctrl+Shift+G") && hint.includes("close"),
			escapeCloseHint: hint.includes("Esc close"),
			closeCalls: fixture.getCloseCalls(),
		}).toEqual({
			hierarchyFocus: true,
			focusedSelection: true,
			mutedSelection: true,
			conversationFocus: true,
			mutedPaneBottom: true,
			activePaneBottom: true,
			mutedEditorTop: true,
			activeEditorTop: true,
			editorFocusBorders: 2,
			adjacentRules: false,
			hierarchyNavigationHint: true,
			conversationNavigationHint: true,
			editorSendHint: true,
			preferredCloseHint: true,
			escapeCloseHint: false,
			closeCalls: 1,
		});
	});

	test("resets child styles before scroll columns and frame borders", () => {
		// Purpose: child components cannot color or hide screen-owned vertical frame cells.
		// Inputs and expected output: an intentionally unclosed selected background is reset before both pane boundaries.
		// Edge case: the reset also closes OSC 8 links before screen chrome.
		// Dependencies: wide pane composition and terminal segment boundaries.
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (color: string, text: string) =>
				color === "selectedBg" ? `\u001b[42m${text}` : text,
			bold: (text: string) => text,
		} as Theme;
		const fixture = createScreen({ theme });
		fixture.screen.focused = true;
		const selectedRow =
			fixture.screen.render(80).find((line) => line.includes("\u001b[42m")) ??
			"";
		const boundary = "\u001b[0m\u001b]8;;\u0007";

		expect({
			leakingBackground: selectedRow.includes("\u001b[42m"),
			boundaryCount: selectedRow.split(boundary).length - 1,
			rightFrame: selectedRow.endsWith("│"),
		}).toEqual({
			leakingBackground: true,
			boundaryCount: 2,
			rightFrame: true,
		});
	});

	test("keeps the width-69 screen terminal-safe with all selected fields", () => {
		// Purpose: the wide layout must preserve physical row safety for all three selected-header rows.
		// Inputs and expected output: controlled identity and prompt text normalize while the 40-column pane retains recognizable metadata.
		// Edge case: newline, carriage return, tab, C0/C1 controls, and input VT sequences cannot escape into full-screen rows.
		// Dependencies: exact wide-layout minima, shared terminal normalization, and one-line selected-header clipping.
		// ARRANGE: provide production-shaped metadata and supported control input on the selected node.
		const inputControls = [
			"\n",
			"\r",
			"\t",
			"\u0001",
			"\u0085",
			"\u001b[38;5;201m",
		];
		const startedAtMs = 1_700_000_000_000;
		const controlledNode: ProjectionNode = {
			...selectedNode(),
			agentId: "Agent\nSafe\r\t\u0001\u0085\u001b[38;5;201mID\u001b[0m",
			taskName: "Task\nSafe\r\t\u0001\u0085\u001b[38;5;201mBody\u001b[0m",
			invocationMetadata: {
				startedAtMs,
				elapsedMs: 102_000,
				modelId: "openai-codex/gpt-5.6-sol",
				contextTokens: 34_000,
				contextWindow: 190_000,
			},
		};
		const nowSpy = spyOn(Date, "now").mockImplementation(
			() => startedAtMs + 102_000,
		);
		const fixture = createScreen({ node: controlledNode });

		// ACT: render total width 69, which preserves 40 content columns in the selected pane beside its scrollbar.
		let rows: string[];
		try {
			rows = fixture.screen.render(69);
		} finally {
			fixture.screen.dispose();
			nowSpy.mockRestore();
		}
		const prompt = rows.find((line) => line.includes("⧗ initial conversation"));
		const metadata = rows.find((line) => line.includes("1m42s · openai"));
		const topBorder = rows[0] ?? "";
		const statusAndIdentity = rows[1] ?? "";
		const dividerAndPrompt = rows[2] ?? "";
		const identityAndMetadata = rows[3] ?? "";
		const taskAndDivider = rows[4] ?? "";
		const paneBottom = rows.at(-3) ?? "";

		// ASSERT: full-screen rows remain physical-row exact and the selected header keeps all three semantic rows.
		expect({
			layout: fixture.screen.layoutForWidth(69),
			rows: rows.length,
			physicalRows: rows.reduce(
				(count, line) => count + line.split(PHYSICAL_ROW_BREAK).length,
				0,
			),
			leakedInputControls: inputControls.filter((control) =>
				rows.some((line) => line.includes(control)),
			),
			identityRecognizable: rows.some((line) => line.includes("Agent Safe")),
			topBorderEmpty: !topBorder.includes("Agents:"),
			topJunction: topBorder.includes("┬"),
			statusAndIdentity:
				statusAndIdentity.includes("Agents: ⧗ 1") &&
				statusAndIdentity.includes("Agent Safe"),
			dividerAndPrompt:
				dividerAndPrompt.startsWith("├") &&
				dividerAndPrompt.includes("┤") &&
				dividerAndPrompt.endsWith("│") &&
				dividerAndPrompt.includes("⧗ initial conversation"),
			identityAndMetadata:
				identityAndMetadata.includes("Agent Safe") &&
				identityAndMetadata.includes("1m42s · openai"),
			taskAndDivider:
				taskAndDivider.startsWith("│") &&
				taskAndDivider.includes("├") &&
				taskAndDivider.endsWith("┤") &&
				taskAndDivider.includes("Task Safe Body"),
			paneBottom:
				paneBottom.startsWith("├") &&
				paneBottom.includes("┴") &&
				paneBottom.endsWith("┤"),
			prompt: prompt !== undefined,
			metadata: metadata !== undefined,
			fits: rows.every((line) => visibleWidth(line) <= 69),
		}).toEqual({
			layout: "wide",
			rows: 18,
			physicalRows: 18,
			leakedInputControls: [],
			identityRecognizable: true,
			topBorderEmpty: true,
			topJunction: true,
			statusAndIdentity: true,
			dividerAndPrompt: true,
			identityAndMetadata: true,
			taskAndDivider: true,
			paneBottom: true,
			prompt: true,
			metadata: true,
			fits: true,
		});
	});

	test("preserves a task ellipsis through selected-row and pane styling", () => {
		// Purpose: hierarchy descriptions must disclose hidden text after screen composition.
		// Inputs and expected output: a selected task wider than the left pane ends with one visible ellipsis.
		// Edge case: selected background and muted foreground styling cannot consume the ellipsis.
		// Dependencies: hierarchy clipping and wide-screen pane composition.
		const fixture = createScreen({
			node: {
				...selectedNode(),
				taskName:
					"Publish level 4 result with additional details beyond the hierarchy pane",
			},
			theme: createFocusTheme(),
		});
		fixture.screen.focused = true;
		const taskRow =
			fixture.screen
				.render(80)
				.find((line) => line.includes("Publish level")) ?? "";
		const dividerIndex = taskRow.indexOf("├");
		const hierarchyTask =
			dividerIndex < 0 ? taskRow : taskRow.slice(0, dividerIndex);

		expect(hierarchyTask).toContain("…");
	});

	test("renders independent hierarchy and conversation scroll columns", () => {
		// Purpose: overflowing panes must expose scroll position without changing their content width.
		// Inputs and expected output: hierarchy movement shifts its block thumb, while conversation overflow owns a separate track.
		// Edge case: narrow hierarchy mode keeps the dedicated column inside the outer right border.
		// Dependencies: pane scroll metrics, border composition, and focus colors.
		const fixture = createScreen({ theme: createFocusTheme(), rows: 20 });
		fixture.screen.focused = true;
		const nodes = Array.from({ length: 12 }, (_, index) => ({
			...selectedNode(),
			stableKey: `scroll-root-${index}`,
			key: {
				ownerPiSessionId: "root-owner",
				ownerLocalSessionId: index + 1,
			},
			childPiSessionId: `child-scroll-${index}`,
			taskName: `Scrollable task ${index + 1}`,
			creationOrder: index + 1,
		}));
		fixture.source.publish({
			revision: 2,
			nodes,
			selectedStableKey: nodes[0]?.stableKey ?? null,
			selectedConversation: [conversationEntry("initial conversation")],
			selectedConversationComplete: true,
			affectedStableKeys: nodes.map((node) => node.stableKey),
		});
		const topRows = fixture.screen.render(80);
		for (let index = 1; index < nodes.length; index += 1) {
			fixture.screen.handleInput(INPUT.down);
		}
		const bottomRows = fixture.screen.render(80);
		const narrowRows = fixture.screen.render(66);
		fixture.source.publish({
			revision: 3,
			nodes,
			selectedStableKey: nodes.at(-1)?.stableKey ?? null,
			selectedConversation: Array.from({ length: 20 }, (_, index) =>
				conversationEntry(`conversation row ${index + 1}`),
			),
			selectedConversationComplete: true,
			affectedStableKeys: [],
		});
		fixture.screen.render(80);
		fixture.screen.handleInput(INPUT.tab);
		const conversationRows = fixture.screen.render(80);
		const activeThumb = "\u001b[37m█\u001b[39m";
		const mutedThumb = "\u001b[90m█\u001b[39m";
		const firstThumbRow = (rows: readonly string[], marker: string) =>
			rows.findIndex((line) => line.includes(marker));

		const topHierarchy = firstThumbRow(topRows, activeThumb);
		const bottomHierarchy = firstThumbRow(bottomRows, activeThumb);
		expect({
			topHierarchy,
			bottomHierarchyAfterTop: bottomHierarchy > topHierarchy,
			narrowScrollColumn: narrowRows.some(
				(line) => line.includes(activeThumb) && line.endsWith("│"),
			),
			inactiveHierarchy: conversationRows.some((line) =>
				line.includes(mutedThumb),
			),
			activeConversation: conversationRows.some(
				(line) => line.includes(activeThumb) && line.endsWith("│"),
			),
			trackVisible: conversationRows.some((line) => line.includes("░")),
		}).toEqual({
			topHierarchy: 3,
			bottomHierarchyAfterTop: true,
			narrowScrollColumn: true,
			inactiveHierarchy: true,
			activeConversation: true,
			trackVisible: true,
		});
	});

	test("uses an indeterminate conversation track until history is complete", () => {
		// Purpose: a partial suffix must not present its loaded row count as the total session size.
		// Inputs and expected output: an overflowing incomplete conversation shows ellipsis and provisional glyphs, then a complete revision shows the normal thumb.
		// Edge case: the hierarchy track remains independent while the selected conversation changes loading state.
		// Dependencies: production screen layout, conversation metrics, and scroll-column rendering.
		const fixture = createScreen();
		fixture.source.publish({
			...fixture.source.getView(),
			revision: 2,
			selectedConversation: Array.from({ length: 20 }, (_, index) =>
				conversationEntry(`partial row ${index + 1}`),
			),
			selectedConversationComplete: false,
			affectedStableKeys: ["stable-descendant-key"],
		});

		const partialRows = fixture.screen.render(80);
		fixture.source.publish({
			...fixture.source.getView(),
			revision: 3,
			selectedConversationComplete: true,
			affectedStableKeys: ["stable-descendant-key"],
		});
		const completeRows = fixture.screen.render(80);

		expect({
			partialEllipsis: partialRows.some((line) => line.includes("⋮")),
			partialTrack: partialRows.some((line) => line.includes("▒")),
			completeEllipsis: completeRows.some((line) => line.includes("⋮")),
			completeThumb: completeRows.some((line) => line.includes("█")),
		}).toEqual({
			partialEllipsis: true,
			partialTrack: true,
			completeEllipsis: false,
			completeThumb: true,
		});
	});

	test("requests earlier turns until an incomplete preview can fill the viewport", async () => {
		// Purpose: actual Pi-rendered rows, rather than a fixed message count, must drive preview expansion.
		// Inputs and expected output: one short incomplete message causes one earlier-page request after the first render.
		// Edge case: the source reports branch completion, so the screen must not spin or issue repeated requests.
		// Dependencies: production render height calculation and the ManagementViewSource progressive-loading contract.
		const fixture = createScreen();
		fixture.source.publish({
			...fixture.source.getView(),
			revision: 2,
			selectedConversation: [conversationEntry("short partial preview")],
			selectedConversationComplete: false,
			affectedStableKeys: ["stable-descendant-key"],
		});

		fixture.screen.render(80);
		await settleSubmission();

		expect(fixture.source.earlierCalls).toBe(1);
	});

	test("opens and constructs the public full-terminal overlay factory", async () => {
		// Purpose: the shared factory must use public ctx.ui.custom sizing and produce one disposable ManagementScreen.
		// Inputs and expected output: opening forwards the exact factory and overlay options, and factory close settles through the provided done callback.
		// Edge case: the fake context exposes no main editor methods, so any normal-editor mutation would fail the test.
		// Dependencies: public extension custom UI, TUI, theme, keybinding, and tool-presentation contracts.
		// ARRANGE: create a factory around read-only screen ports and an observable custom UI context.
		const source = new ViewSourceFake();
		source.publish({
			...source.getView(),
			revision: 2,
			selectedConversation: [assistantConversationEntry()],
			affectedStableKeys: ["stable-descendant-key"],
		});
		const submission = new SubmissionFake();
		const retained = createManagementRetainedState();
		const customCalls: unknown[][] = [];
		const notifications: string[] = [];
		const modelLookups: string[] = [];
		let mainToolsExpanded = true;
		const ctx = {
			cwd: "/tmp",
			mode: "tui",
			hasUI: true,
			ui: {
				custom: async (...args: unknown[]) => {
					customCalls.push(args);
					return undefined;
				},
				getToolsExpanded: () => mainToolsExpanded,
				notify: (message: string) => notifications.push(message),
			},
			modelRegistry: {
				find: (provider: string, modelId: string) => {
					modelLookups.push(`${provider}/${modelId}`);
					return { contextWindow: 190_000 };
				},
			},
		} as unknown as ExtensionContext;
		const tools = createToolPresentationRegistry(
			ctx.cwd,
			SessionManager.inMemory("/tmp/subagents-v2-factory"),
		);
		const factory = createManagementScreenFactory({
			ctx,
			source,
			tools,
			submission,
			retained,
		});

		// ACT: open through ctx.ui.custom, construct the component, and close it through Escape.
		await openManagementOverlay(ctx, factory);
		let doneCalls = 0;
		const factoryKeybindings = createKeybindings() as unknown as Parameters<
			typeof factory
		>[2];
		const component = await factory(
			createTui(),
			createTheme(),
			factoryKeybindings,
			() => {
				doneCalls += 1;
			},
		);
		if (!(component instanceof ManagementScreen)) {
			throw new Error("management factory returned an unexpected component");
		}
		const initialToolsExpanded = component.getToolsExpanded();
		component.handleInput(INPUT.expandTools);
		const mainToolsExpandedAfterLocalToggle = mainToolsExpanded;
		component.render(80);
		component.handleInput(INPUT.escape);
		component.dispose();
		mainToolsExpanded = false;
		const reopened = await factory(
			createTui(),
			createTheme(),
			factoryKeybindings,
			() => {
				doneCalls += 1;
			},
		);
		if (!(reopened instanceof ManagementScreen)) {
			throw new Error("management factory returned an unexpected component");
		}
		const reopenedToolsExpanded = reopened.getToolsExpanded();
		reopened.handleInput(INPUT.escape);
		reopened.dispose();
		const foundNode = findProjectionNode(
			source.getView(),
			"stable-descendant-key",
		);

		// ASSERT: public overlay options, component ownership, and close/dispose behavior are exact.
		expect({
			factoryIdentity: customCalls[0]?.[0] === factory,
			options: customCalls[0]?.[1],
			component: component.constructor.name,
			doneCalls,
			initialToolsExpanded,
			mainToolsExpandedAfterLocalToggle,
			reopenedToolsExpanded,
			notifications,
			modelLookups,
			foundNode: foundNode?.agentId,
			disposedSubscriptions: source.unsubscribeCalls,
		}).toEqual({
			factoryIdentity: true,
			options: {
				overlay: true,
				overlayOptions: {
					width: "100%",
					maxHeight: "100%",
					margin: 0,
				},
			},
			component: "ManagementScreen",
			doneCalls: 2,
			initialToolsExpanded: true,
			mainToolsExpandedAfterLocalToggle: true,
			reopenedToolsExpanded: false,
			notifications: [],
			modelLookups: [],
			foundNode: "SubAgentDeveloper",
			disposedSubscriptions: 2,
		});
	});

	test("consumes global focus and expansion keys before focused children", () => {
		// Purpose: Tab, Shift+Tab, and configured tool expansion must remain screen-owned in every focus zone.
		// Inputs and expected output: focus cycles hierarchy, conversation, editor, and reverse without inserting Tab into the editor.
		// Edge case: global expansion toggles while the editor owns focus and preserves its text.
		// Dependencies: injected Pi KeybindingsManager and public Editor input behavior.
		// ARRANGE: place text in the editor before cycling through every focus owner.
		const fixture = createScreen();
		fixture.screen.setEditorText("unchanged");

		// ACT: cycle forward, reverse once, return to editor, and toggle configured expansion.
		const zones = [fixture.screen.getFocusZone()];
		fixture.screen.handleInput(INPUT.tab);
		zones.push(fixture.screen.getFocusZone());
		fixture.screen.handleInput(INPUT.tab);
		zones.push(fixture.screen.getFocusZone());
		fixture.screen.handleInput(INPUT.shiftTab);
		zones.push(fixture.screen.getFocusZone());
		fixture.screen.handleInput(INPUT.tab);
		fixture.screen.handleInput(INPUT.expandTools);

		// ASSERT: focus and expansion changed without leaking any key into editor contents.
		expect({
			zones,
			expanded: fixture.screen.getToolsExpanded(),
			text: fixture.screen.getEditorText(),
		}).toEqual({
			zones: ["hierarchy", "conversation", "editor", "conversation"],
			expanded: true,
			text: "unchanged",
		});
	});

	test("renders coordinator-owned invocation metadata through production projection", async () => {
		// Purpose: accepted launch facts and terminal usage must reach the selected header through the durable catalog and immutable projection.
		// Inputs and expected output: two active roots expose launch model/context, then one selected terminal event commits elapsed and token usage.
		// Edge case: terminal feedback updates the selected conversation while continuation preserves stable logical selection and unrelated node identity.
		// Dependencies: real coordinator, journal store, catalog, management projection runtime, and screen; only the child process boundary is faked.
		// ARRANGE: register one active owner writer and a deterministic invocation/clock boundary.
		initTheme(undefined, false);
		const manager = SessionManager.inMemory("/tmp/subagents-v2-metadata");
		const owner: OwnerIdentity = {
			ownerPiSessionId: manager.getSessionId(),
			ownerSessionFile: "/tmp/subagents-v2-metadata/session.jsonl",
		};
		const store = new V2SessionStore();
		store.registerActive({
			owner,
			sessionManager: manager,
			appendJournal: (record) =>
				manager.appendCustomEntry(SUBAGENT_JOURNAL_CUSTOM_TYPE, record),
			appendHistory: () => undefined,
		});
		let monotonicMs = 1_000;
		let wallMs = 1_700_000_000_000;
		const nowSpy = spyOn(Date, "now").mockImplementation(() => wallMs);
		const acceptances: InvocationAcceptance[] = [
			{
				invocationId: "unrelated-invocation",
				runtimeLeaseId: "unrelated-lease",
				childPiSessionId: "unrelated-child",
				childSessionDir: "/tmp/unrelated-child",
				childSessionFile: "/tmp/unrelated-child/session.jsonl",
				modelId: "openai/unrelated-model",
				contextWindow: 64_000,
			},
			{
				invocationId: "selected-invocation",
				runtimeLeaseId: "selected-lease",
				childPiSessionId: "selected-child",
				childSessionDir: "/tmp/selected-child",
				childSessionFile: "/tmp/selected-child/session.jsonl",
				modelId: "openai-codex/gpt-5.6-sol",
				contextWindow: 190_000,
			},
			{
				invocationId: "continued-invocation",
				runtimeLeaseId: "continued-lease",
				childPiSessionId: "selected-child",
				childSessionDir: "/tmp/selected-child",
				childSessionFile: "/tmp/selected-child/session.jsonl",
				modelId: "anthropic/claude-sonnet-4",
				contextWindow: 200_000,
			},
		];
		const nextAcceptance = (): InvocationAcceptance => {
			const acceptance = acceptances.shift();
			if (acceptance === undefined) {
				throw new Error("metadata acceptance queue is exhausted");
			}
			monotonicMs +=
				acceptance.invocationId === "continued-invocation" ? 1_000 : 2_000;
			wallMs +=
				acceptance.invocationId === "continued-invocation" ? 1_000 : 2_000;
			return acceptance;
		};
		const invocations: InvocationControl = {
			start: async () => nextAcceptance(),
			continue: async () => nextAcceptance(),
			steer: async () => undefined,
			terminateLease: async () => undefined,
		};
		const catalog = new SessionCatalog();
		const coordinator = new SubagentCoordinator({
			catalog,
			invocations,
			waits: new WaitCoordinator(),
			store,
			clock: {
				monotonicNow: () => monotonicMs,
				wallNow: () => wallMs,
			},
			isAgentAvailable: () => true,
		});
		coordinator.registerOwner(owner);
		await coordinator.start(owner, {
			agentId: "SubAgentUnrelated",
			taskName: "Keep unrelated identity",
			prompt: "Wait",
		});
		await coordinator.start(owner, {
			agentId: "SubAgentDeveloper",
			taskName: "Observe production metadata",
			prompt: "Inspect metadata",
		});
		const active = new ActiveConversationSourceFake();
		active.entries = [conversationEntry("accepted prompt")];
		const runtime = new ManagementProjectionRuntime({
			rootOwnerPiSessionId: owner.ownerPiSessionId,
			catalog,
			activeConversations: active,
			readInactiveBranch: () => active.entries,
			onError: (error) => {
				throw error;
			},
		});
		const selectedStableKey =
			runtime.getView().nodes.find((node) => node.key.ownerLocalSessionId === 2)
				?.stableKey ?? null;
		await runtime.select(selectedStableKey);
		const retained = createManagementRetainedState();
		retained.hierarchy = {
			...retained.hierarchy,
			selectedStableKey,
		};
		const screen = new ManagementScreen({
			tui: createTui(),
			theme: createTheme(),
			keybindings: createKeybindings(),
			cwd: "/tmp",
			source: runtime,
			tools: createToolPresentationRegistry(
				"/tmp",
				SessionManager.inMemory("/tmp/subagents-v2-metadata-tools"),
			),
			submission: new SubmissionFake(),
			retained,
			toolsExpanded: false,
			notify: () => undefined,
			close: () => undefined,
		});
		await runtime.refreshSelected();
		const beforeView = runtime.getView();
		const unrelatedBefore = beforeView.nodes[0];
		const selectedBefore = beforeView.nodes[1];
		const conversationBefore = beforeView.selectedConversation;
		const initialRows = screen.render(120);
		const revisions: ManagementProjectionView[] = [];
		runtime.subscribe((view) => revisions.push(view));

		// ACT: advance the owned clock and commit one terminal usage snapshot.
		monotonicMs += 100_000;
		wallMs += 100_000;
		await coordinator.observeInvocation({
			kind: "terminal",
			invocationId: "selected-invocation",
			status: "success",
			text: "first invocation complete",
			contextTokens: 34_000,
		});
		await settleSubmission();
		const terminalView = runtime.getView();
		const terminalRows = screen.render(120);
		const terminalRevision = revisions.at(-1);

		// ACT: continue the same logical session with new launch facts.
		await coordinator.steer(owner, {
			sessionId: 2,
			prompt: "Continue with the new model",
		});
		monotonicMs += 10_000;
		wallMs += 10_000;
		await settleSubmission();
		const continuedView = runtime.getView();
		const continuedRows = screen.render(120);
		const folded = store
			.fold(manager.getBranch())
			.sessions.find((session) => session.key.ownerLocalSessionId === 2);
		screen.dispose();
		runtime.dispose();
		nowSpy.mockRestore();

		// ASSERT: terminal metrics update the selected node before continuation replaces current invocation facts.
		expect({
			initialHeader: initialRows.some(
				(line) =>
					line.includes("2s") &&
					line.includes("openai-codex/gpt-5.6-sol") &&
					!line.includes("0/190k") &&
					!line.includes("?/190k"),
			),
			selected: terminalView.selectedStableKey,
			unrelatedIdentityStable: terminalView.nodes[0] === unrelatedBefore,
			selectedIdentityRevised: terminalView.nodes[1] !== selectedBefore,
			affectedStableKeys: terminalRevision?.affectedStableKeys,
			conversationEntryStable:
				terminalView.selectedConversation[0] === conversationBefore[0],
			terminalHeader: terminalRows.some(
				(line) => line.includes("1m42s") && line.includes("34k/190k"),
			),
			continuedStableKey: continuedView.selectedStableKey,
			continuedHeader: continuedRows.some(
				(line) =>
					line.includes("1s") &&
					line.includes("anthropic/claude-sonnet-4") &&
					!line.includes("/200k"),
			),
			conversationTexts: continuedView.selectedConversation.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user"
					? [entry.message.content]
					: [],
			),
			foldedInvocationId: folded?.invocationId,
			foldedMetadata: folded?.invocationMetadata,
		}).toEqual({
			initialHeader: true,
			selected: selectedStableKey,
			unrelatedIdentityStable: true,
			selectedIdentityRevised: true,
			affectedStableKeys: selectedStableKey === null ? [] : [selectedStableKey],
			conversationEntryStable: true,
			terminalHeader: true,
			continuedStableKey: selectedStableKey,
			continuedHeader: true,
			conversationTexts: ["accepted prompt"],
			foldedInvocationId: "continued-invocation",
			foldedMetadata: {
				startedAtMs: 1_700_000_104_000,
				elapsedMs: 1_000,
				modelId: "anthropic/claude-sonnet-4",
				contextWindow: 200_000,
			},
		});
	});

	test("projects selected live updates and disposes runtime readers", async () => {
		// Purpose: the root management source must subscribe to accepted catalog facts and refresh only the selected active branch.
		// Inputs and expected output: initial selection reads RPC, child activity replaces conversation, and terminal status switches to the public inactive reader.
		// Edge case: activity emitted after disposal performs no read or publication.
		// Dependencies: ManagementProjectionRuntime, SessionCatalog subscription, and active-conversation source.
		// ARRANGE: seed one active root session and create its runtime-local projection source.
		const catalog = new SessionCatalog();
		const session = logicalSession();
		catalog.add(session);
		const active = new ActiveConversationSourceFake();
		let inactiveReads = 0;
		let resolveInactiveRead = (): void => undefined;
		const inactiveRead = new Promise<void>((resolve) => {
			resolveInactiveRead = resolve;
		});
		const runtime = new ManagementProjectionRuntime({
			rootOwnerPiSessionId: "root-owner",
			catalog,
			activeConversations: active,
			readInactiveBranch: () => {
				inactiveReads += 1;
				resolveInactiveRead();
				return [
					conversationEntry("active"),
					{
						...conversationEntry("inactive terminal"),
						parentId: "message-active",
					},
				];
			},
			onError: (error) => {
				throw error;
			},
		});
		const revisions: number[] = [];
		runtime.subscribe((view) => revisions.push(view.revision));

		// ACT: select, refresh from activity, terminalize, and emit once after disposal.
		const stableKey = runtime.getView().nodes[0]?.stableKey ?? null;
		await runtime.select(stableKey);
		active.entries = [
			conversationEntry("active"),
			{
				...conversationEntry("active update"),
				parentId: "message-active",
			},
		];
		active.emit(session.invocationId);
		await settleProjection(
			() => runtime.getView().selectedConversation.length === 2,
		);
		const liveView = runtime.getView();
		catalog.update(session.key, { state: "terminal-success" });
		await inactiveRead;
		await settleProjection(() =>
			runtime
				.getView()
				.selectedConversation.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						entry.message.content === "inactive terminal",
				),
		);
		const terminalView = runtime.getView();
		const readsBeforeDispose = active.readCalls;
		runtime.dispose();
		active.emit(session.invocationId);
		await Promise.resolve();

		// ASSERT: selection, active/inactive branch changes, serialized notifications, and disposal are observable.
		expect({
			selected: terminalView.selectedStableKey,
			state: terminalView.nodes[0]?.state,
			liveConversation: liveView.selectedConversation.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user"
					? [entry.message.content]
					: [],
			),
			conversation: terminalView.selectedConversation.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user"
					? [entry.message.content]
					: [],
			),
			activeReads: active.readCalls,
			readsBeforeDispose,
			sinceValues: active.sinceValues,
			inactiveReads,
			revisionsIncreasing: revisions.every(
				(revision, index) =>
					index === 0 || revision > (revisions[index - 1] ?? 0),
			),
		}).toEqual({
			selected: stableKey,
			state: "terminal-success",
			liveConversation: ["active", "active update"],
			conversation: ["active", "inactive terminal"],
			activeReads: readsBeforeDispose,
			readsBeforeDispose: 2,
			sinceValues: [undefined, "message-active"],
			inactiveReads: 1,
			revisionsIncreasing: true,
		});
	});

	test("reports selected live refresh failures through the runtime boundary", async () => {
		// Purpose: background child activity failures must be reported instead of becoming unhandled promise rejections.
		// Inputs and expected output: one selected active session first loads, then a rejected RPC refresh reaches onError once.
		// Edge case: the failed read leaves the prior immutable conversation revision intact.
		// Dependencies: management runtime activity subscription and active conversation reader.
		// ARRANGE: select one active session and capture runtime errors.
		const catalog = new SessionCatalog();
		const session = logicalSession();
		catalog.add(session);
		const active = new ActiveConversationSourceFake();
		let resolveError = (): void => undefined;
		const errorObserved = new Promise<void>((resolve) => {
			resolveError = resolve;
		});
		const errors: string[] = [];
		const runtime = new ManagementProjectionRuntime({
			rootOwnerPiSessionId: "root-owner",
			catalog,
			activeConversations: active,
			readInactiveBranch: () => [],
			onError: (error) => {
				errors.push(error.message);
				resolveError();
			},
		});
		const stableKey = runtime.getView().nodes[0]?.stableKey ?? null;
		await runtime.select(stableKey);
		const priorConversation = runtime.getView().selectedConversation;

		// ACT: reject the event-driven active read and await its explicit error sink.
		active.error = new Error("get_entries failed");
		active.emit(session.invocationId);
		await errorObserved;

		// ASSERT: one error is visible and the last successful branch remains selected.
		expect({
			errors,
			conversationUnchanged:
				runtime.getView().selectedConversation === priorConversation,
		}).toEqual({
			errors: ["get_entries failed"],
			conversationUnchanged: true,
		});
		runtime.dispose();
	});

	test("disposes subscriptions and ignores later revisions", () => {
		// Purpose: closing an overlay must release revision subscriptions and component resources deterministically.
		// Inputs and expected output: disposal unsubscribes once and a later visible revision requests no render.
		// Edge case: repeated disposal remains idempotent.
		// Dependencies: explicit source subscription and TUI requestRender boundaries.
		// ARRANGE: create an open screen and record its current render count.
		const fixture = createScreen();
		const requestsBefore = fixture.tui.renderRequests;

		// ACT: dispose twice, then publish a visible revision.
		fixture.screen.dispose();
		fixture.screen.dispose();
		fixture.source.publish({
			...fixture.source.getView(),
			revision: 2,
			affectedStableKeys: ["stable-descendant-key"],
		});

		// ASSERT: one unsubscribe owns the lifetime, selection is released, and disposed updates are inert.
		expect({
			unsubscribeCalls: fixture.source.unsubscribeCalls,
			selected: fixture.source.selected,
			renderRequests: fixture.tui.renderRequests,
			requestsBefore,
		}).toEqual({
			unsubscribeCalls: 1,
			selected: null,
			renderRequests: requestsBefore,
			requestsBefore,
		});
	});
});
