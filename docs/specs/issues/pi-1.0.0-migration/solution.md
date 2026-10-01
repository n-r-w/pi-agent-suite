# Technical solution: Pi 1.0.0 migration

## Problem statement

See [problem.md](problem.md).

## Proposed solution

- Use the repository's `make pi-update PI_VERSION=1.0.0` target to synchronize both manifests and all three lock files.
- Import `uuidv7` from `pi-ai` in the shared auxiliary session ID generator. Retain all callers and the UUIDv7 format.
- Cover ID format and uniqueness with a shared unit test.
- State Pi 1.0.0 compatibility in the README.
- Keep the direct TypeScript and `typebox` dependencies unchanged.

### Validation

- Run `bun run verify`.
- Check that both package roots resolve all four host-provided packages to 1.0.0.
- Load the package and standalone run-subagent extension with the local Pi CLI and isolated temporary state.
- Inspect `before_agent_start.systemPrompt`, active tools, and auxiliary ID generation through a temporary debug extension before any provider request.
- Remove temporary runtime state and the debug extension after inspection.

### Validation results

- The UUIDv7 regression test fails before the import change and passes after the change.
- Both package roots resolve all four host-provided packages to 1.0.0.
- `bun run typecheck` and `bun run check` pass.
- `bun run verify` passes with temporary pi settings that explicitly set `steeringMode: "all"`: 1610 tests pass, one existing overflow-compaction test is skipped, and Go tests, type checking, Biome, formatting, and Go vet pass.
- Two workflow integration tests implicitly require `steeringMode: "all"`. With the default `"one-at-a-time"` mode, both fail on Pi 0.99.2 and 1.0.0. A separate settings check reproduces this difference without real user state. The migration leaves these tests and production queue behavior unchanged.
- Standalone run-subagent loading and complete-package main-agent and child loading exit with code 0.
- Runtime inspection finds 20 distinct registered tools. The main-agent fixture enables `read` and the four subagent tools; the child fixture enables only `read`.
- Auxiliary session ID generation succeeds in both CLI modes. No provider request is made.
- Temporary runtime state and the debug extension are removed after inspection.

## Overengineering and overspecification considerations

The migration changes one import and the dependency contract. It adds no compatibility layer, fallback, feature switch, or custom UUID implementation.

## Open questions

None.

## References

- [Requirements](prd.md)
- [Pi 1.0.0 release notes](https://pi.dev/changelog/releases/1.0.0)
