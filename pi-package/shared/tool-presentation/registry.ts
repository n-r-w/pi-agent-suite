import type {
	AgentToolResult,
	ExtensionAPI,
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

/** Identifies the Pi event bus shared by independently loaded extensions. */
export type PackagePresentationEventBus = ExtensionAPI["events"];

/** Retains the public rendering portion of one package-owned normal definition. */
export interface PackageToolPresentation {
	readonly name: string;
	readonly label: string;
	readonly renderCall?: PackageRenderCall;
	readonly renderResult?: PackageRenderResult;
	readonly renderShell?: ToolDefinition["renderShell"];
}

/** Requests one named presentation from every package extension publisher. */
interface PackageToolPresentationRequest {
	readonly name: string;
	readonly accept: (presentation: PackageToolPresentation) => void;
}

/** Stores the presentations published by one isolated extension module. */
interface PackageToolPresentationPublisher {
	publish(definition: PackageToolPresentation): void;
}

/** Carries synchronous presentation requests across Pi's shared extension event bus. */
const PACKAGE_TOOL_PRESENTATION_REQUEST_CHANNEL =
	"pi-agent-suite:package-tool-presentation:request";

/** Keeps one lifecycle-aware publisher for each extension API instance. */
const publishers = new WeakMap<
	ExtensionAPI,
	PackageToolPresentationPublisher
>();

/** Registers a package tool and exposes its exact renderers to other extensions. */
export function registerPackageTool(
	pi: ExtensionAPI,
	definition: Parameters<ExtensionAPI["registerTool"]>[0],
): void {
	pi.registerTool(definition);
	registerPackageToolPresentation(pi, definition);
}

/** Publishes exact renderer references from one independently loaded extension. */
export function registerPackageToolPresentation(
	pi: ExtensionAPI,
	definition: PackageToolPresentation,
): void {
	let publisher = publishers.get(pi);
	if (publisher === undefined) {
		publisher = createPackageToolPresentationPublisher(pi);
		publishers.set(pi, publisher);
	}
	publisher.publish(definition);
}

/** Resolves a package renderer through Pi's synchronous shared event bus. */
export function getPackageToolPresentation(
	events: PackagePresentationEventBus,
	name: string,
): PackageToolPresentation | undefined {
	let presentation: PackageToolPresentation | undefined;
	const request: PackageToolPresentationRequest = {
		name,
		accept(candidate) {
			presentation = candidate;
		},
	};
	events.emit(PACKAGE_TOOL_PRESENTATION_REQUEST_CHANNEL, request);
	return presentation;
}

/** Creates one publisher whose listener follows the owning extension lifecycle. */
function createPackageToolPresentationPublisher(
	pi: ExtensionAPI,
): PackageToolPresentationPublisher {
	const presentations = new Map<string, PackageToolPresentation>();
	let unsubscribe: (() => void) | undefined;

	/** Installs the request listener after startup and after session replacement. */
	const subscribe = (): void => {
		unsubscribe ??= pi.events.on(
			PACKAGE_TOOL_PRESENTATION_REQUEST_CHANNEL,
			(data) => {
				const request = parsePackageToolPresentationRequest(data);
				if (request === undefined) {
					return;
				}
				const presentation = presentations.get(request.name);
				if (presentation !== undefined) {
					request.accept(presentation);
				}
			},
		);
	};

	subscribe();
	pi.on("session_start", subscribe);
	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
	});

	return {
		publish(definition): void {
			subscribe();
			presentations.set(definition.name, freezePresentation(definition));
		},
	};
}

/** Copies one presentation so later tool-definition mutation cannot change replay. */
function freezePresentation(
	definition: PackageToolPresentation,
): PackageToolPresentation {
	return Object.freeze({
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
	});
}

/** Validates one internal event payload before invoking its response callback. */
function parsePackageToolPresentationRequest(
	data: unknown,
): PackageToolPresentationRequest | undefined {
	if (
		typeof data !== "object" ||
		data === null ||
		!("name" in data) ||
		typeof data.name !== "string" ||
		!("accept" in data) ||
		typeof data.accept !== "function"
	) {
		return undefined;
	}
	return {
		name: data.name,
		accept: data.accept as PackageToolPresentationRequest["accept"],
	};
}
