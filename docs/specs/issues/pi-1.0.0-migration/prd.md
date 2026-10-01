# Idea: Pi 1.0.0 migration

## Definitions

See [terms.md](terms.md).

## Context and problem

See [problem.md](problem.md).

## Goal

Run and validate the package on Pi 1.0.0.

## Scenarios

- Maintainers install dependencies and validate the repository.
- Main-agent and child processes load the package.
- Auxiliary LLM requests create distinct session IDs.

## Scope and non-scope

- Scope: Pi dependency pins, lock files, auxiliary session IDs, compatibility documentation, and isolated runtime checks.
- Non-scope: New Pi features and changes to agent policies or tool schemas.

## Requirements

### Functional requirements

- [x] FRQ-01: Repository dependencies and published-package peer dependencies SHALL pin all four host-provided packages to 1.0.0.
  - Origin: source. The user requested adaptation to the new version.
  - Goal: Establish the target dependency contract.
  - Goal achievement: Partial. Aligns installation and runtime dependencies.
- [x] FRQ-02: Each auxiliary LLM request SHALL receive a distinct UUIDv7 on Pi 1.0.0.
  - Origin: source. The requested adaptation covers the observed generator failure.
  - Goal: Preserve auxiliary request identity.
  - Goal achievement: Partial. Removes the runtime incompatibility.

### Non-functional requirements

- [x] NRQ-01: Validation SHALL include repository tests, strict type checking, linting, and isolated Pi 1.0.0 CLI checks without real provider requests.
  - Origin: source. Project validation rules and the user's compatibility-check request.
  - Goal: Check the migration without real user state or credentials.
  - Goal achievement: Full. Exercises the dependency contract and runtime behavior.

## Open questions

None.

## References

- [Pi 1.0.0 release notes](https://pi.dev/changelog/releases/1.0.0)
