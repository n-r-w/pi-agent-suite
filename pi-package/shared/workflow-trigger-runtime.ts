/** Defines the neutral runner boundary shared by workflow and trigger-owning extensions. */
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Trigger types accepted by the workflow stage contract. */
export type WorkflowTriggerType =
	| "local_knowledge_accumulation"
	| "global_knowledge_accumulation";

/**
 * Runtime list of all workflow trigger types.
 * Mirrors the {@link WorkflowTriggerType} union so consumers can validate
 * trigger type strings without importing individual values.
 * Update this array when new trigger types are added to the union.
 */
export const WORKFLOW_TRIGGER_TYPES = [
	"local_knowledge_accumulation",
	"global_knowledge_accumulation",
] as const satisfies readonly WorkflowTriggerType[];

/**
 * Type guard: returns true when value matches a known
 * {@link WorkflowTriggerType}. Used to validate CLI-provided trigger
 * type strings before invoking the trigger runner.
 */
export function isWorkflowTriggerType(
	value: string,
): value is WorkflowTriggerType {
	return (WORKFLOW_TRIGGER_TYPES as readonly string[]).includes(value);
}

/** One closed workflow stage trigger. */
export interface WorkflowTrigger {
	readonly type: WorkflowTriggerType;
}

/** Result reported after one trigger attempt. */
export type WorkflowTriggerRunResult =
	| { readonly ok: true }
	| { readonly ok: false };

/** Cross-extension runner for one workflow stage trigger. */
export interface WorkflowTriggerRunner {
	run(
		trigger: WorkflowTrigger,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
	): Promise<WorkflowTriggerRunResult>;
}

/** Event bus channel for synchronous cross-extension runner lookup. */
const RUNNER_REQUEST_CHANNEL = "pi-harness:workflow-trigger-runner:request";

/** Mutable slot passed through the event bus for request-reply. */
interface RunnerSlot {
	runner: WorkflowTriggerRunner | undefined;
}

/** Per-pi cache so each extension and each test fake keeps its own reference. */
const runnerByPi = new WeakMap<ExtensionAPI, WorkflowTriggerRunner | undefined>();

/** Registers the process-local runner used by the workflow extension. */
export function registerWorkflowTriggerRunner(
	pi: ExtensionAPI,
	runner: WorkflowTriggerRunner,
): () => void {
	runnerByPi.set(pi, runner);

	/** Replies to future cross-extension lookup requests. */
	if (typeof pi.events?.on === "function") {
		pi.events.on(RUNNER_REQUEST_CHANNEL, (slot: RunnerSlot) => {
			slot.runner = runnerByPi.get(pi);
		});
	}

	return () => {
		if (runnerByPi.get(pi) === runner) {
			runnerByPi.set(pi, undefined);
		}
	};
}

/** Reads the runner registered for the current Pi extension runtime. */
export function getWorkflowTriggerRunner(
	pi: ExtensionAPI,
): WorkflowTriggerRunner | undefined {
	const cached = runnerByPi.get(pi);
	if (cached !== undefined) {
		return cached;
	}

	/** Asks whether another extension already registered a runner. */
	const slot: RunnerSlot = { runner: undefined };
	if (typeof pi.events?.emit === "function") {
		pi.events.emit(RUNNER_REQUEST_CHANNEL, slot);
	}
	if (slot.runner !== undefined) {
		runnerByPi.set(pi, slot.runner);
	}
	return slot.runner;
}
