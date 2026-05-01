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
import { createRpcParticipantRunner } from "./runner";
import { resolveChildStartupPlan } from "./startup";
import type {
	ConveneCouncilDependencies,
	ConveneCouncilParams,
	CouncilContext,
	ProjectContextFile,
} from "./types";

const ConveneCouncilParameters = Type.Object(
	{
		question: Type.String({
			description: "Question to discuss with the council. ENGLISH ONLY",
		}),
	},
	{ additionalProperties: false },
);

/** Extension entry point for council consultation behavior. */
export default function conveneCouncil(
	pi: ExtensionAPI,
	dependencies: ConveneCouncilDependencies = {},
): void {
	const registrationState = readConveneCouncilRegistrationState();
	if (registrationState.kind === "disabled") {
		return;
	}

	const createParticipantRunner =
		dependencies.createParticipantRunner ?? createRpcParticipantRunner;
	const generateContextSummary = dependencies.generateContextSummary;
	const resolveStartupPlan =
		dependencies.resolveStartupPlan ?? resolveChildStartupPlan;
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
		description:
			"Convene a council of experts to solve a very complex problem. The Council knows everything you know",
		parameters: ConveneCouncilParameters,
		renderCall: renderConveneCouncilCall,
		renderResult: renderConveneCouncilResult,
		async execute(...[toolCallId, params, signal, onUpdate, ctx]) {
			return executeConveneCouncil({
				createParticipantRunner,
				...(generateContextSummary === undefined
					? {}
					: { generateContextSummary }),
				resolveStartupPlan,
				toolCallId,
				params: params as ConveneCouncilParams,
				signal,
				ctx: ctx as CouncilContext,
				currentThinkingLevel: pi.getThinkingLevel(),
				loadedSkillRoots,
				contextFiles,
				availableTools: pi.getAllTools(),
				...(onUpdate !== undefined ? { onUpdate } : {}),
			});
		},
	});
}
