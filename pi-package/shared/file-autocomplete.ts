import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
} from "@earendil-works/pi-tui";

export type CreateFileAutocompleteProvider = (
	cwd: string,
	fdPath: string | null,
) => AutocompleteProvider | undefined;

export type ResolveFdPath = () => string | null;

/** Creates file autocomplete for @ references when fd is available. */
export function createFileAutocompleteProvider(
	cwd: string,
	fdPath: string | null,
): AutocompleteProvider | undefined {
	if (fdPath === null) {
		return undefined;
	}
	return new CombinedAutocompleteProvider([], cwd, fdPath);
}

/** Finds an executable fd on PATH for Pi TUI file autocomplete. */
export function resolveFdPathFromPathValue(
	pathValue: string | undefined,
): string | null {
	if (pathValue === undefined || pathValue.length === 0) {
		return null;
	}

	for (const directory of pathValue.split(delimiter)) {
		if (directory.length === 0) {
			continue;
		}
		const candidate = join(directory, "fd");
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Keep scanning PATH entries until an executable fd is found.
		}
	}
	return null;
}
