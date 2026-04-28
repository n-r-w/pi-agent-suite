import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import {
	getAgentRuntimeComposition,
	MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT,
} from "../../shared/agent-runtime-composition";
import {
	sliceTextByWidth,
	sliceTextSuffixByWidth,
	truncateTextByWidth,
} from "../../shared/display-width";
import {
	type ContextOverflowConfig,
	readContextOverflowConfig,
} from "../context-overflow/config";

/** Footer label shown when no main-agent runtime contribution is active. */
const NO_AGENT_LABEL = "No agent";

/** Status key used by the Codex quota extension for quota text. */
const CODEX_QUOTA_STATUS_KEY = "codex-quota";

/** Status key used by the context-projection extension for provider-context projection state. */
const CONTEXT_PROJECTION_STATUS_KEY = "context-projection";

/** Relative config location owned only by this extension. */
const FOOTER_CONFIG_PATH = join("config", "footer.json");

/** Config key that disables or enables the custom footer. */
const ENABLED_CONFIG_KEY = "enabled";

/** Config key that controls provider visibility in the model display segment. */
const SHOW_PROVIDER_CONFIG_KEY = "showProvider";

/** Config key that controls model-name visibility in the model display segment. */
const SHOW_MODEL_CONFIG_KEY = "showModel";

/** Config key that controls thinking-level visibility in the model display segment. */
const SHOW_THINKING_LEVEL_CONFIG_KEY = "showThinkingLevel";

/** Config keys accepted by the footer config object. */
const FOOTER_CONFIG_KEYS = [
	ENABLED_CONFIG_KEY,
	SHOW_PROVIDER_CONFIG_KEY,
	SHOW_MODEL_CONFIG_KEY,
	SHOW_THINKING_LEVEL_CONFIG_KEY,
] as const;

/** Node.js error field used to detect absent config files. */
const ERROR_CODE_KEY = "code";

/** Separator between footer segments in the current minimal renderer. */
export const SEGMENT_SEPARATOR = " · ";

/** Minimum useful width for a shortened label with visible start, ellipsis, and visible end. */
const MIN_SHORTENED_LABEL_WIDTH = 5;

/** Context usage percentage where the footer switches from plain text to warning. */
const CONTEXT_WARNING_USED_PERCENT = 50;

/** Context usage percentage where the footer switches from warning to error. */
const CONTEXT_ERROR_USED_PERCENT = 80;

/** Converts a token ratio into a percentage for threshold checks. */
const PERCENT_FACTOR = 100;

/** Token count where the footer switches from raw numbers to a compact thousands label. */
const TOKEN_COMPACT_THRESHOLD = 1000;

/** Matches MCP status keys that pi exposes for MCP server state. */
const MCP_STATUS_KEY_PATTERN = /^mcp(?:-|$)/i;

/** Words that mark an MCP status as needing user-visible attention. */
const MCP_ERROR_KEYWORDS = [
	"error",
	"failed",
	"failure",
	"timed out",
	"timeout",
	"denied",
	"unavailable",
	"needs-auth",
];

/** Footer data provided by pi to expose extension statuses during rendering. */
interface FooterData {
	getExtensionStatuses(): ReadonlyMap<string, string>;
}

/** TUI surface used by the footer to request render after external footer data changes. */
interface FooterTui {
	requestRender(): void;
}

interface FooterEventBus {
	on(
		eventName: typeof MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT,
		listener: () => void,
	): () => void;
}

/** Minimal theme surface needed by the footer renderer. */
interface FooterTheme {
	fg(color: "warning" | "error", value: string): string;
}

/** Context usage fields that the footer displays without owning context calculation. */
interface FooterContextUsageState {
	readonly tokens?: number | null;
	readonly contextWindow?: number;
}

/** Mutable session state updated by pi events and read by the footer renderer. */
interface FooterSessionState {
	projectName: string | undefined;
	model: FooterModelState | undefined;
	requestRender: (() => void) | undefined;
}

interface FooterModelState {
	readonly provider: string;
	readonly id: string;
}

interface FooterConfig {
	readonly showProvider: boolean;
	readonly showModel: boolean;
	readonly showThinkingLevel: boolean;
}

type FooterConfigResult =
	| { readonly kind: "enabled"; readonly config: FooterConfig }
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid" };

/** Render input assembled from session-owned state. */
interface FooterRenderState {
	readonly agentLabel: string;
	readonly thinkingLevel: string | undefined;
	readonly contextUsage: FooterContextUsageState | undefined;
}

/** Input needed to build one footer render. */
interface FooterRenderOptions {
	readonly config: FooterConfig;
	readonly contextOverflowConfig: ContextOverflowConfig | undefined;
	readonly footerData: FooterData;
	readonly renderState: FooterRenderState;
	readonly sessionState: FooterSessionState;
	readonly theme: FooterTheme;
	readonly width: number;
}

/** Session context surface that the footer reads during rendering. */
interface FooterSessionContext {
	readonly cwd: string;
	readonly hasUI?: boolean;
	readonly model: FooterModelState | undefined;
	getContextUsage(): FooterContextUsageState | undefined;
	readonly ui: {
		setFooter(
			footerFactory: (
				tui: FooterTui,
				theme: FooterTheme,
				footerData: FooterData,
			) => FooterComponent,
		): void;
	};
}

/** Footer component contract used by the pi session UI. */
interface FooterComponent {
	render(width: number): string[];
	invalidate(): void;
	dispose?(): void;
}

/** Formats token counts into compact footer labels. */
function formatTokens(count: number): string {
	if (count < TOKEN_COMPACT_THRESHOLD) {
		return count.toString();
	}

	return `${Math.round(count / TOKEN_COMPACT_THRESHOLD)}k`;
}

/** Resolves the project label from the git root and uses the working directory name outside git repositories. */
async function resolveProjectName(
	pi: ExtensionAPI,
	cwd: string,
): Promise<string> {
	try {
		const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
			cwd,
		});
		const gitRoot = result.stdout.trim();
		if (result.code === 0 && gitRoot.length > 0) {
			return basename(gitRoot);
		}
	} catch {
		// The footer still needs a stable project label when git metadata is unavailable.
	}

	return basename(cwd);
}

/** Shortens a plain label from the middle so both repository label ends remain visible. */
function truncateMiddleToWidth(label: string, width: number): string {
	if (width <= 0) {
		return "";
	}
	if (visibleWidth(label) <= width) {
		return label;
	}
	if (width < MIN_SHORTENED_LABEL_WIDTH) {
		return sliceTextByWidth(label, width);
	}

	const ellipsis = "…";
	const leftWidth = Math.ceil((width - visibleWidth(ellipsis)) / 2);
	const rightWidth = width - visibleWidth(ellipsis) - leftWidth;

	return `${sliceTextByWidth(label, leftWidth)}${ellipsis}${sliceTextSuffixByWidth(label, rightWidth)}`;
}

/** Builds a project label without branch text so the footer keeps space for runtime state. */
function formatProjectLabel(
	projectName: string,
	width: number,
): string | undefined {
	if (width <= 0) {
		return undefined;
	}

	return truncateMiddleToWidth(projectName, width);
}

/** Builds the project segment from the session working directory. */
function buildProjectSegment(
	state: FooterSessionState,
	width: number,
): string | undefined {
	if (!state.projectName) {
		return undefined;
	}

	return formatProjectLabel(state.projectName, width);
}

/** Builds the thinking-level label with colors for exceptional thinking levels. */
function formatThinkingLevel(
	thinkingLevel: string | undefined,
	theme: FooterTheme,
): string | undefined {
	if (!thinkingLevel) {
		return undefined;
	}
	if (thinkingLevel === "xhigh") {
		return theme.fg("error", thinkingLevel);
	}
	if (
		thinkingLevel === "low" ||
		thinkingLevel === "minimal" ||
		thinkingLevel === "off"
	) {
		return theme.fg("warning", thinkingLevel);
	}

	return thinkingLevel;
}

/** Builds the slash-delimited provider, model, and thinking-level segment. */
function buildModelDisplaySegment(
	config: FooterConfig,
	renderState: FooterRenderState,
	sessionState: FooterSessionState,
	theme: FooterTheme,
): string | undefined {
	const parts = [
		config.showProvider ? sessionState.model?.provider : undefined,
		config.showModel ? sessionState.model?.id : undefined,
		config.showThinkingLevel
			? formatThinkingLevel(renderState.thinkingLevel, theme)
			: undefined,
	].filter((part): part is string => Boolean(part));

	return parts.length === 0 ? undefined : parts.join("/");
}

/** Selects the context usage color from used context percentage. */
function getContextUsageColor(
	usedTokens: number,
	contextWindow: number,
): "warning" | "error" | undefined {
	const usedPercent = (usedTokens / contextWindow) * PERCENT_FACTOR;
	if (usedPercent >= CONTEXT_ERROR_USED_PERCENT) {
		return "error";
	}
	if (usedPercent >= CONTEXT_WARNING_USED_PERCENT) {
		return "warning";
	}

	return undefined;
}

/** Builds token context usage without owning context calculation. */
function buildContextSegment(
	state: FooterRenderState,
	theme: FooterTheme,
	contextOverflowConfig: ContextOverflowConfig | undefined,
): string | undefined {
	const contextWindow = state.contextUsage?.contextWindow;
	if (!contextWindow) {
		return undefined;
	}

	const contextOverflowLimit = calculateContextOverflowLimit(
		contextWindow,
		contextOverflowConfig,
	);
	const contextWindowParts = [
		contextOverflowLimit === undefined
			? undefined
			: formatTokens(contextOverflowLimit),
		formatTokens(contextWindow),
	].filter((part): part is string => Boolean(part));

	const usedTokens = state.contextUsage?.tokens;
	if (usedTokens === undefined || usedTokens === null) {
		return ["?", ...contextWindowParts].join("/");
	}

	const segment = [formatTokens(usedTokens), ...contextWindowParts].join("/");
	const color = getContextUsageColor(usedTokens, contextWindow);

	return color ? theme.fg(color, segment) : segment;
}

/** Converts context-overflow remaining-token reserve into the used-token limit shown in the footer. */
function calculateContextOverflowLimit(
	contextWindow: number,
	config: ContextOverflowConfig | undefined,
): number | undefined {
	if (config === undefined || !config.enabled) {
		return undefined;
	}

	return Math.max(0, contextWindow - config.compactRemainingTokens);
}

/** Normalizes status text because footer statuses must stay on one terminal row. */
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Detects whether an MCP status reports a problem instead of healthy server state. */
function isMcpErrorStatus(text: string): boolean {
	const plainText = text.toLowerCase();

	return MCP_ERROR_KEYWORDS.some((keyword) => plainText.includes(keyword));
}

/** Reads session-owned state at render time so footer output follows active session changes. */
function readFooterRenderState(
	pi: ExtensionAPI,
	ctx: FooterSessionContext,
): FooterRenderState {
	return {
		agentLabel:
			getAgentRuntimeComposition(pi).getMainAgentContribution()?.agent?.id ??
			NO_AGENT_LABEL,
		thinkingLevel: pi.getThinkingLevel(),
		contextUsage: ctx.getContextUsage(),
	};
}

/** Reads one allowed extension status by key and normalizes it for one-row footer rendering. */
function buildStatusSegmentByKey(
	footerData: FooterData,
	key: string,
): string | undefined {
	const value = footerData.getExtensionStatuses().get(key);
	if (!value) {
		return undefined;
	}

	const sanitizedValue = sanitizeStatusText(value);
	return sanitizedValue || undefined;
}

/** Builds the agent segment from the runtime contribution used for prompt composition. */
function buildAgentSegment(renderState: FooterRenderState): string {
	return sanitizeStatusText(renderState.agentLabel) || NO_AGENT_LABEL;
}

/** Builds MCP status segments that report user-visible errors. */
function buildMcpStatusSegments(footerData: FooterData): string[] {
	const segments: string[] = [];

	for (const [key, value] of footerData.getExtensionStatuses().entries()) {
		const sanitizedValue = sanitizeStatusText(value);
		if (
			sanitizedValue &&
			MCP_STATUS_KEY_PATTERN.test(key) &&
			isMcpErrorStatus(sanitizedValue)
		) {
			segments.push(sanitizedValue);
		}
	}

	return segments;
}

/** Calculates the remaining width that the project segment may use without hiding runtime status segments. */
function calculateProjectSegmentWidth(
	width: number,
	prioritySegments: readonly string[],
): number {
	if (prioritySegments.length === 0) {
		return width;
	}

	return (
		width -
		visibleWidth(prioritySegments.join(SEGMENT_SEPARATOR)) -
		visibleWidth(SEGMENT_SEPARATOR)
	);
}

/** Builds footer lines from extension-owned status values and session-owned display state. */
function renderFooterLines({
	config,
	contextOverflowConfig,
	footerData,
	renderState,
	sessionState,
	theme,
	width,
}: FooterRenderOptions): string[] {
	const fixedPrioritySegments = [
		buildStatusSegmentByKey(footerData, CODEX_QUOTA_STATUS_KEY),
		buildAgentSegment(renderState),
		buildStatusSegmentByKey(footerData, CONTEXT_PROJECTION_STATUS_KEY),
		...buildMcpStatusSegments(footerData),
		buildContextSegment(renderState, theme, contextOverflowConfig),
	].filter((part): part is string => Boolean(part));
	const rawModelDisplaySegment = buildModelDisplaySegment(
		config,
		renderState,
		sessionState,
		theme,
	);
	const fixedPriorityWidth = visibleWidth(
		fixedPrioritySegments.join(SEGMENT_SEPARATOR),
	);
	const modelDisplaySegment = rawModelDisplaySegment
		? truncateTextByWidth(
				rawModelDisplaySegment,
				width -
					fixedPriorityWidth -
					(fixedPrioritySegments.length > 0
						? visibleWidth(SEGMENT_SEPARATOR)
						: 0),
			)
		: undefined;
	const prioritySegments = [
		buildStatusSegmentByKey(footerData, CODEX_QUOTA_STATUS_KEY),
		buildAgentSegment(renderState),
		modelDisplaySegment,
		buildStatusSegmentByKey(footerData, CONTEXT_PROJECTION_STATUS_KEY),
		...buildMcpStatusSegments(footerData),
		buildContextSegment(renderState, theme, contextOverflowConfig),
	].filter((part): part is string => Boolean(part));
	const projectSegment = buildProjectSegment(
		sessionState,
		calculateProjectSegmentWidth(width, prioritySegments),
	);
	const parts = [projectSegment, ...prioritySegments].filter(
		(part): part is string => Boolean(part),
	);
	if (parts.length === 0) {
		return [];
	}

	return [truncateTextByWidth(parts.join(SEGMENT_SEPARATOR), width)];
}

interface CreateFooterComponentOptions {
	readonly config: FooterConfig;
	readonly contextOverflowConfig: ContextOverflowConfig | undefined;
	readonly pi: ExtensionAPI;
	readonly ctx: FooterSessionContext;
	readonly footerData: FooterData;
	readonly state: FooterSessionState;
	readonly theme: FooterTheme;
	readonly tui: FooterTui;
}

/** Creates the footer component installed into the active pi session. */
function createFooterComponent({
	config,
	contextOverflowConfig,
	pi,
	ctx,
	footerData,
	state,
	theme,
	tui,
}: CreateFooterComponentOptions): FooterComponent {
	const requestRender = () => tui.requestRender();
	const unsubscribeFromAgentChanges = (pi.events as FooterEventBus).on(
		MAIN_AGENT_CONTRIBUTION_CHANGE_EVENT,
		requestRender,
	);
	state.requestRender = requestRender;

	return {
		dispose() {
			unsubscribeFromAgentChanges();
			if (state.requestRender === requestRender) {
				state.requestRender = undefined;
			}
		},
		render(width: number) {
			return renderFooterLines({
				config,
				contextOverflowConfig,
				footerData,
				renderState: readFooterRenderState(pi, ctx),
				sessionState: state,
				theme,
				width,
			});
		},
		invalidate() {},
	};
}

/** Installs the footer component for one active session. */
async function installSessionFooter(
	pi: ExtensionAPI,
	ctx: FooterSessionContext,
	state: FooterSessionState,
): Promise<void> {
	if (ctx.hasUI === false) {
		return;
	}

	const config = await readFooterConfig();
	if (config.kind !== "enabled") {
		return;
	}

	const contextOverflowConfig = await readFooterContextOverflowConfig();
	state.projectName = await resolveProjectName(pi, ctx.cwd);
	state.model = ctx.model;
	ctx.ui.setFooter((tui, theme, footerData) =>
		createFooterComponent({
			config: config.config,
			contextOverflowConfig,
			pi,
			ctx,
			footerData,
			state,
			theme,
			tui,
		}),
	);
}

/** Reads context-overflow config for footer display without surfacing context-overflow errors as footer errors. */
async function readFooterContextOverflowConfig(): Promise<
	ContextOverflowConfig | undefined
> {
	const result = await readContextOverflowConfig();
	if (result.kind === "invalid" || !result.config.enabled) {
		return undefined;
	}

	return result.config;
}

/** Reads footer config while missing config keeps the footer enabled with defaults. */
async function readFooterConfig(): Promise<FooterConfigResult> {
	try {
		const config: unknown = JSON.parse(
			await readFile(join(getAgentDir(), FOOTER_CONFIG_PATH), "utf8"),
		);
		return parseFooterConfig(config);
	} catch (error) {
		return isFileNotFoundError(error)
			? { kind: "enabled", config: buildFooterConfig({}) }
			: { kind: "invalid" };
	}
}

/** Parses the footer config contract. */
function parseFooterConfig(config: unknown): FooterConfigResult {
	if (!isRecord(config)) {
		return { kind: "invalid" };
	}

	const unsupportedKey = Object.keys(config).find(
		(key) => !(FOOTER_CONFIG_KEYS as readonly string[]).includes(key),
	);
	if (unsupportedKey !== undefined) {
		return { kind: "invalid" };
	}

	const enabled = config[ENABLED_CONFIG_KEY];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return { kind: "invalid" };
	}
	if (enabled === false) {
		return { kind: "disabled" };
	}

	const showProvider = config[SHOW_PROVIDER_CONFIG_KEY];
	if (showProvider !== undefined && typeof showProvider !== "boolean") {
		return { kind: "invalid" };
	}

	const showModel = config[SHOW_MODEL_CONFIG_KEY];
	if (showModel !== undefined && typeof showModel !== "boolean") {
		return { kind: "invalid" };
	}

	const showThinkingLevel = config[SHOW_THINKING_LEVEL_CONFIG_KEY];
	if (
		showThinkingLevel !== undefined &&
		typeof showThinkingLevel !== "boolean"
	) {
		return { kind: "invalid" };
	}

	return { kind: "enabled", config: buildFooterConfig(config) };
}

/** Builds footer config by applying defaults for omitted fields. */
function buildFooterConfig(config: Record<string, unknown>): FooterConfig {
	return {
		showProvider: config[SHOW_PROVIDER_CONFIG_KEY] !== false,
		showModel: config[SHOW_MODEL_CONFIG_KEY] !== false,
		showThinkingLevel: config[SHOW_THINKING_LEVEL_CONFIG_KEY] !== false,
	};
}

/** Returns true when a runtime value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns true when a failed config read means the config file is missing. */
function isFileNotFoundError(error: unknown): boolean {
	return isRecord(error) && error[ERROR_CODE_KEY] === "ENOENT";
}

/** Extension entry point for custom footer runtime behavior. */
export default function footer(pi: ExtensionAPI): void {
	const state: FooterSessionState = {
		projectName: undefined,
		model: undefined,
		requestRender: undefined,
	};

	pi.on("model_select", async (event) => {
		state.model = event.model;
		state.requestRender?.();
	});

	pi.on("session_start", async (_event, ctx) => {
		await installSessionFooter(pi, ctx, state);
	});
}
