import { completeSimple as defaultCompleteSimple } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { getAgentRuntimeComposition } from "../../shared/agent-runtime-composition";
import { collectLoadedSkillRoots } from "../../shared/context-projection";
import { readConveneCouncilRegistrationState } from "./config";
import { TOOL_NAME } from "./constants";
import { executeConveneCouncil } from "./loop";
import { buildRuntimeGuidancePrompt } from "./prompts";
import {
	renderConveneCouncilCall,
	renderConveneCouncilResult,
} from "./rendering";
import type {
	ConveneCouncilDependencies,
	ConveneCouncilParams,
	CouncilContext,
	ProjectContextFile,
} from "./types";

const ConveneCouncilParameters = Type.Object(
	{
		question: Type.String({
			description: "Question to discuss with the council",
		}),
	},
	{ additionalProperties: false },
);

/** Extension entry point for council consultation behavior. */
export default function conveneCouncil(
	pi: ExtensionAPI,
	dependencies: ConveneCouncilDependencies = {
		completeSimple: defaultCompleteSimple,
	},
): void {
	const registrationState = readConveneCouncilRegistrationState();
	if (registrationState.kind === "disabled") {
		return;
	}

	const completeSimple = dependencies.completeSimple ?? defaultCompleteSimple;
	let loadedSkillRoots: readonly string[] = [];
	let contextFiles: readonly ProjectContextFile[] = [];

	pi.on("before_agent_start", (event) => {
		loadedSkillRoots = collectLoadedSkillRoots(event);
		contextFiles = event.systemPromptOptions?.contextFiles ?? [];
	});

	if (registrationState.kind === "enabled") {
		getAgentRuntimeComposition(pi).setConveneCouncilContribution({
			requiredToolName: TOOL_NAME,
			prompt: buildRuntimeGuidancePrompt(),
		});
	}

	pi.registerTool({
		name: TOOL_NAME,
		label: "Convene council",
		description: "Convene a council of experts to solve a very complex problem",
		parameters: ConveneCouncilParameters,
		renderCall: renderConveneCouncilCall,
		renderResult: renderConveneCouncilResult,
		async execute(...[toolCallId, params, signal, _onUpdate, ctx]) {
			return executeConveneCouncil({
				completeSimple,
				toolCallId,
				params: params as ConveneCouncilParams,
				signal,
				ctx: ctx as CouncilContext,
				currentThinkingLevel: pi.getThinkingLevel(),
				loadedSkillRoots,
				contextFiles,
			});
		},
	});
}
