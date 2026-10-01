# Problem statement

## Context

The package migration targets Pi 1.0.0 from Pi 0.99.2.

## Observed problem

Pi 1.0.0 removes the `uuidv7` export from `pi-agent-core`. The auxiliary LLM session ID generator imports that export, so auxiliary requests cannot generate session IDs.

## Evidence

- Type checking against Pi 1.0.0 reports a missing export in `pi-package/shared/auxiliary-llm-session.ts`.
- An isolated Pi 1.0.0 CLI loads the package but calling the generator throws `TypeError`.
- Pi 1.0.0 exports `uuidv7` from `pi-ai`.

## Impact

The missing export blocks type checking and auxiliary LLM requests, including advisor calls and compaction summaries.

## Desired state

Maintainers can validate the package and run auxiliary requests on Pi 1.0.0.

## Problem boundary

The problem concerns the Pi dependency contract and auxiliary session IDs. Adoption of new Pi features is outside the migration.

## Open questions

None.
