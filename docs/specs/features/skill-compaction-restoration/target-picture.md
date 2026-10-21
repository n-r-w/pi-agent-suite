# Target picture

## Outcome

After compaction, the main agent and subagents receive the skill files they loaded before compaction. Restoration survives repeated compaction and reopening a session. Files fit within the available context budget; the model receives a list of files that did not fit.

The implementation follows `problem.md`, `prd.md`, `solution.md`, and `terms.md` in this directory. Its scope includes the `skill-restoration` extension, shared skill path handling, model-aware compaction settings, extension order, system prompt guidelines, tests, and extension documentation.

## Decision authority

The agent decides implementation details within the specification and records decisions in `decisions.md`.

The user retains decisions about scope changes, dependency changes, backward compatibility, and departures from the agreed behavior. No remote refs will change.

## Task directory

Task documents belong in `docs/specs/features/skill-compaction-restoration`.

## Acceptance

Behavior tests use Bun and isolated fixtures. Tests check logic only, with no assertions about prompt content. Validation includes package tests, strict type checks, lint and formatting checks, and isolated real Pi loading and runtime checks where unit tests cannot prove integration.

## Approval

The user confirmed the outcome, decision boundaries, and task directory with `O1-1`.

## Open questions

None.
