import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	Message,
	Model,
	Tool,
} from "@mariozechner/pi-ai";
import type { ExtensionContext, ToolInfo } from "@mariozechner/pi-coding-agent";
import type { ProjectContextFile } from "../../shared/project-context-prompt";
import type {
	PARTICIPANT_IDS,
	PARTICIPANT_STATUSES,
	THINKING_VALUES,
} from "./constants";
import type { CouncilProgressReporter } from "./progress";

export type { ProjectContextFile };
export type Thinking = (typeof THINKING_VALUES)[number];
export type ParticipantId = (typeof PARTICIPANT_IDS)[number];
export type ParticipantStatus = (typeof PARTICIPANT_STATUSES)[number];

export interface ConveneCouncilDependencies {
	readonly createParticipantRunner?: ParticipantRunnerFactory;
	readonly generateContextSummary?: ContextSummaryGenerator;
	readonly resolveStartupPlan?: () =>
		| ChildStartupPlan
		| { readonly issue: string };
}

export interface ChildStartupPlan {
	readonly extensionArgs: readonly string[];
	readonly env: Record<string, string>;
}

export interface ParticipantRunner {
	prompt(
		task: string,
		signal: AbortSignal | undefined,
	): Promise<AssistantMessage>;
	dispose(): Promise<void>;
}

export interface ContextSummaryRequest {
	readonly contextPackage: string;
	readonly runtime: ParticipantRuntime;
	readonly reserveTokens: number;
	readonly signal: AbortSignal | undefined;
	readonly ctx: CouncilContext;
}

export type ContextSummaryGenerator = (
	request: ContextSummaryRequest,
) => Promise<string>;

export type ParticipantRunnerFactory = (options: {
	readonly participantId: ParticipantId;
	readonly runtime: ParticipantRuntime;
	readonly sessionFile: string;
	readonly sessionDir: string;
	readonly systemPrompt: string;
	readonly config: ConveneCouncilConfig;
	readonly startupPlan: ChildStartupPlan;
	readonly toolArgs: readonly string[];
	readonly tools: readonly Tool[];
	readonly ctx: CouncilContext;
	readonly signal: AbortSignal | undefined;
	readonly onSessionEvent?: (event: unknown) => void;
}) => Promise<ParticipantRunner>;

export interface ConveneCouncilParams {
	readonly question: string;
}

export interface ParticipantModelConfig {
	readonly id?: string;
	readonly thinking?: Thinking;
}

export interface ParticipantConfig {
	readonly model?: ParticipantModelConfig;
}

export interface ContextSummaryConfig {
	readonly model?: ParticipantModelConfig;
}

export interface ConveneCouncilConfig {
	readonly llm1: ParticipantConfig;
	readonly llm2: ParticipantConfig;
	readonly participantIterationLimit: number;
	readonly finalAnswerParticipant: ParticipantId;
	readonly responseDefectRetries: number;
	readonly tools: readonly string[] | undefined;
	readonly contextWindowUsageLimit: number;
	readonly contextSummary: ContextSummaryConfig;
}

export interface ParticipantRuntime {
	readonly model: Model<Api>;
	readonly thinking?: Thinking;
}

export interface CouncilRuntime {
	readonly llm1: ParticipantRuntime;
	readonly llm2: ParticipantRuntime;
}

export interface CouncilContext extends ExtensionContext {
	readonly model: Model<Api> | undefined;
}

export interface ExecuteConveneCouncilOptions {
	readonly createParticipantRunner: ParticipantRunnerFactory;
	readonly generateContextSummary?: ContextSummaryGenerator;
	readonly resolveStartupPlan: () =>
		| ChildStartupPlan
		| { readonly issue: string };
	readonly toolCallId: string;
	readonly params: ConveneCouncilParams;
	readonly signal: AbortSignal | undefined;
	readonly ctx: CouncilContext;
	readonly currentThinkingLevel: unknown;
	readonly loadedSkillRoots: readonly string[];
	readonly contextFiles: readonly ProjectContextFile[];
	readonly availableTools: readonly ToolInfo[];
	readonly onUpdate?: (partial: AgentToolResult<unknown>) => void;
}

export interface ParticipantState {
	readonly id: ParticipantId;
	readonly history: readonly Message[];
	readonly runtime: ParticipantRuntime;
	readonly runner: ParticipantRunner;
	readonly reviewedOpponent: boolean;
	readonly latest?: ParticipantOpinion;
}

export interface CouncilIssue {
	readonly kind: "logical" | "tool-error";
	readonly message: string;
}

export interface ParticipantOpinion {
	readonly opinion: string;
	readonly status?: ParticipantStatus;
}

export interface ParticipantDiscussionResponse extends ParticipantOpinion {
	readonly status: ParticipantStatus;
}

export interface AcceptedParticipantResponse {
	readonly response: ParticipantOpinion;
	readonly assistantMessage: AssistantMessage;
	readonly taskMessage: Message;
}

export interface PlainParticipantRequestOptions {
	readonly participant: ParticipantState;
	readonly task: string;
	readonly config: ConveneCouncilConfig;
	readonly signal: AbortSignal | undefined;
	readonly contextFiles: readonly ProjectContextFile[];
	readonly progress?: CouncilProgressReporter;
}

export type InitialOpinionRequestOptions = PlainParticipantRequestOptions;

export type MissingInformationResponseRequestOptions =
	PlainParticipantRequestOptions;

export interface ParticipantRequestOptions {
	readonly participant: ParticipantState;
	readonly task: string;
	readonly requiredStatus?: ParticipantStatus;
	readonly config: ConveneCouncilConfig;
	readonly signal: AbortSignal | undefined;
	readonly contextFiles: readonly ProjectContextFile[];
	readonly progress?: CouncilProgressReporter;
}

export interface FinalAnswerRequestOptions {
	readonly participant: ParticipantState;
	readonly task: string;
	readonly config: ConveneCouncilConfig;
	readonly signal: AbortSignal | undefined;
	readonly contextFiles: readonly ProjectContextFile[];
	readonly progress?: CouncilProgressReporter;
}
