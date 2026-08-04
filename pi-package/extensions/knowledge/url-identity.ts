import { isIP } from "node:net";

/** Defines the prohibited C0, DEL, and accepted IPv6 numeric classifications. */
const MAX_CONTROL_CODE_POINT = 31;
const DELETE_CODE_POINT = 127;
const IPV6_VERSION = 6;
/** Defines URI, helper, and platform-local dispatch grammar before profile parsing. */
const URI_PATTERN =
	/^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/u;
const REMOTE_HELPER = /^[A-Za-z][A-Za-z0-9+.-]*::/u;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:/u;
const OTHER_LOCAL_PATH = /^(?:[\\/]|\.{1,2}(?:[\\/]|$)|~[\\/])/u;
/** Defines RFC component characters and percent-escape normalization rules. */
const INVALID_PERCENT_ESCAPE = /%(?![0-9A-Fa-f]{2})/u;
const PERCENT_ESCAPE = /%([0-9A-Fa-f]{2})/gu;
const URI_PATH_CHARACTER = /^[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u;
const URI_QUERY_CHARACTER = /^[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/u;
const URI_USER_CHARACTER = /^[A-Za-z0-9._~!$&'()*+,;=%-]+$/u;
const URI_HOST_CHARACTER = /^[A-Za-z0-9._~!$&'()*+,;=%-]+$/u;
const URI_IP_LITERAL_CHARACTER = /^[A-Za-z0-9._~!$&'()*+,;=:%-]+$/u;
/** Defines the closed GitHub transport and path forms owned by github-v1. */
const GITHUB_PATH_SEGMENT = /^[A-Za-z0-9._~!$&'()*+,;=:@-]+$/u;
const GITHUB_HTTPS = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/iu;
const GITHUB_SSH =
	/^ssh:\/\/git@(github\.com|ssh\.github\.com)(?::([0-9]+))?\/([^/]+)\/([^/]+)$/iu;
const GITHUB_SCP = /^git@github\.com:([^/]+)\/([^/]+)$/iu;
const GITHUB_AUTHORITY =
	/^(?:(?:https?|ssh|git):\/\/(?:[^/@]+@)?(?:github\.com|ssh\.github\.com)(?=[:/]|$)|[^@:\s]+@(?:github\.com|ssh\.github\.com):)/iu;
/** Defines conservative SCP-like identity and user-host grammar. */
const GENERIC_SCP = /^(?:([^@:/]+)@)?([^@:/\\]+):(.+)$/u;
const SCP_USER_OR_HOST = /^[^\s@:/\\]+$/u;
/** Defines URI normalization values shared across generic schemes. */
const UNRESERVED_BYTE = /^[A-Za-z0-9._~-]$/u;
const DECIMAL_PORT = /^[0-9]+$/u;
const IP_FUTURE = /^v[0-9A-F]+\.[A-Za-z0-9._~!$&'()*+,;=:]+$/iu;
const GIT_SUFFIX = ".git";
const SUPPORTED_URI_SCHEMES = new Set(["http", "https", "ssh", "git"]);
const STANDARD_PORTS: Readonly<Record<string, string>> = {
	http: "80",
	https: "443",
	ssh: "22",
	git: "9418",
};

export type IdentityProfile = "github-v1" | "generic-uri-v1" | "generic-scp-v1";

/** Describes one accepted effective fetch URL without retaining credentials. */
export interface FetchUrlIdentity {
	readonly profile: IdentityProfile;
	readonly canonicalIdentity: string;
	readonly displayName: string;
	readonly redactedUrl: string;
}

/** Holds one normalized URI authority with and without allowed SSH userinfo. */
interface NormalizedAuthority {
	readonly canonical: string;
	readonly redacted: string;
}

/** Separates one URI host and optional port without normalizing either value. */
interface HostPortParts {
	readonly host: string;
	readonly port: string | undefined;
	readonly bracketed: boolean;
}

/** Parses an effective fetch URL through the accepted identity profiles. */
export function parseFetchUrl(url: string): FetchUrlIdentity | undefined {
	if (url.length === 0 || hasProhibitedControlCharacter(url)) {
		return undefined;
	}

	const github = parseGitHubUrl(url);
	if (github !== undefined) {
		return github;
	}
	// GitHub-like evidence must satisfy the closed GitHub profile rather than
	// falling through to generic identity rules with different equivalence.
	if (GITHUB_AUTHORITY.test(url)) {
		return undefined;
	}

	const uriMatch = URI_PATTERN.exec(url);
	if (uriMatch !== null) {
		return parseGenericUri(uriMatch);
	}
	// Remote-helper syntax cannot be reinterpreted as an SCP-like host and path.
	if (REMOTE_HELPER.test(url)) {
		return undefined;
	}
	if (WINDOWS_DRIVE_PATH.test(url) || OTHER_LOCAL_PATH.test(url)) {
		return undefined;
	}
	return parseGenericScp(url);
}

/** Parses only the closed GitHub HTTPS, SSH URI, and SCP-like forms. */
function parseGitHubUrl(url: string): FetchUrlIdentity | undefined {
	const https = GITHUB_HTTPS.exec(url);
	if (https !== null) {
		return buildGitHubIdentity(https[1], https[2], url);
	}
	const ssh = GITHUB_SSH.exec(url);
	if (ssh !== null) {
		const host = ssh[1]?.toLowerCase();
		const port = ssh[2];
		const validEndpoint =
			(host === "github.com" && (port === undefined || port === "22")) ||
			(host === "ssh.github.com" && port === "443");
		if (!validEndpoint) {
			return undefined;
		}
		return buildGitHubIdentity(ssh[3], ssh[4], url);
	}
	const scp = GITHUB_SCP.exec(url);
	return scp === null ? undefined : buildGitHubIdentity(scp[1], scp[2], url);
}

/** Builds the lowercased GitHub standard name after exact path validation. */
function buildGitHubIdentity(
	owner: string | undefined,
	repository: string | undefined,
	url: string,
): FetchUrlIdentity | undefined {
	if (
		owner === undefined ||
		repository === undefined ||
		owner.includes("%") ||
		repository.includes("%") ||
		!GITHUB_PATH_SEGMENT.test(owner) ||
		!GITHUB_PATH_SEGMENT.test(repository)
	) {
		return undefined;
	}
	const repositoryWithoutSuffix = repository.endsWith(GIT_SUFFIX)
		? repository.slice(0, -GIT_SUFFIX.length)
		: repository;
	if (repositoryWithoutSuffix.length === 0) {
		return undefined;
	}
	const normalizedOwner = owner.toLowerCase();
	const normalizedRepository = repositoryWithoutSuffix.toLowerCase();
	return {
		profile: "github-v1",
		canonicalIdentity: `github.com/${normalizedOwner}/${normalizedRepository}`,
		displayName: normalizedRepository,
		redactedUrl: redactGitHubUrl(url, normalizedOwner, normalizedRepository),
	};
}

/** Removes GitHub transport userinfo while retaining repository evidence. */
function redactGitHubUrl(
	url: string,
	owner: string,
	repository: string,
): string {
	if (url.toLowerCase().startsWith("https://")) {
		return `https://github.com/${owner}/${repository}`;
	}
	return `github.com:${owner}/${repository}`;
}

/** Parses and normalizes a standard URI match. */
function parseGenericUri(match: RegExpExecArray): FetchUrlIdentity | undefined {
	const scheme = match[1]?.toLowerCase();
	const rawAuthority = match[2];
	const rawPath = match[3];
	if (
		scheme === undefined ||
		rawAuthority === undefined ||
		rawPath === undefined ||
		!SUPPORTED_URI_SCHEMES.has(scheme)
	) {
		return undefined;
	}
	const authority = normalizeAuthority(rawAuthority, scheme);
	if (authority === undefined) {
		return undefined;
	}
	const path = normalizeUriComponent(rawPath, URI_PATH_CHARACTER);
	if (
		path === undefined ||
		!path.startsWith("/") ||
		!path.split("/").some((segment) => segment.length > 0)
	) {
		return undefined;
	}
	const query = normalizeOptionalComponent(match[4], "?", URI_QUERY_CHARACTER);
	const fragment = normalizeOptionalComponent(
		match[5],
		"#",
		URI_QUERY_CHARACTER,
	);
	if (query === undefined || fragment === undefined) {
		return undefined;
	}
	const displayName = finalNonEmptySegment(path);
	if (displayName === undefined) {
		return undefined;
	}
	return {
		profile: "generic-uri-v1",
		canonicalIdentity: `${scheme}://${authority.canonical}${path}${query.canonical}${fragment.canonical}`,
		displayName,
		redactedUrl: `${scheme}://${authority.redacted}${path}${query.redacted}${fragment.redacted}`,
	};
}

/** Normalizes URI authority and enforces scheme-specific userinfo rules. */
function normalizeAuthority(
	authority: string,
	scheme: string,
): NormalizedAuthority | undefined {
	const firstAt = authority.indexOf("@");
	const lastAt = authority.lastIndexOf("@");
	if (firstAt !== lastAt) {
		return undefined;
	}
	let user = "";
	let hostPort = authority;
	if (firstAt >= 0) {
		if (scheme !== "ssh") {
			return undefined;
		}
		const rawUser = authority.slice(0, firstAt);
		if (rawUser.includes(":")) {
			return undefined;
		}
		const normalizedUser = normalizeUriComponent(rawUser, URI_USER_CHARACTER);
		if (normalizedUser === undefined) {
			return undefined;
		}
		user = `${normalizedUser}@`;
		hostPort = authority.slice(firstAt + 1);
	}
	const endpoint = normalizeHostPort(hostPort, scheme);
	if (endpoint === undefined) {
		return undefined;
	}
	return {
		canonical: `${user}${endpoint}`,
		redacted: endpoint,
	};
}

/** Lowercases a URI host and removes only its scheme's exact standard port. */
function normalizeHostPort(
	hostPort: string,
	scheme: string,
): string | undefined {
	const parts = splitHostPort(hostPort);
	if (parts === undefined) {
		return undefined;
	}
	if (parts.bracketed && !isIpLiteral(parts.host)) {
		return undefined;
	}
	const allowedHost = parts.bracketed
		? URI_IP_LITERAL_CHARACTER
		: URI_HOST_CHARACTER;
	const normalizedHost = normalizeUriComponent(parts.host, allowedHost);
	if (
		normalizedHost === undefined ||
		normalizedHost.length === 0 ||
		(parts.port !== undefined && !DECIMAL_PORT.test(parts.port))
	) {
		return undefined;
	}
	const host = parts.bracketed
		? `[${normalizedHost.toLowerCase()}]`
		: normalizedHost.toLowerCase();
	const port = parts.port === STANDARD_PORTS[scheme] ? undefined : parts.port;
	return port === undefined ? host : `${host}:${port}`;
}

/** Accepts only the RFC IP-literal forms allowed inside URI brackets. */
function isIpLiteral(host: string): boolean {
	return isIP(host) === IPV6_VERSION || IP_FUTURE.test(host);
}

/** Separates bracketed and registered hosts before normalization. */
function splitHostPort(hostPort: string): HostPortParts | undefined {
	if (hostPort.startsWith("[")) {
		return splitBracketedHostPort(hostPort);
	}
	const separator = hostPort.lastIndexOf(":");
	if (separator < 0) {
		return { host: hostPort, port: undefined, bracketed: false };
	}
	if (hostPort.indexOf(":") !== separator) {
		return undefined;
	}
	return {
		host: hostPort.slice(0, separator),
		port: hostPort.slice(separator + 1),
		bracketed: false,
	};
}

/** Separates an IP literal from its optional port while preserving brackets. */
function splitBracketedHostPort(hostPort: string): HostPortParts | undefined {
	const closingBracket = hostPort.indexOf("]");
	if (closingBracket <= 1) {
		return undefined;
	}
	const remainder = hostPort.slice(closingBracket + 1);
	if (remainder.length > 0 && !remainder.startsWith(":")) {
		return undefined;
	}
	return {
		host: hostPort.slice(1, closingBracket),
		port: remainder.length === 0 ? undefined : remainder.slice(1),
		bracketed: true,
	};
}

/** Preserves absent versus empty markers while redacting populated query data. */
function normalizeOptionalComponent(
	value: string | undefined,
	marker: "?" | "#",
	allowedCharacters: RegExp,
): { readonly canonical: string; readonly redacted: string } | undefined {
	if (value === undefined) {
		return { canonical: "", redacted: "" };
	}
	const content = value.slice(1);
	const normalized = normalizeUriComponent(content, allowedCharacters);
	if (normalized === undefined) {
		return undefined;
	}
	return {
		canonical: `${marker}${normalized}`,
		redacted: normalized.length === 0 ? marker : `${marker}[redacted]`,
	};
}

/** Validates one URI component and applies component-local percent normalization. */
function normalizeUriComponent(
	value: string,
	allowedCharacters: RegExp,
): string | undefined {
	if (
		!allowedCharacters.test(value) ||
		INVALID_PERCENT_ESCAPE.test(value) ||
		hasProhibitedControlCharacter(value)
	) {
		return undefined;
	}
	return value.replace(PERCENT_ESCAPE, (_escape, hex: string) => {
		const decoded = String.fromCharCode(Number.parseInt(hex, 16));
		return UNRESERVED_BYTE.test(decoded) ? decoded : `%${hex.toUpperCase()}`;
	});
}

/** Parses SCP-like syntax after URI, helper, and local-path rejection. */
function parseGenericScp(url: string): FetchUrlIdentity | undefined {
	const match = GENERIC_SCP.exec(url);
	if (match === null) {
		return undefined;
	}
	const user = match[1];
	const host = match[2];
	const path = match[3];
	if (
		host === undefined ||
		path === undefined ||
		!SCP_USER_OR_HOST.test(host) ||
		path.length === 0 ||
		(user !== undefined && !SCP_USER_OR_HOST.test(user))
	) {
		return undefined;
	}
	const normalizedHost = host.toLowerCase();
	const displayName = finalNonEmptySegment(path);
	if (displayName === undefined) {
		return undefined;
	}
	return {
		profile: "generic-scp-v1",
		canonicalIdentity: `${user === undefined ? "" : `${user}@`}${normalizedHost}:${path}`,
		displayName,
		redactedUrl: `${normalizedHost}:${path}`,
	};
}

/** Selects the last non-empty slash-separated repository path segment. */
function finalNonEmptySegment(path: string): string | undefined {
	const segments = path.split("/");
	for (let index = segments.length - 1; index >= 0; index -= 1) {
		const segment = segments[index];
		if (segment !== undefined && segment.length > 0) {
			return segment;
		}
	}
	return undefined;
}

/** Rejects C0 and DEL characters before any URL grammar is attempted. */
function hasProhibitedControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (
			codePoint !== undefined &&
			(codePoint <= MAX_CONTROL_CODE_POINT || codePoint === DELETE_CODE_POINT)
		) {
			return true;
		}
	}
	return false;
}
