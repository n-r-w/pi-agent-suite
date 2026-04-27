import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface MainAgentRuntimeInfo {
	readonly id: string;
	readonly tools?: readonly string[];
	readonly agents?: readonly string[];
}

export interface MainAgentContribution {
	readonly prompt: string;
	readonly tools?: readonly string[];
	readonly agent?: MainAgentRuntimeInfo;
}

interface PromptContribution {
	readonly prompt?: string;
	readonly buildPrompt?: () => Promise<string | undefined> | string | undefined;
	readonly requiredToolName?: string;
}

interface BeforeAgentStartEventLike {
	readonly systemPrompt?: string;
}

type BeforeComposeHandler = (ctx: unknown) => Promise<void> | void;
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
	setBeforeComposeHandler(handler: BeforeComposeHandler | undefined): void;
	setRunSubagentContribution(
		contribution: PromptContribution | undefined,
	): void;
	setRunSubagentActiveToolFilter(filter: ActiveToolFilter | undefined): void;
	setConsultAdvisorContribution(
		contribution: PromptContribution | undefined,
	): void;
}

const RUNTIME_PROPERTY = "__piHarnessAgentRuntimeCompositionV2";

interface RuntimeCompositionCarrier {
	[RUNTIME_PROPERTY]?: AgentRuntimeComposition;
}

/** Returns the singleton runtime composition owner for one extension runtime. */
export function getAgentRuntimeComposition(
	pi: ExtensionAPI,
): AgentRuntimeComposition {
	const carrier = pi.events as RuntimeCompositionCarrier;
	const existing = carrier[RUNTIME_PROPERTY];
	if (existing !== undefined) {
		return existing;
	}

	const runtime = new AgentRuntimeCompositionImpl(pi);
	Object.defineProperty(carrier, RUNTIME_PROPERTY, {
		configurable: false,
		enumerable: false,
		value: runtime,
		writable: false,
	});
	return runtime;
}

/** Owns final prompt and active-tool application for agent-related extensions. */
class AgentRuntimeCompositionImpl implements AgentRuntimeComposition {
	private mainAgentContribution: MainAgentContribution | undefined;
	private runSubagentContribution: PromptContribution | undefined;
	private runSubagentActiveToolFilter: ActiveToolFilter | undefined;
	private consultAdvisorContribution: PromptContribution | undefined;
	private beforeComposeHandler: BeforeComposeHandler | undefined;
	private baselineActiveTools: string[] | undefined;

	public constructor(private readonly pi: ExtensionAPI) {
		this.pi.on("before_agent_start", async (event, ctx) => {
			await this.beforeComposeHandler?.(ctx);
			const activeToolNames = await this.resolveActiveToolNames(ctx);
			const contributionPrompts = (
				await Promise.all([
					this.mainAgentContribution?.prompt,
					resolvePromptContribution(
						this.runSubagentContribution,
						activeToolNames,
					),
					resolvePromptContribution(
						this.consultAdvisorContribution,
						activeToolNames,
					),
				])
			).filter((prompt) => prompt !== undefined && prompt.length > 0);
			if (contributionPrompts.length === 0) {
				return undefined;
			}

			const basePrompt = (event as BeforeAgentStartEventLike).systemPrompt;
			return {
				systemPrompt: [basePrompt, ...contributionPrompts]
					.filter(Boolean)
					.join("\n\n"),
			};
		});
	}

	public setMainAgentContribution(
		contribution: MainAgentContribution | undefined,
	): void {
		if (this.baselineActiveTools === undefined) {
			this.baselineActiveTools = this.pi.getActiveTools();
		}

		this.mainAgentContribution = contribution;
		this.pi.setActiveTools(
			contribution?.tools !== undefined
				? [...contribution.tools]
				: this.baselineActiveTools,
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

	public setBeforeComposeHandler(
		handler: BeforeComposeHandler | undefined,
	): void {
		this.beforeComposeHandler = handler;
	}

	public setRunSubagentContribution(
		contribution: PromptContribution | undefined,
	): void {
		this.runSubagentContribution = contribution;
	}

	public setRunSubagentActiveToolFilter(
		filter: ActiveToolFilter | undefined,
	): void {
		this.runSubagentActiveToolFilter = filter;
	}

	public setConsultAdvisorContribution(
		contribution: PromptContribution | undefined,
	): void {
		this.consultAdvisorContribution = contribution;
	}

	/** Applies dynamic tool filters after selected-agent restoration and before prompt composition. */
	private async resolveActiveToolNames(
		ctx: unknown,
	): Promise<readonly string[]> {
		const currentToolNames = this.pi.getActiveTools();
		const filteredToolNames =
			this.runSubagentActiveToolFilter === undefined
				? currentToolNames
				: await this.runSubagentActiveToolFilter(currentToolNames, ctx);
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
): Promise<string | undefined> {
	if (contribution?.requiredToolName !== undefined) {
		const isToolActive = activeToolNames.includes(
			contribution.requiredToolName,
		);
		if (!isToolActive) {
			return undefined;
		}
	}

	return contribution?.buildPrompt?.() ?? contribution?.prompt;
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
