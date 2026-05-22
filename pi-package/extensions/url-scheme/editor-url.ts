/** Editor URL schemes supported by the extension. */
export const SUPPORTED_SCHEMES = [
	"vscode",
	"cursor",
	"webstorm",
	"idea",
	"pycharm",
	"phpstorm",
	"txmt",
	"bbedit",
	"zed",
] as const;

export type SupportedScheme = (typeof SUPPORTED_SCHEMES)[number];

/** Returns true when config selects a supported editor URL scheme. */
export function isSupportedScheme(value: unknown): value is SupportedScheme {
	return (
		typeof value === "string" &&
		SUPPORTED_SCHEMES.includes(value as SupportedScheme)
	);
}

/** Formats the finite set of supported schemes for config diagnostics. */
export function formatSupportedSchemeIssue(): string {
	return `scheme must be one of: ${SUPPORTED_SCHEMES.join(", ")}`;
}

/** Builds an editor URL with scheme-specific path and query encoding. */
export function formatEditorUrl(options: {
	readonly scheme: SupportedScheme;
	readonly absolutePath: string;
	readonly line?: number;
	readonly column?: number;
}): string {
	const suffix = formatLineColumnSuffix(options.line, options.column);
	const query = formatLineColumnQuery(options.line, options.column);
	const encodedPath = encodeEditorPath(options.absolutePath);

	switch (options.scheme) {
		case "vscode":
			return `vscode://file${formatPathUrlTarget(encodedPath)}${suffix}`;
		case "cursor":
			return `cursor://file${formatPathUrlTarget(encodedPath)}${suffix}`;
		case "webstorm":
		case "idea":
		case "pycharm":
		case "phpstorm":
			return `${options.scheme}://open?file=${encodeQueryValue(options.absolutePath)}${query}`;
		case "txmt":
			return `txmt://open?url=${encodeURIComponent(formatFileUrl(options.absolutePath))}${query}`;
		case "bbedit":
			return `x-bbedit://open?url=${encodeURIComponent(formatFileUrl(options.absolutePath))}${query}`;
		case "zed":
			return `zed://${formatPathUrlTarget(encodedPath)}${suffix}`;
	}
}

/** Adds the separator required before Windows drive paths in path-style editor URLs. */
function formatPathUrlTarget(encodedPath: string): string {
	return encodedPath.startsWith("/") ? encodedPath : `/${encodedPath}`;
}

/** Formats path-style line and column suffixes only when the source reference provided them. */
function formatLineColumnSuffix(
	line: number | undefined,
	column: number | undefined,
): string {
	if (line === undefined) {
		return "";
	}
	if (column === undefined) {
		return `:${line}`;
	}

	return `:${line}:${column}`;
}

/** Formats query-string line and column parameters only when the source reference provided them. */
function formatLineColumnQuery(
	line: number | undefined,
	column: number | undefined,
): string {
	if (line === undefined) {
		return "";
	}
	if (column === undefined) {
		return `&line=${line}`;
	}

	return `&line=${line}&column=${column}`;
}

/** Encodes a filesystem path for path-style editor URLs while preserving URL separators. */
function encodeEditorPath(path: string): string {
	return normalizePathSeparators(path)
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
}

/** Encodes a filesystem path for query-string editor parameters. */
function encodeQueryValue(path: string): string {
	return encodeURIComponent(normalizePathSeparators(path));
}

/** Builds a file URL value before it is encoded as a query parameter. */
function formatFileUrl(path: string): string {
	const normalizedPath = normalizePathSeparators(path);
	return normalizedPath.startsWith("/")
		? `file://${normalizedPath}`
		: `file:///${normalizedPath}`;
}

/** Normalizes Windows separators to URL path separators. */
function normalizePathSeparators(path: string): string {
	return path.replaceAll("\\", "/");
}
