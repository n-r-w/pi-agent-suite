# Technical solution: Pi 1.5.0 migration

## Problem statement

See the [problem statement](problem.md).

## Proposed solution

Use the `pi-update` target in `Makefile` to synchronize the four Pi packages in both manifests and regenerate `bun.lock`, `pi-package/bun.lock`, and `pi-package/package-lock.json` for Pi 1.5.0.

Supply Pi's `keyText` and `keyHint` functions in the existing test renderer contexts. Reuse Pi's implementations for formatting keybinding hints. Existing rendering tests retain their configured-keybinding assertions. Production renderer implementations remain unchanged because the host supplies those functions.

Keep TypeBox schemas. Pi 1.5.0 accepts their JSON Schema representation through `pi-schema`. The package does not use the unsupported TypeBox-only features listed in the release notes, such as `Type.Refine()` and `Type.BigInt()`.

Update the supported version in the README and OpenAI WebSocket extension documentation. Historical measurements and earlier migration documents retain their original version references.

## Overengineering and overspecification considerations

The migration uses the existing dependency update command and renderer fixtures. It adds no compatibility layer, runtime fallback, or production dependency beyond Pi's updated dependency tree.

## Validation results

Before the fixture changes, `bun run typecheck` with Pi 1.5.0 reports five errors for missing renderer hint functions.

After the changes, `bun run verify` with the local Pi 1.5.0 CLI selected for child processes passes 2064 tests, skips one test, and reports zero failures. Go tests, strict TypeScript checks, Biome checks of 478 files, formatting checks, and Go vet also pass. The skipped test is `overflow compaction retries after passive context restoration`.

The initial `make pi-update PI_VERSION=1.5.0` invocation completed dependency synchronization but exceeded its command timeout during validation. A subsequent complete `bun run verify` succeeded.

Separate Pi 1.5.0 CLI runs load the complete package and standalone `run-subagent` extension with exit code 0 and no diagnostics. A temporary debug extension captures `before_agent_start.systemPrompt` and active tools before a fake-provider request. Both main and child modes register 20 tools; the restricted child exposes only `read`. The probe exits before any network request and removes its temporary state.

## Open questions

None. The isolated checks do not establish live provider or terminal-specific compatibility.

## References

- [Critical requirements](prd.md)
- [Pi 1.5.0 release notes](https://github.com/earendil-works/pi/releases/tag/v1.5.0)
