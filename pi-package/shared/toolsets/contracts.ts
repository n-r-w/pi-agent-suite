export interface Toolset {
	readonly providerId: string;
	readonly name: string;
	readonly description: string;
	readonly toolNames: readonly string[];
	/** Model-facing context persisted with the first successful activation result. */
	readonly activationContext?: string;
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
	readonly activationContext?: string;
}

export interface ToolsetActivationPresentation {
	readonly name: string;
	readonly status: "activated" | "already_active";
	readonly toolNames: readonly string[];
}

/** Keeps replay state and typed presentation data together without parsing LLM text. */
export interface ToolsetActivationDetails {
	readonly version: 1;
	readonly activeToolsets: readonly string[];
	readonly activation: ToolsetActivationPresentation;
}
