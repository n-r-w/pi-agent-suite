import { join, resolve } from "node:path";

const LEADING_SEPARATOR = /^[/\\]/;
const PATH_SEPARATOR = /[/\\:]/g;

/** Encodes a resolved working directory using Pi's project-session naming. */
export function encodeProjectSessionDirectory(cwd: string): string {
	const resolvedCwd = resolve(cwd);
	return `--${resolvedCwd.replace(LEADING_SEPARATOR, "").replace(PATH_SEPARATOR, "-")}--`;
}

/** Returns the project-specific session directory under the supplied storage root. */
export function projectSessionDirectory(
	sessionsRoot: string,
	cwd: string,
): string {
	return join(sessionsRoot, encodeProjectSessionDirectory(cwd));
}
