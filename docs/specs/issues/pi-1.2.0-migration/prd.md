# Idea: Pi 1.2.0 migration

## Definitions

See [terms](terms.md).

## Context and problem

See the [problem statement](problem.md).

## Goal

Run and validate Pi Agent Suite on Pi 1.2.0 while preserving its tested extension behavior.

## Scenarios

- A user loads the package or an individual extension in Pi.
- A user starts a run with a prompt or an extension-triggered custom message.
- A maintainer runs the repository checks against the target host version.

## Scope and non-scope

Scope includes Pi dependency declarations, lockfiles, the startup integration fixture, compatibility documentation, and package validation. Production behavior changes, releases, commits, and pushes are outside this migration.

## Requirements

### Functional requirements

- [X] FRQ-01: Development and published-package peer dependencies SHALL pin all four host-provided Pi packages to 1.2.0.
  - Origin: source. The maintainer approved exact Pi 1.2.0 dependency pins.
  - Goal: Align development and consumer host versions.
  - Goal achievement: Full. Both manifests declare the tested host version.
- [X] FRQ-02: The package SHALL preserve its tested extension behavior on Pi 1.2.0.
  - Origin: source. The maintainer requested migration and checks beyond the reported test failure.
  - Goal: Preserve extension use on the new host.
  - Goal achievement: Full within the exercised scenarios. Regression tests and isolated CLI runs provide the evidence.

### Non-functional requirements

- [X] NRQ-01: Validation SHALL include the full repository checks, isolated extension loading, and real CLI startup runs with a fake provider.
  - Origin: source. The maintainer approved isolated checks and their repetition in the repository.
  - Goal: Detect test, type, loading, and startup incompatibilities without real user state or LLM requests.
  - Goal achievement: Full within the isolated checks. External integrations remain unverified.

## Open questions

None.

## References

- [Pi 1.2.0 release notes](https://pi.dev/changelog/releases/1.2.0)
- [Technical solution](solution.md)
