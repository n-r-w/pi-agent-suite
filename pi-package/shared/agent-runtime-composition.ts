import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeRuntimeDiagnostic } from "./agent-runtime-diagnostics";
import type { ModelSettings } from "./model-settings";

export interface MainAgentRuntimeInfo {
	readonly id: string;
	readonly tools?: readonly string[];
	readonly workflows?: readonly string[];
	readonly agents?: readonly string[];
}

export interface MainAgentContribution {
	readonly prompt: string;
	readonly tools?: readonly string[];
	readonly agent?: MainAgentRuntimeInfo;
	readonly model?: ModelSettings;
}

/** Defines static or dynamic guidance built after runtime tool filtering. */
interface PromptContribution {
	readonly prompt?: string;
	readonly buildPrompt?: (
		activeToolNames: readonly string[],
		cwd: string,
	) => Promise<string | undefined> | string | undefined;
	readonly requiredToolName?: string;
}

interface BeforeAgentStartEventLike {
	readonly systemPrompt?: string;
}

type ActiveToolFilter = (toolNames: readonly string[]) => readonly string[];

/** Runtime composition owner for agent-related prompt and active-tool contributions. */
export interface AgentRuntimeComposition {
	setMainAgentContribution(
		contribution: MainAgentContribution | undefined,
	): void;
	clearMainAgentContribution(): void;
	getMainAgentContribution(): MainAgentContribution | undefined;
	setSubagentsContribution(contribution: PromptContribution | undefined): void;
	/** Records tools registered during extension loading without invoking Pi action methods. */
	publishBaselineToolNames(toolNames: readonly string[]): void;
	/** Adds registered baseline tools without allowing policy filters to be bypassed. */
	addBaselineToolNames(toolNames: readonly string[]): void;
	/** Replaces one owner's registered baseline-tool contribution. */
	replaceBaselineToolNames(owner: string, toolNames: readonly string[]): void;
	/** Stages one owner's baseline replacement for a coupled reconciliation. */
	stageBaselineToolNames(owner: string, toolNames: readonly string[]): void;
	/** Applies one named restrictive allowlist to the final active-tool pipeline. */
	setRestrictiveToolNames(
		name: string,
		toolNames: readonly string[] | undefined,
	): void;
	/** Applies one named restrictive filter to every active-tool reconciliation. */
	setRestrictiveToolFilter(
		name: string,
		filter: ActiveToolFilter | undefined,
	): void;
	/** Records an extension-loading filter without calling unavailable Pi action methods. */
	publishRestrictiveToolFilter(name: string, filter: ActiveToolFilter): void;
	reconcileActiveTools(): void;
	setConsultAdvisorContribution(
		contribution: PromptContribution | undefined,
	): void;
	setConveneCouncilContribution(
		contribution: PromptContribution | undefined,
	): void;
}

export const MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT =
	"pi-harness:main-agent-contribution-change";

/** Event bus channel for synchronous cross-extension composition lookup. */
const COMPOSITION_REQUEST_CHANNEL =
	"pi-harness:agent-runtime-composition:request";

interface RuntimeCompositionHolder {
	runtime: AgentRuntimeComposition;
	stale: boolean;
}

/** Mutable slot passed through the event bus for request-reply. */
interface CompositionSlot {
	holder: RuntimeCompositionHolder | undefined;
}

/** Per-pi cache so each extension and each test fake keeps its own reference.
 *
 * In production, all entries point to the same shared holder (found via the
 * event bus). In tests, each fake pi gets its own isolated holder.
 */
const holderByPi = new WeakMap<ExtensionAPI, RuntimeCompositionHolder>();

interface AgentRuntimeEventBus {
	emit(
		eventName: typeof MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT,
		data: undefined,
	): void;
}

/** Returns the singleton runtime composition owner for one extension runtime.
 *
 * Pi 0.84.0 loads each extension via jiti with `moduleCache: false`, giving
 * every extension its own copy of shared modules. The event bus is the only
 * channel shared across extension instances, so the composition reference is
 * exchanged through a synchronous emit/on request-reply with a mutable slot.
 * A WeakMap keyed by pi provides per-instance caching and test isolation.
 */
export function getAgentRuntimeComposition(
	pi: ExtensionAPI,
): AgentRuntimeComposition {
	const cached = holderByPi.get(pi);
	if (cached !== undefined && !cached.stale) {
		return cached.runtime;
	}

	/** Asks whether another extension already created the composition. */
	const slot: CompositionSlot = { holder: undefined };
	if (typeof pi.events?.emit === "function") {
		pi.events.emit(COMPOSITION_REQUEST_CHANNEL, slot);
	}
	if (slot.holder !== undefined && !slot.holder.stale) {
		holderByPi.set(pi, slot.holder);
		return slot.holder.runtime;
	}

	writeRuntimeDiagnostic("runtime-composition.created", {
		replacedStaleRuntime: slot.holder !== undefined,
	});
	const holder: RuntimeCompositionHolder = {
		runtime: new AgentRuntimeCompositionImpl(pi),
		stale: false,
	};
	holderByPi.set(pi, holder);

	/** Replies to future requests from other extensions with this holder. */
	if (typeof pi.events?.on === "function") {
		pi.events.on(COMPOSITION_REQUEST_CHANNEL, (data: unknown) => {
			(data as CompositionSlot).holder = holder;
		});
	}

	return holder.runtime;
}

/** Marks the current runtime composition stale after pi starts replacing the extension runtime. */
export function markAgentRuntimeCompositionStale(pi: ExtensionAPI): void {
	const holder = holderByPi.get(pi);
	if (holder === undefined) {
		return;
	}

	holder.stale = true;
	writeRuntimeDiagnostic("runtime-composition.stale-marked");
}

/** Owns final prompt and active-tool application for agent-related extensions. */
class AgentRuntimeCompositionImpl implements AgentRuntimeComposition {
	private mainAgentContribution: MainAgentContribution | undefined;
	private subagentsContribution: PromptContribution | undefined;
	private consultAdvisorContribution: PromptContribution | undefined;
	private conveneCouncilContribution: PromptContribution | undefined;
	private baselineActiveTools: string[] | undefined;
	private readonly pendingBaselineToolNames: string[] = [];
	private readonly baselineToolNamesByOwner = new Map<
		string,
		readonly string[]
	>();
	private readonly restrictiveToolNames = new Map<string, readonly string[]>();
	private readonly restrictiveToolFilters = new Map<string, ActiveToolFilter>();

	public constructor(private readonly pi: ExtensionAPI) {
		writeRuntimeDiagnostic("runtime-composition.before-agent-start.registered");
		this.pi.on("before_agent_start", async (event, ctx) => {
			writeRuntimeDiagnostic("runtime-composition.before-agent-start.started", {
				mainAgentId: this.mainAgentContribution?.agent?.id ?? null,
				mainPromptLength: this.mainAgentContribution?.prompt.length ?? 0,
				activeToolsBeforeFilter: this.pi.getActiveTools(),
			});
			const activeToolNames = await this.resolveActiveToolNames(ctx);
			const { cwd } = ctx;
			const mainAgentPrompt = this.mainAgentContribution?.prompt;
			const subagentsPrompt = await resolvePromptContribution(
				this.subagentsContribution,
				activeToolNames,
				cwd,
			);
			const consultAdvisorPrompt = await resolvePromptContribution(
				this.consultAdvisorContribution,
				activeToolNames,
				cwd,
			);
			const conveneCouncilPrompt = await resolvePromptContribution(
				this.conveneCouncilContribution,
				activeToolNames,
				cwd,
			);
			const contributionPrompts = [
				mainAgentPrompt,
				subagentsPrompt,
				consultAdvisorPrompt,
				conveneCouncilPrompt,
			].filter((prompt) => prompt !== undefined && prompt.length > 0);
			writeRuntimeDiagnostic(
				"runtime-composition.before-agent-start.resolved",
				{
					mainAgentId: this.mainAgentContribution?.agent?.id ?? null,
					activeTools: activeToolNames,
					basePromptLength:
						(event as BeforeAgentStartEventLike).systemPrompt?.length ?? 0,
					mainAgentPromptLength: mainAgentPrompt?.length ?? 0,
					subagentsPromptLength: subagentsPrompt?.length ?? 0,
					consultAdvisorPromptLength: consultAdvisorPrompt?.length ?? 0,
					conveneCouncilPromptLength: conveneCouncilPrompt?.length ?? 0,
					contributionCount: contributionPrompts.length,
				},
			);
			if (contributionPrompts.length === 0) {
				return undefined;
			}

			const basePrompt = (event as BeforeAgentStartEventLike).systemPrompt;
			const systemPrompt = [basePrompt, ...contributionPrompts]
				.filter(Boolean)
				.join("\n\n");
			writeRuntimeDiagnostic("runtime-composition.before-agent-start.applied", {
				mainAgentId: this.mainAgentContribution?.agent?.id ?? null,
				finalPromptLength: systemPrompt.length,
			});
			return { systemPrompt };
		});
	}

	public setMainAgentContribution(
		contribution: MainAgentContribution | undefined,
	): void {
		this.ensureBaselineActiveTools();

		writeRuntimeDiagnostic("runtime-composition.main-agent.set", {
			mainAgentId: contribution?.agent?.id ?? null,
			mainPromptLength: contribution?.prompt.length ?? 0,
			mainAgentTools: contribution?.agent?.tools ?? null,
			mainAgentSubagents: contribution?.agent?.agents ?? null,
			activeToolsBeforeSet: this.pi.getActiveTools(),
		});
		this.mainAgentContribution = contribution;
		this.reconcileActiveTools();
		writeRuntimeDiagnostic("runtime-composition.main-agent.tools-applied", {
			mainAgentId: contribution?.agent?.id ?? null,
			activeToolsAfterSet: this.pi.getActiveTools(),
		});
		(this.pi.events as unknown as AgentRuntimeEventBus).emit(
			MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT,
			undefined,
		);
	}

	public clearMainAgentContribution(): void {
		if (this.mainAgentContribution === undefined) {
			return;
		}

		this.setMainAgentContribution(undefined);
	}

	public getMainAgentContribution(): MainAgentContribution | undefined {
		return this.mainAgentContribution;
	}

	public setSubagentsContribution(
		contribution: PromptContribution | undefined,
	): void {
		this.subagentsContribution = contribution;
	}

	public publishBaselineToolNames(toolNames: readonly string[]): void {
		for (const name of toolNames) {
			if (
				!this.pendingBaselineToolNames.includes(name) &&
				!this.baselineActiveTools?.includes(name)
			) {
				this.pendingBaselineToolNames.push(name);
			}
		}
	}

	public addBaselineToolNames(toolNames: readonly string[]): void {
		const baseline = this.ensureBaselineActiveTools();
		for (const name of toolNames) {
			if (!baseline.includes(name)) {
				baseline.push(name);
			}
		}
		this.reconcileActiveTools();
	}

	public replaceBaselineToolNames(
		owner: string,
		toolNames: readonly string[],
	): void {
		const baseline = this.ensureBaselineActiveTools();
		const previousBaseline = [...baseline];
		const previousContribution = this.baselineToolNamesByOwner.get(owner);
		this.stageBaselineToolNames(owner, toolNames);
		try {
			this.reconcileActiveTools();
		} catch (error) {
			// Baseline ownership and Pi's active list must describe the same catalog.
			baseline.splice(0, baseline.length, ...previousBaseline);
			if (previousContribution === undefined) {
				this.baselineToolNamesByOwner.delete(owner);
			} else {
				this.baselineToolNamesByOwner.set(owner, previousContribution);
			}
			this.reconcileActiveTools();
			throw error;
		}
	}

	public stageBaselineToolNames(
		owner: string,
		toolNames: readonly string[],
	): void {
		const baseline = this.ensureBaselineActiveTools();
		const previousContribution = this.baselineToolNamesByOwner.get(owner);
		const nextContribution = [...new Set(toolNames)];
		const namesOwnedElsewhere = new Set(
			[...this.baselineToolNamesByOwner.entries()]
				.filter(([candidateOwner]) => candidateOwner !== owner)
				.flatMap(([, names]) => names),
		);
		const removedNames = new Set(
			(previousContribution ?? []).filter(
				(name) =>
					!nextContribution.includes(name) && !namesOwnedElsewhere.has(name),
			),
		);

		baseline.splice(
			0,
			baseline.length,
			...baseline.filter((name) => !removedNames.has(name)),
		);
		for (const name of nextContribution) {
			if (!baseline.includes(name)) {
				baseline.push(name);
			}
		}
		this.baselineToolNamesByOwner.set(owner, nextContribution);
	}

	public setRestrictiveToolNames(
		name: string,
		toolNames: readonly string[] | undefined,
	): void {
		if (toolNames === undefined) {
			this.restrictiveToolNames.delete(name);
		} else {
			this.restrictiveToolNames.set(name, [...toolNames]);
		}
		this.reconcileActiveTools();
	}

	public setRestrictiveToolFilter(
		name: string,
		filter: ActiveToolFilter | undefined,
	): void {
		if (filter === undefined) {
			this.restrictiveToolFilters.delete(name);
		} else {
			this.restrictiveToolFilters.set(name, filter);
		}
		this.reconcileActiveTools();
	}

	/** Records a restriction during extension loading and reconciles it only after Pi actions become available. */
	public publishRestrictiveToolFilter(
		name: string,
		filter: ActiveToolFilter,
	): void {
		this.restrictiveToolFilters.set(name, filter);
		if (this.baselineActiveTools !== undefined) {
			this.reconcileActiveTools();
		}
	}

	public reconcileActiveTools(): void {
		const baseline = this.ensureBaselineActiveTools();
		const source = this.mainAgentContribution?.tools ?? baseline;
		const resolved = [...source];
		for (const allowedNames of this.restrictiveToolNames.values()) {
			intersectToolNames(resolved, allowedNames);
		}
		for (const filter of this.restrictiveToolFilters.values()) {
			intersectToolNames(resolved, filter(resolved));
		}
		if (!areStringArraysEqual(this.pi.getActiveTools(), resolved)) {
			this.pi.setActiveTools(resolved);
		}
	}

	public setConsultAdvisorContribution(
		contribution: PromptContribution | undefined,
	): void {
		this.consultAdvisorContribution = contribution;
	}

	public setConveneCouncilContribution(
		contribution: PromptContribution | undefined,
	): void {
		this.conveneCouncilContribution = contribution;
	}

	/** Captures Pi state lazily because action methods are unavailable during extension loading. */
	private ensureBaselineActiveTools(): string[] {
		if (this.baselineActiveTools === undefined) {
			this.baselineActiveTools = [...this.pi.getActiveTools()];
		}
		const baseline = this.baselineActiveTools;
		for (const name of this.pendingBaselineToolNames) {
			if (!baseline.includes(name)) {
				baseline.push(name);
			}
		}
		this.pendingBaselineToolNames.length = 0;
		return baseline;
	}

	/** Resolves every named restriction before composing tool-dependent prompts. */
	private resolveActiveToolNames(_ctx: unknown): readonly string[] {
		this.reconcileActiveTools();
		return this.pi.getActiveTools();
	}
}

/** Resolves static and dynamic prompt contributions at agent-start time. */
async function resolvePromptContribution(
	contribution: PromptContribution | undefined,
	activeToolNames: readonly string[],
	cwd: string,
): Promise<string | undefined> {
	if (contribution?.requiredToolName !== undefined) {
		const isToolActive = activeToolNames.includes(
			contribution.requiredToolName,
		);
		if (!isToolActive) {
			return undefined;
		}
	}

	return (
		contribution?.buildPrompt?.(activeToolNames, cwd) ?? contribution?.prompt
	);
}

/** Compares ordered tool-name lists to avoid redundant active-tool writes. */
function intersectToolNames(
	candidates: string[],
	requestedNames: readonly string[],
): void {
	const requested = new Set(requestedNames);
	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const candidate = candidates[index];
		if (candidate !== undefined && !requested.has(candidate)) {
			candidates.splice(index, 1);
		}
	}
}

function areStringArraysEqual(
	left: readonly string[],
	right: readonly string[],
): boolean {
	if (left.length !== right.length) {
		return false;
	}

	return left.every((value, index) => value === right[index]);
}
