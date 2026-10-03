import { readSuiteConfigFileSync } from "../../shared/agent-suite-storage";
import { hasExactKeys } from "./boundary-validation";
import { errorMessage } from "./error-message";

/** Resolves additional child extensions from the suite's agent-selection configuration. */
export function readSubagentExtensionArgs(): readonly string[] {
	const result = readSuiteConfigFileSync("agent-selection");
	if (result.kind === "missing") {
		return [];
	}
	if (result.kind === "read-error") {
		throw new Error(
			`[subagents] could not read ${result.location.displayPath}: ${errorMessage(result.error)}`,
		);
	}
	try {
		return parseExtensionArgs(JSON.parse(result.file.content));
	} catch (error) {
		throw new Error(
			`[subagents] invalid ${result.file.displayPath}: ${errorMessage(error)}`,
			{ cause: error },
		);
	}
}

function parseExtensionArgs(value: unknown): readonly string[] {
	if (!hasExactKeys(value, [], ["enabled", "subagents"])) {
		throw new Error("configuration accepts only enabled and subagents");
	}
	const subagents = value["subagents"];
	if (subagents === undefined) {
		return [];
	}
	if (!hasExactKeys(subagents, [], ["extensions"])) {
		throw new Error("subagents must be an object with only extensions");
	}
	const extensions = subagents["extensions"];
	if (extensions === undefined) {
		return [];
	}
	if (!hasExactKeys(extensions, ["mode"], ["include"])) {
		throw new Error("subagents.extensions accepts only mode and include");
	}
	if (extensions["mode"] === "explicit") {
		const include = extensions["include"];
		if (
			!Array.isArray(include) ||
			!include.every(
				(source: unknown): source is string =>
					typeof source === "string" && source.trim().length > 0,
			)
		) {
			throw new Error("explicit mode requires include with non-empty strings");
		}
		return ["--no-extensions", ...include.flatMap((source) => ["-e", source])];
	}
	if (Object.hasOwn(extensions, "include")) {
		throw new Error("include is allowed only in explicit mode");
	}
	if (extensions["mode"] === "none") {
		return ["--no-extensions"];
	}
	if (extensions["mode"] === "all") {
		return [];
	}
	throw new Error("subagents.extensions.mode must be none, all, or explicit");
}
