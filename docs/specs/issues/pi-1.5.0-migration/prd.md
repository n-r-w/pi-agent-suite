# Idea: Pi 1.5.0 migration

## Definitions

See [terms](terms.md).

## Context and problem

See the [problem statement](problem.md).

## Goal

Run and validate Pi Agent Suite on Pi 1.5.0 while preserving its tested extension behavior.

## Affected scenarios

Users load extensions in main and child sessions. Maintainers run repository checks against the supported Pi version.

## Scope and non-scope

Scope includes the Pi dependency declarations, lockfiles, test renderer contexts, compatibility documentation, and isolated validation. Changes to production extension behavior, the user-level Pi installation, releases, commits, and pushes are outside this migration.

## Requirements

### Functional requirements

- [X] FRQ-01: Both manifests SHALL pin the four host-provided Pi packages to 1.5.0, and their lockfiles SHALL agree with those declarations.
  - Origin: Pi 1.5.0 migration and the dependency declarations in both manifests.
  - Goal: Align development and published-package host requirements.
  - Goal achievement: Full when both installations resolve Pi 1.5.0.
- [X] FRQ-02: Test renderer contexts SHALL satisfy Pi 1.5.0's public renderer interfaces while preserving the tested rendering behavior.
  - Origin: Pi 1.5.0's renderer interfaces and the five reproduced TypeScript errors.
  - Goal: Restore type checks without changing production rendering.
  - Goal achievement: Full when type checks and rendering tests pass.

### Non-functional requirements

- [X] NRQ-01: Validation SHALL include `bun run verify` and isolated real CLI checks using Pi 1.5.0, temporary agent state, and a fake provider.
  - Origin: project validation rules.
  - Goal: Check compatibility without real credentials or LLM requests.
  - Goal achievement: Full within the exercised scenarios.

## Critical scenarios

- SCN-01: A maintainer runs `bun run verify` with the repository's Pi 1.5.0 CLI available to child processes. Behavior tests, type checks, and lint checks pass. Covers FRQ-01, FRQ-02, and NRQ-01.
- SCN-02: A user loads the complete package and standalone `run-subagent` extension in isolated CLI sessions. Pi reports no extension loading errors. Covers FRQ-01 and NRQ-01.
- SCN-03: A debug extension captures the system prompt and active tools before a fake-provider request in main and child modes. The child retains its tool restriction. Covers FRQ-01 and NRQ-01.

## Open questions

None.

## References

- [Technical solution](solution.md)
- [Pi 1.5.0 release notes](https://github.com/earendil-works/pi/releases/tag/v1.5.0)
