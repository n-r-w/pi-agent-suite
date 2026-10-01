# Idea: Codex quota test isolation

## Definitions

See [terms.md](terms.md).

## Context and problem

See [problem.md](problem.md).

## Goal

Isolate quota tests without changing `HOME` or creating unused authentication files.

## Scenarios

- Quota tests read temporary configuration.
- Quota tests obtain credentials from a fake pi model registry.

## Scope and non-scope

- Scope: The quota test helper, the unused Codex CLI auth fixture, and credential-source documentation.
- Non-scope: Production authorization behavior and other extensions.

## Requirements

### Functional requirements

- [x] FRQ-01: Quota tests SHALL leave `HOME` unchanged and use temporary pi configuration.
  - Origin: source. The user requested removal of the HOME substitution.
  - Goal: Isolate configuration without changing unrelated path resolution.
  - Goal achievement: Partial. Removes process-wide home redirection.
- [x] FRQ-02: The credential test SHALL use fake model-registry credentials without creating `.config/codex/auth.json`.
  - Origin: source. The user requested removal of the unused file.
  - Goal: Keep the test fixture aligned with the credential source.
  - Goal achievement: Partial. Removes unused authentication state.

### Non-functional requirements

- [x] NRQ-01: All 23 quota tests SHALL pass without real user files, credentials, or network requests.
  - Origin: source. Project testing rules.
  - Goal: Preserve quota behavior checks with isolated fixtures.
  - Goal achievement: Full. Checks the revised isolation and credential fixtures.

## Open questions

None.
