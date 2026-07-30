import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createCodingTools,
	createReadOnlyTools,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { rejectPresentationExecution } from "../../shared/tool-presentation/bounded.ts";
import {
	getPackageToolPresentation,
	type PackagePresentationEventBus,
	type PackageToolPresentation,
} from "../../shared/tool-presentation/registry.ts";
import { createUniversalToolDefinition } from "../../shared/tool-presentation/universal.ts";

/** Describes the closed presentation category selected for one conversation tool. */
type ToolPresentationResolution =
	| { readonly category: "builtin"; readonly definition: undefined }
	| {
			readonly category: "package" | "unknown";
			readonly definition: ToolDefinition;
	  };

/** Resolves one tool through the three public presentation paths. */
export interface ToolPresentationRegistry {
	resolve(toolName: string): ToolPresentationResolution;
}

/** Creates one registry that classifies built-ins through Pi's public definition factory. */
export function createToolPresentationRegistry(
	cwd: string,
	presentationEvents: PackagePresentationEventBus,
): ToolPresentationRegistry {
	const builtInNames = new Set(
		[...createCodingTools(cwd), ...createReadOnlyTools(cwd)].map(
			(tool) => tool.name,
		),
	);
	const unknownDefinitions = new Map<string, ToolDefinition>();
	return {
		resolve(toolName): ToolPresentationResolution {
			if (builtInNames.has(toolName)) {
				// Undefined is intentional: ToolExecutionComponent then selects its own
				// public built-in definition path for the active working directory.
				return { category: "builtin", definition: undefined };
			}

			const packagePresentation = getPackageToolPresentation(
				presentationEvents,
				toolName,
			);
			if (packagePresentation !== undefined) {
				return {
					category: "package",
					definition: createPresentationDefinition(packagePresentation),
				};
			}

			let definition = unknownDefinitions.get(toolName);
			if (definition === undefined) {
				definition = createUniversalToolDefinition(toolName);
				unknownDefinitions.set(toolName, definition);
			}
			return { category: "unknown", definition };
		},
	};
}

/** Converts renderer references into a public display-only ToolDefinition. */
function createPresentationDefinition(
	presentation: PackageToolPresentation,
): ToolDefinition {
	return {
		name: presentation.name,
		label: presentation.label,
		description: `Display package-owned tool ${presentation.name}.`,
		parameters: Type.Unknown(),
		renderShell: presentation.renderShell ?? "default",
		...(presentation.renderCall === undefined
			? {}
			: { renderCall: presentation.renderCall }),
		...(presentation.renderResult === undefined
			? {}
			: { renderResult: presentation.renderResult }),
		execute: rejectPresentationExecution,
	};
}
