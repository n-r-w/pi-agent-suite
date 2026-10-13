# Pi 1.2.0 migration implementation

## Changes

- Both package manifests pin `pi-agent-core`, `pi-ai`, `pi-coding-agent`, and `pi-tui` from `@earendil-works` to 1.2.0. The existing update target regenerated all three lockfiles.
- Three calls in `test/integration/main-agent-startup-barrier.test.ts` now pass a user trigger object and system-prompt options to `emitBeforeAgentStart`. For example, the first call uses `{ messageType: "user", prompt: "first input" }` as its trigger.
- The test assertions and production extension code remain unchanged.
- The README names Pi 1.2.0 as the supported host version, and the roadmap includes this migration.

## Validation

The repository run of `make pi-update PI_VERSION=1.2.0` completed successfully.

| Check | Result |
| --- | --- |
| `bun run test`, invoked by `bun run verify` | 1693 Bun tests passed, one skipped, zero failed; Go tests passed. |
| `bun run typecheck`, invoked by `bun run verify` | Strict TypeScript checks passed. |
| `bun run check`, invoked by `bun run verify` | Biome, gofmt, and Go vet checks passed. |
| `./node_modules/.bin/pi --version` | `1.2.0` |
| Isolated CLI loading | The whole package and all 26 individual extension entries exited successfully without stderr output. |
| Real CLI RPC startup | User and custom-message runs each reached the fake provider without stderr output. |
| `git diff --check` | Passed. |

CLI loading used `--no-session`, `--no-extensions`, `--offline`, and print mode without a prompt. Startup probes used RPC mode with an in-process fake provider and no offline flag. All probes used temporary working directories and separate Pi and Agent Suite state, with native MCP discovery disabled.

The temporary debug extension recorded `before_agent_start.systemPrompt` and `pi.getActiveTools()` for both startup variants. Both variants had `ctx.isIdle() === false`, a populated system prompt, and the same active tools; the fake provider received two requests. The debug extension and runtime state were removed after the check.

## Requirement evidence

- FRQ-01: Both package manifests and all three lockfiles contain Pi 1.2.0 pins; the local CLI reports 1.2.0.
- FRQ-02: The full regression suite, extension-loading probes, and user/custom startup probes passed.
- NRQ-01: The checks used isolated state and a fake provider without LLM network requests.

## Remaining limits

The existing `overflow compaction retries after passive context restoration` test remains skipped. The migration adds no skip, suppression, or runtime workaround. Live LLM providers, clipboard integration, remote systems, and terminal-specific rendering were not exercised.
