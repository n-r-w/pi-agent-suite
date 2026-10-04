# Idea: Agent registry warnings

## Definitions

See [terms](terms.md).

## Context and problem

See [problem statement](problem.md).

## Goal

Explain unavailable agents without interrupting Pi startup.

## Scenarios

- A user starts Pi with malformed YAML in an agent definition.
- A definition contains an unsupported field or invalid metadata.
- Pi cannot read an agent file or registry directory.
- Project filenames share an NFC-normalized identity, for example `K.md` and `K.md`.

## Scope and non-scope

The shared agent registry and main-agent-selection warning output are in scope. User-owned agent files and unrelated extension configuration policies remain unchanged.

## Requirements

### Functional requirements

- [x] FRQ-01: When an agent definition cannot be parsed or validated, Pi shall warn the user with the file path and rejection reason.
  - Origin: source, user request to report suppressed agent errors.
  - Goal: explain missing agents.
  - Goal achievement: Full. The user can identify and repair the rejected definition.
- [x] FRQ-02: When registry discovery or file reading fails, or project filenames have an ambiguous identity, Pi shall report the affected paths and reason.
  - Origin: source, user request to expose similar suppressed information.
  - Goal: explain other unavailable agents.
  - Goal achievement: Full. Users can distinguish storage failures and filename collisions from metadata errors.

- [x] FRQ-03: Pi shall display each identical registry warning once per session, including when main-agent-selection and run-subagent load the registry together or separately.
  - Origin: source, user approved a shared reporter with per-session suppression of repeated warnings.
  - Goal: avoid repeated reports of the same failure.
  - Goal achievement: Full. Both extensions retain diagnostics while each distinct failure appears once.

### Non-functional requirements

- [x] NRQ-01: Registry warnings shall allow session startup and subsequent input to continue. Other readable definitions shall remain available.
  - Origin: source, user explicitly requires uninterrupted startup.
  - Goal: preserve access to Pi during diagnosis.
  - Goal achievement: Full. A broken definition affects its own availability while Pi remains usable.
- [x] NRQ-02: The implementation shall leave user-owned agent definitions unchanged.
  - Origin: source, user reserves the broken agent file for manual diagnosis.
  - Goal: preserve the diagnostic case.
  - Goal achievement: Full. The original file remains available to reproduce the warning.

## Open questions

None.
