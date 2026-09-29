# Idea: Reliable Pi Dependency Update

## Definitions

See `terms.md`.

## Context and Problem

See `problem.md`.

## Goal

Make `make pi-update PI_VERSION=<version>` synchronize every tracked Pi dependency boundary before repository validation.

## Scenarios

- A maintainer updates all four Pi packages from one exact version to another.
- A maintainer reviews generated manifest and lock-file changes before committing them.
- Repository validation runs against the same Pi version required by the published package.

## Scope and Non-Scope

In scope:

- Root Pi development dependencies.
- Published Pi peer dependencies.
- Root and `pi-package` Bun lock files.
- `pi-package/package-lock.json`.

Out of scope:

- Unrelated dependencies.
- Global Pi installations.
- Automatic package publication.

## Requirements

### Functional Requirements

- [X] FRQ-01: One target invocation shall set all four root Pi development dependencies to `PI_VERSION`.
  - Origin: source. The user requested the command to be corrected and rerun for `0.87.1`.
  - Goal: Keep the repository development environment on the requested version.
  - Goal achievement: Full. The root toolchain uses the requested Pi release.
- [X] FRQ-02: One target invocation shall set all four published Pi peer dependencies to `PI_VERSION`.
  - Origin: source. The reported defect is the retained `0.87.0` peer contract.
  - Goal: Keep the published contract aligned with repository validation.
  - Goal achievement: Full. Consumers and maintainers use the same declared Pi release.
- [X] FRQ-03: The target shall regenerate the tracked Bun and npm lock files after manifest synchronization.
  - Origin: formulated from the tracked dependency boundaries used by the repository.
  - Goal: Leave reproducible dependency metadata after the update.
  - Goal achievement: Full. No tracked lock file retains the previous Pi contract.
- [X] FRQ-04: The target shall run repository validation after dependency synchronization.
  - Origin: source. The existing command behavior includes full validation and must remain intact.
  - Goal: Detect incompatibility with the requested Pi release.
  - Goal achievement: Full. Validation evaluates the synchronized state.
- [X] FRQ-05: Repeating the target with the same `PI_VERSION` shall preserve the synchronized manifests and lock files.
  - Origin: formulated from the observed repeated-run behavior of Bun peer dependency installation.
  - Goal: Make dependency synchronization idempotent.
  - Goal achievement: Full. A retry or repeated update produces the same dependency contract.

### Non-Functional Requirements

- [X] NRQ-01: The behavior test shall use temporary fixtures and fake package-manager commands.
  - Origin: formulated from repository testing rules.
  - Goal: Verify update orchestration without changing user files or accessing registries.
  - Goal achievement: Full. The test is isolated and deterministic.

## Open Questions

None.

## Technical Supplement

None.

## References

- `Makefile`
- `docs/PUBLISHING.md`
