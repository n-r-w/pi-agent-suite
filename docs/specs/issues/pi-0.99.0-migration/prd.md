# Idea: Pi 0.99.0 migration

## Definitions

See [terms.md](terms.md).

## Context and problem

See [problem.md](problem.md).

## Goal

Validate and load the package on Pi 0.99.0 without adopting new Pi capabilities.

## Scenarios

- Maintainers install dependencies and run repository validation.
- Pi loads the package for the main agent and run-subagent children.

## Scope and non-scope

- Scope: Pi dependency pins, lock files, affected test fixtures, and isolated runtime validation.
- Non-scope: Enabling built-in MCP/codemode, changing llama.cpp loading, adopting the new OpenAI login, and modifying production extension behavior.

## Requirements

### Functional requirements

- [x] FRQ-01: The repository and published package SHALL pin all four host-provided packages to Pi 0.99.0.
  - Origin: source. The user approved O1-1, including F1.
  - Goal: Build and validate against the requested version.
  - Goal achievement: Partial. Establishes the target dependency contract.
- [x] FRQ-02: Tool execution and council startup fixtures SHALL satisfy Pi 0.99.0 types without changing their tested behavior.
  - Origin: source. The user approved O1-1, including F2.
  - Goal: Remove the four migration type errors.
  - Goal achievement: Partial. Restores type-check compatibility.

### Non-functional requirements

- [x] NRQ-01: Validation SHALL include `bun run verify` and isolated Pi 0.99.0 package loading for main-agent and run-subagent child modes.
  - Origin: source. O1-1 includes validation on 0.99.0 with isolated data.
  - Goal: Check compilation, behavior, linting, and package loading on the target version.
  - Goal achievement: Full. Exercises the migration result without real user state or model requests.

## Open questions

None.

## References

- [Pi 0.99.0 release notes](https://pi.dev/changelog/releases/0.99.0)
