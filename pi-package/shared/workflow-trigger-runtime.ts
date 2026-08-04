/** Defines the neutral runner boundary shared by workflow and trigger-owning extensions. */
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Trigger types accepted by the workflow stage contract. */
export type WorkflowTriggerType =
	| "local_knowledge_accumulation"
	| "global_knowledge_accumulation";

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

const RUNTIME_PROPERTY = "__piHarnessWorkflowTriggerRunner";

/** Event-bus carrier shared by separately loaded package extensions. */
interface WorkflowTriggerRuntimeCarrier {
	[RUNTIME_PROPERTY]?: WorkflowTriggerRunner | undefined;
}

/** Registers the process-local runner used by the workflow extension. */
export function registerWorkflowTriggerRunner(
	pi: ExtensionAPI,
	runner: WorkflowTriggerRunner,
): () => void {
	const carrier = pi.events as unknown as WorkflowTriggerRuntimeCarrier;
	if (Object.hasOwn(carrier, RUNTIME_PROPERTY)) {
		carrier[RUNTIME_PROPERTY] = runner;
	} else {
		Object.defineProperty(carrier, RUNTIME_PROPERTY, {
			configurable: false,
			enumerable: false,
			value: runner,
			writable: true,
		});
	}
	return () => {
		if (carrier[RUNTIME_PROPERTY] === runner) {
			carrier[RUNTIME_PROPERTY] = undefined;
		}
	};
}

/** Reads the runner registered for the current Pi extension runtime. */
export function getWorkflowTriggerRunner(
	pi: ExtensionAPI,
): WorkflowTriggerRunner | undefined {
	return (pi.events as unknown as WorkflowTriggerRuntimeCarrier)[
		RUNTIME_PROPERTY
	];
}
