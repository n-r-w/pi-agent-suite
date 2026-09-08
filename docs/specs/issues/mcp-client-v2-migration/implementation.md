# MCP client v2 migration verification

## Implementation

Both manifests declare `@modelcontextprotocol/client@^2.0.0`. All three tracked lockfiles resolve client version `2.0.0`. The adapter imports `Client` and `StreamableHTTPClientTransport` from the package root and `StdioClientTransport` from its `/stdio` export.

The [SDK migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html) identifies the changed call signature and list aggregation behavior. The adapter passes request options as the second `callTool` argument. Its constructor assignment no longer uses an `unknown` cast. Tests exercise real SDK pagination through `McpClientManager`, including an explicit cursor request, without duplicate tools.

SCN-01 tests cover both transports, request option forwarding, argument and environment configuration, working directory, HTTP headers, result mapping, protocol and tool errors, cancellation, timeout, and closure. Stdio uses a local child fixture. Streamable HTTP uses the real transport with fake fetch responses. No live MCP service or provider is needed.

Release preparation runs validation and SCN-02 and SCN-03 before `npm version`. Consumer checks build npm archives in temporary staging directories and use Pi's `--legacy-peer-deps` installation policy. The upgrade fixture retains the vulnerable transitive version in its lockfile without a direct `qs` dependency or override.

The npm production lockfile and both consumer trees exclude SDK v1 and its Express chain. Bun lockfiles retain SDK v1 through the host's optional `@google/genai` peer. Root overrides still apply to that locked development tree, so this migration does not make those overrides obsolete.

## Verification results

Checks ran on 2026-09-06 with Node.js `25.8.2`, npm `11.11.1`, Bun `1.2.18`, and repository-local Pi `0.85.1`.

| Check | Exit code | Result |
| --- | --- | --- |
| Adapter regression before implementation | 1 | Both transport cases failed because call options were undefined. |
| Release preparation tests before implementation | 1 | Seven assertions failed against the compile-only stub. |
| `bun run test ./pi-package/extensions/mcp-wrapper ./scripts` | 0 | 105 passed, 0 failed. |
| `bun run verify` | 0 | 1439 passed, 1 pre-existing skip, 0 failed; type and formatting checks passed. |
| `make audit` | 0 | 0 vulnerabilities. |
| `make release-check` | 0 | Full validation, both consumer scenarios, and both isolated Pi loads passed. |
| SCN-03 baseline audit | 1 | Installed and locked `qs@6.15.3`; 1 moderate vulnerability. |
| SCN-02 and SCN-03 candidate audits | 0 each | 0 vulnerabilities at the low-severity threshold. |
| SCN-03 with the published v1-based `2.8.0` archive as candidate | 1 | Consumer audit rejected the retained vulnerability. |

The skipped test is `overflow compaction retries after passive context restoration`. No new tests were skipped.

Both consumer loads used `--no-session --no-extensions --offline -p -e <installed-package>` with temporary project and agent state. No prompt was passed. No consumer fixture directories remained after successful checks and the rejected v1 candidate check.

The package version remains `2.8.0`. No release was published and no commit or tag was created. Registry advisories can change; these results describe the checks on the stated date.
