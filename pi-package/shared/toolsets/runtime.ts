import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getAgentRuntimeComposition } from "../agent-runtime-composition.ts";
import { registerPackageTool } from "../tool-presentation/registry.ts";
import type {
	Toolset,
	ToolsetActivation,
	ToolsetActivationDetails,
	VisibleToolset,
} from "./contracts.ts";
import {
	renderActivateToolsetCall,
	renderActivateToolsetResult,
} from "./rendering.ts";

const ACTIVATE_TOOLSET_TOOL_NAME = "activate_toolset";
const DEFERRED_TOOLSETS_FILTER_NAME = "deferred-toolsets";
const TOOLSET_RUNTIME_REQUEST_CHANNEL = "pi-harness:toolset-runtime:request";

export interface ToolsetHistoryContext {
	readonly hasUI: boolean;
	readonly ui: {
		notify(message: string, level: "warning"): void;
	};
}

export interface ToolsetRuntime {
	replaceProvider(providerId: string, toolsets: readonly Toolset[]): void;
	restoreFromBranch(
		branch: readonly unknown[],
		ctx: ToolsetHistoryContext,
	): void;
	getVisibleToolsets(): readonly VisibleToolset[];
	activate(name: string): Promise<ToolsetActivation>;
}

interface ToolsetRuntimeSlot {
	runtime: ToolsetRuntime | undefined;
}

const runtimeByPi = new WeakMap<ExtensionAPI, ToolsetRuntime>();

class ToolsetRuntimeImpl implements ToolsetRuntime {
	private readonly toolsetsByProvider = new Map<string, readonly Toolset[]>();
	private readonly activeToolsets = new Set<string>();
	// Captured before this runtime removes deferred names, so activation can never grant an upstream-restricted tool.
	private preDeferredToolNames: readonly string[] = [];

	public constructor(private readonly pi: ExtensionAPI) {
		const composition = getAgentRuntimeComposition(pi);
		registerPackageTool(pi, {
			name: ACTIVATE_TOOLSET_TOOL_NAME,
			label: "Activate Toolset",
			description:
				"Activate a toolset listed in <toolsets> when its tools are needed.",
			parameters: Type.Object(
				{
					name: Type.String({
						minLength: 1,
						description: "Exact case-sensitive toolset name from <toolsets>.",
					}),
				},
				{ additionalProperties: false },
			),
			executionMode: "sequential",
			renderCall: renderActivateToolsetCall,
			renderResult: renderActivateToolsetResult,
			execute: async (_toolCallId, params) => {
				const activation = await this.activate(readActivationName(params));
				const details: ToolsetActivationDetails = {
					version: 1,
					activeToolsets: [...this.activeToolsets],
					activation: {
						name: activation.name,
						status: activation.alreadyActive ? "already_active" : "activated",
						toolNames: activation.toolNames,
					},
				};
				return {
					content: [
						{
							type: "text" as const,
							text: formatActivationContent(activation),
						},
					],
					details,
				};
			},
		});
		composition.publishBaselineToolNames([ACTIVATE_TOOLSET_TOOL_NAME]);
		composition.publishRestrictiveToolFilter(
			DEFERRED_TOOLSETS_FILTER_NAME,
			(candidates) => this.filterDeferredTools(candidates),
		);
		pi.on(
			"session_tree",
			(
				_event: unknown,
				ctx: ToolsetHistoryContext & {
					readonly sessionManager: { getBranch(): readonly unknown[] };
				},
			) => {
				this.restoreFromBranch(ctx.sessionManager.getBranch(), ctx);
			},
		);
	}

	public replaceProvider(
		providerId: string,
		toolsets: readonly Toolset[],
	): void {
		validateProviderCatalog(providerId, toolsets, this.toolsetsByProvider);
		const previousToolsets = this.toolsetsByProvider.get(providerId);
		const previousActiveToolsets = new Set(this.activeToolsets);

		this.toolsetsByProvider.set(providerId, [...toolsets]);
		this.removeUnavailableActiveToolsets();
		const composition = getAgentRuntimeComposition(this.pi);
		try {
			composition.publishRestrictiveToolFilter(
				DEFERRED_TOOLSETS_FILTER_NAME,
				(candidates) => this.filterDeferredTools(candidates),
			);
		} catch (error) {
			// Catalog and activation state move together so a failed reconciliation
			// cannot leave routes that disagree with the active-tool filter.
			if (previousToolsets === undefined) {
				this.toolsetsByProvider.delete(providerId);
			} else {
				this.toolsetsByProvider.set(providerId, previousToolsets);
			}
			this.replaceActiveToolsets(previousActiveToolsets);
			composition.publishRestrictiveToolFilter(
				DEFERRED_TOOLSETS_FILTER_NAME,
				(candidates) => this.filterDeferredTools(candidates),
			);
			throw error;
		}
	}

	public getVisibleToolsets(): readonly VisibleToolset[] {
		return this.resolveVisibleToolsets(this.preDeferredToolNames);
	}

	private resolveVisibleToolsets(
		candidateToolNames: readonly string[],
	): readonly VisibleToolset[] {
		return this.allToolsets()
			.filter((toolset) => !this.activeToolsets.has(toolset.name))
			.map((toolset) => ({
				name: toolset.name,
				description: toolset.description,
				toolNames: toolset.toolNames.filter((name) =>
					candidateToolNames.includes(name),
				),
			}))
			.filter((toolset) => toolset.toolNames.length > 0);
	}

	public async activate(name: string): Promise<ToolsetActivation> {
		const candidateToolNames = this.preDeferredToolNames;
		const toolset = this.allToolsets().find(
			(candidate) => candidate.name === name,
		);
		if (toolset === undefined) {
			throw new Error(`unknown toolset: ${name}`);
		}
		const toolNames = toolset.toolNames.filter((toolName) =>
			candidateToolNames.includes(toolName),
		);
		if (this.activeToolsets.has(name)) {
			return { name, toolNames, alreadyActive: true };
		}
		if (toolNames.length === 0) {
			throw new Error(`toolset is not available: ${name}`);
		}

		const providerToolNames = await toolset.activate();
		if (!containSameNames(providerToolNames, toolset.toolNames)) {
			throw new Error(`provider activation catalog mismatch: ${name}`);
		}
		this.activeToolsets.add(name);
		try {
			getAgentRuntimeComposition(this.pi).reconcileActiveTools();
		} catch (error) {
			// Activation is committed only after Pi accepts the recomposed list.
			// Restoring the marker also restores the deferred filter on retry.
			this.activeToolsets.delete(name);
			getAgentRuntimeComposition(this.pi).reconcileActiveTools();
			throw error;
		}
		return {
			name,
			toolNames,
			alreadyActive: false,
			...(toolset.activationContext === undefined
				? {}
				: { activationContext: toolset.activationContext }),
		};
	}

	public restoreFromBranch(
		branch: readonly unknown[],
		ctx: ToolsetHistoryContext,
	): void {
		let snapshot: readonly string[] = [];
		for (const entry of branch) {
			const details = readSuccessfulActivationDetails(entry);
			if (details !== undefined) {
				snapshot = details;
			}
		}

		const loadedNames = new Set(
			this.allToolsets().map((toolset) => toolset.name),
		);
		const restoredNames = snapshot.filter((name) => loadedNames.has(name));
		const staleNames = snapshot.filter((name) => !loadedNames.has(name));
		const previousActiveToolsets = new Set(this.activeToolsets);
		this.replaceActiveToolsets(new Set(restoredNames));
		try {
			getAgentRuntimeComposition(this.pi).reconcileActiveTools();
		} catch (error) {
			// Branch restoration changes the complete activation snapshot as one
			// unit; failed reconciliation leaves the prior branch state intact.
			this.replaceActiveToolsets(previousActiveToolsets);
			getAgentRuntimeComposition(this.pi).reconcileActiveTools();
			throw error;
		}
		if (staleNames.length > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`[toolsets] ignored stale activated toolsets: ${staleNames.join(", ")}`,
				"warning",
			);
		}
	}

	private filterDeferredTools(
		candidates: readonly string[],
	): readonly string[] {
		// Eligibility uses the unmodified candidates; activation-tool visibility additionally requires its name to survive upstream filters.
		this.preDeferredToolNames = [...candidates];
		const eligibleToolsets = this.resolveVisibleToolsets(candidates);
		const deferredToolNames = new Set(
			this.allToolsets()
				.filter((toolset) => !this.activeToolsets.has(toolset.name))
				.flatMap((toolset) => toolset.toolNames),
		);
		return candidates.filter((name) => {
			if (name === ACTIVATE_TOOLSET_TOOL_NAME) {
				return eligibleToolsets.length > 0;
			}
			return !deferredToolNames.has(name);
		});
	}

	private removeUnavailableActiveToolsets(): void {
		const loadedNames = new Set(
			this.allToolsets().map((toolset) => toolset.name),
		);
		for (const name of this.activeToolsets) {
			if (!loadedNames.has(name)) {
				this.activeToolsets.delete(name);
			}
		}
	}

	private replaceActiveToolsets(names: ReadonlySet<string>): void {
		this.activeToolsets.clear();
		for (const name of names) {
			this.activeToolsets.add(name);
		}
	}

	private allToolsets(): readonly Toolset[] {
		return [...this.toolsetsByProvider.values()].flat();
	}
}

export function getToolsetRuntime(pi: ExtensionAPI): ToolsetRuntime {
	const cached = runtimeByPi.get(pi);
	if (cached !== undefined) {
		return cached;
	}

	const slot: ToolsetRuntimeSlot = { runtime: undefined };
	if (typeof pi.events?.emit === "function") {
		pi.events.emit(TOOLSET_RUNTIME_REQUEST_CHANNEL, slot);
	}
	if (slot.runtime !== undefined) {
		runtimeByPi.set(pi, slot.runtime);
		return slot.runtime;
	}

	const runtime = new ToolsetRuntimeImpl(pi);
	runtimeByPi.set(pi, runtime);

	// Pi loads shared modules separately for each extension, so the session event bus carries the singleton across ExtensionAPI objects.
	if (typeof pi.events?.on === "function") {
		pi.events.on(TOOLSET_RUNTIME_REQUEST_CHANNEL, (data: unknown) => {
			(data as ToolsetRuntimeSlot).runtime = runtime;
		});
	}

	return runtime;
}

function validateProviderCatalog(
	providerId: string,
	toolsets: readonly Toolset[],
	catalogs: ReadonlyMap<string, readonly Toolset[]>,
): void {
	const names = new Set<string>();
	for (const [registeredProviderId, registeredToolsets] of catalogs) {
		if (registeredProviderId === providerId) {
			continue;
		}
		for (const toolset of registeredToolsets) {
			names.add(toolset.name);
		}
	}
	for (const toolset of toolsets) {
		if (toolset.providerId !== providerId) {
			throw new Error(`toolset provider mismatch: ${toolset.name}`);
		}
		if (names.has(toolset.name)) {
			throw new Error(`duplicate toolset name: ${toolset.name}`);
		}
		names.add(toolset.name);
	}
}

function containSameNames(
	left: readonly string[],
	right: readonly string[],
): boolean {
	if (left.length !== right.length) {
		return false;
	}
	const rightNames = new Set(right);
	return left.every((name) => rightNames.has(name));
}

function formatActivationContent(activation: ToolsetActivation): string {
	const status = activation.alreadyActive
		? `Toolset "${activation.name}" is already active.`
		: `Activated toolset "${activation.name}".`;
	const summary = `${status}\nAvailable tools:\n${activation.toolNames
		.map((name) => `- ${name}`)
		.join("\n")}`;
	return activation.activationContext === undefined
		? summary
		: `${summary}\n\n${activation.activationContext}`;
}

function readActivationName(params: unknown): string {
	if (!isRecord(params) || typeof params["name"] !== "string") {
		throw new Error("activate_toolset requires a name");
	}
	return params["name"];
}

/** Accepts only successful version-1 snapshots; malformed history never changes runtime state. */
function readSuccessfulActivationDetails(
	entry: unknown,
): readonly string[] | undefined {
	if (!isRecord(entry) || entry["type"] !== "message") {
		return undefined;
	}
	const message = entry["message"];
	if (
		!isRecord(message) ||
		message["role"] !== "toolResult" ||
		message["toolName"] !== ACTIVATE_TOOLSET_TOOL_NAME ||
		message["isError"] !== false
	) {
		return undefined;
	}
	const details = message["details"];
	if (
		!isRecord(details) ||
		details["version"] !== 1 ||
		!Array.isArray(details["activeToolsets"]) ||
		!details["activeToolsets"].every((name) => typeof name === "string")
	) {
		return undefined;
	}
	return details["activeToolsets"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
