import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getAgentRuntimeComposition } from "../../shared/agent-runtime-composition";
import { recordHelperApiCost } from "../../shared/helper-api-cost";
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
	const resolveStartupPlan =
		dependencies.resolveStartupPlan ?? resolveChildStartupPlan;
	let contextFiles: readonly ProjectContextFile[] = [];

	pi.on("before_agent_start", (event) => {
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
			"Convene a council of experts to solve a very complex problem. The Council knows everything you know. " +
			"MUST NOT call convene_council in parallel execution.",
		parameters: ConveneCouncilParameters,
		executionMode: "parallel",
		renderCall: renderConveneCouncilCall,
		renderResult: renderConveneCouncilResult,
		async execute(...[toolCallId, params, signal, onUpdate, ctx]) {
			return executeConveneCouncil({
				createParticipantRunner,
				resolveStartupPlan,
				toolCallId,
				params: params as ConveneCouncilParams,
				signal,
				ctx: ctx as CouncilContext,
				currentThinkingLevel: pi.getThinkingLevel(),
				contextFiles,
				availableTools: pi.getAllTools(),
				recordCost: (message) => {
					recordHelperApiCost(pi, "convene-council", message);
				},
				...(onUpdate !== undefined ? { onUpdate } : {}),
			});
		},
	});
}
