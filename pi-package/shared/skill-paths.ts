import { isAbsolute, relative, resolve, sep } from "node:path";
import { expandHomePath } from "./path-expansion";

/** Returns the path argument accepted by pi's read tool. */
export function getReadToolCallPath(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return undefined;
	}

	const record = args as Record<string, unknown>;
	const path = record["path"];
	if (typeof path === "string") {
		return path;
	}

	const filePath = record["file_path"];
	return typeof filePath === "string" ? filePath : undefined;
}

/** Resolves read input paths using pi's cwd, tilde, and @-prefix semantics. */
export function resolveReadInputPath(inputPath: string, cwd: string): string {
	const withoutAtPrefix = inputPath.startsWith("@")
		? inputPath.slice(1)
		: inputPath;
	const expandedPath = expandHomePath(withoutAtPrefix);
	return isAbsolute(expandedPath)
		? resolve(expandedPath)
		: resolve(cwd, expandedPath);
}

/** Returns whether a path equals or lexically descends from a directory. */
export function isPathInsideOrEqual(
	targetPath: string,
	rootPath: string,
): boolean {
	const relativePath = relative(resolve(rootPath), resolve(targetPath));
	return (
		relativePath !== ".." &&
		!relativePath.startsWith(`..${sep}`) &&
		!isAbsolute(relativePath)
	);
}
