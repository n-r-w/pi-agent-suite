import { Buffer } from "node:buffer";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readExtensionConfigFile } from "../../shared/agent-suite-storage";

/** Footer status key owned by the Codex quota extension. */
const STATUS_KEY = "codex-quota";

/** Suite directory owned only by this extension. */
const CODEX_QUOTA_EXTENSION_DIR = "codex-quota";

/** Legacy config file name supported for existing installations. */
const CODEX_QUOTA_LEGACY_CONFIG_FILE = "codex-quota.json";

/** ChatGPT endpoint used by Codex quota status checks. */
const CODEX_QUOTA_URL = "https://chatgpt.com/backend-api/wham/usage";

/** Built-in pi provider id that owns ChatGPT Codex OAuth refresh. */
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

/** JWT claim namespace used by ChatGPT access tokens. */
const CHATGPT_AUTH_CLAIM_KEY = "https://api.openai.com/auth";

/** ChatGPT account id claim required by Codex backend requests. */
const CHATGPT_ACCOUNT_ID_CLAIM_KEY = "chatgpt_account_id";

/** Default refresh interval in seconds when config is missing or invalid. */
const DEFAULT_REFRESH_INTERVAL_SECONDS = 60;

/** Minimum supported refresh interval in seconds to avoid aggressive polling. */
const MIN_REFRESH_INTERVAL_SECONDS = 10;

/** Milliseconds in one second for timer conversion. */
const SECOND_MS = 1000;

/** HTTP status returned by the usage endpoint when Codex auth is missing or expired. */
const UNAUTHORIZED_STATUS = 401;

/** Full percentage value used for quota percentage calculations. */
const FULL_PERCENT = 100;

/** Minimum remaining percentage shown with the healthy quota color. */
const HEALTHY_REMAINING_PERCENT = 70;

/** Minimum remaining percentage shown with the warning quota color. */
const WARNING_REMAINING_PERCENT = 30;

/** Seconds in one day for compact duration formatting. */
const DAY_SECONDS = 86_400;

/** Seconds in one hour for compact duration formatting. */
const HOUR_SECONDS = 3_600;

/** Seconds in one minute for compact duration formatting. */
const MINUTE_SECONDS = 60;

/** Config key that controls Codex quota polling frequency. */
const REFRESH_INTERVAL_CONFIG_KEY = "refreshInterval";

/** Config key that disables or enables quota polling. */
const ENABLED_CONFIG_KEY = "enabled";

/** Config keys accepted by this extension. */
const CODEX_QUOTA_CONFIG_KEYS = [
	ENABLED_CONFIG_KEY,
	REFRESH_INTERVAL_CONFIG_KEY,
] as const;

/** Number of dot-separated segments expected in a JWT. */
const JWT_SEGMENT_COUNT = 3;

/** Zero-based JWT payload segment index. */
const JWT_PAYLOAD_SEGMENT_INDEX = 1;

type QuotaConfigResult =
	| { readonly kind: "disabled" }
	| { readonly kind: "valid"; readonly refreshIntervalSeconds: number }
	| { readonly kind: "invalid"; readonly issue: string };

type CodexAuthResult =
	| {
			readonly kind: "available";
			readonly accessToken: string;
			readonly accountId: string;
	  }
	| { readonly kind: "unavailable" };

interface QuotaTheme {
	fg(color: "accent" | "warning" | "error", text: string): string;
}

interface QuotaSession {
	readonly hasUI?: boolean;
	readonly modelRegistry?: {
		getApiKeyForProvider(provider: string): Promise<string | undefined>;
	};
	readonly ui: {
		readonly theme: QuotaTheme;
		setStatus(key: string, text: string | undefined): void;
		notify?(message: string, type?: "info" | "warning" | "error"): void;
	};
}

interface ChatgptAuthClaimRecord extends Record<string, unknown> {
	readonly [CHATGPT_ACCOUNT_ID_CLAIM_KEY]?: unknown;
}

interface JwtPayloadRecord extends Record<string, unknown> {
	readonly [CHATGPT_AUTH_CLAIM_KEY]?: unknown;
}

interface UsageResponseRecord extends Record<string, unknown> {
	readonly rate_limit?: unknown;
}

interface UsageRateLimitRecord extends Record<string, unknown> {
	readonly primary_window?: unknown;
	readonly secondary_window?: unknown;
}

interface UsageWindowRecord extends Record<string, unknown> {
	readonly used_percent?: unknown;
	readonly reset_after_seconds?: unknown;
}

/** Extension entry point for Codex quota status handling. */
export default function codexQuota(pi: ExtensionAPI): void {
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let activeGeneration = 0;
	let activeRefresh: Promise<void> | undefined;
	let activeAbortController: AbortController | undefined;

	const startRefresh = (
		session: QuotaSession,
		generation: number,
	): Promise<void> => {
		if (activeRefresh !== undefined) {
			return activeRefresh;
		}

		const abortController = new AbortController();
		activeAbortController = abortController;
		const refresh = refreshQuotaStatus(
			session,
			() => generation === activeGeneration,
			abortController.signal,
		).finally(() => {
			if (activeRefresh === refresh) {
				activeRefresh = undefined;
			}
			if (activeAbortController === abortController) {
				activeAbortController = undefined;
			}
		});
		activeRefresh = refresh;
		return refresh;
	};

	pi.on("session_start", async (_event, ctx) => {
		const session = ctx as QuotaSession;
		if (session.hasUI === false) {
			return;
		}

		const generation = activeGeneration + 1;
		activeGeneration = generation;
		activeAbortController?.abort();
		activeAbortController = undefined;
		activeRefresh = undefined;

		const config = await readQuotaConfig();
		if (generation !== activeGeneration) {
			return;
		}

		if (config.kind === "disabled") {
			return;
		}

		const refreshIntervalSeconds =
			config.kind === "valid"
				? config.refreshIntervalSeconds
				: DEFAULT_REFRESH_INTERVAL_SECONDS;

		if (config.kind === "invalid") {
			reportConfigIssue(session, config.issue);
		}

		if (refreshTimer !== undefined) {
			clearInterval(refreshTimer);
		}

		session.ui.setStatus(STATUS_KEY, renderLoadingStatus());
		await startRefresh(session, generation);
		if (generation !== activeGeneration) {
			return;
		}

		refreshTimer = setInterval(() => {
			startRefresh(session, generation).catch(() => {});
		}, refreshIntervalSeconds * SECOND_MS);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		activeGeneration += 1;
		if (refreshTimer !== undefined) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
		activeAbortController?.abort();

		const session = ctx as QuotaSession;
		if (session.hasUI !== false) {
			session.ui.setStatus(STATUS_KEY, undefined);
		}
	});
}

/** Reads quota config and converts invalid input into an isolated extension issue. */
async function readQuotaConfig(): Promise<QuotaConfigResult> {
	const configFile = await readExtensionConfigFile({
		extensionDir: CODEX_QUOTA_EXTENSION_DIR,
		legacyConfigFileName: CODEX_QUOTA_LEGACY_CONFIG_FILE,
	});
	if (configFile.kind === "missing") {
		return { kind: "disabled" };
	}
	if (configFile.kind === "read-error") {
		return {
			kind: "invalid",
			issue: `failed to read ${configFile.location.displayPath}: ${formatError(configFile.error)}`,
		};
	}

	try {
		const config: unknown = JSON.parse(configFile.file.content);

		return parseQuotaConfig(config, configFile.file.displayPath);
	} catch (error) {
		return {
			kind: "invalid",
			issue: `failed to parse ${configFile.file.displayPath}: ${formatError(error)}`,
		};
	}
}

/** Parses quota config JSON before session lifecycle logic uses it. */
function parseQuotaConfig(
	config: unknown,
	configDisplayPath: string,
): QuotaConfigResult {
	if (!isRecord(config)) {
		return {
			kind: "invalid",
			issue: `${configDisplayPath} must contain a JSON object`,
		};
	}

	const unsupportedKey = Object.keys(config).find(
		(key) =>
			!CODEX_QUOTA_CONFIG_KEYS.includes(
				key as (typeof CODEX_QUOTA_CONFIG_KEYS)[number],
			),
	);
	if (unsupportedKey !== undefined) {
		return {
			kind: "invalid",
			issue: `unsupported key "${unsupportedKey}" in ${configDisplayPath}`,
		};
	}

	const enabled = config[ENABLED_CONFIG_KEY];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return {
			kind: "invalid",
			issue: `${ENABLED_CONFIG_KEY} must be a boolean`,
		};
	}
	if (enabled !== true) {
		return { kind: "disabled" };
	}

	const refreshInterval = config[REFRESH_INTERVAL_CONFIG_KEY];
	if (refreshInterval === undefined) {
		return {
			kind: "valid",
			refreshIntervalSeconds: DEFAULT_REFRESH_INTERVAL_SECONDS,
		};
	}

	if (
		typeof refreshInterval !== "number" ||
		!Number.isFinite(refreshInterval) ||
		refreshInterval < MIN_REFRESH_INTERVAL_SECONDS
	) {
		return {
			kind: "invalid",
			issue: `${REFRESH_INTERVAL_CONFIG_KEY} must be a finite number greater than or equal to ${MIN_REFRESH_INTERVAL_SECONDS}`,
		};
	}

	return { kind: "valid", refreshIntervalSeconds: refreshInterval };
}

/** Refreshes the footer status once without throwing into the pi event loop. */
async function refreshQuotaStatus(
	session: QuotaSession,
	isCurrent: () => boolean,
	signal: AbortSignal,
): Promise<void> {
	const auth = await readCodexAuth(session.modelRegistry);
	if (!isCurrent()) {
		return;
	}

	if (auth.kind === "unavailable") {
		session.ui.setStatus(STATUS_KEY, renderAuthStatus(session.ui.theme));
		return;
	}

	try {
		const response = await fetch(CODEX_QUOTA_URL, {
			method: "GET",
			signal,
			headers: {
				Authorization: `Bearer ${auth.accessToken}`,
				"chatgpt-account-id": auth.accountId,
				"User-Agent": "codex-cli",
				"Content-Type": "application/json",
			},
		});
		if (!isCurrent()) {
			return;
		}

		if (response.status === UNAUTHORIZED_STATUS) {
			session.ui.setStatus(STATUS_KEY, renderAuthStatus(session.ui.theme));
			return;
		}

		if (!response.ok) {
			session.ui.setStatus(STATUS_KEY, renderErrorStatus(session.ui.theme));
			return;
		}

		const payload: unknown = await response.json();
		if (!isCurrent()) {
			return;
		}

		session.ui.setStatus(
			STATUS_KEY,
			formatQuotaStatus(payload, session.ui.theme),
		);
	} catch (error) {
		if (signal.aborted || isAbortError(error)) {
			return;
		}
		if (isCurrent()) {
			session.ui.setStatus(STATUS_KEY, renderErrorStatus(session.ui.theme));
		}
	}
}

/** Reads pi-managed Codex OAuth and returns the headers required by the usage endpoint. */
async function readCodexAuth(
	modelRegistry: QuotaSession["modelRegistry"],
): Promise<CodexAuthResult> {
	if (modelRegistry === undefined) {
		return { kind: "unavailable" };
	}

	try {
		const accessToken = await modelRegistry.getApiKeyForProvider(
			OPENAI_CODEX_PROVIDER_ID,
		);
		const credentials = extractCodexCredentials(accessToken);
		return credentials === undefined
			? { kind: "unavailable" }
			: { kind: "available", ...credentials };
	} catch {
		return { kind: "unavailable" };
	}
}

/** Extracts the bearer token and ChatGPT account ID from a pi-managed Codex access token. */
function extractCodexCredentials(
	accessToken: string | undefined,
): { readonly accessToken: string; readonly accountId: string } | undefined {
	if (typeof accessToken !== "string" || accessToken.length === 0) {
		return undefined;
	}

	const accountId = extractChatgptAccountId(accessToken);
	if (accountId === undefined) {
		return undefined;
	}

	return { accessToken, accountId };
}

/** Extracts the ChatGPT account id claim from a JWT-shaped access token without exposing token contents. */
function extractChatgptAccountId(accessToken: string): string | undefined {
	const parts = accessToken.split(".");
	if (parts.length !== JWT_SEGMENT_COUNT) {
		return undefined;
	}

	try {
		const payload: unknown = JSON.parse(
			Buffer.from(parts[JWT_PAYLOAD_SEGMENT_INDEX] ?? "", "base64url").toString(
				"utf8",
			),
		);
		if (
			!isJwtPayloadRecord(payload) ||
			!isChatgptAuthClaimRecord(payload[CHATGPT_AUTH_CLAIM_KEY])
		) {
			return undefined;
		}

		const accountId =
			payload[CHATGPT_AUTH_CLAIM_KEY][CHATGPT_ACCOUNT_ID_CLAIM_KEY];
		return typeof accountId === "string" && accountId.length > 0
			? accountId
			: undefined;
	} catch {
		return undefined;
	}
}

/** Converts the Codex usage payload into one compact, colorized footer status. */
function formatQuotaStatus(payload: unknown, theme: QuotaTheme): string {
	const windows = extractUsageWindows(payload);
	const parts = windows
		.map((window) => formatWindowStatus(window, theme))
		.filter((part) => part.length > 0);

	return parts.length > 0 ? parts.join(" ") : renderUnknownStatus(theme);
}

/** Extracts primary and secondary usage windows from the Codex usage response. */
function extractUsageWindows(payload: unknown): readonly UsageWindowRecord[] {
	if (
		!isUsageResponseRecord(payload) ||
		!isUsageRateLimitRecord(payload.rate_limit)
	) {
		return [];
	}

	return [
		payload.rate_limit.primary_window,
		payload.rate_limit.secondary_window,
	].filter(isUsageWindowRecord);
}

/** Formats one usage window as colorized remaining percentage plus optional reset duration. */
function formatWindowStatus(
	window: UsageWindowRecord,
	theme: QuotaTheme,
): string {
	const usedPercent = window.used_percent;
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
		return "";
	}

	const remainingPercent = clampPercent(FULL_PERCENT - usedPercent);
	const resetAfterSeconds = window.reset_after_seconds;
	const resetText =
		typeof resetAfterSeconds === "number" && Number.isFinite(resetAfterSeconds)
			? `/${formatDuration(resetAfterSeconds)}`
			: "";
	return `${colorizePercent(theme, remainingPercent)}${resetText}`;
}

/** Renders the first-refresh placeholder in compact footer form. */
function renderLoadingStatus(): string {
	return "CX …";
}

/** Renders missing or expired auth in compact footer form. */
function renderAuthStatus(theme: QuotaTheme): string {
	return `${theme.fg("accent", "CX")} auth`;
}

/** Renders request failures in compact footer form. */
function renderErrorStatus(theme: QuotaTheme): string {
	return `${theme.fg("accent", "CX")} ${theme.fg("error", "err")}`;
}

/** Renders successful responses with unsupported quota shape in compact footer form. */
function renderUnknownStatus(theme: QuotaTheme): string {
	return `${theme.fg("accent", "CX")} ${theme.fg("warning", "?")}`;
}

/** Colors remaining quota percentage by health threshold. */
function colorizePercent(theme: QuotaTheme, remainingPercent: number): string {
	const text = `${remainingPercent}%`;
	if (remainingPercent >= HEALTHY_REMAINING_PERCENT) {
		return text;
	}
	if (remainingPercent >= WARNING_REMAINING_PERCENT) {
		return theme.fg("warning", text);
	}
	return theme.fg("error", text);
}

/** Keeps endpoint percentages within the displayable range. */
function clampPercent(value: number): number {
	return Math.max(0, Math.min(FULL_PERCENT, Math.round(value)));
}

/** Formats reset durations compactly for the footer. */
function formatDuration(totalSeconds: number): string {
	const safeSeconds = Math.max(0, Math.floor(totalSeconds));
	const days = Math.floor(safeSeconds / DAY_SECONDS);
	const hours = Math.floor((safeSeconds % DAY_SECONDS) / HOUR_SECONDS);
	const minutes = Math.floor((safeSeconds % HOUR_SECONDS) / MINUTE_SECONDS);

	if (days > 0) {
		return `${days}d`;
	}

	if (hours > 0) {
		return `${hours}h`;
	}

	return `${minutes}m`;
}

/** Reports invalid config without interrupting other extensions or the footer. */
function reportConfigIssue(session: QuotaSession, issue: string): void {
	if (session.hasUI === false) {
		return;
	}

	session.ui.notify?.(`[codex-quota] ${issue}`, "warning");
}

/** Returns true when a runtime value can contain ChatGPT access token auth claims. */
function isChatgptAuthClaimRecord(
	value: unknown,
): value is ChatgptAuthClaimRecord {
	return isRecord(value);
}

/** Returns true when a runtime value can contain JWT claims needed by Codex requests. */
function isJwtPayloadRecord(value: unknown): value is JwtPayloadRecord {
	return isRecord(value);
}

/** Returns true when a runtime value can contain the Codex usage response. */
function isUsageResponseRecord(value: unknown): value is UsageResponseRecord {
	return isRecord(value);
}

/** Returns true when a runtime value can contain Codex rate-limit windows. */
function isUsageRateLimitRecord(value: unknown): value is UsageRateLimitRecord {
	return isRecord(value);
}

/** Returns true when a runtime value can contain one Codex usage window. */
function isUsageWindowRecord(value: unknown): value is UsageWindowRecord {
	return isRecord(value);
}

/** Returns true when a fetch failure was caused by request cancellation. */
function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

/** Returns true when a runtime value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Converts unknown failures into safe diagnostics for config issue messages. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
