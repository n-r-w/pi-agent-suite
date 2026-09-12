import { homedir } from "node:os";
import { join } from "node:path";

const HOME_PATH_PREFIXES = ["~", "$HOME", `\${HOME}`] as const;

/** Expands a supported home-directory prefix without changing other path text. */
export function expandHomePath(
	inputPath: string,
	homeDirectory: string = homedir(),
): string {
	for (const prefix of HOME_PATH_PREFIXES) {
		if (inputPath === prefix) {
			return homeDirectory;
		}
		if (inputPath.startsWith(`${prefix}/`)) {
			return join(homeDirectory, inputPath.slice(prefix.length + 1));
		}
	}

	return inputPath;
}
