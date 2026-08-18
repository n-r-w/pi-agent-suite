export interface Toolset {
	readonly providerId: string;
	readonly name: string;
	readonly description: string;
	readonly toolNames: readonly string[];
	/** Confirms provider readiness and returns the registered names available for composition. */
	readonly activate: () => Promise<readonly string[]>;
}

export interface VisibleToolset {
	readonly name: string;
	readonly description: string;
	readonly toolNames: readonly string[];
}

export interface ToolsetActivation {
	readonly name: string;
	readonly toolNames: readonly string[];
	readonly alreadyActive: boolean;
}

/** Full branch-local state; replay replaces activation state instead of merging events. */
export interface ToolsetActivationSnapshotV1 {
	readonly version: 1;
	readonly activeToolsets: readonly string[];
}

export interface ToolsetActivationPresentation {
	readonly name: string;
	readonly status: "activated" | "already_active";
	readonly toolNames: readonly string[];
}

/** Keeps replay state and typed presentation data together without parsing LLM text. */
export interface ToolsetActivationDetails extends ToolsetActivationSnapshotV1 {
	readonly activation: ToolsetActivationPresentation;
}
