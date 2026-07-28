import type {
	AgentToolResult,
	ExtensionContext,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

// Package tools have different schemas. Bivariant callable fields preserve each
// concrete renderer identity while keeping the heterogeneous registry typed.
type PackageRenderCall = {
	bivarianceHack(args: unknown, theme: Theme, context: unknown): Component;
}["bivarianceHack"];
type PackageRenderResult = {
	bivarianceHack(
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: unknown,
	): Component;
}["bivarianceHack"];

/** Identifies one Pi runtime through its public shared session manager object. */
export type PackageRuntimePresentationOwner =
	ExtensionContext["sessionManager"];

/** Retains the public rendering portion of one package-owned normal definition. */
export interface PackageToolPresentation {
	readonly name: string;
	readonly label: string;
	readonly renderCall?: PackageRenderCall;
	readonly renderResult?: PackageRenderResult;
	readonly renderShell?: ToolDefinition["renderShell"];
}

// Pi supplies the same SessionManager to every extension context in one runtime.
// Weak ownership shares dynamic renderers across extensions without cross-runtime leaks.
const packagePresentations = new WeakMap<
	PackageRuntimePresentationOwner,
	Map<string, PackageToolPresentation>
>();

/** Registers the exact renderer references used by one package-owned normal tool. */
export function registerPackageToolPresentation(
	owner: PackageRuntimePresentationOwner,
	definition: PackageToolPresentation,
): void {
	let presentations = packagePresentations.get(owner);
	if (presentations === undefined) {
		presentations = new Map();
		packagePresentations.set(owner, presentations);
	}
	presentations.set(
		definition.name,
		Object.freeze({
			name: definition.name,
			label: definition.label,
			...(definition.renderCall === undefined
				? {}
				: { renderCall: definition.renderCall }),
			...(definition.renderResult === undefined
				? {}
				: { renderResult: definition.renderResult }),
			...(definition.renderShell === undefined
				? {}
				: { renderShell: definition.renderShell }),
		}),
	);
}

/** Resolves package renderers without replaying extension lifecycle or querying Pi internals. */
export function getPackageToolPresentation(
	owner: PackageRuntimePresentationOwner,
	name: string,
): PackageToolPresentation | undefined {
	return packagePresentations.get(owner)?.get(name);
}
