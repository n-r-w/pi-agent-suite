import { completeSimple as defaultCompleteSimple } from "@earendil-works/pi-ai/compat";
import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readSuiteConfigFile } from "../../shared/agent-suite-storage";
import type { AuxiliaryLlmCompletion } from "../../shared/auxiliary-llm";
import { registerPackageTool } from "../../shared/tool-presentation/registry";
import { parseVisionConfig, type VisionConfig } from "./config";
import { describeImage, resolveVisionRuntime } from "./delegate";
import { ImageLoadError, loadImage } from "./image";
import { renderVisionCall, renderVisionResult } from "./rendering";

const TOOL_NAME = "describe_image";
const EXTENSION_DIRECTORY = "vision";
const ERROR_PREFIX_PATTERN = /^[^:]+:\s*/;
const TOOL_PARAMETERS = Type.Object(
	{
		image_path: Type.String({
			minLength: 1,
			description: "Path to image file.",
		}),
		prompt: Type.String({
			minLength: 1,
			maxLength: 2048,
			description: "Question or instruction to answer about image.",
		}),
	},
	{ additionalProperties: false },
);

interface VisionParams {
	readonly image_path: string;
	readonly prompt: string;
}

type VisionExecutionContext = Parameters<
	NonNullable<ToolDefinition<typeof TOOL_PARAMETERS>["execute"]>
>[4];

export function isMultimodal(
	model: { readonly input?: readonly string[] } | undefined,
): boolean {
	return model?.input?.includes("image") === true;
}

export default function vision(
	pi: ExtensionAPI,
	dependencies: {
		readonly completeSimple?: AuxiliaryLlmCompletion;
		readonly readConfigFile?: typeof readSuiteConfigFile;
	} = {},
): void {
	const completeSimple = dependencies.completeSimple ?? defaultCompleteSimple;
	const readConfigFile = dependencies.readConfigFile ?? readSuiteConfigFile;
	let config = defaultConfig();
	const sync = createToolSynchronizer(pi, () => config);
	pi.on("session_start", async (_event, ctx) => {
		config = await loadConfig(ctx.ui, readConfigFile);
		sync(ctx.model);
	});
	pi.on("model_select", (event) => sync(event.model));
	registerPackageTool(
		pi,
		createToolDefinition(pi, () => config, completeSimple),
	);
}

function createToolSynchronizer(
	pi: ExtensionAPI,
	getConfig: () => VisionConfig,
) {
	return (model: { readonly input?: readonly string[] } | undefined): void => {
		const config = getConfig();
		const active = pi.getActiveTools().filter((name) => name !== TOOL_NAME);
		if (
			config.enabled &&
			config.provider !== undefined &&
			config.model !== undefined &&
			!isMultimodal(model)
		) {
			active.push(TOOL_NAME);
		}
		pi.setActiveTools(active);
	};
}

function createToolDefinition(
	_pi: ExtensionAPI,
	getConfig: () => VisionConfig,
	completeSimple: AuxiliaryLlmCompletion,
): ToolDefinition<typeof TOOL_PARAMETERS> {
	return {
		name: TOOL_NAME,
		label: "Describe Image",
		description:
			"Analyze one image file with a vision model. Each call is independent and does not remember earlier calls; ask everything about image in one prompt.",
		promptSnippet:
			"Analyze one image file and return a text description or answer questions about it",
		promptGuidelines: [
			"Call describe_image when active model cannot process images natively.",
		],
		parameters: TOOL_PARAMETERS,
		executionMode: "sequential" as const,
		renderCall: renderVisionCall,
		renderResult: renderVisionResult,
		async execute(...[_toolCallId, params, signal, _onUpdate, ctx]) {
			return executeVisionCall({
				params: params as VisionParams,
				signal,
				ctx,
				config: getConfig(),
				completeSimple,
			});
		},
	};
}

async function executeVisionCall(options: {
	readonly params: VisionParams;
	readonly signal: AbortSignal | undefined;
	readonly ctx: VisionExecutionContext;
	readonly config: VisionConfig;
	readonly completeSimple: AuxiliaryLlmCompletion;
}) {
	if (isMultimodal(options.ctx.model)) {
		return toolResult("Use the read tool for image analysis.");
	}
	if (
		options.config.provider === undefined ||
		options.config.model === undefined
	) {
		throw new Error("not_configured: provider and model must be configured");
	}
	const runtime = await resolveVisionRuntime(
		options.ctx,
		options.config.provider,
		options.config.model,
	);
	try {
		const image = await loadImage(options.params.image_path, {
			cwd: options.ctx.cwd,
			compression: options.config.compression,
		});
		return toolResult(
			await describeImage({
				runtime,
				image,
				prompt: options.params.prompt,
				retry: options.config.retry,
				signal: options.signal,
				completeSimple: options.completeSimple,
			}),
		);
	} catch (error) {
		const { code, message } = formatImageError(error);
		return toolResult(`[error: ${code} — ${message}]`);
	}
}

async function loadConfig(
	ui: { notify(message: string, level: "warning"): void } | undefined,
	readConfigFile: typeof readSuiteConfigFile,
): Promise<VisionConfig> {
	const file = await readConfigFile(EXTENSION_DIRECTORY);
	const parsed =
		file.kind === "found"
			? parseJsonConfig(file.file.content)
			: parseVisionConfig({});
	if (parsed.kind === "invalid") {
		ui?.notify(`[vision] ${parsed.issue}`, "warning");
		return defaultConfig();
	}
	if (
		parsed.config.enabled &&
		(parsed.config.provider === undefined || parsed.config.model === undefined)
	) {
		ui?.notify("[vision] provider and model must be configured", "warning");
	}
	return parsed.config;
}

function toolResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

function formatImageError(error: unknown): {
	readonly code: string;
	readonly message: string;
} {
	if (error instanceof ImageLoadError) {
		return { code: error.code, message: error.message };
	}
	if (error instanceof Error) {
		const [code] = error.message.split(":");
		return {
			code: code ?? "error",
			message: error.message.replace(ERROR_PREFIX_PATTERN, ""),
		};
	}
	return { code: "error", message: String(error) };
}

function parseJsonConfig(content: string) {
	try {
		return parseVisionConfig(JSON.parse(content));
	} catch {
		return { kind: "invalid" as const, issue: "config contains invalid JSON" };
	}
}

function defaultConfig(): VisionConfig {
	const result = parseVisionConfig({});
	if (result.kind === "invalid") {
		throw new Error(result.issue);
	}
	return result.config;
}
