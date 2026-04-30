import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
	PARTICIPANT_IDS,
	PARTICIPANT_STATUSES,
	THINKING_VALUES,
} from "./constants";

export type Thinking = (typeof THINKING_VALUES)[number];
export type ParticipantId = (typeof PARTICIPANT_IDS)[number];
export type ParticipantStatus = (typeof PARTICIPANT_STATUSES)[number];

export interface ConveneCouncilDependencies {
	readonly completeSimple?: (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
}

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

export interface ConveneCouncilConfig {
	readonly llm1: ParticipantConfig;
	readonly llm2: ParticipantConfig;
	readonly participantIterationLimit: number;
	readonly finalAnswerParticipant: ParticipantId;
	readonly responseDefectRetries: number;
	readonly providerRequestRetries: number;
	readonly providerRetryDelayMs: number;
}

export interface ParticipantRuntime {
	readonly model: Model<Api>;
	readonly apiKey?: string;
	readonly headers?: Record<string, string>;
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
	readonly completeSimple: NonNullable<
		ConveneCouncilDependencies["completeSimple"]
	>;
	readonly toolCallId: string;
	readonly params: ConveneCouncilParams;
	readonly signal: AbortSignal | undefined;
	readonly ctx: CouncilContext;
	readonly currentThinkingLevel: unknown;
	readonly loadedSkillRoots: readonly string[];
}

export interface ParticipantState {
	readonly id: ParticipantId;
	readonly history: readonly Message[];
	readonly runtime: ParticipantRuntime;
	readonly reviewedOpponent: boolean;
	readonly latest?: ParticipantDiscussionResponse;
}

export interface CouncilIssue {
	readonly kind: "logical" | "tool-error";
	readonly message: string;
}

export interface ParticipantDiscussionResponse {
	readonly status: ParticipantStatus;
	readonly opinion: string;
}

export interface AcceptedParticipantResponse {
	readonly response: ParticipantDiscussionResponse;
	readonly assistantMessage: AssistantMessage;
	readonly taskMessage: Message;
}

export interface ParticipantRequestOptions {
	readonly participant: ParticipantState;
	readonly task: string;
	readonly requiredStatus?: ParticipantStatus;
	readonly config: ConveneCouncilConfig;
	readonly completeSimple: NonNullable<
		ConveneCouncilDependencies["completeSimple"]
	>;
	readonly signal: AbortSignal | undefined;
}

export interface FinalAnswerRequestOptions {
	readonly participant: ParticipantState;
	readonly task: string;
	readonly config: ConveneCouncilConfig;
	readonly completeSimple: NonNullable<
		ConveneCouncilDependencies["completeSimple"]
	>;
	readonly signal: AbortSignal | undefined;
}
