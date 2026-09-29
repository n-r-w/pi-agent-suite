# Technical Solution: Synchronize Pi Update Boundaries

## Problem Statement

See `problem.md`.

## Proposed Solution

The `pi-update` target keeps the existing registry checks and root `bun add --dev --exact` operation.

The target uses `npm pkg set` to update the four exact peer versions in `pi-package/package.json`. It then deletes the nested Bun lock and runs `bun install`. The generated lock contains the package's own dependencies, while the Pi host packages remain peer dependencies supplied by the consumer.

The target then runs `npm install --package-lock-only --ignore-scripts --legacy-peer-deps` in `pi-package`. This command updates `pi-package/package-lock.json` without installing a second dependency tree, installing host peer dependencies, or executing dependency scripts.

A behavior test runs the Makefile target twice in a temporary repository. Fake `npm`, `bun`, and `pi` executables verify idempotent command orchestration and manifest results without registry or installation access.

## Overengineering and Overspecification Considerations

The solution uses package-manager operations already present in the repository. It adds no synchronization service or custom manifest editor. The test covers the observable defect through the public Makefile target.

## Open Questions

None.

## References

- `Makefile` - Pi dependency update target.
- `scripts/pi-update.test.ts` - Isolated behavior test.
