# Problem Statement

## Context

A developer uses Pi and `pi-agent-suite` in Git projects across multiple sessions. During work, the agent discovers information and makes decisions needed in later sessions.

## Problem Statement

A new session does not automatically receive knowledge discovered in previous sessions for the same project and branch. The developer must repeat it, transfer it manually to `AGENTS.md`, or accept repeated investigation and the risk of inconsistent decisions.

## Who Is Affected

One developer working with one logical remote Git repository through multiple sessions, clones, branches, and worktrees.

## Evidence

- The user regularly observes the problem while using Pi on real projects.
- The user identified three recurring effects: repeated investigation, decisions made without prior context, and manual maintenance of `AGENTS.md`.
- No extension registered in `package.json` or present under `extensions/` owns persistent cross-session knowledge.
- No quantitative measurements of lost time or tokens were provided.

## Impact

- Time and model context are spent repeating completed investigation.
- New decisions may contradict previously established constraints and rules.
- The developer must decide manually what to transfer between sessions.
- Unbounded accumulation can exhaust provider context.
- Frequent tactical updates can displace the project's strategic foundation.

## Reproduction Steps

1. Discover a significant project rule or make a project decision in one session.
2. End the session without manually copying that information into project instructions.
3. Start a new session in the same project and branch.
4. Request work that depends on the information.
5. Observe repeated investigation, a context request, or a decision that omits the information.

## Current State

Pi receives explicit instructions and context supplied by existing mechanisms. Information discovered by the agent does not automatically carry into a new session. The developer can update `AGENTS.md` manually but must select and maintain its contents.

## Desired Outcome

A new session uses previously discovered global project knowledge and local knowledge for its active branch without a manual reminder. Available knowledge remains bounded, preserves the strategic foundation, and retains applicable tactical information.

## Success Metrics

- In a repeated scenario, the new session's decision follows a predefined knowledge statement absent from the user request and `AGENTS.md`.
- A global test knowledge statement is applied in different branches of one project.
- A local test knowledge statement is applied in its branch and not applied in another branch.
- The knowledge presented to the model does not exceed the configured token limit.
- When applicable knowledge exists in both categories, the resulting set contains strategic and tactical sections.
- The scenario requires no `AGENTS.md` change or manual repetition of the knowledge.

## Scope

- Personal use by one developer.
- Logical remote Git repositories and their clones and worktrees.
- Global project knowledge and local knowledge for non-primary branches.
- Strategic and tactical semantic layers.
- Cross-session availability and bounded knowledge size.

## Out of Scope / Non-Goals

- Collaborative team editing of knowledge.
- Knowledge catalog synchronization between machines.
- Shared knowledge between a fork and its upstream repository.
- Repositories without a remote.
- Knowledge accumulation while working on the primary branch.
- Knowledge accumulation in detached HEAD state.
- Automatic changes to `AGENTS.md`.

## Constraints

- Global knowledge remains available from every project branch.
- Local knowledge is limited to one non-primary branch.
- Work on the primary branch is treated as an invalid accumulation scenario and ignored.
- In detached HEAD state, global knowledge is available, but no new knowledge accumulates.
- A fork has a separate project identity.
- The extension uses only the knowledge catalog available to the Pi environment in which it runs.
- The knowledge presented to the model has a configurable token limit.
- Project instructions, including `AGENTS.md`, remain a separate and immutable context source.

## Assumptions

- An LLM can extract and shorten knowledge without removing the statements required by the evaluation scenarios. Verification: evaluate consolidation using a test corpus built from user-provided real sessions.
- Clones of one remote repository can be mapped reliably to one project identity. Verification: test the selected identity mechanism with HTTPS, SSH, and multiple remotes.
- Knowledge supplied to the model influences decisions in the scenarios defined under Success Metrics. Verification: compare equivalent tasks in fresh sessions with and without the supplied knowledge.

## Open Questions

1. **High priority — requirements:** How is the token budget divided between strategic and tactical sections?
2. **High priority — requirements:** What happens when consolidation output still exceeds the limit after another compression attempt?
3. **High priority — identity:** How are HTTPS, SSH, and alternate remotes for one project mapped to one identity?
4. **Medium priority — lifecycle:** What happens to knowledge after a branch is renamed, merged, or deleted?
5. **Medium priority — triggers:** Which events initiate knowledge extraction and consolidation?

These questions do not change the problem statement or glossary. They must be resolved in the approved later phases.