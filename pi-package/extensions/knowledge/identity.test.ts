import { describe, expect, test } from "bun:test";
import { createProjectIdentity, sanitizeReadablePrefix } from "./identity";
import { parseFetchUrl } from "./url-identity";

const EXPECTED_PROJECT_KEY =
	"ed0513b170cc4769a82e13527af2de5202188504fae1fc05c30f7a3193a02541";

describe("knowledge project identity", () => {
	/** Verifies that every accepted GitHub spelling collapses to one identity and hash. */
	test("normalizes every supported GitHub URL form", () => {
		// ARRANGE
		const urls = [
			"https://github.com/n-r-w/pi-agent-suite",
			"https://github.com/N-R-W/PI-Agent-Suite.git",
			"git@github.com:n-r-w/pi-agent-suite.git",
			"ssh://git@github.com/n-r-w/pi-agent-suite",
			"ssh://git@github.com:22/n-r-w/pi-agent-suite.git",
			"ssh://git@ssh.github.com:443/n-r-w/pi-agent-suite.git",
		] as const;

		// ACT
		const identities = urls.map((url) => parseFetchUrl(url));

		// ASSERT
		expect(
			identities.every(
				(identity) =>
					identity?.profile === "github-v1" &&
					identity.canonicalIdentity === "github.com/n-r-w/pi-agent-suite",
			),
		).toBe(true);
		const identity = identities[0];
		expect(identity).toBeDefined();
		if (identity === undefined) {
			return;
		}
		expect(createProjectIdentity(identity)).toEqual({
			profile: "github-v1",
			canonicalIdentity: "github.com/n-r-w/pi-agent-suite",
			displayName: "pi-agent-suite",
			key: EXPECTED_PROJECT_KEY,
			directoryName: `pi-agent-suite-${EXPECTED_PROJECT_KEY}`,
		});
	});

	/** Verifies that a fork changes canonical identity and therefore the full project key. */
	test("distinguishes repositories owned by different GitHub accounts", () => {
		// ARRANGE
		const upstream = parseFetchUrl(
			"https://github.com/n-r-w/pi-agent-suite.git",
		);
		const fork = parseFetchUrl("https://github.com/example/pi-agent-suite.git");

		// ACT
		const upstreamProject =
			upstream === undefined ? undefined : createProjectIdentity(upstream);
		const forkProject =
			fork === undefined ? undefined : createProjectIdentity(fork);

		// ASSERT
		expect(upstreamProject?.key).not.toBe(forkProject?.key);
	});

	/** Verifies that GitHub's closed profile rejects prohibited syntax instead of generalizing it. */
	test("rejects unsupported GitHub URL variants", () => {
		// ARRANGE
		const urls = [
			"https://user@github.com/owner/repository",
			"https://github.com/owner/repository/",
			"https://github.com/owner/repository?view=1",
			"https://github.com/owner/re%70ository",
			"git@github.com:owner/repository/extra",
			"ssh://root@github.com/owner/repository",
			"ssh://git:secret@github.com/owner/repository",
			"ssh://git@github.com:2222/owner/repository",
			"ssh://git@ssh.github.com/owner/repository",
			"https://github.com/owner/.git",
		] as const;

		// ACT
		const results = urls.map((url) => parseFetchUrl(url));

		// ASSERT
		expect(results.every((result) => result === undefined)).toBe(true);
	});

	/**
	 * Verifies conservative URI normalization: component-local percent handling,
	 * matching standard-port removal, case rules, and empty marker preservation.
	 */
	test("normalizes supported generic URIs without rewriting meaningful syntax", () => {
		// ARRANGE
		const url = "HTTPS://Example.COM:443/a/%7eRepo.git/?#";

		// ACT
		const result = parseFetchUrl(url);

		// ASSERT
		expect(result).toEqual({
			profile: "generic-uri-v1",
			canonicalIdentity: "https://example.com/a/~Repo.git/?#",
			displayName: "~Repo.git",
			redactedUrl: "https://example.com/a/~Repo.git/?#",
		});
		expect(parseFetchUrl("ssh://Deploy@Example.com:22/a/%2frepo.git")).toEqual({
			profile: "generic-uri-v1",
			canonicalIdentity: "ssh://Deploy@example.com/a/%2Frepo.git",
			displayName: "%2Frepo.git",
			redactedUrl: "ssh://example.com/a/%2Frepo.git",
		});
		expect(parseFetchUrl("git://Example.com:9418/repo/")).toEqual({
			profile: "generic-uri-v1",
			canonicalIdentity: "git://example.com/repo/",
			displayName: "repo",
			redactedUrl: "git://example.com/repo/",
		});
		expect(parseFetchUrl("https://[2001:DB8::1]:443/repo")).toEqual({
			profile: "generic-uri-v1",
			canonicalIdentity: "https://[2001:db8::1]/repo",
			displayName: "repo",
			redactedUrl: "https://[2001:db8::1]/repo",
		});
	});

	/** Verifies that absent, empty, and populated query or fragment components stay distinct. */
	test("preserves generic URI query and fragment markers", () => {
		// ARRANGE
		const urls = [
			"https://example.com/repo",
			"https://example.com/repo?",
			"https://example.com/repo#",
			"https://example.com/repo?view=%7efull#part%2f1",
		] as const;

		// ACT
		const identities = urls.map((url) => parseFetchUrl(url)?.canonicalIdentity);

		// ASSERT
		expect(identities).toEqual([
			"https://example.com/repo",
			"https://example.com/repo?",
			"https://example.com/repo#",
			"https://example.com/repo?view=~full#part%2F1",
		]);
	});

	/** Verifies fail-closed generic URI userinfo, scheme, host, path, and escape rules. */
	test("rejects prohibited or malformed generic URIs", () => {
		// ARRANGE
		const urls = [
			"https://user@example.com/repo",
			"git://user@example.com/repo",
			"ssh://user:secret@example.com/repo",
			"ftp://example.com/repo",
			"file:///tmp/repo",
			"https:///repo",
			"https://example.com/",
			"https://example.com/re%zz",
			"https://example.com:abc/repo",
			"https://[not-ip]/repo",
			"https://example.com/repo with space",
		] as const;

		// ACT
		const results = urls.map((url) => parseFetchUrl(url));

		// ASSERT
		expect(results.every((result) => result === undefined)).toBe(true);
	});

	/** Verifies SCP identity preservation after local-path and helper syntax rejection. */
	test("normalizes generic SCP URLs and rejects local or helper forms", () => {
		// ARRANGE
		const supported = [
			"Deploy@Git.Example.com:Group/Repo.git",
			"git.example.com:Group/Repo.git/",
		] as const;
		const unsupported = [
			"C:\\repository",
			"C:/repository",
			"C:repository",
			"/tmp/repository",
			"../repository",
			"ext::transport-data",
			"bad host:repository",
			"bad user@git.example.com:repository",
			"git.example.com:",
			"git.example.com:repo\u0000name",
		] as const;

		// ACT
		const supportedResults = supported.map((url) => parseFetchUrl(url));
		const unsupportedResults = unsupported.map((url) => parseFetchUrl(url));

		// ASSERT
		expect(supportedResults).toEqual([
			{
				profile: "generic-scp-v1",
				canonicalIdentity: "Deploy@git.example.com:Group/Repo.git",
				displayName: "Repo.git",
				redactedUrl: "git.example.com:Group/Repo.git",
			},
			{
				profile: "generic-scp-v1",
				canonicalIdentity: "git.example.com:Group/Repo.git/",
				displayName: "Repo.git",
				redactedUrl: "git.example.com:Group/Repo.git/",
			},
		]);
		expect(unsupportedResults.every((result) => result === undefined)).toBe(
			true,
		);
	});

	/** Verifies display-only normalization, sanitization, fallback, and UTF-8 budget rules. */
	test("generates bounded readable prefixes without changing identity", () => {
		// ARRANGE
		const composed = " Cafe\u0301🚀.git";
		const overBudget = "é".repeat(41);

		// ACT
		const prefixes = [
			sanitizeReadablePrefix(composed),
			sanitizeReadablePrefix("._-"),
			sanitizeReadablePrefix(overBudget),
		];

		// ASSERT
		expect(prefixes).toEqual(["Café", "project", "é".repeat(40)]);
		expect(Buffer.byteLength(prefixes[2] ?? "", "utf8")).toBe(80);
	});
});
