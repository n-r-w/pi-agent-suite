# Target picture

## Expected result
Users of the bundled template receive rules for the role of their Pi process. Main agents receive common rules and conversation rules. Child agents receive common rules and the instruction to report defects outside their task to their caller. A session with a custom prompt keeps the prompt that Pi builds, with both bundled and custom templates. Custom-prompt sources are CLI `--system-prompt` text or files, a trusted project's `.pi/SYSTEM.md`, and the Pi agent directory's `SYSTEM.md`. Runtime composition continues to reconcile active tools and append selected-agent and eligible tool prompt contributions.

The implementation follows `prd.md` and `solution.md`. Main-agent text changes only in the defect-reporting rule. Custom templates without section markers keep their rendered text in sessions without a custom prompt.

## Decision authority
The implementer chooses internal module structure, isolated test fixtures, and documentation wording within the specification. Each implementation decision is recorded in `decisions.md`.

The user retains decisions about dependencies, scope expansion, new backward-compatibility trade-offs, and fallback behavior beyond the approved solution. Unrelated defects are reported separately and require approval before investigation of a fix or modification.

## Task directory
Task documents belong in `docs/specs/features/system-prompt-agent-type`. Existing documents are the starting point and may be updated with research findings.

## Acceptance
- Behavior tests exercise logic with isolated fixtures, without checking bundled prompt content.
- Package test, typecheck, and check scripts pass.
- Real Pi runs inspect runtime system prompts and active tools using temporary state and a temporary debug extension.
- A one-time comparison checks that bundled main-agent text changes only in the specified defect-reporting rule.
- The user receives the implementation acceptance report after final validation under the `final_only` policy recorded in `decisions.md`.

## Open questions
None. QST-01 from `prd.md` was resolved during fact collection by real Pi checks of CLI, project, agent-directory, and council participant prompts. See `facts.md`. Post-implementation runtime probes remain acceptance checks.

## Confirmation
The user approved D1, D2, and D3 by selecting O2-1. The user subsequently approved the solution package and implementation by selecting O4-1; see `decisions.md`.
