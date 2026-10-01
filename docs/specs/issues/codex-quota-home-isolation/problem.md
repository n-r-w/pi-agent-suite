# Problem statement

## Context

Codex quota tests use temporary configuration and fake authorization and network dependencies.

## Observed problem

The test helper replaces `HOME` for the entire test process, although quota configuration uses `PI_CODING_AGENT_DIR` and authorization uses the model registry.

## Evidence

- `withIsolatedAgentDir` in `test/extensions/codex-quota/index.test.ts` changes and restores `HOME`.
- `readCodexAuth` obtains the token through `modelRegistry.getApiKeyForProvider`.
- All 23 tests pass in an isolated copy after removing the `HOME` writes.

## Impact

Other code in the test process can resolve its home paths to the temporary quota directory. The test file violates the project's prohibition on changing `HOME`.

## Desired state

Quota tests isolate their configuration and credentials without changing the process's home directory setting.

## Problem boundary

The problem concerns quota test isolation and its unused Codex CLI auth fixture.

## Open questions

None.
