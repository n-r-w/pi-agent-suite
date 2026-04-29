import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getAgentDir } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	type Keybinding,
	type SelectItem,
	SelectList,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import {
	type AgentDefinition,
	loadAgentDefinitions,
} from "../../shared/agent-registry";
import { getAgentRuntimeComposition } from "../../shared/agent-runtime-composition";
import { resolveToolPolicy } from "../../shared/tool-policy";
import { isChildSubagentProcess } from "./environment";

const COMMAND_NAME = "agent";

/** Command argument and selector label that clear the main-agent selection. */
const NO_AGENT_LABEL = "No agent";

/** Case-insensitive /agent argument that stores the explicit no-agent state. */
const NO_AGENT_ARGUMENT = "none";

/** Internal selector value for the explicit no-agent option. */
const NO_AGENT_VALUE = "__none__";

type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];

const SHORTCUT = "Ctrl+Shift+A" as ShortcutKey;
const STATE_DIR = join("agent-selection", "state");
const ISSUE_PREFIX = "[main-agent-selection]";
const CONFIG_PATH = join("config", "main-agent-selection.json");
const ENABLED_CONFIG_KEY = "enabled";
const STATE_KEYS = ["cwd", "activeAgentId"] as const;
const SELECTED_AGENT_STATE_HASH_ENCODING = "hex";

interface MainAgentSelectorTui {
	requestRender(): void;
}

interface MainAgentSelectorTheme {
	fg(color: string, text: string): string;
}

type MainAgentSelectorKeybinding = Extract<
	Keybinding,
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.confirm"
	| "tui.select.cancel"
>;

interface MainAgentSelectorKeybindings {
	matches(data: string, keybinding: MainAgentSelectorKeybinding): boolean;
}

interface MainAgentContext {
	readonly cwd: string;
	readonly hasUI?: boolean;
	readonly sessionManager: {
		getSessionFile(): string | undefined;
	};
	readonly ui: {
		custom?<T>(
			factory: (
				tui: MainAgentSelectorTui,
				theme: MainAgentSelectorTheme,
				keybindings: MainAgentSelectorKeybindings,
				done: (result: T) => void,
			) => Component | Promise<Component>,
		): Promise<T>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
	readonly modelRegistry: {
		find(provider: string, modelId: string): Model<Api> | undefined;
	};
}

interface SelectedAgentState {
	readonly cwd: string;
	readonly activeAgentId: string | null;
}

interface SessionStartEventLike {
	readonly reason?: string;
}

interface SessionShutdownEventLike {
	readonly reason?: string;
	readonly targetSessionFile?: string;
}

const SESSION_REPLACEMENT_HANDOFFS_PROPERTY =
	"__piHarnessMainAgentSelectionSessionReplacementHandoffs";

interface SessionReplacementHandoffCarrier {
	[SESSION_REPLACEMENT_HANDOFFS_PROPERTY]?: Map<string, string | null>;
}

type SessionReplacementHandoff =
	| { readonly found: false }
	| { readonly found: true; readonly activeAgentId: string | null };

interface SearchableAgentSelectorOptions {
	readonly options: readonly SelectItem[];
	readonly currentAgentId: string | null;
	readonly keybindings: MainAgentSelectorKeybindings;
	readonly theme: MainAgentSelectorTheme;
	readonly onSelect: (value: string) => void;
	readonly onCancel: () => void;
}

/** Searchable selector used by the /agent menu. */
class SearchableAgentSelector implements Component, Focusable {
	private readonly options: readonly SelectItem[];
	private readonly keybindings: MainAgentSelectorKeybindings;
	private readonly searchInput = new Input();
	private readonly theme: MainAgentSelectorTheme;
	private readonly onSelect: (value: string) => void;
	private readonly onCancel: () => void;
	private selectList: SelectList;
	private filteredOptions: readonly SelectItem[];
	private selectedValue: string;
	private readonly maxVisibleOptions: number;
	private _focused = false;

	/** Creates the selector with the current agent highlighted before any search query is entered. */
	constructor(config: SearchableAgentSelectorOptions) {
		this.options = config.options;
		this.keybindings = config.keybindings;
		this.theme = config.theme;
		this.onSelect = config.onSelect;
		this.onCancel = config.onCancel;
		this.filteredOptions = config.options;
		this.selectedValue = config.currentAgentId ?? NO_AGENT_VALUE;
		this.maxVisibleOptions = Math.min(config.options.length, 10);
		this.selectList = this.createSelectList(this.filteredOptions);
		this.syncSelectedIndex();
	}

	/** Reports whether the embedded search input owns the terminal cursor. */
	get focused(): boolean {
		return this._focused;
	}

	/** Keeps the embedded search input aligned with the outer custom component focus. */
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	/** Renders the search input and the currently matching agent options. */
	render(width: number): string[] {
		const lines = [
			truncateToWidth(
				this.theme.fg(
					"dim",
					"Type to search agents • navigate • select • cancel",
				),
				width,
			),
			...this.searchInput.render(width),
		];
		if (this.filteredOptions.length === 0) {
			lines.push(
				truncateToWidth(
					this.theme.fg("warning", "  No matching agents"),
					width,
				),
			);
			return lines;
		}

		lines.push(...this.selectList.render(width));
		return lines;
	}

	/** Routes navigation keys to the list and text-editing keys to the search input. */
	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.confirmSelection();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		}

		const previousQuery = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		if (this.searchInput.getValue() !== previousQuery) {
			this.applySearch();
		}
	}

	/** Clears cached child rendering state after theme changes. */
	invalidate(): void {
		this.searchInput.invalidate();
		this.selectList.invalidate();
	}

	/** Rebuilds the visible option list from the current case-insensitive substring query. */
	private applySearch(): void {
		const query = this.searchInput.getValue().toLowerCase();
		this.filteredOptions =
			query.length === 0
				? this.options
				: this.options.filter((option) =>
						option.label.toLowerCase().includes(query),
					);
		this.selectList = this.createSelectList(this.filteredOptions);
		this.syncSelectedIndex();
	}

	/** Keeps the same menu candidate when visible, otherwise selects the first visible option. */
	private syncSelectedIndex(): void {
		const selectedIndex = this.filteredOptions.findIndex(
			(option) => option.value === this.selectedValue,
		);
		if (selectedIndex >= 0) {
			this.selectList.setSelectedIndex(selectedIndex);
			return;
		}

		const firstOption = this.filteredOptions[0];
		if (firstOption !== undefined) {
			this.selectedValue = firstOption.value;
			this.selectList.setSelectedIndex(0);
		}
	}

	/** Moves the local menu candidate through the filtered options with wraparound. */
	private moveSelection(direction: -1 | 1): void {
		if (this.filteredOptions.length === 0) {
			return;
		}

		const currentIndex = this.filteredOptions.findIndex(
			(option) => option.value === this.selectedValue,
		);
		const startIndex = currentIndex >= 0 ? currentIndex : 0;
		const nextIndex =
			(startIndex + direction + this.filteredOptions.length) %
			this.filteredOptions.length;
		const nextOption = this.filteredOptions[nextIndex];
		if (nextOption === undefined) {
			return;
		}

		this.selectedValue = nextOption.value;
		this.selectList.setSelectedIndex(nextIndex);
	}

	/** Applies the local menu candidate when at least one option is visible. */
	private confirmSelection(): void {
		if (this.filteredOptions.length === 0) {
			return;
		}

		this.onSelect(this.selectedValue);
	}

	/** Creates a SelectList with the selector theme. */
	private createSelectList(options: readonly SelectItem[]): SelectList {
		const selectList = new SelectList([...options], this.maxVisibleOptions, {
			selectedPrefix: (text) => this.theme.fg("accent", text),
			selectedText: (text) => this.theme.fg("accent", text),
			description: (text) => this.theme.fg("muted", text),
			scrollInfo: (text) => this.theme.fg("dim", text),
			noMatch: (text) => this.theme.fg("warning", text),
		});
		return selectList;
	}
}

/** Extension entry point for main-agent selection behavior. */
export default function mainAgentSelection(pi: ExtensionAPI): void {
	if (isMainAgentSelectionDisabled()) {
		return;
	}

	getAgentRuntimeComposition(pi);

	pi.registerCommand(COMMAND_NAME, {
		description: "Select the main agent for this working directory",
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			if (trimmedArgs.toLowerCase() === NO_AGENT_ARGUMENT) {
				await selectNoMainAgent(pi, ctx as MainAgentContext);
				return;
			}

			await selectMainAgent(
				pi,
				ctx as MainAgentContext,
				trimmedArgs || undefined,
			);
		},
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Select the main agent",
		handler: async (ctx) => {
			await selectMainAgent(pi, ctx as MainAgentContext, undefined);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		if (isChildSubagentProcess()) {
			return;
		}

		if (
			await restoreSessionReplacementMainAgent(
				pi,
				event,
				ctx as MainAgentContext,
			)
		) {
			return;
		}

		if (!shouldRestoreSelectedMainAgent(event)) {
			return;
		}

		await restoreSelectedMainAgent(pi, ctx as MainAgentContext);
	});

	pi.on("session_shutdown", (event, ctx) => {
		if (isChildSubagentProcess()) {
			return;
		}

		captureSessionReplacementMainAgent(pi, event, ctx as MainAgentContext);
	});
}

/** Returns whether this session-start reason must refresh selected-agent state from disk. */
function shouldRestoreSelectedMainAgent(event: unknown): boolean {
	const reason = (event as SessionStartEventLike).reason;
	return reason === "startup" || reason === "reload" || reason === "resume";
}

/** Captures the selected agent ID before pi tears down a runtime that must preserve the current agent. */
function captureSessionReplacementMainAgent(
	pi: ExtensionAPI,
	event: unknown,
	mainContext: MainAgentContext,
): void {
	const handoffKey = getSessionReplacementShutdownHandoffKey(
		event,
		mainContext,
	);
	if (handoffKey === undefined) {
		return;
	}

	const activeAgentId =
		getAgentRuntimeComposition(pi).getMainAgentContribution()?.agent?.id ??
		null;
	getSessionReplacementHandoffStore().set(handoffKey, activeAgentId);
}

/** Restores a replacement-runtime handoff without consulting or rewriting persisted selected-agent state. */
async function restoreSessionReplacementMainAgent(
	pi: ExtensionAPI,
	event: unknown,
	mainContext: MainAgentContext,
): Promise<boolean> {
	const handoffKey = getSessionReplacementStartHandoffKey(event, mainContext);
	if (handoffKey === undefined) {
		return false;
	}

	const handoff = consumeSessionReplacementHandoff(handoffKey);
	if (!handoff.found) {
		return false;
	}
	if (handoff.activeAgentId === null) {
		getAgentRuntimeComposition(pi).clearMainAgentContribution();
		return true;
	}

	const agents = await loadSelectableAgents();
	const agent = agents.find(
		(candidate) => candidate.id === handoff.activeAgentId,
	);
	if (agent === undefined) {
		reportIssue(
			mainContext,
			`selected agent ${handoff.activeAgentId} was not found`,
		);
		getAgentRuntimeComposition(pi).clearMainAgentContribution();
		return true;
	}

	await applyAgentSelection(pi, mainContext, agent);
	return true;
}

/** Returns true when pi replaces the runtime without changing the current main-agent selection. */
function isSessionReplacementHandoffReason(
	reason: string | undefined,
): boolean {
	return reason === "new" || reason === "fork" || reason === "resume";
}

/** Returns the handoff key used before the old runtime is destroyed. */
function getSessionReplacementShutdownHandoffKey(
	event: unknown,
	mainContext: MainAgentContext,
): string | undefined {
	const shutdownEvent = event as SessionShutdownEventLike;
	if (!isSessionReplacementHandoffReason(shutdownEvent.reason)) {
		return undefined;
	}

	return (
		shutdownEvent.targetSessionFile ??
		mainContext.sessionManager.getSessionFile() ??
		normalizeCwd(mainContext.cwd)
	);
}

/** Returns the handoff key used after the replacement runtime is bound. */
function getSessionReplacementStartHandoffKey(
	event: unknown,
	mainContext: MainAgentContext,
): string | undefined {
	const startEvent = event as SessionStartEventLike;
	if (!isSessionReplacementHandoffReason(startEvent.reason)) {
		return undefined;
	}

	return (
		mainContext.sessionManager.getSessionFile() ?? normalizeCwd(mainContext.cwd)
	);
}

/** Returns the process-wide handoff store shared by freshly loaded extension modules. */
function getSessionReplacementHandoffStore(): Map<string, string | null> {
	const carrier = globalThis as SessionReplacementHandoffCarrier;
	const existing = carrier[SESSION_REPLACEMENT_HANDOFFS_PROPERTY];
	if (existing !== undefined) {
		return existing;
	}

	const store = new Map<string, string | null>();
	carrier[SESSION_REPLACEMENT_HANDOFFS_PROPERTY] = store;
	return store;
}

/** Reads and deletes one handoff so a stale agent cannot be restored later. */
function consumeSessionReplacementHandoff(
	cwd: string,
): SessionReplacementHandoff {
	const store = getSessionReplacementHandoffStore();
	if (!store.has(cwd)) {
		return { found: false };
	}

	const activeAgentId = store.get(cwd) ?? null;
	store.delete(cwd);
	return { found: true, activeAgentId };
}

/** Returns true only for a present valid config that explicitly disables main-agent selection. */
function isMainAgentSelectionDisabled(): boolean {
	try {
		const config: unknown = JSON.parse(
			readFileSync(join(getAgentDir(), CONFIG_PATH), "utf8"),
		);
		return isRecord(config) && config[ENABLED_CONFIG_KEY] === false;
	} catch {
		return false;
	}
}

/** Restores the persisted main-agent state before prompts depend on it. */
async function restoreSelectedMainAgent(
	pi: ExtensionAPI,
	mainContext: MainAgentContext,
): Promise<void> {
	const composition = getAgentRuntimeComposition(pi);
	const normalizedCwd = normalizeCwd(mainContext.cwd);
	const state = await readSelectedAgentState(normalizedCwd);
	if (state.kind === "missing") {
		composition.clearMainAgentContribution();
		return;
	}
	if (state.kind === "invalid") {
		composition.clearMainAgentContribution();
		reportIssue(mainContext, state.issue);
		return;
	}
	if (state.state.activeAgentId === null) {
		composition.clearMainAgentContribution();
		return;
	}

	const agents = await loadSelectableAgents();
	const agent = agents.find(
		(candidate) => candidate.id === state.state.activeAgentId,
	);
	if (agent === undefined) {
		reportIssue(
			mainContext,
			`selected agent ${state.state.activeAgentId} was not found`,
		);
		composition.clearMainAgentContribution();
		return;
	}

	await applyAgentSelection(pi, mainContext, agent);
}

/** Selects a main agent by explicit ID or interactive UI choice. */
async function selectMainAgent(
	pi: ExtensionAPI,
	ctx: MainAgentContext,
	explicitAgentId: string | undefined,
): Promise<void> {
	const agents = await loadSelectableAgents();
	const selectedAgentId =
		explicitAgentId ?? (await promptForAgent(pi, ctx, agents));
	if (selectedAgentId === undefined) {
		return;
	}
	if (selectedAgentId === null) {
		await selectNoMainAgent(pi, ctx);
		return;
	}

	const agent = agents.find((candidate) => candidate.id === selectedAgentId);
	if (agent === undefined) {
		reportIssue(ctx, `agent ${selectedAgentId} was not found`);
		return;
	}

	const normalizedCwd = normalizeCwd(ctx.cwd);
	const applied = await applyAgentSelection(pi, ctx, agent);
	if (!applied) {
		await writeSelectedAgentState({
			cwd: normalizedCwd,
			activeAgentId: null,
		});
		return;
	}

	await writeSelectedAgentState({
		cwd: normalizedCwd,
		activeAgentId: agent.id,
	});
}

/** Loads agents that can be used as top-level main agents. */
async function loadSelectableAgents(): Promise<AgentDefinition[]> {
	const agents = await loadAgentDefinitions();
	return agents.filter(
		(agent) => agent.type === "main" || agent.type === "both",
	);
}

/** Prompts the user to choose an agent and maps the selected label back to an agent ID. */
async function promptForAgent(
	pi: ExtensionAPI,
	ctx: MainAgentContext,
	agents: readonly AgentDefinition[],
): Promise<string | null | undefined> {
	if (ctx.hasUI === false || ctx.ui.custom === undefined) {
		reportIssue(ctx, "agent selection UI is unavailable");
		return undefined;
	}

	const currentAgentId =
		getAgentRuntimeComposition(pi).getMainAgentContribution()?.agent?.id ??
		null;
	const options: SelectItem[] = [
		{ value: NO_AGENT_VALUE, label: NO_AGENT_LABEL },
		...agents.map((agent) => ({
			value: agent.id,
			label: formatAgentOption(agent),
		})),
	];
	const selected = await ctx.ui.custom<string | undefined>(
		(tui, theme, keybindings, done) => {
			const selector = new SearchableAgentSelector({
				options,
				currentAgentId,
				keybindings,
				theme,
				onSelect: (value) => done(value),
				onCancel: () => done(undefined),
			});

			return {
				get focused(): boolean {
					return selector.focused;
				},
				set focused(value: boolean) {
					selector.focused = value;
				},
				render(width: number): string[] {
					return selector.render(width);
				},
				invalidate(): void {
					selector.invalidate();
				},
				handleInput(data: string): void {
					selector.handleInput(data);
					tui.requestRender();
				},
			};
		},
	);
	if (selected === undefined) {
		return undefined;
	}

	return selected === NO_AGENT_VALUE ? null : selected;
}

/** Stores the explicit no-agent state and removes the main-agent runtime contribution. */
async function selectNoMainAgent(
	pi: ExtensionAPI,
	ctx: MainAgentContext,
): Promise<void> {
	const normalizedCwd = normalizeCwd(ctx.cwd);
	getAgentRuntimeComposition(pi).clearMainAgentContribution();

	await writeSelectedAgentState({
		cwd: normalizedCwd,
		activeAgentId: null,
	});
}

/** Applies selected agent model, thinking, and runtime composition contribution. */
async function applyAgentSelection(
	pi: ExtensionAPI,
	ctx: MainAgentContext,
	agent: AgentDefinition,
): Promise<boolean> {
	const resolvedTools = resolveMainAgentTools(pi, agent);
	if ("issue" in resolvedTools) {
		clearMainAgentSelection(pi);
		reportIssue(ctx, resolvedTools.issue);
		return false;
	}

	if (agent.model?.id !== undefined) {
		const model = resolveModel(ctx, agent.model.id);
		if (model === undefined) {
			clearMainAgentSelection(pi);
			reportIssue(ctx, `model ${agent.model.id} was not found`);
			return false;
		}

		const modelApplied = await pi.setModel(model);
		if (!modelApplied) {
			clearMainAgentSelection(pi);
			reportIssue(ctx, `model ${agent.model.id} could not be applied`);
			return false;
		}
	}

	if (agent.model?.thinking !== undefined) {
		pi.setThinkingLevel(agent.model.thinking);
	}

	getAgentRuntimeComposition(pi).setMainAgentContribution({
		prompt: agent.prompt,
		agent: {
			id: agent.id,
			...(resolvedTools.tools !== undefined
				? { tools: resolvedTools.tools }
				: {}),
			...(agent.agents !== undefined ? { agents: agent.agents } : {}),
		},
		...(resolvedTools.tools !== undefined
			? { tools: resolvedTools.tools }
			: {}),
	});
	return true;
}

/** Resolves a main-agent tool policy through the same exact-name and wildcard rules used by subagents. */
function resolveMainAgentTools(
	pi: ExtensionAPI,
	agent: AgentDefinition,
): { readonly tools?: readonly string[] } | { readonly issue: string } {
	if (agent.tools === undefined) {
		return {};
	}

	const availableToolNames = pi.getAllTools().map((tool) => tool.name);
	const resolved = resolveToolPolicy(agent.tools, availableToolNames);
	if ("issue" in resolved) {
		return resolved;
	}

	return { tools: resolved.tools };
}

/** Resolves provider/model IDs through the session model registry. */
function resolveModel(
	ctx: MainAgentContext,
	modelId: string,
): Model<Api> | undefined {
	const separatorIndex = modelId.indexOf("/");
	if (separatorIndex <= 0 || separatorIndex === modelId.length - 1) {
		return undefined;
	}

	const provider = modelId.slice(0, separatorIndex);
	const id = modelId.slice(separatorIndex + 1);
	return ctx.modelRegistry.find(provider, id);
}

/** Formats one visible selection option while keeping the agent ID recoverable. */
function formatAgentOption(agent: AgentDefinition): string {
	return `${agent.id} — ${agent.description}`;
}

/** Clears selected runtime contribution after failed selection so stale agents cannot stay active. */
function clearMainAgentSelection(pi: ExtensionAPI): void {
	getAgentRuntimeComposition(pi).clearMainAgentContribution();
}

/** Reads selected-agent state for the current working directory. */
async function readSelectedAgentState(
	cwd: string,
): Promise<
	| { readonly kind: "missing" }
	| { readonly kind: "valid"; readonly state: SelectedAgentState }
	| { readonly kind: "invalid"; readonly issue: string }
> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(selectedAgentStatePath(cwd), "utf8"));
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return { kind: "missing" };
		}

		return {
			kind: "invalid",
			issue: `failed to read selected-agent state: ${formatError(error)}`,
		};
	}

	const state = parseSelectedAgentState(parsed);
	if (state.kind === "invalid") {
		return state;
	}
	if (state.state.cwd !== cwd) {
		return {
			kind: "invalid",
			issue:
				"selected-agent state cwd does not match current working directory",
		};
	}

	return state;
}

/** Parses strict selected-agent state with only cwd and activeAgentId fields. */
function parseSelectedAgentState(
	state: unknown,
):
	| { readonly kind: "valid"; readonly state: SelectedAgentState }
	| { readonly kind: "invalid"; readonly issue: string } {
	if (!isRecord(state) || !hasOnlyKeys(state, STATE_KEYS)) {
		return {
			kind: "invalid",
			issue: "selected-agent state must contain only cwd and activeAgentId",
		};
	}

	const cwd = state[STATE_KEYS[0]];
	const activeAgentId = state[STATE_KEYS[1]];
	if (typeof cwd !== "string") {
		return {
			kind: "invalid",
			issue: "selected-agent state cwd must be a string",
		};
	}
	if (!(typeof activeAgentId === "string" || activeAgentId === null)) {
		return {
			kind: "invalid",
			issue: "selected-agent state activeAgentId must be a string or null",
		};
	}

	return { kind: "valid", state: { cwd, activeAgentId } };
}

/** Persists selected-agent state without runtime model, thinking, or tool data. */
async function writeSelectedAgentState(
	state: SelectedAgentState,
): Promise<void> {
	const stateDir = join(getAgentDir(), STATE_DIR);
	await mkdir(stateDir, { recursive: true });
	await writeFile(
		selectedAgentStatePath(state.cwd),
		JSON.stringify(state, null, 2),
	);
}

/** Returns the deterministic selected-agent state path for one normalized working directory. */
function selectedAgentStatePath(cwd: string): string {
	return join(
		getAgentDir(),
		STATE_DIR,
		`${selectedAgentStateFileName(cwd)}.json`,
	);
}

/** Returns the fixed-length selected-agent state file name for one normalized working directory. */
function selectedAgentStateFileName(cwd: string): string {
	return createHash("sha256")
		.update(cwd)
		.digest(SELECTED_AGENT_STATE_HASH_ENCODING);
}

/** Normalizes working-directory identity before state reads and writes. */
function normalizeCwd(cwd: string): string {
	return resolve(cwd);
}

/** Reports a visible issue scoped only to main-agent-selection. */
function reportIssue(ctx: MainAgentContext, issue: string): void {
	if (ctx.hasUI === false) {
		return;
	}

	ctx.ui.notify(`${ISSUE_PREFIX} ${issue}`, "warning");
}

/** Returns true when an object contains only keys from a finite set. */
function hasOnlyKeys(
	value: Record<string, unknown>,
	allowedKeys: readonly string[],
): boolean {
	return Object.keys(value).every((key) => allowedKeys.includes(key));
}

/** Returns true when a runtime value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Converts unknown failures into safe diagnostics for state issue messages. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Returns true when a filesystem error represents a missing state file. */
function isFileNotFoundError(error: unknown): boolean {
	if (!isRecord(error)) {
		return false;
	}

	const { code } = error;
	return code === "ENOENT";
}
