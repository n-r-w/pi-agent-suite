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

type ActiveToolFilter = (
	toolNames: readonly string[],
	ctx: unknown,
) => Promise<readonly string[]> | readonly string[];

/** Runtime composition owner for agent-related prompt and active-tool contributions. */
export interface AgentRuntimeComposition {
	setMainAgentContribution(
		contribution: MainAgentContribution | undefined,
	): void;
	clearMainAgentContribution(): void;
	getMainAgentContribution(): MainAgentContribution | undefined;
	setSubagentsContribution(contribution: PromptContribution | undefined): void;
	setSubagentsActiveToolFilter(filter: ActiveToolFilter | undefined): void;
	setConsultAdvisorContribution(
		contribution: PromptContribution | undefined,
	): void;
	setConveneCouncilContribution(
		contribution: PromptContribution | undefined,
	): void;
}

const RUNTIME_PROPERTY = "__piHarnessAgentRuntimeComposition";

export const MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT =
	"pi-harness:main-agent-contribution-change";

interface RuntimeCompositionHolder {
	runtime: AgentRuntimeComposition;
	stale: boolean;
}

interface RuntimeCompositionCarrier {
	[RUNTIME_PROPERTY]?: RuntimeCompositionHolder;
}

interface AgentRuntimeEventBus {
	emit(
		eventName: typeof MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT,
		data: undefined,
	): void;
}

/** Returns the singleton runtime composition owner for one extension runtime. */
export function getAgentRuntimeComposition(
	pi: ExtensionAPI,
): AgentRuntimeComposition {
	const carrier = pi.events as RuntimeCompositionCarrier;
	const existing = carrier[RUNTIME_PROPERTY];
	if (existing !== undefined && !existing.stale) {
		return existing.runtime;
	}

	writeRuntimeDiagnostic("runtime-composition.created", {
		replacedStaleRuntime: existing !== undefined,
	});
	const holder: RuntimeCompositionHolder = {
		runtime: new AgentRuntimeCompositionImpl(pi),
		stale: false,
	};
	if (existing !== undefined) {
		carrier[RUNTIME_PROPERTY] = holder;
		return holder.runtime;
	}

	Object.defineProperty(carrier, RUNTIME_PROPERTY, {
		configurable: false,
		enumerable: false,
		value: holder,
		writable: true,
	});
	return holder.runtime;
}

/** Marks the current runtime composition stale after pi starts replacing the extension runtime. */
export function markAgentRuntimeCompositionStale(pi: ExtensionAPI): void {
	const holder = (pi.events as RuntimeCompositionCarrier)[RUNTIME_PROPERTY];
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
	private subagentsActiveToolFilter: ActiveToolFilter | undefined;
	private consultAdvisorContribution: PromptContribution | undefined;
	private conveneCouncilContribution: PromptContribution | undefined;
	private baselineActiveTools: string[] | undefined;

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
		if (this.baselineActiveTools === undefined) {
			this.baselineActiveTools = this.pi.getActiveTools();
		}

		writeRuntimeDiagnostic("runtime-composition.main-agent.set", {
			mainAgentId: contribution?.agent?.id ?? null,
			mainPromptLength: contribution?.prompt.length ?? 0,
			mainAgentTools: contribution?.agent?.tools ?? null,
			mainAgentSubagents: contribution?.agent?.agents ?? null,
			activeToolsBeforeSet: this.pi.getActiveTools(),
		});
		this.mainAgentContribution = contribution;
		this.pi.setActiveTools(
			contribution?.tools !== undefined
				? [...contribution.tools]
				: this.baselineActiveTools,
		);
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

	public setSubagentsActiveToolFilter(
		filter: ActiveToolFilter | undefined,
	): void {
		this.subagentsActiveToolFilter = filter;
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

	/** Applies dynamic tool filters after selected-agent restoration and before prompt composition. */
	private async resolveActiveToolNames(
		ctx: unknown,
	): Promise<readonly string[]> {
		const currentToolNames = this.pi.getActiveTools();
		const filteredToolNames =
			this.subagentsActiveToolFilter === undefined
				? currentToolNames
				: await this.subagentsActiveToolFilter(currentToolNames, ctx);
		if (!areStringArraysEqual(currentToolNames, filteredToolNames)) {
			this.pi.setActiveTools([...filteredToolNames]);
		}

		return filteredToolNames;
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
function areStringArraysEqual(
	left: readonly string[],
	right: readonly string[],
): boolean {
	if (left.length !== right.length) {
		return false;
	}

	return left.every((value, index) => value === right[index]);
}
