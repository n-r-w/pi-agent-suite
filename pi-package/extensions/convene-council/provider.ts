import type { AssistantMessage } from "@mariozechner/pi-ai";
import { COUNCIL_CONTEXT_TOO_LARGE_ERROR } from "./constants";
import {
	getAssistantText,
	isValidFinalAnswer,
	parseParticipantResponse,
} from "./parser";
import {
	buildParticipantRepairInstruction,
	createTaskMessage,
} from "./prompts";
import type {
	AcceptedParticipantResponse,
	CouncilIssue,
	FinalAnswerRequestOptions,
	InitialOpinionRequestOptions,
	MissingInformationResponseRequestOptions,
	ParticipantRequestOptions,
	PlainParticipantRequestOptions,
} from "./types";

/** Requests one first-turn free-form participant opinion with response-defect retries. */
export function requestInitialOpinion(
	options: InitialOpinionRequestOptions,
): Promise<AcceptedParticipantResponse | CouncilIssue> {
	return requestPlainParticipantResponse(
		options,
		0,
		`${options.participant.id} returned an unusable initial opinion.`,
	);
}

/** Requests one free-form missing-information clarification with response-defect retries. */
export function requestMissingInformationResponse(
	options: MissingInformationResponseRequestOptions,
): Promise<AcceptedParticipantResponse | CouncilIssue> {
	return requestPlainParticipantResponse(
		options,
		0,
		`${options.participant.id} returned an unusable clarification.`,
	);
}

/** Executes one free-form participant attempt and recurses only when repair is allowed. */
async function requestPlainParticipantResponse(
	options: PlainParticipantRequestOptions,
	attempt: number,
	failureMessage: string,
): Promise<AcceptedParticipantResponse | CouncilIssue> {
	const { participant, task, config, signal, progress } = options;
	if (attempt > config.responseDefectRetries) {
		return logicalIssue(failureMessage);
	}

	const taskMessage = createTaskMessage(task);
	const runnerResult = await callParticipantRunner(
		participant.runner,
		task,
		signal,
	);
	if ("kind" in runnerResult) {
		return runnerResult;
	}

	const opinion = getAssistantText(runnerResult.message);
	if (opinion.length > 0) {
		return {
			response: { opinion },
			assistantMessage: runnerResult.message,
			taskMessage,
		};
	}

	if (attempt < config.responseDefectRetries) {
		progress?.recordResponseDefectRetry(
			participant.id,
			attempt + 1,
			config.responseDefectRetries,
		);
	}
	return requestPlainParticipantResponse(options, attempt + 1, failureMessage);
}

/** Requests one structured participant discussion response with response-defect repair retries. */
export function requestParticipantDiscussion(
	options: ParticipantRequestOptions,
): Promise<AcceptedParticipantResponse | CouncilIssue> {
	return requestParticipantDiscussionAttempt(options, 0);
}

/** Executes one participant response-defect attempt and recurses only when repair is allowed. */
async function requestParticipantDiscussionAttempt(
	options: ParticipantRequestOptions,
	attempt: number,
): Promise<AcceptedParticipantResponse | CouncilIssue> {
	const { participant, task, config, signal, progress } = options;
	if (attempt > config.responseDefectRetries) {
		return logicalIssue(
			`${participant.id} returned unusable participant output.`,
		);
	}

	const prompt =
		attempt === 0 ? task : `${task}\n\n${buildParticipantRepairInstruction()}`;
	const taskMessage = createTaskMessage(prompt);
	const runnerResult = await callParticipantRunner(
		participant.runner,
		prompt,
		signal,
	);
	if ("kind" in runnerResult) {
		return runnerResult;
	}

	const parsed = parseParticipantResponse(runnerResult.message);
	if (
		"response" in parsed &&
		(options.requiredStatus === undefined ||
			parsed.response.status === options.requiredStatus)
	) {
		return {
			response: parsed.response,
			assistantMessage: runnerResult.message,
			taskMessage,
		};
	}

	if (attempt < config.responseDefectRetries) {
		progress?.recordResponseDefectRetry(
			participant.id,
			attempt + 1,
			config.responseDefectRetries,
		);
	}
	return requestParticipantDiscussionAttempt(options, attempt + 1);
}

/** Requests one final answer and rejects empty or tagged final output. */
export function requestFinalAnswer(
	options: FinalAnswerRequestOptions,
): Promise<{ readonly answer: string } | CouncilIssue> {
	return requestFinalAnswerAttempt(options, 0);
}

/** Executes one final-answer defect attempt and recurses only when repair is allowed. */
async function requestFinalAnswerAttempt(
	options: FinalAnswerRequestOptions,
	attempt: number,
): Promise<{ readonly answer: string } | CouncilIssue> {
	const { participant, task, config, signal, progress } = options;
	if (attempt > config.responseDefectRetries) {
		return logicalIssue("Council returned an unusable final answer.");
	}

	const runnerResult = await callParticipantRunner(
		participant.runner,
		task,
		signal,
	);
	if ("kind" in runnerResult) {
		return runnerResult;
	}

	const answer = getAssistantText(runnerResult.message);
	if (isValidFinalAnswer(answer)) {
		return { answer };
	}

	if (attempt < config.responseDefectRetries) {
		progress?.recordResponseDefectRetry(
			participant.id,
			attempt + 1,
			config.responseDefectRetries,
		);
	}
	return requestFinalAnswerAttempt(options, attempt + 1);
}

/** Sends one prompt to the participant runner and normalizes transport errors. */
async function callParticipantRunner(
	runner: {
		prompt(
			task: string,
			signal: AbortSignal | undefined,
		): Promise<AssistantMessage>;
	},
	task: string,
	signal: AbortSignal | undefined,
): Promise<{ readonly message: AssistantMessage } | CouncilIssue> {
	if (signal?.aborted === true) {
		return toolErrorIssue("participant request aborted", "aborted");
	}
	try {
		return { message: await runner.prompt(task, signal) };
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === COUNCIL_CONTEXT_TOO_LARGE_ERROR
		) {
			return toolErrorIssue(COUNCIL_CONTEXT_TOO_LARGE_ERROR);
		}
		return toolErrorIssue(
			error instanceof Error
				? `participant request failed: ${error.message}`
				: "participant request failed",
			isAbortSignalSet(signal) ? "aborted" : "failed",
		);
	}
}

/** Reads abort state through a helper because the signal may change during await. */
function isAbortSignalSet(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

/** Builds one logical issue that should be returned as a normal text result. */
function logicalIssue(message: string): CouncilIssue {
	return { kind: "logical", message };
}

/** Builds one infrastructure issue that should be surfaced as a Pi tool error. */
function toolErrorIssue(
	message: string,
	status: "failed" | "aborted" = "failed",
): CouncilIssue {
	return { kind: "tool-error", message, status };
}
