import type { AgentToolResult } from "@earendil-works/pi-agent-core";
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

/** Converts ratios into percentages for context-window pressure. */
const FULL_PERCENT = 100;

/** Bounds deterministic display-name hashing without bitwise operators. */
const DISPLAY_NAME_HASH_MODULUS = 1_000_000_007;

/** Maps internal participant IDs to stable legacy labels used in event history. */
const PARTICIPANT_LABELS: Record<ParticipantId, CouncilParticipantLabel> = {
	llm1: "A",
	llm2: "B",
};

/** Provides deterministic display names for participant rows. */
const COUNCIL_DISPLAY_NAMES = [
	"Socrates",
	"Plato",
	"Aristotle",
	"Confucius",
	"Pifagoras",
	"Descartes",
] as const;

/** Defines participant labels retained for compact event-history rows. */
export type CouncilParticipantLabel = "A" | "B";

/** Defines lifecycle states for one council tool run or participant row. */
export type CouncilRunStatus = "running" | "succeeded" | "failed" | "aborted";

/** Defines semantic event kinds shown in compact and expanded council progress. */
export type CouncilProgressEventKind =
	| "request"
	| "response"
	| "retry"
	| "success"
	| "info"
	| "tool_call"
	| "tool_result"
	| "error";

/** Stores participant context-window usage reported by a child assistant message. */
export interface CouncilContextUsage {
	readonly tokens: number | null;
	readonly contextWindow: number;
	readonly percent: number | null;
}

/** Stores one participant runtime row for the tool-call header and expanded details. */
export interface CouncilParticipantDetails {
	readonly label: CouncilParticipantLabel;
	readonly displayName: string;
	readonly participantId: ParticipantId;
	readonly modelId: string;
	readonly thinking: string;
	readonly display: string;
	readonly contextWindow: number;
	readonly status: CouncilRunStatus;
	readonly elapsedMs: number;
	readonly activity?: string;
	readonly contextUsage?: CouncilContextUsage;
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
	participants: CouncilParticipantDetails[];
	readonly participantTurnTimers: CouncilParticipantTurnTimer[];
	readonly iterationLimit: number;
	readonly startedAtMs: number;
	iteration: number;
	phase: string;
	readonly events: CouncilProgressEvent[];
	omittedEventCount: number;
}

/** Tracks the active or last completed turn duration for one participant row. */
interface CouncilParticipantTurnTimer {
	readonly participantId: ParticipantId;
	startedAtMs: number | undefined;
	elapsedMs: number;
	active: boolean;
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
	recordResponseDefectRetry(
		participantId: ParticipantId,
		attempt: number,
		maxAttempts: number,
	): void;
	recordSessionEvent(participantId: ParticipantId, event: unknown): void;
	recordInfo(title: string, phase?: string): void;
	recordSuccess(title: string, phase?: string): void;
	recordParticipantSuccess(
		participantId: ParticipantId,
		title: string,
		phase?: string,
	): void;
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
	const participants = createInitialParticipantDetails(runId, runtime);
	const state: CouncilProgressState = {
		runId,
		question,
		participants,
		participantTurnTimers: createInitialParticipantTurnTimers(participants),
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
			recordParticipantOpinion(state, append, participantId, opinion),
		recordResponse: (participantId, status, opinion) =>
			recordParticipantResponse(state, append, {
				participantId,
				status,
				...(opinion === undefined ? {} : { opinion }),
			}),
		recordClarification: (participantId, clarification) =>
			recordParticipantClarification(
				state,
				append,
				participantId,
				clarification,
			),
		recordResponseDefectRetry: (participantId, attempt, maxAttempts) =>
			recordParticipantRetry(state, append, {
				participantId,
				retryKind: "response",
				attempt,
				maxAttempts,
			}),
		recordSessionEvent: (participantId, event) =>
			recordParticipantSessionEvent(state, append, participantId, event),
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
		recordParticipantSuccess: (participantId, title, phase) =>
			recordParticipantSuccess(state, append, {
				participantId,
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

interface ParticipantPatch {
	readonly status?: CouncilRunStatus;
	readonly activity?: string;
	readonly contextUsage?: CouncilContextUsage;
}

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
	state.phase = formatDisplayText(state, phase);
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
		state.phase = formatDisplayText(state, options.phase);
	}
	startParticipantTurn(state, options.participantId, Date.now());
	updateParticipantProgress(state, options.participantId, {
		status: "running",
		activity: formatDisplayText(state, options.title),
	});
	append(
		"request",
		`${formatParticipantLabel(options.participantId)} ${options.title}`,
	);
}

/** Records a free-form first-turn participant opinion preview. */
function recordParticipantOpinion(
	state: CouncilProgressState,
	append: ProgressAppender,
	participantId: ParticipantId,
	opinion: string,
): void {
	const preview = normalizeProgressText(opinion);
	finishParticipantTurn(state, participantId, Date.now());
	updateParticipantProgress(state, participantId, {
		activity: preview === undefined ? "opinion" : `opinion ${preview}`,
	});
	append(
		"response",
		`${formatParticipantLabel(participantId)} opinion`,
		opinion,
	);
}

/** Records a structured participant response with its status and bounded opinion preview. */
function recordParticipantResponse(
	state: CouncilProgressState,
	append: ProgressAppender,
	options: {
		readonly participantId: ParticipantId;
		readonly status: ParticipantStatus;
		readonly opinion?: string;
	},
): void {
	const preview = normalizeProgressText(options.opinion);
	finishParticipantTurn(state, options.participantId, Date.now());
	updateParticipantProgress(state, options.participantId, {
		activity:
			preview === undefined ? options.status : `${options.status} ${preview}`,
	});
	append(
		"response",
		`${formatParticipantLabel(options.participantId)} ${options.status}`,
		options.opinion,
	);
}

/** Records a free-form missing-information clarification preview. */
function recordParticipantClarification(
	state: CouncilProgressState,
	append: ProgressAppender,
	participantId: ParticipantId,
	clarification: string,
): void {
	const preview = normalizeProgressText(clarification);
	finishParticipantTurn(state, participantId, Date.now());
	updateParticipantProgress(state, participantId, {
		activity:
			preview === undefined ? "clarification" : `clarification ${preview}`,
	});
	append(
		"response",
		`${formatParticipantLabel(participantId)} clarification`,
		clarification,
	);
}

/** Records a bounded retry event for one participant. */
function recordParticipantRetry(
	state: CouncilProgressState,
	append: ProgressAppender,
	options: {
		readonly participantId: ParticipantId;
		readonly retryKind: "response";
		readonly attempt: number;
		readonly maxAttempts: number;
	},
): void {
	const activity = `${options.retryKind} retry ${options.attempt}/${options.maxAttempts}`;
	updateParticipantProgress(state, options.participantId, {
		status: "running",
		activity,
	});
	append(
		"retry",
		`${formatParticipantLabel(options.participantId)} ${activity}`,
	);
}

/** Records one child session event as participant-labeled live progress. */
function recordParticipantSessionEvent(
	state: CouncilProgressState,
	append: ProgressAppender,
	participantId: ParticipantId,
	event: unknown,
): void {
	const participantUpdate = toParticipantProgressUpdate(
		state,
		participantId,
		event,
	);
	if (participantUpdate !== undefined) {
		const eventType = isPlainRecord(event)
			? getStringField(event, "type")
			: undefined;
		if (eventType === "agent_end") {
			finishParticipantTurn(state, participantId, Date.now());
		}
		updateParticipantProgress(state, participantId, participantUpdate);
	}
	const progressEvent = toParticipantSessionProgressEvent(participantId, event);
	if (progressEvent === undefined) {
		return;
	}
	append(progressEvent.kind, progressEvent.title, progressEvent.text);
}

/** Converts model-visible child RPC events into compact TUI progress rows. */
function toParticipantSessionProgressEvent(
	participantId: ParticipantId,
	event: unknown,
):
	| {
			readonly kind: CouncilProgressEventKind;
			readonly title: string;
			readonly text?: string;
	  }
	| undefined {
	if (!isPlainRecord(event)) {
		return undefined;
	}
	const eventType = getStringField(event, "type");
	const label = formatParticipantLabel(participantId);
	if (eventType === "agent_start") {
		return { kind: "info", title: `${label} started` };
	}
	if (eventType === "agent_end") {
		return { kind: "success", title: `${label} finished` };
	}
	if (eventType === "tool_execution_start") {
		const toolName = getStringField(event, "toolName") ?? "tool";
		const text = formatEventPayload(event["args"] ?? event["input"]);
		return {
			kind: "tool_call",
			title: `${label} ${toolName}`,
			...(text === undefined ? {} : { text }),
		};
	}
	if (eventType === "tool_execution_end") {
		const toolName = getStringField(event, "toolName") ?? "tool";
		const isError = event["isError"] === true;
		const text = getToolExecutionResultText(event);
		return {
			kind: isError ? "error" : "tool_result",
			title: `${label} ${toolName} result`,
			...(text === undefined ? {} : { text }),
		};
	}
	return undefined;
}

/** Converts child RPC events into structured participant row state. */
function toParticipantProgressUpdate(
	state: CouncilProgressState,
	participantId: ParticipantId,
	event: unknown,
): ParticipantPatch | undefined {
	if (!isPlainRecord(event)) {
		return undefined;
	}
	const eventType = getStringField(event, "type");
	if (eventType === "agent_start") {
		return { status: "running", activity: "started" };
	}
	if (eventType === "agent_end") {
		return { status: "succeeded" };
	}
	if (eventType === "tool_execution_start") {
		return toParticipantToolStartProgressUpdate(event);
	}
	if (eventType === "tool_execution_end") {
		return toParticipantToolEndProgressUpdate(event);
	}
	if (eventType === "message_end") {
		return toParticipantMessageEndProgressUpdate(state, participantId, event);
	}
	return undefined;
}

/** Converts a child tool-start event into participant row state. */
function toParticipantToolStartProgressUpdate(
	event: Record<string, unknown>,
): ParticipantPatch {
	const toolName = getStringField(event, "toolName") ?? "tool";
	const text = formatEventPayload(event["args"] ?? event["input"]);
	return {
		status: "running",
		activity: text === undefined ? toolName : `${toolName} ${text}`,
	};
}

/** Converts a child tool-end event into participant row state. */
function toParticipantToolEndProgressUpdate(
	event: Record<string, unknown>,
): ParticipantPatch {
	const toolName = getStringField(event, "toolName") ?? "tool";
	const text = getToolExecutionResultText(event);
	return {
		activity:
			text === undefined ? `${toolName} result` : `${toolName} result ${text}`,
	};
}

/** Converts a child assistant message event into participant row state. */
function toParticipantMessageEndProgressUpdate(
	state: CouncilProgressState,
	participantId: ParticipantId,
	event: Record<string, unknown>,
): ParticipantPatch | undefined {
	const message = getRecordField(event, "message");
	if (
		message === undefined ||
		getStringField(message, "role") !== "assistant"
	) {
		return undefined;
	}
	const contextUsage = getMessageContextUsage(
		message,
		getParticipantContextWindow(state, participantId),
	);
	const assistantText = getMessageText(message);
	const errorMessage = getStringField(message, "errorMessage");
	const activity = errorMessage ?? assistantText;
	return {
		...(activity === undefined ? {} : { activity: `assistant ${activity}` }),
		...(contextUsage === undefined ? {} : { contextUsage }),
	};
}

/** Records a participant-owned success event and updates the stable row activity. */
function recordParticipantSuccess(
	state: CouncilProgressState,
	append: ProgressAppender,
	options: {
		readonly participantId: ParticipantId;
		readonly title: string;
		readonly phase?: string;
	},
): void {
	if (options.phase !== undefined) {
		state.phase = formatDisplayText(state, options.phase);
	}
	finishParticipantTurn(state, options.participantId, Date.now());
	updateParticipantProgress(state, options.participantId, {
		activity: formatDisplayText(state, options.title),
	});
	append(
		"success",
		`${formatParticipantLabel(options.participantId)} ${options.title}`,
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
		state.phase = formatDisplayText(state, options.phase);
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
	state.phase = formatDisplayText(state, phase);
	finishActiveParticipantTurns(state, Date.now());
	for (const participant of state.participants) {
		updateParticipantProgress(state, participant.participantId, { status });
	}
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
		isCouncilRunStatus(details.status) &&
		typeof details.phase === "string" &&
		typeof details.elapsedMs === "number" &&
		typeof details.iteration === "number" &&
		typeof details.iterationLimit === "number" &&
		Array.isArray(details.participants) &&
		details.participants.every(isCouncilParticipantDetails) &&
		Array.isArray(details.events) &&
		typeof details.omittedEventCount === "number"
	);
}

/** Validates one participant row before renderer access. */
function isCouncilParticipantDetails(
	value: unknown,
): value is CouncilParticipantDetails {
	if (!isPlainRecord(value)) {
		return false;
	}
	return (
		(value["label"] === "A" || value["label"] === "B") &&
		typeof value["displayName"] === "string" &&
		(value["participantId"] === "llm1" || value["participantId"] === "llm2") &&
		typeof value["modelId"] === "string" &&
		typeof value["thinking"] === "string" &&
		typeof value["display"] === "string" &&
		typeof value["contextWindow"] === "number" &&
		isCouncilRunStatus(value["status"]) &&
		typeof value["elapsedMs"] === "number" &&
		(value["activity"] === undefined ||
			typeof value["activity"] === "string") &&
		(value["contextUsage"] === undefined ||
			isCouncilContextUsage(value["contextUsage"]))
	);
}

/** Validates one participant context usage object before renderer access. */
function isCouncilContextUsage(value: unknown): value is CouncilContextUsage {
	if (!isPlainRecord(value)) {
		return false;
	}
	return (
		(typeof value["tokens"] === "number" || value["tokens"] === null) &&
		typeof value["contextWindow"] === "number" &&
		(typeof value["percent"] === "number" || value["percent"] === null)
	);
}

/** Validates the finite status set shared by council runs and participant rows. */
function isCouncilRunStatus(value: unknown): value is CouncilRunStatus {
	return (
		value === "running" ||
		value === "succeeded" ||
		value === "failed" ||
		value === "aborted"
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
		participants: state.participants.map((participant) => ({
			...participant,
			elapsedMs: getParticipantTurnElapsedMs(
				state,
				participant.participantId,
				nowMs,
			),
		})),
		events: state.events.map((event) => ({ ...event })),
		omittedEventCount: state.omittedEventCount,
	};
}

/** Builds initial participant rows with deterministic display names. */
function createInitialParticipantDetails(
	runId: string,
	runtime: CouncilRuntime,
): CouncilParticipantDetails[] {
	const [firstName, secondName] = selectParticipantDisplayNames(runId);
	return [
		createParticipantDetails("llm1", runtime.llm1, firstName),
		createParticipantDetails("llm2", runtime.llm2, secondName),
	];
}

/** Builds one participant runtime row without exposing credentials or headers. */
function createParticipantDetails(
	participantId: ParticipantId,
	runtime: ParticipantRuntime,
	displayName: string,
): CouncilParticipantDetails {
	const modelId = `${runtime.model.provider}/${runtime.model.id}`;
	const thinking = runtime.thinking ?? "off";
	return {
		label: formatParticipantLabel(participantId),
		displayName,
		participantId,
		modelId,
		thinking,
		display: `${modelId}/${thinking}`,
		contextWindow: runtime.model.contextWindow,
		status: "running",
		elapsedMs: 0,
		activity: "starting",
	};
}

/** Selects a stable pseudo-random pair for one council run. */
function selectParticipantDisplayNames(
	runId: string,
): readonly [string, string] {
	const firstIndex = hashText(runId) % COUNCIL_DISPLAY_NAMES.length;
	const secondBase =
		Math.floor(hashText(`${runId}:second`) / COUNCIL_DISPLAY_NAMES.length) %
		(COUNCIL_DISPLAY_NAMES.length - 1);
	const secondIndex = secondBase >= firstIndex ? secondBase + 1 : secondBase;
	return [
		COUNCIL_DISPLAY_NAMES[firstIndex] ?? "Socrates",
		COUNCIL_DISPLAY_NAMES[secondIndex] ?? "Confucius",
	];
}

/** Hashes run identity into a deterministic unsigned integer for display selection. */
function hashText(value: string): number {
	let hash = 0;
	for (const [index, char] of [...value].entries()) {
		hash =
			(hash + (char.codePointAt(0) ?? 0) * (index + 1)) %
			DISPLAY_NAME_HASH_MODULUS;
	}
	return hash;
}

/** Replaces legacy A/B row references with the persisted participant display names. */
function formatDisplayText(state: CouncilProgressState, text: string): string {
	return state.participants.reduce(
		(current, participant) =>
			current.replace(
				new RegExp(`\\b${participant.label}\\b`, "g"),
				participant.displayName,
			),
		text,
	);
}

/** Builds timers that keep participant row durations scoped to their latest council turn. */
function createInitialParticipantTurnTimers(
	participants: readonly CouncilParticipantDetails[],
): CouncilParticipantTurnTimer[] {
	return participants.map((participant) => ({
		participantId: participant.participantId,
		startedAtMs: undefined,
		elapsedMs: 0,
		active: false,
	}));
}

/** Starts a fresh visible work timer for one participant turn. */
function startParticipantTurn(
	state: CouncilProgressState,
	participantId: ParticipantId,
	nowMs: number,
): void {
	const timer = getParticipantTurnTimer(state, participantId);
	if (timer === undefined) {
		return;
	}
	timer.startedAtMs = nowMs;
	timer.elapsedMs = 0;
	timer.active = true;
}

/** Freezes one participant turn timer when the child finishes its current prompt. */
function finishParticipantTurn(
	state: CouncilProgressState,
	participantId: ParticipantId,
	nowMs: number,
): void {
	const timer = getParticipantTurnTimer(state, participantId);
	if (timer === undefined || !timer.active || timer.startedAtMs === undefined) {
		return;
	}
	timer.elapsedMs = Math.max(0, nowMs - timer.startedAtMs);
	timer.active = false;
}

/** Freezes all active turn timers before a terminal council status is emitted. */
function finishActiveParticipantTurns(
	state: CouncilProgressState,
	nowMs: number,
): void {
	for (const timer of state.participantTurnTimers) {
		finishParticipantTurn(state, timer.participantId, nowMs);
	}
}

/** Returns the elapsed duration for the active or last completed participant turn. */
function getParticipantTurnElapsedMs(
	state: CouncilProgressState,
	participantId: ParticipantId,
	nowMs: number,
): number {
	const timer = getParticipantTurnTimer(state, participantId);
	if (timer === undefined) {
		return 0;
	}
	if (timer.active && timer.startedAtMs !== undefined) {
		return Math.max(0, nowMs - timer.startedAtMs);
	}
	return timer.elapsedMs;
}

/** Finds the mutable turn timer for one participant row. */
function getParticipantTurnTimer(
	state: CouncilProgressState,
	participantId: ParticipantId,
): CouncilParticipantTurnTimer | undefined {
	return state.participantTurnTimers.find(
		(timer) => timer.participantId === participantId,
	);
}

/** Updates the mutable participant row while preserving stable runtime fields. */
function updateParticipantProgress(
	state: CouncilProgressState,
	participantId: ParticipantId,
	patch: ParticipantPatch,
): void {
	const index = state.participants.findIndex(
		(participant) => participant.participantId === participantId,
	);
	const current = state.participants[index];
	if (current === undefined) {
		return;
	}
	state.participants[index] = {
		...current,
		...(patch.status === undefined ? {} : { status: patch.status }),
		...(patch.activity === undefined ? {} : { activity: patch.activity }),
		...(patch.contextUsage === undefined
			? {}
			: { contextUsage: patch.contextUsage }),
	};
}

/** Returns the configured context window for one participant. */
function getParticipantContextWindow(
	state: CouncilProgressState,
	participantId: ParticipantId,
): number | undefined {
	return state.participants.find(
		(participant) => participant.participantId === participantId,
	)?.contextWindow;
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

/** Converts structured tool arguments or inputs into bounded display text. */
function formatEventPayload(payload: unknown): string | undefined {
	if (payload === undefined) {
		return undefined;
	}
	if (typeof payload === "string") {
		return normalizeProgressText(payload);
	}
	try {
		return normalizeProgressText(JSON.stringify(payload));
	} catch {
		return normalizeProgressText(String(payload));
	}
}

/** Extracts visible text from a completed child tool execution event. */
function getToolExecutionResultText(
	event: Record<string, unknown>,
): string | undefined {
	const result = getRecordField(event, "result");
	return (
		getMessageText(result) ??
		getStringField(event, "error") ??
		getStringField(event, "errorMessage")
	);
}

/** Extracts context usage from assistant usage metadata emitted by a child session. */
function getMessageContextUsage(
	message: Record<string, unknown>,
	contextWindow: number | undefined,
): CouncilContextUsage | undefined {
	if (contextWindow === undefined) {
		return undefined;
	}
	const usage = getRecordField(message, "usage");
	const totalTokens = usage?.["totalTokens"];
	if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens)) {
		return undefined;
	}
	const tokens = Math.max(0, totalTokens);
	return {
		tokens,
		contextWindow,
		percent: contextWindow > 0 ? (tokens / contextWindow) * FULL_PERCENT : null,
	};
}

/** Extracts bounded text from a message-like value. */
function getMessageText(message: unknown): string | undefined {
	return normalizeProgressText(getFullMessageText(message));
}

/** Extracts text content from a message or content-part list. */
function getFullMessageText(message: unknown): string | undefined {
	if (!isPlainRecord(message)) {
		return undefined;
	}
	const { content } = message;
	if (typeof content === "string") {
		return normalizeProgressText(content);
	}
	if (!Array.isArray(content)) {
		return undefined;
	}
	const textParts = content.flatMap(extractContentPartText);
	return textParts.length > 0 ? textParts.join("\n") : undefined;
}

/** Extracts text from one message content part. */
function extractContentPartText(part: unknown): readonly string[] {
	if (typeof part === "string") {
		const text = normalizeProgressText(part);
		return text === undefined ? [] : [text];
	}
	if (!isPlainRecord(part)) {
		return [];
	}
	if (part["type"] !== "text" || typeof part["text"] !== "string") {
		return [];
	}
	const text = normalizeProgressText(part["text"]);
	return text === undefined ? [] : [text];
}

/** Returns true when an unknown value can be inspected as a plain object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Returns a string field from one parsed child RPC event. */
function getStringField(
	value: Record<string, unknown>,
	fieldName: string,
): string | undefined {
	const field = value[fieldName];
	return typeof field === "string" ? field : undefined;
}

/** Returns a record field from one parsed child RPC event. */
function getRecordField(
	value: Record<string, unknown>,
	fieldName: string,
): Record<string, unknown> | undefined {
	const field = value[fieldName];
	return isPlainRecord(field) ? field : undefined;
}

/** Formats compact model-facing partial progress text. */
function formatCouncilProgressContent(details: CouncilRunDetails): string {
	const iteration =
		details.iteration > 0
			? `iter ${details.iteration}/${details.iterationLimit}`
			: `iter 0/${details.iterationLimit}`;
	return `convene_council ${details.status}: ${details.phase} (${iteration}, ${formatCouncilElapsedMs(details.elapsedMs)})`;
}
