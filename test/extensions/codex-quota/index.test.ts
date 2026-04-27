import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import codexQuota from "../../../pi-package/extensions/codex-quota/index";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const HOME_ENV = "HOME";

interface RegisteredHandler {
	readonly eventName: string;
	readonly handler: unknown;
}

interface StatusUpdate {
	readonly key: string;
	readonly text: string | undefined;
}

interface Notification {
	readonly message: string;
	readonly type: string | undefined;
}

interface ExtensionApiFake extends ExtensionAPI {
	readonly handlers: RegisteredHandler[];
}

interface SessionContextFake {
	readonly ctx: {
		readonly hasUI?: boolean;
		readonly modelRegistry: {
			getApiKeyForProvider(provider: string): Promise<string | undefined>;
		};
		readonly ui: {
			readonly theme: {
				fg(color: string, text: string): string;
			};
			setStatus(key: string, text: string | undefined): void;
			notify(message: string, type: string | undefined): void;
		};
	};
	readonly statuses: StatusUpdate[];
	readonly notifications: Notification[];
	readonly apiKeyRequests: string[];
}

interface IntervalRegistration {
	readonly callback: () => void;
	readonly intervalMs: number;
	readonly id: ReturnType<typeof setInterval>;
}

type SessionHandler = (event: unknown, ctx: unknown) => Promise<void> | void;

type FetchFake = (
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
}

/** Creates a compact JWT-shaped access token with the ChatGPT account claim used by Codex requests. */
function createCodexAccessToken(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
		"base64url",
	);
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
		}),
	).toString("base64url");

	return `${header}.${payload}.signature`;
}

/** Creates the ExtensionAPI fake needed to observe session lifecycle hooks. */
function createExtensionApiFake(): ExtensionApiFake {
	const handlers: RegisteredHandler[] = [];

	return {
		handlers,
		on(eventName: string, handler: unknown): void {
			handlers.push({ eventName, handler });
		},
	} as ExtensionApiFake;
}

/** Creates the UI context fake needed to observe status, theme, and notification side effects. */
function createSessionContextFake(
	options: {
		readonly colorized?: boolean;
		readonly hasUI?: boolean;
		readonly accessToken?: string | null;
	} = {},
): SessionContextFake {
	const statuses: StatusUpdate[] = [];
	const notifications: Notification[] = [];
	const apiKeyRequests: string[] = [];
	const accessToken =
		options.accessToken === undefined
			? createCodexAccessToken("account-456")
			: options.accessToken;

	return {
		ctx: {
			...(options.hasUI !== undefined ? { hasUI: options.hasUI } : {}),
			modelRegistry: {
				async getApiKeyForProvider(
					provider: string,
				): Promise<string | undefined> {
					apiKeyRequests.push(provider);
					return accessToken ?? undefined;
				},
			},
			ui: {
				theme: {
					fg(color: string, text: string): string {
						return options.colorized ? `<${color}>${text}</${color}>` : text;
					},
				},
				setStatus(key: string, text: string | undefined): void {
					statuses.push({ key, text });
				},
				notify(message: string, type: string | undefined): void {
					notifications.push({ message, type });
				},
			},
		},
		statuses,
		notifications,
		apiKeyRequests,
	};
}

/** Runs a test with an isolated pi agent directory so config and auth reads never touch real user files. */
async function withIsolatedAgentDir<T>(
	action: (agentDir: string) => Promise<T>,
	options: { readonly writeDefaultEnabledConfig?: boolean } = {},
): Promise<T> {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const previousHome = process.env[HOME_ENV];
	const agentDir = await mkdtemp(join(tmpdir(), "pi-codex-quota-"));

	process.env[AGENT_DIR_ENV] = agentDir;
	process.env[HOME_ENV] = agentDir;
	try {
		if (options.writeDefaultEnabledConfig ?? true) {
			await writeQuotaConfig(agentDir, JSON.stringify({ enabled: true }));
		}

		return await action(agentDir);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env[AGENT_DIR_ENV];
		} else {
			process.env[AGENT_DIR_ENV] = previousAgentDir;
		}
		if (previousHome === undefined) {
			delete process.env[HOME_ENV];
		} else {
			process.env[HOME_ENV] = previousHome;
		}
		await rm(agentDir, { recursive: true, force: true });
	}
}

/** Runs a test with fake timer functions so quota polling never waits in real time. */
async function withFakeIntervals<T>(
	action: (
		intervals: IntervalRegistration[],
		cleared: ReturnType<typeof setInterval>[],
	) => Promise<T>,
): Promise<T> {
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	const intervals: IntervalRegistration[] = [];
	const cleared: ReturnType<typeof setInterval>[] = [];

	globalThis.setInterval = ((callback: () => void, intervalMs?: number) => {
		const id = { id: intervals.length + 1 } as unknown as ReturnType<
			typeof setInterval
		>;
		intervals.push({ callback, intervalMs: intervalMs ?? 0, id });
		return id;
	}) as typeof setInterval;
	globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
		cleared.push(id);
	}) as typeof clearInterval;

	try {
		return await action(intervals, cleared);
	} finally {
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	}
}

/** Runs a test with fake fetch so quota refresh never reaches the network. */
async function withFakeFetch<T>(
	fetchImpl: FetchFake,
	action: () => Promise<T>,
): Promise<T> {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl as typeof fetch;
	try {
		return await action();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

/** Creates a manually controlled promise for testing shutdown while fetch is pending. */
function createDeferred<T>(): Deferred<T> {
	let resolve: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});

	if (resolve === undefined) {
		throw new Error("failed to create deferred promise");
	}

	return { promise, resolve };
}

/** Returns one registered handler from the ExtensionAPI fake. */
function getHandler(pi: ExtensionApiFake, eventName: string): SessionHandler {
	const handler = pi.handlers.find(
		(registeredHandler) => registeredHandler.eventName === eventName,
	)?.handler;

	if (typeof handler !== "function") {
		throw new Error(`expected ${eventName} handler to be registered`);
	}

	return handler as SessionHandler;
}

/** Writes an isolated codex-quota config file with caller-provided JSON content. */
async function writeQuotaConfig(
	agentDir: string,
	content: string,
): Promise<void> {
	await mkdir(join(agentDir, "config"), { recursive: true });
	await writeFile(join(agentDir, "config", "codex-quota.json"), content);
}

/** Starts a quota session through the registered extension handler. */
async function startQuotaSession(
	pi: ExtensionApiFake,
	ctx: unknown,
): Promise<void> {
	await getHandler(pi, "session_start")(
		{ type: "session_start", reason: "startup" },
		ctx,
	);
}

/** Shuts down a quota session through the registered extension handler. */
async function shutdownQuotaSession(
	pi: ExtensionApiFake,
	ctx: unknown,
): Promise<void> {
	await getHandler(pi, "session_shutdown")(
		{ type: "session_shutdown", reason: "quit" },
		ctx,
	);
}

/** Returns the first interval or fails the test with a clear error. */
function requireFirstInterval(
	intervals: readonly IntervalRegistration[],
): IntervalRegistration {
	const firstInterval = intervals[0];
	if (firstInterval === undefined) {
		throw new Error("expected quota refresh interval to be registered");
	}

	return firstInterval;
}

/** Allows async timer callback work to finish after a fake interval fires. */
async function flushAsyncWork(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("codex-quota", () => {
	test("stays disabled without warnings when enabled is omitted", async () => {
		// Purpose: omitted config fields must use defaults instead of producing startup warnings.
		// Input and expected output: refreshInterval without enabled does not poll and reports no warning.
		// Edge case: a valid non-enabled field is present, so only enabled is omitted.
		// Dependencies: this test uses fake timers, fake fetch, and an isolated agent directory.
		await withIsolatedAgentDir(
			async (agentDir) => {
				await writeQuotaConfig(
					agentDir,
					JSON.stringify({ refreshInterval: 60 }),
				);
				await withFakeIntervals(async (intervals) => {
					let fetchCount = 0;
					await withFakeFetch(
						async () => {
							fetchCount += 1;
							return new Response(JSON.stringify({}), { status: 200 });
						},
						async () => {
							const pi = createExtensionApiFake();
							const session = createSessionContextFake();
							codexQuota(pi);

							await startQuotaSession(pi, session.ctx);

							expect(fetchCount).toBe(0);
							expect(intervals).toEqual([]);
							expect(session.statuses).toEqual([]);
							expect(session.notifications).toEqual([]);
						},
					);
				});
			},
			{ writeDefaultEnabledConfig: false },
		);
	});

	test("stays disabled when config file is missing", async () => {
		// Purpose: codex-quota is disabled by default and must not poll ChatGPT without an explicit enabled config.
		// Input and expected output: no codex-quota.json produces no status, fetch, interval, or warning.
		// Edge case: the session has UI and usable OAuth, so the only disablement source is missing config.
		// Dependencies: this test uses fake timers, fake fetch, and an isolated agent directory.
		await withIsolatedAgentDir(
			async () => {
				await withFakeIntervals(async (intervals) => {
					let fetchCount = 0;
					await withFakeFetch(
						async () => {
							fetchCount += 1;
							return new Response(JSON.stringify({}), { status: 200 });
						},
						async () => {
							const pi = createExtensionApiFake();
							const session = createSessionContextFake();
							codexQuota(pi);

							await startQuotaSession(pi, session.ctx);

							expect(fetchCount).toBe(0);
							expect(intervals).toEqual([]);
							expect(session.statuses).toEqual([]);
							expect(session.notifications).toEqual([]);
						},
					);
				});
			},
			{ writeDefaultEnabledConfig: false },
		);
	});

	test("uses pi openai-codex OAuth token for quota requests", async () => {
		// Purpose: quota refresh must use pi-managed openai-codex OAuth so expired tokens are refreshed by pi before the quota request.
		// Input and expected output: a fake pi access token with account ID sends bearer and chatgpt-account-id headers to the usage endpoint.
		// Edge case: no Codex CLI auth file exists, so the test proves the pi model registry is the auth source.
		// Dependencies: this test uses a temp agent directory, fake model registry, fake fetch, and fake intervals.
		await withIsolatedAgentDir(async () => {
			await withFakeIntervals(async () => {
				const accessToken = createCodexAccessToken("pi-account-123");
				const observedHeaders: Array<{
					authorization: string | null;
					accountId: string | null;
				}> = [];
				await withFakeFetch(
					async (_input, init) => {
						const headers = new Headers(init?.headers);
						observedHeaders.push({
							authorization: headers.get("authorization"),
							accountId: headers.get("chatgpt-account-id"),
						});
						return new Response(
							JSON.stringify({
								rate_limit: { primary_window: { used_percent: 10 } },
							}),
							{ status: 200 },
						);
					},
					async () => {
						const pi = createExtensionApiFake();
						const session = createSessionContextFake({ accessToken });
						codexQuota(pi);

						await startQuotaSession(pi, session.ctx);

						expect(session.apiKeyRequests).toEqual(["openai-codex"]);
						expect(observedHeaders).toEqual([
							{
								authorization: `Bearer ${accessToken}`,
								accountId: "pi-account-123",
							},
						]);
						expect(session.statuses.at(-1)).toEqual({
							key: "codex-quota",
							text: "90%",
						});
					},
				);
			});
		});
	});

	test("uses default refresh interval, refreshes quota with pi OAuth and fetch, and shuts down polling", async () => {
		// Purpose: session lifecycle must start quota polling, update the footer status, and clean up the timer.
		// Input and expected output: missing config, pi-managed Codex OAuth, and fake wham usage response produce plain healthy quota percentages with reset times.
		// Edge case: missing config must use the default refresh interval instead of reporting an issue.
		// Dependencies: this test uses only an in-memory ExtensionAPI fake, fake theme, fake model registry, fake fetch, and fake intervals.
		await withIsolatedAgentDir(async () => {
			await withFakeIntervals(async (intervals, cleared) => {
				const fetchCalls: Array<{
					url: string;
					authorization: string | null;
					accountId: string | null;
					userAgent: string | null;
				}> = [];
				await withFakeFetch(
					async (input, init) => {
						const headers = new Headers(init?.headers);
						fetchCalls.push({
							url: String(input),
							authorization: headers.get("authorization"),
							accountId: headers.get("chatgpt-account-id"),
							userAgent: headers.get("user-agent"),
						});
						return new Response(
							JSON.stringify({
								rate_limit: {
									primary_window: {
										used_percent: 9,
										reset_after_seconds: 14_400,
									},
									secondary_window: {
										used_percent: 0,
										reset_after_seconds: 518_400,
									},
								},
							}),
							{ status: 200 },
						);
					},
					async () => {
						const pi = createExtensionApiFake();
						const session = createSessionContextFake({ colorized: true });
						codexQuota(pi);

						await startQuotaSession(pi, session.ctx);

						expect(fetchCalls).toEqual([
							{
								url: "https://chatgpt.com/backend-api/wham/usage",
								authorization: `Bearer ${createCodexAccessToken("account-456")}`,
								accountId: "account-456",
								userAgent: "codex-cli",
							},
						]);
						expect(session.statuses).toEqual([
							{ key: "codex-quota", text: "<dim>CX …</dim>" },
							{
								key: "codex-quota",
								text: "91%/4h 100%/6d",
							},
						]);
						expect(session.notifications).toEqual([]);
						expect(intervals.map((interval) => interval.intervalMs)).toEqual([
							60_000,
						]);

						await shutdownQuotaSession(pi, session.ctx);

						expect(cleared).toEqual([requireFirstInterval(intervals).id]);
						expect(session.statuses.at(-1)).toEqual({
							key: "codex-quota",
							text: undefined,
						});
					},
				);
			});
		});
	});

	test("does not set quota status when UI is unavailable", async () => {
		// Purpose: non-interactive pi modes must not receive codex-quota status or notification UI calls.
		// Input and expected output: session_start with hasUI false records no statuses, notifications, or interval registrations.
		// Edge case: the UI object still has setStatus and notify, but hasUI is the authoritative mode signal.
		// Dependencies: this test uses temp agent files, fake intervals, and a session context fake.
		await withIsolatedAgentDir(async () => {
			await withFakeIntervals(async (intervals) => {
				const pi = createExtensionApiFake();
				const session = createSessionContextFake({ hasUI: false });
				codexQuota(pi);

				await startQuotaSession(pi, session.ctx);

				expect(session.statuses).toEqual([]);
				expect(session.notifications).toEqual([]);
				expect(intervals).toEqual([]);
			});
		});
	});

	test("uses default interval without notification when refreshInterval is missing", async () => {
		// Purpose: optional refreshInterval must not be treated as an invalid configuration.
		// Input and expected output: empty config object produces a 60-second interval and no warning.
		// Edge case: config file exists but contains no refreshInterval field.
		// Dependencies: this test uses temp config, fake model registry, fake fetch, and fake intervals.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeQuotaConfig(agentDir, JSON.stringify({ enabled: true }));

			await withFakeIntervals(async (intervals) => {
				await withFakeFetch(
					async () => new Response(JSON.stringify({}), { status: 200 }),
					async () => {
						const pi = createExtensionApiFake();
						const session = createSessionContextFake();
						codexQuota(pi);

						await startQuotaSession(pi, session.ctx);

						expect(intervals.map((interval) => interval.intervalMs)).toEqual([
							60_000,
						]);
						expect(session.notifications).toEqual([]);
					},
				);
			});
		});
	});

	test("accepts the minimum refresh interval from config", async () => {
		// Purpose: valid config must control the polling period without changing quota fetch behavior.
		// Input and expected output: refreshInterval 10 produces a 10-second interval and a status from fake usage percentage.
		// Edge case: 10 is the lowest accepted value.
		// Dependencies: this test uses only temp config, fake model registry, fake fetch, and fake intervals.
		await withIsolatedAgentDir(async (agentDir) => {
			await writeQuotaConfig(
				agentDir,
				JSON.stringify({ enabled: true, refreshInterval: 10 }),
			);

			await withFakeIntervals(async (intervals) => {
				await withFakeFetch(
					async () =>
						new Response(
							JSON.stringify({
								rate_limit: {
									primary_window: {
										used_percent: 25,
										reset_after_seconds: 600,
									},
								},
							}),
							{ status: 200 },
						),
					async () => {
						const pi = createExtensionApiFake();
						const session = createSessionContextFake();
						codexQuota(pi);

						await startQuotaSession(pi, session.ctx);

						expect(intervals.map((interval) => interval.intervalMs)).toEqual([
							10_000,
						]);
						expect(session.statuses.at(-1)).toEqual({
							key: "codex-quota",
							text: "75%/10m",
						});
					},
				);
			});
		});
	});

	test("colorizes remaining quota as normal, warning, and error thresholds", async () => {
		// Purpose: quota health colors must match the footer threshold contract without adding a quota label prefix.
		// Input and expected output: 70 remains plain, 30 remains warning, and 29 or 0 remain error.
		// Edge cases: exact boundary values 70, 30, 29, and 0 are covered.
		// Dependencies: this test uses fake model registry, fake fetch, fake theme, and fake intervals.
		const cases = [
			{ remainingPercent: 70, expectedText: "70%" },
			{ remainingPercent: 30, expectedText: "<warning>30%</warning>" },
			{ remainingPercent: 29, expectedText: "<error>29%</error>" },
			{ remainingPercent: 0, expectedText: "<error>0%</error>" },
		] as const;

		for (const { remainingPercent, expectedText } of cases) {
			await withIsolatedAgentDir(async () => {
				await withFakeIntervals(async () => {
					await withFakeFetch(
						async () =>
							new Response(
								JSON.stringify({
									rate_limit: {
										primary_window: {
											used_percent: 100 - remainingPercent,
										},
									},
								}),
								{ status: 200 },
							),
						async () => {
							const pi = createExtensionApiFake();
							const session = createSessionContextFake({ colorized: true });
							codexQuota(pi);

							await startQuotaSession(pi, session.ctx);

							expect(session.statuses.at(-1)).toEqual({
								key: "codex-quota",
								text: expectedText,
							});
						},
					);
				});
			});
		}
	});

	test("uses default interval and reports only codex-quota issues when config is invalid", async () => {
		// Purpose: malformed config must not block quota polling and must isolate diagnostics to codex-quota.
		// Input and expected output: unsupported key, invalid JSON, non-number, low number, and non-finite values produce warnings and 60-second intervals.
		// Edge cases: all invalid configuration cases listed in the extension README are covered.
		// Dependencies: this test uses temp config, fake model registry, fake fetch, and fake intervals.
		const invalidConfigs = [
			JSON.stringify({ enabled: true, "": 10, refreshInterval: 10 }),
			"{",
			JSON.stringify({ enabled: true, refreshInterval: "10" }),
			JSON.stringify({ enabled: true, refreshInterval: 9 }),
			'{"enabled":true,"refreshInterval":1e999}',
		];

		for (const configContent of invalidConfigs) {
			await withIsolatedAgentDir(async (agentDir) => {
				await writeQuotaConfig(agentDir, configContent);
				await withFakeIntervals(async (intervals) => {
					await withFakeFetch(
						async () => new Response(JSON.stringify({}), { status: 200 }),
						async () => {
							const pi = createExtensionApiFake();
							const session = createSessionContextFake();
							codexQuota(pi);

							await startQuotaSession(pi, session.ctx);

							expect(intervals.map((interval) => interval.intervalMs)).toEqual([
								60_000,
							]);
							expect(session.notifications).toHaveLength(1);
							expect(session.notifications[0]?.message).toStartWith(
								"[codex-quota]",
							);
							expect(session.notifications[0]?.type).toBe("warning");
						},
					);
				});
			});
		}
	});

	test("does not fetch quota when pi Codex OAuth is unavailable", async () => {
		// Purpose: missing pi OAuth must not break the footer or trigger an unauthenticated network request.
		// Input and expected output: no pi-managed openai-codex token produces an auth-unavailable status and zero fetch calls.
		// Edge case: the agent directory exists, but pi has no openai-codex OAuth token.
		// Dependencies: this test uses a temp agent directory, fake model registry, fake fetch, and fake intervals.
		await withIsolatedAgentDir(async () => {
			await withFakeIntervals(async () => {
				let fetchCallCount = 0;
				await withFakeFetch(
					async () => {
						fetchCallCount += 1;
						return new Response(JSON.stringify({}), { status: 200 });
					},
					async () => {
						const pi = createExtensionApiFake();
						const session = createSessionContextFake({ accessToken: null });
						codexQuota(pi);

						await startQuotaSession(pi, session.ctx);

						expect(session.apiKeyRequests).toEqual(["openai-codex"]);
						expect(fetchCallCount).toBe(0);
						expect(session.statuses.at(-1)).toEqual({
							key: "codex-quota",
							text: "CX auth",
						});
					},
				);
			});
		});
	});

	test("ignores Codex CLI fallback auth and uses pi Codex OAuth", async () => {
		// Purpose: quota auth must stay owned by pi OAuth instead of stale Codex CLI auth files.
		// Input and expected output: auth in .config/codex/auth.json is ignored, and the pi token sends bearer and account ID headers.
		// Edge case: a stale secondary Codex CLI auth file exists.
		// Dependencies: this test uses temp Codex CLI auth, fake model registry, fake fetch, and fake intervals.
		await withIsolatedAgentDir(async (agentDir) => {
			const authDir = join(agentDir, ".config", "codex");
			await mkdir(authDir, { recursive: true });
			await writeFile(
				join(authDir, "auth.json"),
				JSON.stringify({
					tokens: {
						access_token: "fallback-token",
						account_id: "fallback-account",
					},
				}),
			);

			await withFakeIntervals(async () => {
				const observedHeaders: Array<{
					authorization: string | null;
					accountId: string | null;
				}> = [];
				await withFakeFetch(
					async (_input, init) => {
						const headers = new Headers(init?.headers);
						observedHeaders.push({
							authorization: headers.get("authorization"),
							accountId: headers.get("chatgpt-account-id"),
						});
						return new Response(
							JSON.stringify({
								rate_limit: { primary_window: { used_percent: 10 } },
							}),
							{ status: 200 },
						);
					},
					async () => {
						const pi = createExtensionApiFake();
						const session = createSessionContextFake();
						codexQuota(pi);

						await startQuotaSession(pi, session.ctx);

						expect(session.apiKeyRequests).toEqual(["openai-codex"]);
						expect(observedHeaders).toEqual([
							{
								authorization: `Bearer ${createCodexAccessToken("account-456")}`,
								accountId: "account-456",
							},
						]);
					},
				);
			});
		});
	});

	test("does not fetch quota when pi Codex OAuth misses account id", async () => {
		// Purpose: the usage endpoint needs both access token and account ID, so partial auth must fail closed.
		// Input and expected output: pi token without account ID produces CX auth and zero fetch calls.
		// Edge case: the token is JWT-shaped but lacks the required ChatGPT account identifier.
		// Dependencies: this test uses fake model registry, fake fetch, and fake intervals.
		await withIsolatedAgentDir(async () => {
			await withFakeIntervals(async () => {
				let fetchCallCount = 0;
				await withFakeFetch(
					async () => {
						fetchCallCount += 1;
						return new Response(JSON.stringify({}), { status: 200 });
					},
					async () => {
						const pi = createExtensionApiFake();
						const tokenWithoutAccountId = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({})).toString("base64url")}.signature`;
						const session = createSessionContextFake({
							accessToken: tokenWithoutAccountId,
						});
						codexQuota(pi);

						await startQuotaSession(pi, session.ctx);

						expect(session.apiKeyRequests).toEqual(["openai-codex"]);
						expect(fetchCallCount).toBe(0);
						expect(session.statuses.at(-1)).toEqual({
							key: "codex-quota",
							text: "CX auth",
						});
					},
				);
			});
		});
	});

	test("performs later quota refreshes from the polling interval", async () => {
		// Purpose: the registered interval callback must refresh quota after the initial session-start refresh.
		// Input and expected output: two fake fetch responses update status from 1/10 to 2/10.
		// Edge case: interval callback uses the same session context without registering a second timer.
		// Dependencies: this test uses fake model registry, fake fetch, and fake intervals.
		await withIsolatedAgentDir(async () => {
			await withFakeIntervals(async (intervals) => {
				const usageResponses = [
					{ rate_limit: { primary_window: { used_percent: 1 } } },
					{ rate_limit: { primary_window: { used_percent: 2 } } },
				];
				await withFakeFetch(
					async () => {
						const nextResponse = usageResponses.shift();
						return new Response(JSON.stringify(nextResponse), { status: 200 });
					},
					async () => {
						const pi = createExtensionApiFake();
						const session = createSessionContextFake();
						codexQuota(pi);

						await startQuotaSession(pi, session.ctx);
						requireFirstInterval(intervals).callback();
						await flushAsyncWork();

						expect(session.statuses).toContainEqual({
							key: "codex-quota",
							text: "99%",
						});
						expect(session.statuses.at(-1)).toEqual({
							key: "codex-quota",
							text: "98%",
						});
						expect(intervals).toHaveLength(1);
					},
				);
			});
		});
	});

	test("renders compact unknown and error quota statuses", async () => {
		// Purpose: fallback status text must stay short when payload has no usable quota windows and when fetch fails.
		// Input and expected output: empty usage response produces CX ?, then interval fetch 503 produces CX err.
		// Edge case: a successful response with unknown shape is displayed as unknown quota data.
		// Dependencies: this test uses fake model registry, fake fetch, and fake intervals.
		await withIsolatedAgentDir(async () => {
			await withFakeIntervals(async (intervals) => {
				const responses = [
					new Response(JSON.stringify({}), { status: 200 }),
					new Response("server error", { status: 503 }),
				];
				await withFakeFetch(
					async () => {
						const response = responses.shift();
						if (response === undefined) {
							throw new Error("unexpected fetch call");
						}

						return response;
					},
					async () => {
						const pi = createExtensionApiFake();
						const session = createSessionContextFake();
						codexQuota(pi);

						await startQuotaSession(pi, session.ctx);
						requireFirstInterval(intervals).callback();
						await flushAsyncWork();

						expect(session.statuses).toContainEqual({
							key: "codex-quota",
							text: "CX ?",
						});
						expect(session.statuses.at(-1)).toEqual({
							key: "codex-quota",
							text: "CX err",
						});
					},
				);
			});
		});
	});

	test("does not write stale status after shutdown while initial refresh is still pending", async () => {
		// Purpose: shutdown must invalidate already-running async refresh work before it can restore a cleared footer status.
		// Input and expected output: delayed fetch resolves after shutdown, but no status is written after the clear and no interval is registered.
		// Edge case: session shuts down during the initial refresh, before the first timer is created.
		// Dependencies: this test uses fake model registry, fake fetch, fake intervals, and a deferred response.
		await withIsolatedAgentDir(async () => {
			await withFakeIntervals(async (intervals, cleared) => {
				const fetchEntered = createDeferred<void>();
				const fetchResponse = createDeferred<Response>();
				await withFakeFetch(
					async () => {
						fetchEntered.resolve(undefined);
						return await fetchResponse.promise;
					},
					async () => {
						const pi = createExtensionApiFake();
						const session = createSessionContextFake();
						codexQuota(pi);

						const startPromise = getHandler(pi, "session_start")(
							{ type: "session_start", reason: "startup" },
							session.ctx,
						);
						await fetchEntered.promise;
						await shutdownQuotaSession(pi, session.ctx);
						fetchResponse.resolve(
							new Response(
								JSON.stringify({
									rate_limit: { primary_window: { used_percent: 3 } },
								}),
								{ status: 200 },
							),
						);
						await startPromise;

						expect(session.statuses).toEqual([
							{ key: "codex-quota", text: "CX …" },
							{ key: "codex-quota", text: undefined },
						]);
						expect(intervals).toEqual([]);
						expect(cleared).toEqual([]);
					},
				);
			});
		});
	});
});
