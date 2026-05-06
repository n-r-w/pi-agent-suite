import { type SpawnOptions, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { platform as getPlatform } from "node:os";
import { env as processEnv } from "node:process";
import type {
	AgentEndEvent,
	ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import {
	getSuiteConfigLocation,
	isFileNotFoundError,
} from "../../shared/agent-suite-storage";
import { isChildAgentProcess } from "../../shared/child-agent-environment";

/** Suite directory owned only by this extension. */
const COMPLETION_SOUND_EXTENSION_DIR = "completion-sound";

/** Config key that disables all behavior owned by this extension. */
const ENABLED_CONFIG_KEY = "enabled";

/** Config key that selects the executable used for sound playback. */
const COMMAND_CONFIG_KEY = "command";

/** Config key that passes arguments to the configured playback executable. */
const ARGS_CONFIG_KEY = "args";

/** Config key that controls built-in playback volume as a percentage. */
const VOLUME_CONFIG_KEY = "volume";

/** Config keys accepted by the completion-sound config object. */
const COMPLETION_SOUND_CONFIG_KEYS = [
	ENABLED_CONFIG_KEY,
	COMMAND_CONFIG_KEY,
	ARGS_CONFIG_KEY,
	VOLUME_CONFIG_KEY,
] as const;

/** Full-volume percentage used by platform playback commands. */
const FULL_VOLUME_PERCENT = 100;

/** Maximum accepted built-in playback volume percentage. */
const MAX_VOLUME_PERCENT = 150;

/** PulseAudio volume unit that represents 100 percent playback volume. */
const PULSEAUDIO_FULL_VOLUME = 65_536;

/** Command and arguments used to play one completion sound. */
interface PlaybackCommand {
	readonly command: string;
	readonly args: readonly string[];
}

/** Raw config values accepted after strict JSON validation. */
interface CompletionSoundRawConfig {
	readonly enabled?: boolean;
	readonly command?: string;
	readonly args?: readonly string[];
	readonly volume?: number;
}

/** Effective config used by lifecycle handlers after defaults are applied. */
interface CompletionSoundConfig {
	readonly enabled: boolean;
	readonly playback: PlaybackCommand | undefined;
}

/** Config read result that keeps invalid config fail-closed. */
type CompletionSoundConfigResult =
	| { readonly kind: "valid"; readonly config: CompletionSoundConfig }
	| { readonly kind: "invalid"; readonly issue: string };

/** Narrow session context shape used only for config warning notifications. */
interface CompletionSoundSessionContext {
	readonly hasUI?: boolean;
	readonly ui?: {
		notify(message: string, type: "warning"): void;
	};
}

type AssistantAgentMessage = Extract<
	AgentEndEvent["messages"][number],
	{ readonly role: "assistant" }
>;

/** Optional dependencies that isolate environment and playback side effects. */
export interface CompletionSoundDependencies {
	readonly env?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly play?: (command: string, args: readonly string[]) => void;
}

/** Registers top-level completion sound lifecycle handlers. */
export default function completionSound(
	pi: ExtensionAPI,
	dependencies?: CompletionSoundDependencies,
): void {
	const runtimeEnv = dependencies?.env ?? processEnv;
	const runtimePlatform = dependencies?.platform ?? getPlatform();
	const play = dependencies?.play ?? playPlaybackCommand;

	pi.on("session_start", async (_event, ctx) => {
		const config = await readCompletionSoundConfig(runtimePlatform);
		if (config.kind === "invalid") {
			reportConfigIssue(ctx as CompletionSoundSessionContext, config.issue);
		}
	});

	pi.on("agent_end", async (event) => {
		if (isChildAgentProcess(runtimeEnv) || !isCompletedWorkEvent(event)) {
			return;
		}

		const config = await readCompletionSoundConfig(runtimePlatform);
		if (
			config.kind === "invalid" ||
			!config.config.enabled ||
			config.config.playback === undefined
		) {
			return;
		}

		try {
			play(config.config.playback.command, config.config.playback.args);
		} catch {
			return;
		}
	});
}

/** Returns true only for agent endings that represent completed assistant work. */
function isCompletedWorkEvent(event: AgentEndEvent): boolean {
	const lastAssistantMessage = findLastAssistantMessage(event.messages);
	return (
		lastAssistantMessage !== undefined &&
		lastAssistantMessage.stopReason !== "error" &&
		lastAssistantMessage.stopReason !== "aborted"
	);
}

/** Finds the latest assistant message because tool results can follow assistant turns. */
function findLastAssistantMessage(
	messages: AgentEndEvent["messages"],
): AssistantAgentMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant") {
			return message;
		}
	}

	return undefined;
}

/** Reads and validates config while missing config keeps platform-default playback enabled. */
async function readCompletionSoundConfig(
	currentPlatform: NodeJS.Platform,
): Promise<CompletionSoundConfigResult> {
	const configLocation = getSuiteConfigLocation(COMPLETION_SOUND_EXTENSION_DIR);

	let content: string;
	try {
		content = await readFile(configLocation.path, "utf8");
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return {
				kind: "valid",
				config: buildCompletionSoundConfig({}, currentPlatform),
			};
		}

		return invalidConfig(`failed to read config: ${formatError(error)}`);
	}

	try {
		const config: unknown = JSON.parse(content);

		return parseCompletionSoundConfig(config, currentPlatform);
	} catch (error) {
		return invalidConfig(`failed to parse config: ${formatError(error)}`);
	}
}

/** Parses config JSON before lifecycle logic uses it to run a local playback command. */
function parseCompletionSoundConfig(
	config: unknown,
	currentPlatform: NodeJS.Platform,
): CompletionSoundConfigResult {
	if (!isRecord(config)) {
		return invalidConfig("config must be an object");
	}

	const unsupportedKey = Object.keys(config).find(
		(key) =>
			!COMPLETION_SOUND_CONFIG_KEYS.includes(
				key as (typeof COMPLETION_SOUND_CONFIG_KEYS)[number],
			),
	);
	if (unsupportedKey !== undefined) {
		return invalidConfig("config contains unsupported keys");
	}

	const rawConfig = parseCompletionSoundFields(config);
	if (rawConfig.kind === "invalid") {
		return rawConfig;
	}

	return {
		kind: "valid",
		config: buildCompletionSoundConfig(rawConfig.config, currentPlatform),
	};
}

/** Parses known config fields after object shape and key ownership are proven. */
function parseCompletionSoundFields(config: Record<string, unknown>):
	| { readonly kind: "valid"; readonly config: CompletionSoundRawConfig }
	| {
			readonly kind: "invalid";
			readonly issue: string;
	  } {
	const enabled = config[ENABLED_CONFIG_KEY];
	if (enabled !== undefined && typeof enabled !== "boolean") {
		return invalidConfig("enabled must be a boolean");
	}

	const command = config[COMMAND_CONFIG_KEY];
	if (
		command !== undefined &&
		(typeof command !== "string" || command.length === 0)
	) {
		return invalidConfig("command must be a non-empty string");
	}

	const args = config[ARGS_CONFIG_KEY];
	if (args !== undefined && !isStringArray(args)) {
		return invalidConfig("args must be an array of strings");
	}

	const volume = config[VOLUME_CONFIG_KEY];
	if (volume !== undefined && !isValidVolume(volume)) {
		return invalidConfig(
			`volume must be a number from 0 to ${MAX_VOLUME_PERCENT}`,
		);
	}

	if (command === undefined && args !== undefined) {
		return invalidConfig("command is required when args is set");
	}

	return {
		kind: "valid",
		config: {
			...(enabled !== undefined ? { enabled } : {}),
			...(command !== undefined ? { command } : {}),
			...(args !== undefined ? { args } : {}),
			...(volume !== undefined ? { volume } : {}),
		},
	};
}

/** Builds effective config by applying platform defaults to omitted fields. */
function buildCompletionSoundConfig(
	config: CompletionSoundRawConfig,
	currentPlatform: NodeJS.Platform,
): CompletionSoundConfig {
	return {
		enabled: config.enabled ?? true,
		playback:
			config.command !== undefined
				? { command: config.command, args: config.args ?? [] }
				: getDefaultPlaybackCommand(currentPlatform, config.volume),
	};
}

/** Returns the platform default playback command when the platform has a safe built-in option. */
function getDefaultPlaybackCommand(
	currentPlatform: NodeJS.Platform,
	volume: number | undefined,
): PlaybackCommand | undefined {
	switch (currentPlatform) {
		case "darwin":
			return {
				command: "afplay",
				args:
					volume === undefined
						? ["/System/Library/Sounds/Glass.aiff"]
						: [
								"-v",
								String(volume / FULL_VOLUME_PERCENT),
								"/System/Library/Sounds/Glass.aiff",
							],
			};
		case "linux":
			return {
				command: "paplay",
				args:
					volume === undefined
						? ["/usr/share/sounds/freedesktop/stereo/complete.oga"]
						: [
								`--volume=${Math.round(PULSEAUDIO_FULL_VOLUME * (volume / FULL_VOLUME_PERCENT))}`,
								"/usr/share/sounds/freedesktop/stereo/complete.oga",
							],
			};
		case "win32":
			return {
				command: "powershell.exe",
				args: [
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-Command",
					"[console]::beep(880,180)",
				],
			};
		default:
			return undefined;
	}
}

/** Builds fail-closed config result with an isolated extension issue. */
function invalidConfig(issue: string): CompletionSoundConfigResult {
	return {
		kind: "invalid",
		issue,
	};
}

/** Reports invalid config without interrupting other extensions. */
function reportConfigIssue(
	ctx: CompletionSoundSessionContext,
	issue: string,
): void {
	if (ctx.hasUI === false) {
		return;
	}

	ctx.ui?.notify(`[completion-sound] ${issue}`, "warning");
}

/** Runs the configured playback command as a detached child process. */
function playPlaybackCommand(command: string, args: readonly string[]): void {
	const options: SpawnOptions = {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	};

	try {
		const child = spawn(command, [...args], options);
		child.on("error", () => undefined);
		child.unref();
	} catch {
		return;
	}
}

/** Returns true when a value is a JSON object suitable for strict config parsing. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns true when a config value is a list of process argument strings. */
function isStringArray(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

/** Returns true when a config value is a valid built-in playback volume percentage. */
function isValidVolume(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= MAX_VOLUME_PERCENT
	);
}

/** Converts unknown failures into safe diagnostics for config issue messages. */
function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
