import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "node:process";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

/** Environment variable that overrides the pi-agent-suite storage root. */
export const AGENT_SUITE_DIR_ENV = "PI_AGENT_SUITE_DIR";

/** Directory name used when the suite root is not overridden. */
const DEFAULT_AGENT_SUITE_DIR = "agent-suite";

/** Shared legacy config directory used by earlier package versions. */
const LEGACY_CONFIG_DIR = "config";

/** File name used by every extension-owned suite config. */
const SUITE_CONFIG_FILE = "config.json";

/** Node.js error field used to detect absent files or directories. */
const ERROR_CODE_KEY = "code";

export interface StorageFileReadResult {
	readonly path: string;
	readonly displayPath: string;
	readonly directory: string;
	readonly content: string;
}

export interface ExtensionConfigLocation {
	readonly path: string;
	readonly displayPath: string;
	readonly directory: string;
}

/** Resolves the suite root from PI_AGENT_SUITE_DIR or the default pi agent directory. */
export function getAgentSuiteDir(): string {
	const configuredDir = env[AGENT_SUITE_DIR_ENV];
	if (configuredDir !== undefined && configuredDir.length > 0) {
		return expandHomeDirectory(configuredDir);
	}

	return join(getAgentDir(), DEFAULT_AGENT_SUITE_DIR);
}

/** Returns the suite-owned directory for one extension or extension area. */
export function getSuiteExtensionDir(extensionDir: string): string {
	return join(getAgentSuiteDir(), extensionDir);
}

/** Returns the suite-owned config file location for one extension or extension area. */
export function getSuiteConfigLocation(
	extensionDir: string,
): ExtensionConfigLocation {
	const directory = getSuiteExtensionDir(extensionDir);
	return {
		path: join(directory, SUITE_CONFIG_FILE),
		displayPath: join(DEFAULT_AGENT_SUITE_DIR, extensionDir, SUITE_CONFIG_FILE),
		directory,
	};
}

/** Returns the legacy shared config file location for one extension. */
export function getLegacyConfigLocation(
	legacyConfigFileName: string,
): ExtensionConfigLocation {
	const directory = join(getAgentDir(), LEGACY_CONFIG_DIR);
	return {
		path: join(directory, legacyConfigFileName),
		displayPath: join(LEGACY_CONFIG_DIR, legacyConfigFileName),
		directory,
	};
}

/** Reads suite config first and legacy config only when the suite config is absent. */
export async function readExtensionConfigFile(options: {
	readonly extensionDir: string;
	readonly legacyConfigFileName: string;
}): Promise<
	| { readonly kind: "found"; readonly file: StorageFileReadResult }
	| { readonly kind: "missing" }
	| {
			readonly kind: "read-error";
			readonly location: ExtensionConfigLocation;
			readonly error: unknown;
	  }
> {
	const suiteLocation = getSuiteConfigLocation(options.extensionDir);
	const suiteRead = await readFileIfPresent(suiteLocation);
	if (suiteRead.kind !== "missing") {
		return suiteRead;
	}

	return readFileIfPresent(
		getLegacyConfigLocation(options.legacyConfigFileName),
	);
}

/** Synchronously reads suite config first and legacy config only when the suite config is absent. */
export function readExtensionConfigFileSync(options: {
	readonly extensionDir: string;
	readonly legacyConfigFileName: string;
}):
	| { readonly kind: "found"; readonly file: StorageFileReadResult }
	| { readonly kind: "missing" }
	| {
			readonly kind: "read-error";
			readonly location: ExtensionConfigLocation;
			readonly error: unknown;
	  } {
	const suiteLocation = getSuiteConfigLocation(options.extensionDir);
	const suiteRead = readFileIfPresentSync(suiteLocation);
	if (suiteRead.kind !== "missing") {
		return suiteRead;
	}

	return readFileIfPresentSync(
		getLegacyConfigLocation(options.legacyConfigFileName),
	);
}

/** Returns true when a Node.js file operation failed because the target is absent. */
export function isFileNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		ERROR_CODE_KEY in error &&
		(error as { readonly code?: unknown }).code === "ENOENT"
	);
}

/** Expands home-relative env values consistently with pi's agent-dir handling. */
function expandHomeDirectory(path: string): string {
	if (path === "~") {
		return homedir();
	}
	if (path.startsWith("~/")) {
		return join(homedir(), path.slice(2));
	}

	return path;
}

/** Reads one optional file while preserving non-missing read errors. */
async function readFileIfPresent(location: ExtensionConfigLocation): Promise<
	| { readonly kind: "found"; readonly file: StorageFileReadResult }
	| { readonly kind: "missing" }
	| {
			readonly kind: "read-error";
			readonly location: ExtensionConfigLocation;
			readonly error: unknown;
	  }
> {
	try {
		return {
			kind: "found",
			file: {
				...location,
				directory: dirname(location.path),
				content: await readFile(location.path, "utf8"),
			},
		};
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return { kind: "missing" };
		}

		return { kind: "read-error", location, error };
	}
}

/** Synchronously reads one optional file while preserving non-missing read errors. */
function readFileIfPresentSync(location: ExtensionConfigLocation):
	| { readonly kind: "found"; readonly file: StorageFileReadResult }
	| { readonly kind: "missing" }
	| {
			readonly kind: "read-error";
			readonly location: ExtensionConfigLocation;
			readonly error: unknown;
	  } {
	try {
		return {
			kind: "found",
			file: {
				...location,
				directory: dirname(location.path),
				content: readFileSync(location.path, "utf8"),
			},
		};
	} catch (error) {
		if (isFileNotFoundError(error)) {
			return { kind: "missing" };
		}

		return { kind: "read-error", location, error };
	}
}
