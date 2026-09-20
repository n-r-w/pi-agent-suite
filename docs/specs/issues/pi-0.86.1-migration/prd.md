# Idea: Migration to Pi 0.86.1

## Definitions

Domain terms are defined in `terms.md`.

## Context and Problem

The problem is defined in `problem.md`.

## Goal

Migrate the repository from Pi 0.85.1 to Pi 0.86.1 without changing repository extension functional capabilities or observable behavior.

## Scenarios

- Repository maintainers identify compatibility issues caused by Pi 0.86.1.
- Repository maintainers update the repository to use Pi 0.86.1.
- Repository maintainers compare extension behavior before and after the migration.
- Repository maintainers stop work on an affected area when preserving its behavior is not possible.

## Scope and Non-Scope

In scope:

- Migration of the repository to Pi 0.86.1.
- Evaluation of preliminary findings in `analysis.md`.
- Identification of compatibility issues omitted from the preliminary analysis.
- Preservation of repository extension functional capabilities and observable behavior.

Out of scope:

- Compatibility with Pi 0.85.1 after the migration.
- New functional capabilities.
- Intentional changes to observable behavior.

## Requirements

### Functional Requirements

- [X] FRQ-01: The repository SHALL target Pi 0.86.1.
  - Origin: source. The user requested migration to Pi 0.86.1.
  - Goal: Define one target runtime version.
  - Goal achievement: Full. The requirement identifies the migration target.
- [X] FRQ-02: The migrated repository SHALL NOT support Pi 0.85.1.
  - Origin: source. The user rejected backward compatibility.
  - Goal: Exclude a compatibility layer from the migration.
  - Goal achievement: Partial. The requirement limits migration scope but does not complete the migration.
- [X] FRQ-03: The migration SHALL preserve repository extension functional capabilities and observable behavior.
  - Origin: source. The user prohibited functional changes.
  - Goal: Complete the migration without product behavior changes.
  - Goal achievement: Full. The requirement defines the required migration outcome.

### Non-Functional Requirements

- [X] NRQ-01: Each preliminary finding in `analysis.md` SHALL be evaluated against Pi 0.86.1 contracts and repository evidence before it is included in the technical solution.
  - Origin: source. The user stated that preliminary findings are not confirmed facts.
  - Goal: Prevent unverified claims from determining the migration design.
  - Goal achievement: Partial. The requirement evaluates known findings but does not identify omitted compatibility issues.
- [X] NRQ-02: Compatibility evaluation SHALL cover documented breaking changes from versions after Pi 0.85.1 through Pi 0.86.1 and build, typecheck, test, and runtime failures observed with Pi 0.86.1.
  - Origin: formulated. This requirement makes the user's concern about omitted findings observable and bounded.
  - Goal: Identify material compatibility issues omitted from `analysis.md`.
  - Goal achievement: Full. The requirement defines the evidence sources used to detect omitted issues.
- [X] NRQ-03: When a compatibility issue prevents preservation of a functional capability or observable behavior, design work for that affected area SHALL stop until the issue is recorded as a blocker and the user decides how to proceed.
  - Origin: source. The user required separate and careful resolution when behavior preservation is impossible.
  - Goal: Prevent an unapproved functional change.
  - Goal achievement: Full. The requirement defines the mandatory response to a conflict with FRQ-03.

## Open Questions

None.

## References

- `analysis.md`
- `problem.md`
- `terms.md`
