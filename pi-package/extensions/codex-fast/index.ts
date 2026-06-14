import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { getSuiteExtensionDir } from "../../shared/agent-suite-storage";
import {
	CODEX_FAST_ENABLED_STATUS,
	CODEX_FAST_STATUS_KEY,
} from "../../shared/codex-fast-status";

/** Suite directory owned only by this extension. */
const CODEX_FAST_EXTENSION_DIR = "codex-fast";

/** File name used for user-controlled runtime state. */
const STATE_FILE = "state.json";

/** Slash command that toggles Codex fast mode. */
const FAST_COMMAND = "fast";

/** Keyboard shortcut that toggles Codex fast mode. */
const FAST_SHORTCUT = Key.ctrlAlt("f");

/** Provider/model pairs that support fast mode payload injection. */
const FAST_MODELS = ["openai-codex/gpt-5.4", "openai-codex/gpt-5.5"] as const;

/** Payload field expected by the OpenAI Codex provider for fast mode routing. */
const SERVICE_TIER_PAYLOAD_KEY = "service_tier";

/** Payload value sent to the provider when fast mode is enabled. */
const FAST_SERVICE_TIER = "priority";

/** Node.js error field used to detect absent state files. */
const ERROR_CODE_KEY = "code";

/** Persisted runtime state controlled by `/fast` and Ctrl+Alt+F. */
interface CodexFastState {
	readonly enabled: boolean;
}

/** Mutable runtime state owned by one loaded extension instance. */
interface CodexFastRuntime {
	enabled: boolean;
	writeQueue: Promise<void>;
}

/** Returns true for plain object records used by JSON and provider payloads. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns true when a filesystem error means the state file does not exist yet. */
function isFileNotFoundError(error: unknown): boolean {
	return isRecord(error) && error[ERROR_CODE_KEY] === "ENOENT";
}

/** Returns the suite-owned state file path for this extension. */
function statePath(): string {
	return join(getSuiteExtensionDir(CODEX_FAST_EXTENSION_DIR), STATE_FILE);
}

/** Formats the current provider/model pair for fast mode model matching. */
function currentModelName(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

/** Returns true when the active model supports fast mode. */
function supportsFastMode(ctx: ExtensionContext): boolean {
	const modelName = currentModelName(ctx);
	return (
		modelName !== undefined &&
		FAST_MODELS.includes(modelName as (typeof FAST_MODELS)[number])
	);
}

/** Converts unknown JSON into a valid persisted state, defaulting to disabled. */
function parsePersistedState(value: unknown): CodexFastState {
	return isRecord(value) && value["enabled"] === true
		? { enabled: true }
		: { enabled: false };
}

/** Reads persisted fast mode state from suite-owned storage. */
async function readPersistedState(): Promise<CodexFastState> {
	try {
		const content = await readFile(statePath(), "utf8");
		return parsePersistedState(JSON.parse(content));
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return { enabled: false };
		}
		throw error;
	}
}

/** Writes fast mode state to suite-owned storage. */
async function writePersistedState(state: CodexFastState): Promise<void> {
	const directory = getSuiteExtensionDir(CODEX_FAST_EXTENSION_DIR);
	await mkdir(directory, { recursive: true });
	await writeFile(statePath(), `${JSON.stringify(state, null, "\t")}\n`);
}

/** Formats unknown failures for safe user-facing notifications. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Updates the footer status consumed by the custom footer extension. */
function updateStatus(runtime: CodexFastRuntime, ctx: ExtensionContext): void {
	if (!ctx.hasUI) {
		return;
	}

	ctx.ui.setStatus(
		CODEX_FAST_STATUS_KEY,
		runtime.enabled ? CODEX_FAST_ENABLED_STATUS : undefined,
	);
}

/** Shows a concise toggle result without exposing provider payload internals. */
function notifyState(runtime: CodexFastRuntime, ctx: ExtensionContext): void {
	if (!ctx.hasUI) {
		return;
	}

	ctx.ui.notify(
		runtime.enabled ? "Fast mode enabled." : "Fast mode disabled.",
		"info",
	);
}

/** Persists user-controlled state without allowing one failed write to block later writes. */
function persistState(
	runtime: CodexFastRuntime,
	ctx: ExtensionContext,
): Promise<void> {
	runtime.writeQueue = runtime.writeQueue
		.catch(() => undefined)
		.then(() => writePersistedState({ enabled: runtime.enabled }));

	return runtime.writeQueue.catch((error) => {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`codex-fast: failed to write state: ${formatError(error)}`,
				"warning",
			);
		}
	});
}

/** Applies a new fast mode state to runtime, footer, user notification, and storage. */
async function setFastMode(
	runtime: CodexFastRuntime,
	enabled: boolean,
	ctx: ExtensionContext,
): Promise<void> {
	runtime.enabled = enabled;
	updateStatus(runtime, ctx);
	notifyState(runtime, ctx);
	await persistState(runtime, ctx);
}

/** Reloads persisted state when a pi session starts. */
async function reloadFastModeState(
	runtime: CodexFastRuntime,
	ctx: ExtensionContext,
): Promise<void> {
	try {
		runtime.enabled = (await readPersistedState()).enabled;
	} catch (error) {
		runtime.enabled = false;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`codex-fast: failed to read state: ${formatError(error)}`,
				"warning",
			);
		}
	}

	updateStatus(runtime, ctx);
}

/** Returns a patched provider payload when fast mode applies to the current request. */
function buildFastModePayload(
	runtime: CodexFastRuntime,
	payload: unknown,
	ctx: ExtensionContext,
): Record<string, unknown> | undefined {
	if (!runtime.enabled || !supportsFastMode(ctx) || !isRecord(payload)) {
		return undefined;
	}

	return {
		...payload,
		[SERVICE_TIER_PAYLOAD_KEY]: FAST_SERVICE_TIER,
	};
}

/** Registers the Codex fast mode extension. */
export default function codexFast(pi: ExtensionAPI): void {
	const runtime: CodexFastRuntime = {
		enabled: false,
		writeQueue: Promise.resolve(),
	};

	pi.registerCommand(FAST_COMMAND, {
		description: "Toggle Codex fast mode",
		handler: async (_args, ctx) => {
			await setFastMode(runtime, !runtime.enabled, ctx);
		},
	});

	pi.registerShortcut(FAST_SHORTCUT, {
		description: "Toggle Codex fast mode",
		handler: async (ctx) => {
			await setFastMode(runtime, !runtime.enabled, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await reloadFastModeState(runtime, ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		return buildFastModePayload(runtime, event.payload, ctx);
	});
}
