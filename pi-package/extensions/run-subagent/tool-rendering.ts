import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
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
interface ToolPresentationResolution {
	readonly category: "builtin" | "package" | "unknown";
	readonly definition: ToolDefinition;
}

/** Resolves one tool through the three public presentation paths. */
export interface ToolPresentationRegistry {
	resolve(toolName: string): ToolPresentationResolution;
}

/** Creates display-only presentations from Pi definitions and package renderers. */
export function createToolPresentationRegistry(
	cwd: string,
	presentationEvents: PackagePresentationEventBus,
): ToolPresentationRegistry {
	const builtInDefinitions = new Map(
		[
			createReadToolDefinition(cwd),
			createBashToolDefinition(cwd),
			createEditToolDefinition(cwd),
			createWriteToolDefinition(cwd),
			createGrepToolDefinition(cwd),
			createFindToolDefinition(cwd),
			createLsToolDefinition(cwd),
		].map((definition) => [
			definition.name,
			createPresentationDefinition(definition),
		]),
	);
	const unknownDefinitions = new Map<string, ToolDefinition>();
	return {
		resolve(toolName): ToolPresentationResolution {
			const builtInDefinition = builtInDefinitions.get(toolName);
			if (builtInDefinition !== undefined) {
				return { category: "builtin", definition: builtInDefinition };
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
		description: `Display tool ${presentation.name}.`,
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
