import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createCodingTools,
	createReadOnlyTools,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { rejectPresentationExecution } from "../../shared/tool-presentation/bounded.ts";
import {
	getPackageToolPresentation,
	type PackageRuntimePresentationOwner,
	type PackageToolPresentation,
} from "../../shared/tool-presentation/registry.ts";
import { createUniversalToolDefinition } from "../../shared/tool-presentation/universal.ts";
import {
	renderConsultAdvisorCall,
	renderConsultAdvisorResult,
} from "../consult-advisor/rendering.ts";
import {
	renderConveneCouncilCall,
	renderConveneCouncilResult,
} from "../convene-council/rendering.ts";
import {
	renderSubagentStartCall,
	renderSubagentStartResult,
	renderSubagentSteerCall,
	renderSubagentSteerResult,
	renderSubagentWaitCall,
	renderSubagentWaitResult,
} from "./semantic-rendering.ts";

const CONSULT_ADVISOR_TOOL_NAME = "consult_advisor";
const CONVENE_COUNCIL_TOOL_NAME = "convene_council";

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
	presentationOwner: PackageRuntimePresentationOwner,
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

			const packagePresentation =
				getPackageToolPresentation(presentationOwner, toolName) ??
				getStaticPackagePresentation(toolName);
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

/** Supplies package renderers even when a static package tool is currently disabled. */
function getStaticPackagePresentation(
	toolName: string,
): PackageToolPresentation | undefined {
	if (toolName === "subagent_start") {
		return {
			name: toolName,
			label: toolName,
			renderCall: renderSubagentStartCall,
			renderResult: renderSubagentStartResult,
			renderShell: "default",
		};
	}
	if (toolName === "subagent_steer") {
		return {
			name: toolName,
			label: toolName,
			renderCall: renderSubagentSteerCall,
			renderResult: renderSubagentSteerResult,
			renderShell: "default",
		};
	}
	if (toolName === "subagent_wait") {
		return {
			name: toolName,
			label: toolName,
			renderCall: renderSubagentWaitCall,
			renderResult: renderSubagentWaitResult,
			renderShell: "default",
		};
	}
	if (toolName === CONSULT_ADVISOR_TOOL_NAME) {
		return {
			name: toolName,
			label: "Consult advisor",
			renderCall: renderConsultAdvisorCall,
			renderResult: renderConsultAdvisorResult,
			renderShell: "default",
		};
	}
	if (toolName === CONVENE_COUNCIL_TOOL_NAME) {
		return {
			name: toolName,
			label: "Convene council",
			renderCall: renderConveneCouncilCall,
			renderResult: renderConveneCouncilResult,
			renderShell: "default",
		};
	}
	return undefined;
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
