# Problem statement

## Key definitions and abbreviations

See [terms](terms.md).

## Context

Pi Agent Suite declares Pi 1.4.0 in its development and published-package peer dependencies. The target host version is Pi 1.5.0.

## Observed problem

With Pi 1.5.0, TypeScript rejects five test renderer contexts because they lack the required `keyText` and `keyHint` functions.

## Affected audience

Maintainers validating the package and users loading it on Pi 1.5.0.

## Evidence

Before adapting the fixtures, `bun run typecheck` reports five errors across `test/support/tool-render-context.ts`, `pi-package/extensions/mcp-wrapper/index.test.ts`, and `pi-package/extensions/run-subagent/tool-rendering.test.ts`. The Pi 1.5.0 renderer interfaces require both functions.

## Impact

The incompatibility blocks the repository's type checks. The published package also declares the previous host version as its required peer version.

## Current state

The migration updates the dependency declarations and renderer fixtures. See [validation results](solution.md#validation-results).

## Desired state

Maintainers can validate the package against Pi 1.5.0, and the published package declares that host version.

## Problem boundary

The migration concerns host-version compatibility of the package, including main and child sessions.

## Assumptions

No unverified assumption is required for the isolated checks. Live provider and terminal-specific behavior remains outside their evidence.

## Open questions

None.
