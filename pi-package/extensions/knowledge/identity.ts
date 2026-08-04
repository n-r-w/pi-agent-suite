import { createHash } from "node:crypto";
import type { FetchUrlIdentity, IdentityProfile } from "./url-identity";

/** Defines the versioned hash domain and display-only project naming rules. */
const KEY_DOMAIN = "pi-agent-suite:knowledge-project:key-v1";
const GIT_SUFFIX = ".git";
const NULL_BYTE = Buffer.from([0]);
const PREFIX_BYTE_LIMIT = 80;
const UNSAFE_PREFIX_RUN = /[^\p{L}\p{N}\p{M}._-]+/gu;
const LEADING_DECORATION = /^[._-]+/u;
const TRAILING_DECORATION = /[._-]+$/u;

/** Describes the stable project identity and its diagnostic catalog name. */
export interface ProjectIdentity {
	readonly profile: IdentityProfile;
	readonly canonicalIdentity: string;
	readonly displayName: string;
	readonly key: string;
	readonly directoryName: string;
}

/** Derives the versioned SHA-256 project key and catalog directory name. */
export function createProjectIdentity(
	identity: FetchUrlIdentity,
): ProjectIdentity {
	if (
		identity.profile.includes("\u0000") ||
		identity.canonicalIdentity.includes("\u0000")
	) {
		throw new Error("project identity cannot contain U+0000");
	}
	const key = createHash("sha256")
		.update(
			Buffer.concat([
				Buffer.from(KEY_DOMAIN, "utf8"),
				NULL_BYTE,
				Buffer.from(identity.profile, "utf8"),
				NULL_BYTE,
				Buffer.from(identity.canonicalIdentity, "utf8"),
			]),
		)
		.digest("hex");
	const prefix = sanitizeReadablePrefix(identity.displayName);
	return {
		profile: identity.profile,
		canonicalIdentity: identity.canonicalIdentity,
		displayName: identity.displayName,
		key,
		directoryName: `${prefix}-${key}`,
	};
}

/** Produces a display-only filesystem-safe prefix within the UTF-8 budget. */
export function sanitizeReadablePrefix(
	value: string,
	fallback = "project",
): string {
	const withoutGitSuffix = value.endsWith(GIT_SUFFIX)
		? value.slice(0, -GIT_SUFFIX.length)
		: value;
	const normalized = withoutGitSuffix
		.normalize("NFC")
		.replace(UNSAFE_PREFIX_RUN, "-")
		.replace(LEADING_DECORATION, "")
		.replace(TRAILING_DECORATION, "");
	const bounded = takeUtf8Prefix(normalized, PREFIX_BYTE_LIMIT).replace(
		TRAILING_DECORATION,
		"",
	);
	return bounded.length === 0 ? fallback : bounded;
}

/** Truncates UTF-8 text without splitting a Unicode code point. */
function takeUtf8Prefix(value: string, byteLimit: number): string {
	let result = "";
	let byteLength = 0;
	for (const codePoint of value) {
		const codePointBytes = Buffer.byteLength(codePoint, "utf8");
		if (byteLength + codePointBytes > byteLimit) {
			break;
		}
		result += codePoint;
		byteLength += codePointBytes;
	}
	return result;
}
