import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	type Keybinding,
	type SelectItem,
	SelectList,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { agentIdMatches } from "../../shared/agent-id";
import {
	type AgentDefinition,
	loadAgentDefinitions,
} from "../../shared/agent-registry";
import {
	getAgentRuntimeComposition,
	markAgentRuntimeCompositionStale,
} from "../../shared/agent-runtime-composition";
import { writeRuntimeDiagnostic } from "../../shared/agent-runtime-diagnostics";
import {
	getSuiteExtensionDir,
	readExtensionConfigFileSync,
} from "../../shared/agent-suite-storage";
import {
	assertThinkingLevelSupported,
	isModelId,
	splitModelId,
} from "../../shared/model-settings";
import { isSingleLineText } from "../../shared/text-contracts";
import { resolveToolPolicy } from "../../shared/tool-policy";
import {
	type ResolvedWorkflowPolicy,
	resolveWorkflowPolicy,
} from "../../shared/workflow-policy";
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
const AGENT_SELECTION_EXTENSION_DIR = "agent-selection";
const LEGACY_STATE_DIR = join("agent-selection", "state");
const STATE_SUBDIR = "state";
const ISSUE_PREFIX = "[main-agent-selection]";
const LEGACY_CONFIG_FILE = "main-agent-selection.json";
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
	readonly model: Model<Api> | undefined;
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

/** Separates consumed handoffs from successful agent application for runtime diagnostics. */
type SessionReplacementRestoreResult =
	| { readonly handled: false }
	| { readonly handled: true; readonly applied: boolean };

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
		writeRuntimeDiagnostic("main-agent-selection.disabled");
		return;
	}

	writeRuntimeDiagnostic("main-agent-selection.loaded");
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
		await handleSessionStart(pi, event, ctx as MainAgentContext);
	});

	pi.on("session_shutdown", (event, ctx) => {
		handleSessionShutdown(pi, event, ctx as MainAgentContext);
	});
}

/** Handles selected main-agent restoration for one pi session-start event. */
async function handleSessionStart(
	pi: ExtensionAPI,
	event: unknown,
	mainContext: MainAgentContext,
): Promise<void> {
	writeRuntimeDiagnostic("main-agent-selection.session-start.started", {
		reason: (event as SessionStartEventLike).reason ?? null,
		isChildSubagentProcess: isChildSubagentProcess(),
		cwd: mainContext.cwd,
	});
	if (isChildSubagentProcess()) {
		return;
	}

	const replacementRestore = await restoreSessionReplacementMainAgent(
		pi,
		event,
		mainContext,
	);
	if (replacementRestore.handled) {
		if (replacementRestore.applied) {
			writeRuntimeDiagnostic(
				"main-agent-selection.session-start.handoff-restored",
				{
					reason: (event as SessionStartEventLike).reason ?? null,
					activeAgentId:
						getAgentRuntimeComposition(pi).getMainAgentContribution()?.agent
							?.id ?? null,
				},
			);
		}
		return;
	}

	if (!shouldRestoreSelectedMainAgent(event)) {
		writeRuntimeDiagnostic("main-agent-selection.session-start.skipped", {
			reason: (event as SessionStartEventLike).reason ?? null,
		});
		return;
	}

	await restoreSelectedMainAgent(pi, mainContext);
	writeRuntimeDiagnostic("main-agent-selection.session-start.completed", {
		reason: (event as SessionStartEventLike).reason ?? null,
		activeAgentId:
			getAgentRuntimeComposition(pi).getMainAgentContribution()?.agent?.id ??
			null,
		activeTools: pi.getActiveTools(),
	});
}

/** Handles selected main-agent handoff capture for one pi session-shutdown event. */
function handleSessionShutdown(
	pi: ExtensionAPI,
	event: unknown,
	mainContext: MainAgentContext,
): void {
	writeRuntimeDiagnostic("main-agent-selection.session-shutdown.started", {
		reason: (event as SessionShutdownEventLike).reason ?? null,
		isChildSubagentProcess: isChildSubagentProcess(),
	});
	if (isChildSubagentProcess()) {
		return;
	}

	captureSessionReplacementMainAgent(pi, event, mainContext);
	markAgentRuntimeCompositionStale(pi);
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
	writeRuntimeDiagnostic("main-agent-selection.handoff.captured", {
		handoffKey,
		activeAgentId,
	});
	getSessionReplacementHandoffStore().set(handoffKey, activeAgentId);
}

/** Restores a replacement-runtime handoff without consulting or rewriting persisted selected-agent state. */
async function restoreSessionReplacementMainAgent(
	pi: ExtensionAPI,
	event: unknown,
	mainContext: MainAgentContext,
): Promise<SessionReplacementRestoreResult> {
	const handoffKey = getSessionReplacementStartHandoffKey(event, mainContext);
	if (handoffKey === undefined) {
		return { handled: false };
	}

	const handoff = consumeSessionReplacementHandoff(handoffKey);
	writeRuntimeDiagnostic("main-agent-selection.handoff.consumed", {
		handoffKey,
		found: handoff.found,
		activeAgentId: handoff.found ? handoff.activeAgentId : null,
	});
	if (!handoff.found) {
		return { handled: false };
	}
	if (handoff.activeAgentId === null) {
		getAgentRuntimeComposition(pi).clearMainAgentContribution();
		return { handled: true, applied: true };
	}

	const activeAgentId = handoff.activeAgentId;
	const agents = await loadSelectableAgents(mainContext.cwd);
	const agent = agents.find((candidate) =>
		agentIdMatches(candidate.id, activeAgentId),
	);
	if (agent === undefined) {
		reportIssue(
			mainContext,
			`selected agent ${handoff.activeAgentId} was not found`,
		);
		getAgentRuntimeComposition(pi).clearMainAgentContribution();
		return { handled: true, applied: true };
	}

	const application = await applyAgentSelection(pi, mainContext, agent);
	return { handled: true, applied: application === "applied" };
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
	const configFile = readExtensionConfigFileSync({
		extensionDir: AGENT_SELECTION_EXTENSION_DIR,
		legacyConfigFileName: LEGACY_CONFIG_FILE,
	});
	if (configFile.kind === "missing") {
		return false;
	}
	if (configFile.kind === "read-error") {
		throw new Error(
			`${ISSUE_PREFIX} failed to read ${configFile.location.displayPath}: ${formatError(configFile.error)}`,
		);
	}

	try {
		const config: unknown = JSON.parse(configFile.file.content);
		return isRecord(config) && config[ENABLED_CONFIG_KEY] === false;
	} catch (error) {
		throw new Error(
			`${ISSUE_PREFIX} failed to parse ${configFile.file.displayPath}: ${formatError(error)}`,
		);
	}
}

/** Restores the persisted main-agent state before prompts depend on it. */
async function restoreSelectedMainAgent(
	pi: ExtensionAPI,
	mainContext: MainAgentContext,
): Promise<void> {
	const composition = getAgentRuntimeComposition(pi);
	const normalizedCwd = normalizeCwd(mainContext.cwd);
	const agents = await loadSelectableAgents(mainContext.cwd);
	const state = await readSelectedAgentState(normalizedCwd);
	writeRuntimeDiagnostic("main-agent-selection.restore.state-read", {
		cwd: normalizedCwd,
		stateKind: state.kind,
		activeAgentId: state.kind === "valid" ? state.state.activeAgentId : null,
		issue: state.kind === "invalid" ? state.issue : null,
	});
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

	const activeAgentId = state.state.activeAgentId;
	const agent = agents.find((candidate) =>
		agentIdMatches(candidate.id, activeAgentId),
	);
	if (agent === undefined) {
		reportIssue(
			mainContext,
			`selected agent ${state.state.activeAgentId} was not found`,
		);
		composition.clearMainAgentContribution();
		return;
	}

	const application = await applyAgentSelection(pi, mainContext, agent);
	if (application !== "applied") {
		return;
	}
	writeRuntimeDiagnostic("main-agent-selection.restore.applied", {
		activeAgentId: agent.id,
		activeTools: pi.getActiveTools(),
	});
}

/** Selects a main agent by explicit ID or interactive UI choice. */
async function selectMainAgent(
	pi: ExtensionAPI,
	ctx: MainAgentContext,
	explicitAgentId: string | undefined,
): Promise<void> {
	const agents = await loadSelectableAgents(ctx.cwd);
	const selectedAgentId =
		explicitAgentId ?? (await promptForAgent(pi, ctx, agents));
	if (selectedAgentId === undefined) {
		return;
	}
	if (selectedAgentId === null) {
		await selectNoMainAgent(pi, ctx);
		return;
	}

	const agent = agents.find((candidate) =>
		agentIdMatches(candidate.id, selectedAgentId),
	);
	if (agent === undefined) {
		reportIssue(ctx, `agent ${selectedAgentId} was not found`);
		return;
	}

	const normalizedCwd = normalizeCwd(ctx.cwd);
	const application = await applyAgentSelection(pi, ctx, agent);
	if (application === "workflow-policy-error") {
		return;
	}
	if (application === "application-error") {
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

/** Loads agents that can be used as top-level main agents for the active project registry. */
async function loadSelectableAgents(cwd: string): Promise<AgentDefinition[]> {
	const agents = await loadAgentDefinitions(cwd);
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
): Promise<"applied" | "workflow-policy-error" | "application-error"> {
	writeRuntimeDiagnostic("main-agent-selection.apply.started", {
		agentId: agent.id,
		promptLength: agent.prompt.length,
		configuredTools: agent.tools ?? null,
		configuredWorkflows: agent.workflows ?? null,
		configuredSubagents: agent.agents ?? null,
		availableTools: pi.getAllTools().map((tool) => tool.name),
	});
	const policies = resolveMainAgentPolicies(pi, ctx, agent);
	if (policies.kind === "error") {
		return policies.outcome;
	}

	const thinkingIssue = validateConfiguredThinking(ctx, agent);
	if (thinkingIssue !== undefined) {
		clearMainAgentSelection(pi);
		reportIssue(ctx, thinkingIssue);
		return "application-error";
	}

	const modelIssue = await applyConfiguredModel(pi, ctx, agent);
	if (modelIssue !== undefined) {
		clearMainAgentSelection(pi);
		reportIssue(ctx, modelIssue);
		return "application-error";
	}

	const appliedThinkingIssue = applyConfiguredThinking(pi, agent);
	if (appliedThinkingIssue !== undefined) {
		clearMainAgentSelection(pi);
		reportIssue(ctx, appliedThinkingIssue);
		return "application-error";
	}

	writeRuntimeDiagnostic("main-agent-selection.apply.resolved", {
		agentId: agent.id,
		resolvedTools: policies.tools ?? null,
		resolvedWorkflows: policies.workflows ?? null,
		configuredSubagents: agent.agents ?? null,
	});
	getAgentRuntimeComposition(pi).setMainAgentContribution({
		prompt: agent.prompt,
		agent: {
			id: agent.id,
			...(policies.tools !== undefined ? { tools: policies.tools } : {}),
			...workflowPolicyMetadata(policies.workflows),
			...(agent.agents !== undefined ? { agents: agent.agents } : {}),
		},
		...(agent.model !== undefined ? { model: agent.model } : {}),
		...(policies.tools !== undefined ? { tools: policies.tools } : {}),
	});
	return "applied";
}

/** Validates configured thinking against the model that would receive it. */
function validateConfiguredThinking(
	ctx: MainAgentContext,
	agent: AgentDefinition,
): string | undefined {
	const thinking = agent.model?.thinking;
	if (thinking === undefined) {
		return undefined;
	}
	const model =
		agent.model?.id === undefined
			? ctx.model
			: resolveModel(ctx, agent.model.id);
	if (model === undefined) {
		return agent.model?.id === undefined
			? "current model is unavailable"
			: `model ${agent.model.id} was not found`;
	}
	try {
		assertThinkingLevelSupported(model, thinking);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** Applies configured thinking and rejects Pi's silent capability clamping. */
function applyConfiguredThinking(
	pi: ExtensionAPI,
	agent: AgentDefinition,
): string | undefined {
	const thinking = agent.model?.thinking;
	if (thinking === undefined) {
		return undefined;
	}
	try {
		pi.setThinkingLevel(thinking);
		if (pi.getThinkingLevel() !== thinking) {
			return `thinking level ${thinking} could not be applied`;
		}
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** Applies one optional configured model and returns a precise failure issue. */
async function applyConfiguredModel(
	pi: ExtensionAPI,
	ctx: MainAgentContext,
	agent: AgentDefinition,
): Promise<string | undefined> {
	if (agent.model?.id === undefined) {
		return undefined;
	}
	const model = resolveModel(ctx, agent.model.id);
	if (model === undefined) {
		return `model ${agent.model.id} was not found`;
	}
	return (await pi.setModel(model))
		? undefined
		: `model ${agent.model.id} could not be applied`;
}

/** Resolves tool and workflow policy before model or runtime-composition side effects. */
function resolveMainAgentPolicies(
	pi: ExtensionAPI,
	ctx: MainAgentContext,
	agent: AgentDefinition,
):
	| {
			readonly kind: "resolved";
			readonly tools?: readonly string[];
			readonly workflows: ResolvedWorkflowPolicy;
	  }
	| {
			readonly kind: "error";
			readonly outcome: "workflow-policy-error" | "application-error";
	  } {
	const workflows = resolveWorkflowPolicy(pi, agent.workflows);
	if (workflows.kind === "error") {
		reportIssue(ctx, workflows.issue);
		return { kind: "error", outcome: "workflow-policy-error" };
	}
	const tools = resolveMainAgentTools(pi, agent);
	if ("issue" in tools) {
		clearMainAgentSelection(pi);
		reportIssue(ctx, tools.issue);
		return { kind: "error", outcome: "application-error" };
	}
	return {
		kind: "resolved",
		...(tools.tools === undefined ? {} : { tools: tools.tools }),
		workflows: workflows.policy,
	};
}

/** Omits unrestricted policy while preserving empty and explicit canonical IDs. */
function workflowPolicyMetadata(policy: ResolvedWorkflowPolicy): {
	readonly workflows?: readonly string[];
} {
	return policy === undefined ? {} : { workflows: policy };
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
	if (!isModelId(modelId)) {
		return undefined;
	}
	const { provider, id } = splitModelId(modelId);
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
	const stateFile = await readSelectedAgentStateFile(cwd);
	if (stateFile.kind === "missing") {
		return { kind: "missing" };
	}
	if (stateFile.kind === "invalid") {
		return stateFile;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(stateFile.content);
	} catch (error) {
		return {
			kind: "invalid",
			issue: `failed to parse selected-agent state: ${formatError(error)}`,
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
	if (!(isSingleLineText(activeAgentId) || activeAgentId === null)) {
		return {
			kind: "invalid",
			issue:
				"selected-agent state activeAgentId must be a single-line string or null",
		};
	}

	return {
		kind: "valid",
		state: {
			cwd,
			activeAgentId:
				activeAgentId === null ? null : activeAgentId.normalize("NFC"),
		},
	};
}

/** Persists selected-agent state without runtime model, thinking, or tool data. */
async function writeSelectedAgentState(
	state: SelectedAgentState,
): Promise<void> {
	const stateDir = selectedAgentStateDir();
	await mkdir(stateDir, { recursive: true });
	await writeFile(
		selectedAgentStatePath(state.cwd),
		JSON.stringify(state, null, 2),
	);
}

/** Reads selected-agent state from suite storage and falls back to legacy storage only when suite state is absent. */
async function readSelectedAgentStateFile(
	cwd: string,
): Promise<
	| { readonly kind: "missing" }
	| { readonly kind: "valid"; readonly content: string }
	| { readonly kind: "invalid"; readonly issue: string }
> {
	try {
		return {
			kind: "valid",
			content: await readFile(selectedAgentStatePath(cwd), "utf8"),
		};
	} catch (error) {
		if (!isFileNotFoundError(error)) {
			return {
				kind: "invalid",
				issue: `failed to read selected-agent state: ${formatError(error)}`,
			};
		}
	}

	try {
		return {
			kind: "valid",
			content: await readFile(legacySelectedAgentStatePath(cwd), "utf8"),
		};
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return { kind: "missing" };
		}

		return {
			kind: "invalid",
			issue: `failed to read selected-agent state: ${formatError(error)}`,
		};
	}
}

/** Returns the suite-owned selected-agent state directory. */
function selectedAgentStateDir(): string {
	return join(
		getSuiteExtensionDir(AGENT_SELECTION_EXTENSION_DIR),
		STATE_SUBDIR,
	);
}

/** Returns the deterministic selected-agent state path for one normalized working directory. */
function selectedAgentStatePath(cwd: string): string {
	return join(
		selectedAgentStateDir(),
		`${selectedAgentStateFileName(cwd)}.json`,
	);
}

/** Returns the legacy selected-agent state path for one normalized working directory. */
function legacySelectedAgentStatePath(cwd: string): string {
	return join(
		getAgentDir(),
		LEGACY_STATE_DIR,
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
