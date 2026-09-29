# Technical solution: Pi 0.99.0 migration

## Problem statement

See [problem.md](problem.md).

## Proposed solution

### Dependency contract

Use `make pi-update PI_VERSION=0.99.0` to synchronize the four Pi development dependencies, published-package peer dependencies, and all three lock files. Keep the direct `typebox` dependency and TypeScript compiler version unchanged.

### Test fixtures

- Change the advisor tool context fixture to `ExtensionToolContext`. Supply an empty `tools` list and an `executeTool` fake that rejects unexpected nested calls.
- Supply the same new tool-context fields to the two MCP wrapper tool execution calls. Retain the pre-existing partial event-context fixture and type-check the added fields with `satisfies ExtensionToolContext`.
- Set `exposure: "direct"` on the council startup tool registry fixture.

These changes adapt fixture types. They do not change production behavior or add new behavior tests. The existing tests continue to cover advisor model selection, MCP routing and deferred activation, and council tool-policy resolution.

### Validation

- Run `bun run verify` against the installed target dependencies.
- Check that both package roots resolve the four Pi packages to 0.99.0.
- Use the local Pi 0.99.0 CLI with temporary state and a debug extension to inspect `before_agent_start.systemPrompt` and `pi.getActiveTools()` for main-agent and child loading.
- Keep all user-owned changes to `system.md` intact.

### Validation results

- `bun run verify` passes on Pi 0.99.0: 1609 behavior tests pass, one pre-existing overflow-compaction test is skipped, and TypeScript, Biome, Go tests, and Go vet pass.
- Both the repository root and `pi-package` resolve all four host-provided packages to 0.99.0. The local Pi CLI reports 0.99.0.
- Isolated offline loading of the complete package exits with code 0 in main-agent and child modes.
- A temporary debug extension reaches `before_agent_start` without a provider request. Main-agent active tools are `read`, `subagent_start`, `subagent_steer`, `subagent_wait`, and `subagent_query`. The child fixture's policy leaves only `read` active.
- Temporary runtime state and the debug extension are removed after inspection.

## Overengineering and overspecification considerations

The migration changes dependency pins and three test files. It introduces no production adapters, compiler suppressions, new feature switches, or compatibility layer for Pi 0.87.1.

## Open questions

None.

## References

- [Requirements](prd.md)
- [Pi 0.99.0 release notes](https://pi.dev/changelog/releases/0.99.0)
- `test/integration/runtime-package-loading.test.ts`: isolated main-agent and child loading fixtures.
