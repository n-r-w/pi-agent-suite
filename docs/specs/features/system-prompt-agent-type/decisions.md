# Decisions

| ID | Decision | Authority and basis |
| --- | --- | --- |
| D1 | Implement the behavior specified in `prd.md` and `solution.md`. | User confirmed O2-1. |
| D2 | Choose internal code structure, isolated fixtures, and documentation wording within the specification. Preserve custom-template compatibility; retain user approval for dependencies, scope expansion, and new compatibility trade-offs. | User confirmed O2-1. |
| D3 | Keep task documents in `docs/specs/features/system-prompt-agent-type`. | User confirmed O2-1. |
| D4 | Rebase the feature branch onto local `main` without fetching or changing remote refs. | User selected O3-1. Rebase completed without conflicts at `a487bbc` on `7e88dc9`; the two untracked task documents were restored byte-for-byte. |
| D5 | Reuse the terms already defined in the confirmed specification and collect them in `terms.md`. | Within D2. The approved specification already names these concepts. No concept is renamed. |
| D6 | Preserve the tool-guideline formatting received from main and download only lockfile-declared dependency versions before implementation validation. | Within D1-D2; source facts FND-06. No dependency declaration or lockfile changes. |
| D7 | Treat a truthy `customPrompt` as Pi's custom-prompt condition. An empty string follows Pi and permits template rendering. | Within D2. Pi's section builder uses the same truthy condition. |
| D8 | Retain the original section design, classify with the shared child marker, and keep variable substitution after section selection. | Within D1-D2. Prevents runtime values from becoming template syntax; retains section-free template output. |
| D9 | Validate from the main process, or use a check subprocess with a copied environment omitting collector-owned `PI_SUBAGENT_*` and `PI_AGENT_SUITE_CHILD_AGENT_PROCESS` markers. Keep parent/session environment and HOME unchanged. | The user challenged the baseline failures. The main-process full scripts pass; the collector's controlled focused run also passes after omitting those markers. Earlier failure reports are superseded; F1 is withdrawn. |

## Alternatives
- D1: Implement the provided scope. Scope expansion and redesign of unrelated prompt rules were not selected.
- D2: Delegate internal implementation details within confirmed boundaries. Retaining each internal choice for user approval was not selected.
- D3: Use the supplied feature directory. No relocation or second task directory was selected.
- D4: Use existing local `main`. A `master` target was unavailable; fetching and remote-ref modification were not selected.
- D5: Retain original terms. Renaming existing concepts was not selected.
- D6: Preserve rebased behavior and use declared dependency versions. Reverting main's tool-guideline changes or altering dependency versions was not selected.
- D7: Follow Pi's truthy condition. Checking only whether the option is defined or trimming its text would differ from Pi and was not selected.
- D8: Use the specified sections and shared marker. Duplicating common rules in two templates, adding a general template engine, and interpreting runtime values as section syntax were not selected.
- D9: Correct the check execution context. Changing product code, changing assertions, or accepting a failing normal baseline was not selected.

## Stage checks
- Target picture: user confirmed D1-D3; transition passed after writing `target-picture.md`.
- Project baseline: commands and diagnostics recorded in `project-state.md`; transition passed without user confirmation as the workflow requires.
- Facts: each target condition has inspected source or runtime observations in `facts.md`; QST-01 resolved; transition passed without user confirmation.
- Problem: existing problem description retained, real-run observations added, QST-01 closed. No change to the confirmed target picture. Transition passed without user confirmation.
- Requirements: `requirements.md` retains FRQ-01 through FRQ-06 and NRQ-01 through NRQ-02, including the approved solution's tool-preservation constraints. Each requirement has a source, goal, feasibility basis, and acceptance condition. Transition passed without user confirmation.

- Technical solution: requirements mapped to methods, primary paths dry-run, direct custom-prompt correction traced to the handler boundary, and each element checked against scope and overengineering gates. Transition passed without user confirmation.
- Self-review: the required critic found no behavioral blocker and one stale question status in the target picture. The main agent verified and corrected it. `self-review.md` records the outcome. No approach, requirement, or target boundary changed. Transition passed without user confirmation.

## Checkpoint approval
The user selected O4-1 after the baseline correction. This confirms the problem, requirements, technical solution, and D1-D9, selects `final_only`, and authorizes planning and implementation with one local commit per unit and no push. No exception for failing normal-environment tests was requested or approved.

## Implementation decisions
- D10: Keep role-section grammar and selection together in the extension-local `sections.ts`; keep environment access in `environment.ts` using the existing shared classifier. This is within D2 and follows the approved design and small-module project rule. A general-purpose template engine, second common template, and new process marker were not introduced.
- The final marker-only line without a trailing newline is handled by the same line-span calculation. The case is reachable in a user template and is part of marker-only line semantics; it requires no extra abstraction or configuration.
- The longer README custom-prompt source list proposed during text review was rejected. The extension documentation already lists the sources, and the README retains the specified concise exception.

## Implementation checks
Both units passed RED-GREEN verification, project scripts, the required code/text/behavior reviews, and their runtime checks under `final_only`. `implementation-checks.md` records outcomes and separate findings F2/F3. The main agent's final `bun run verify` passed with 1862 tests, 1 existing skip, and 0 failures. No scope expansion or compatibility change was accepted during implementation.

## User-authorized follow-up
- D11: The user requested correction of F2 and F3 after the implementation acceptance report. This extends the task only to replacing the named bundled-content test with fixture logic and adding the missing README fence. The earlier exclusion of these two corrections is superseded. Other unrelated defects remain outside scope.
- The follow-up retains `final_only` and adds sequential UNT-03 and UNT-04 in `plan.md`. No production behavior, dependency, or feature requirement changes. F2 is resolved by an isolated template fixture with exact insertion-output verification. F3 is resolved by one closing-fence line. The already installed Markdown parser now produces two valid JSON blocks and the full-example paragraph between them. Both units passed the required reviews; final root verification after the last code/test edit had 1862 passing tests, 1 existing skip, and 0 failures.

- D12: The user identified the unchanged `Template example` in extension documentation. UNT-05 adds both role sections while retaining the shared runtime-variable example. This completes the documentation portion of the original feature; it adds no production behavior or new requirement. A complete copy of the bundled prompt and a permanent prompt-content test are unnecessary.

## Open questions
None requiring a user decision within the implementation scope.
