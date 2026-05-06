import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getSuiteExtensionDir,
	readExtensionConfigFileSync,
} from "./agent-suite-storage";

const DIAGNOSTIC_EXTENSION_DIR = "agent-selection";
const DIAGNOSTIC_LEGACY_CONFIG_FILE = "main-agent-selection.json";
const DIAGNOSTIC_FILE_NAME = "runtime-diagnostics.jsonl";
const DIAGNOSTICS_ENABLED_CONFIG_KEY = "diagnosticsEnabled";
const BYTES_PER_KIBIBYTE = 1024;
const MAX_DIAGNOSTIC_FILE_MIBIBYTES = 5;
const MAX_DIAGNOSTIC_FILE_BYTES =
	MAX_DIAGNOSTIC_FILE_MIBIBYTES * BYTES_PER_KIBIBYTE * BYTES_PER_KIBIBYTE;

/** JSON value allowed in runtime diagnostic records. */
type DiagnosticValue =
	| string
	| number
	| boolean
	| null
	| readonly DiagnosticValue[]
	| { readonly [key: string]: DiagnosticValue };

/** Fields attached to one runtime diagnostic event. */
export type DiagnosticFields = Record<string, DiagnosticValue>;

/** Appends one bounded JSONL diagnostic event without affecting runtime behavior. */
export function writeRuntimeDiagnostic(
	event: string,
	fields: DiagnosticFields = {},
): void {
	try {
		if (!isRuntimeDiagnosticsEnabled()) {
			return;
		}

		const filePath = getRuntimeDiagnosticsPath();
		mkdirSync(getSuiteExtensionDir(DIAGNOSTIC_EXTENSION_DIR), {
			recursive: true,
		});
		resetDiagnosticFileIfTooLarge(filePath);
		appendFileSync(
			filePath,
			`${JSON.stringify({
				timestamp: new Date().toISOString(),
				event,
				pid: process.pid,
				...fields,
			})}\n`,
		);
	} catch {
		// Diagnostics must not change agent behavior when the log path is unavailable.
	}
}

/** Returns the suite-owned runtime diagnostics log path. */
export function getRuntimeDiagnosticsPath(): string {
	return join(
		getSuiteExtensionDir(DIAGNOSTIC_EXTENSION_DIR),
		DIAGNOSTIC_FILE_NAME,
	);
}

/** Keeps the diagnostic log bounded so repeated prompts cannot grow it without limit. */
function resetDiagnosticFileIfTooLarge(filePath: string): void {
	try {
		if (statSync(filePath).size <= MAX_DIAGNOSTIC_FILE_BYTES) {
			return;
		}

		writeFileSync(
			filePath,
			`${JSON.stringify({
				timestamp: new Date().toISOString(),
				event: "diagnostics.truncated",
				pid: process.pid,
				maxBytes: MAX_DIAGNOSTIC_FILE_BYTES,
			})}\n`,
		);
	} catch {
		// Missing log files are created by the next append.
	}
}

/** Returns true only when agent-selection config explicitly enables runtime diagnostics. */
function isRuntimeDiagnosticsEnabled(): boolean {
	const configFile = readExtensionConfigFileSync({
		extensionDir: DIAGNOSTIC_EXTENSION_DIR,
		legacyConfigFileName: DIAGNOSTIC_LEGACY_CONFIG_FILE,
	});
	if (configFile.kind !== "found") {
		return false;
	}

	const config: unknown = JSON.parse(configFile.file.content);
	return isRecord(config) && config[DIAGNOSTICS_ENABLED_CONFIG_KEY] === true;
}

/** Returns true when a runtime value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
