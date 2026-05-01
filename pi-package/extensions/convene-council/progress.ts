import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type {
	CouncilRuntime,
	ParticipantId,
	ParticipantRuntime,
	ParticipantStatus,
} from "./types";

/** Identifies serialized details that belong to live convene_council TUI progress. */
export const COUNCIL_PROGRESS_DETAILS_TYPE = "convene_council_progress";

/** Keeps recent council events while bounding partial-result history growth. */
export const MAX_COUNCIL_PROGRESS_EVENTS = 40;

/** Keeps each stored event preview bounded before terminal-width rendering. */
const MAX_COUNCIL_PROGRESS_TEXT_LENGTH = 240;

/** Converts milliseconds to seconds in compact TUI labels. */
const SECOND_MS = 1000;

/** Keeps elapsed seconds readable without claiming false precision. */
const ELAPSED_SECONDS_FRACTION_DIGITS = 1;

/** Maps internal participant IDs to stable TUI labels. */
const PARTICIPANT_LABELS: Record<ParticipantId, CouncilParticipantLabel> = {
	llm1: "A",
	llm2: "B",
};

/** Defines participant labels shown in compact TUI rows. */
export type CouncilParticipantLabel = "A" | "B";

/** Defines lifecycle states for one council tool run. */
export type CouncilRunStatus = "running" | "succeeded" | "failed" | "aborted";

/** Defines semantic event kinds shown in compact and expanded council progress. */
export type CouncilProgressEventKind =
	| "request"
	| "response"
	| "retry"
	| "success"
	| "info"
	| "error";

/** Stores one participant runtime row for the tool-call header and expanded details. */
export interface CouncilParticipantDetails {
	readonly label: CouncilParticipantLabel;
	readonly participantId: ParticipantId;
	readonly modelId: string;
	readonly thinking: string;
	readonly display: string;
}

/** Stores one visible council event without raw participant opinions. */
export interface CouncilProgressEvent {
	readonly kind: CouncilProgressEventKind;
	readonly title: string;
	readonly text: string | undefined;
	readonly timestampMs: number;
}

/** Stores mutable progress for the active council run. */
interface CouncilProgressState {
	readonly runId: string;
	readonly question: string;
	readonly participants: readonly CouncilParticipantDetails[];
	readonly iterationLimit: number;
	readonly startedAtMs: number;
	iteration: number;
	phase: string;
	readonly events: CouncilProgressEvent[];
	omittedEventCount: number;
}

/** Stores serializable progress details used only by live TUI rendering. */
export interface CouncilRunDetails {
	readonly type: typeof COUNCIL_PROGRESS_DETAILS_TYPE;
	readonly runId: string;
	readonly question: string;
	readonly status: CouncilRunStatus;
	readonly phase: string;
	readonly elapsedMs: number;
	readonly iteration: number;
	readonly iterationLimit: number;
	readonly participants: readonly CouncilParticipantDetails[];
	readonly events: readonly CouncilProgressEvent[];
	readonly omittedEventCount: number;
}

/** Receives council milestones from loop and provider code. */
export interface CouncilProgressReporter {
	setPhase(phase: string, iteration?: number): void;
	recordRequest(
		participantId: ParticipantId,
		title: string,
		phase?: string,
	): void;
	recordOpinion(participantId: ParticipantId, opinion: string): void;
	recordResponse(
		participantId: ParticipantId,
		status: ParticipantStatus,
		opinion?: string,
	): void;
	recordClarification(
		participantId: ParticipantId,
		clarification: string,
	): void;
	recordProviderRetry(
		participantId: ParticipantId,
		attempt: number,
		maxAttempts: number,
	): void;
	recordResponseDefectRetry(
		participantId: ParticipantId,
		attempt: number,
		maxAttempts: number,
	): void;
	recordInfo(title: string, phase?: string): void;
	recordSuccess(title: string, phase?: string): void;
	recordError(title: string, phase?: string): void;
	finish(status: CouncilRunStatus, phase: string): CouncilRunDetails;
}

/** Creates a reporter that emits partial AgentToolResult updates for live TUI rendering. */
export function createCouncilProgressReporter({
	runId,
	question,
	runtime,
	iterationLimit,
	onUpdate,
}: {
	readonly runId: string;
	readonly question: string;
	readonly runtime: CouncilRuntime;
	readonly iterationLimit: number;
	readonly onUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined;
}): CouncilProgressReporter {
	const state: CouncilProgressState = {
		runId,
		question,
		participants: [
			createParticipantDetails("llm1", runtime.llm1),
			createParticipantDetails("llm2", runtime.llm2),
		],
		iterationLimit,
		startedAtMs: Date.now(),
		iteration: 0,
		phase: "preparing context",
		events: [],
		omittedEventCount: 0,
	};

	return createCouncilProgressReporterApi(state, onUpdate);
}

/** Builds the reporter API around one mutable progress state. */
function createCouncilProgressReporterApi(
	state: CouncilProgressState,
	onUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined,
): CouncilProgressReporter {
	const emit = (status: CouncilRunStatus): CouncilRunDetails =>
		emitCouncilProgress(state, status, onUpdate);
	const append = createProgressAppender(state, emit);
	return {
		setPhase: (phase, iteration) => recordPhase(state, emit, phase, iteration),
		recordRequest: (participantId, title, phase) =>
			recordParticipantRequest(state, append, {
				participantId,
				title,
				...(phase !== undefined ? { phase } : {}),
			}),
		recordOpinion: (participantId, opinion) =>
			recordParticipantOpinion(append, participantId, opinion),
		recordResponse: (participantId, status, opinion) =>
			recordParticipantResponse(append, participantId, status, opinion),
		recordClarification: (participantId, clarification) =>
			recordParticipantClarification(append, participantId, clarification),
		recordProviderRetry: (participantId, attempt, maxAttempts) =>
			recordParticipantRetry(append, {
				participantId,
				retryKind: "provider",
				attempt,
				maxAttempts,
			}),
		recordResponseDefectRetry: (participantId, attempt, maxAttempts) =>
			recordParticipantRetry(append, {
				participantId,
				retryKind: "response",
				attempt,
				maxAttempts,
			}),
		recordInfo: (title, phase) =>
			recordEvent(state, append, {
				kind: "info",
				title,
				...(phase !== undefined ? { phase } : {}),
			}),
		recordSuccess: (title, phase) =>
			recordEvent(state, append, {
				kind: "success",
				title,
				...(phase !== undefined ? { phase } : {}),
			}),
		recordError: (title, phase) =>
			recordEvent(state, append, {
				kind: "error",
				title,
				...(phase !== undefined ? { phase } : {}),
			}),
		finish: (status, phase) =>
			finishCouncilProgress(state, emit, status, phase),
	};
}

type ProgressAppender = (
	kind: CouncilProgressEventKind,
	title: string,
	text?: string,
) => void;

type ProgressEmitter = (status: CouncilRunStatus) => CouncilRunDetails;

/** Creates a helper that appends one event and emits a running partial update. */
function createProgressAppender(
	state: CouncilProgressState,
	emit: ProgressEmitter,
): ProgressAppender {
	return (kind, title, text) => {
		appendCouncilProgressEvent(state, {
			kind,
			title,
			text: normalizeProgressText(text),
			timestampMs: Date.now(),
		});
		emit("running");
	};
}

/** Records a phase transition and emits the updated header state. */
function recordPhase(
	state: CouncilProgressState,
	emit: ProgressEmitter,
	phase: string,
	iteration?: number,
): void {
	state.phase = phase;
	if (iteration !== undefined) {
		state.iteration = Math.max(0, Math.floor(iteration));
	}
	emit("running");
}

/** Records a participant request event and updates the active phase when provided. */
function recordParticipantRequest(
	state: CouncilProgressState,
	append: ProgressAppender,
	options: {
		readonly participantId: ParticipantId;
		readonly title: string;
		readonly phase?: string;
	},
): void {
	if (options.phase !== undefined) {
		state.phase = options.phase;
	}
	append(
		"request",
		`${formatParticipantLabel(options.participantId)} ${options.title}`,
	);
}

/** Records a free-form first-turn participant opinion preview. */
function recordParticipantOpinion(
	append: ProgressAppender,
	participantId: ParticipantId,
	opinion: string,
): void {
	append(
		"response",
		`${formatParticipantLabel(participantId)} opinion`,
		opinion,
	);
}

/** Records a structured participant response with its status and bounded opinion preview. */
function recordParticipantResponse(
	append: ProgressAppender,
	participantId: ParticipantId,
	status: ParticipantStatus,
	opinion?: string,
): void {
	append(
		"response",
		`${formatParticipantLabel(participantId)} ${status}`,
		opinion,
	);
}

/** Records a free-form missing-information clarification preview. */
function recordParticipantClarification(
	append: ProgressAppender,
	participantId: ParticipantId,
	clarification: string,
): void {
	append(
		"response",
		`${formatParticipantLabel(participantId)} clarification`,
		clarification,
	);
}

/** Records a bounded retry event for one participant. */
function recordParticipantRetry(
	append: ProgressAppender,
	options: {
		readonly participantId: ParticipantId;
		readonly retryKind: "provider" | "response";
		readonly attempt: number;
		readonly maxAttempts: number;
	},
): void {
	append(
		"retry",
		`${formatParticipantLabel(options.participantId)} ${options.retryKind} retry ${options.attempt}/${options.maxAttempts}`,
	);
}

/** Records one non-participant event and updates phase when provided. */
function recordEvent(
	state: CouncilProgressState,
	append: ProgressAppender,
	options: {
		readonly kind: CouncilProgressEventKind;
		readonly title: string;
		readonly phase?: string;
	},
): void {
	if (options.phase !== undefined) {
		state.phase = options.phase;
	}
	append(options.kind, options.title);
}

/** Emits a final progress state for the live TUI renderer. */
function finishCouncilProgress(
	state: CouncilProgressState,
	emit: ProgressEmitter,
	status: CouncilRunStatus,
	phase: string,
): CouncilRunDetails {
	state.phase = phase;
	return emit(status);
}

/** Emits one partial progress update and returns the serialized details. */
function emitCouncilProgress(
	state: CouncilProgressState,
	status: CouncilRunStatus,
	onUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined,
): CouncilRunDetails {
	const details = toCouncilRunDetails(state, status, Date.now());
	onUpdate?.({
		content: [{ type: "text", text: formatCouncilProgressContent(details) }],
		details,
	});
	return details;
}

/** Formats the participant label used by compact progress rows. */
export function formatParticipantLabel(
	participantId: ParticipantId,
): CouncilParticipantLabel {
	return PARTICIPANT_LABELS[participantId];
}

/** Formats elapsed milliseconds into a short duration string. */
export function formatCouncilElapsedMs(elapsedMs: number): string {
	if (elapsedMs < SECOND_MS) {
		return `${elapsedMs}ms`;
	}
	return `${(elapsedMs / SECOND_MS).toFixed(ELAPSED_SECONDS_FRACTION_DIGITS)}s`;
}

/** Validates details before custom rendering uses the council progress shape. */
export function isCouncilRunDetails(
	value: unknown,
): value is CouncilRunDetails {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const details = value as Partial<CouncilRunDetails>;
	return (
		details.type === COUNCIL_PROGRESS_DETAILS_TYPE &&
		typeof details.runId === "string" &&
		typeof details.question === "string" &&
		typeof details.status === "string" &&
		typeof details.phase === "string" &&
		typeof details.elapsedMs === "number" &&
		typeof details.iteration === "number" &&
		typeof details.iterationLimit === "number" &&
		Array.isArray(details.participants) &&
		Array.isArray(details.events) &&
		typeof details.omittedEventCount === "number"
	);
}

/** Converts mutable progress into the stable details shape used by TUI rendering. */
function toCouncilRunDetails(
	state: CouncilProgressState,
	status: CouncilRunStatus,
	nowMs: number,
): CouncilRunDetails {
	return {
		type: COUNCIL_PROGRESS_DETAILS_TYPE,
		runId: state.runId,
		question: state.question,
		status,
		phase: state.phase,
		elapsedMs: Math.max(0, nowMs - state.startedAtMs),
		iteration: state.iteration,
		iterationLimit: state.iterationLimit,
		participants: state.participants.map((participant) => ({ ...participant })),
		events: state.events.map((event) => ({ ...event })),
		omittedEventCount: state.omittedEventCount,
	};
}

/** Builds one participant runtime row without exposing credentials or headers. */
function createParticipantDetails(
	participantId: ParticipantId,
	runtime: ParticipantRuntime,
): CouncilParticipantDetails {
	const modelId = `${runtime.model.provider}/${runtime.model.id}`;
	const thinking = runtime.thinking ?? "off";
	return {
		label: formatParticipantLabel(participantId),
		participantId,
		modelId,
		thinking,
		display: `${modelId}/${thinking}`,
	};
}

/** Appends one progress event and trims older events after the configured limit. */
function appendCouncilProgressEvent(
	state: CouncilProgressState,
	event: CouncilProgressEvent,
): void {
	state.events.push(event);
	while (state.events.length > MAX_COUNCIL_PROGRESS_EVENTS) {
		state.events.shift();
		state.omittedEventCount += 1;
	}
}

/** Normalizes progress text to a compact single-line preview. */
function normalizeProgressText(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length === 0) {
		return undefined;
	}
	return normalized.length > MAX_COUNCIL_PROGRESS_TEXT_LENGTH
		? `${normalized.slice(0, MAX_COUNCIL_PROGRESS_TEXT_LENGTH)}…`
		: normalized;
}

/** Formats compact model-facing partial progress text. */
function formatCouncilProgressContent(details: CouncilRunDetails): string {
	const iteration =
		details.iteration > 0
			? `iter ${details.iteration}/${details.iterationLimit}`
			: `iter 0/${details.iterationLimit}`;
	return `convene_council ${details.status}: ${details.phase} (${iteration}, ${formatCouncilElapsedMs(details.elapsedMs)})`;
}
