# Idea: System prompt by kind of agent session

## Definitions
Use the definitions in [terms.md](terms.md).

## Context and Problem
[problem.md](problem.md). The real Pi observations in [facts.md](facts.md) resolve the original QST-01.

## Goal
Users receive rules appropriate to each agent's role and retain their own system prompts. Main agents report each discovered defect outside the task with enough information for the person to understand the behavior and proposed correction.

## Scenarios
1. A person runs a main agent with the bundled template.
2. A main agent delegates a task to a subagent.
3. An agent discovers a defect outside the task.
4. A session uses a custom prompt from CLI `--system-prompt`, a trusted project's `.pi/SYSTEM.md`, or the Pi agent directory's `SYSTEM.md`. Council participants supply their custom prompts through CLI.
5. A person uses a custom template.

## Scope and Non-Scope
In scope are the system-prompt extension, bundled template, and their documentation. The confirmed technical constraints and wording in `prd.md` remain applicable. Other bundled rules, user-authored template text, ask-llm, consult-advisor, unrelated defects, and dependency upgrades are outside scope.

## Requirements

### Functional Requirements
- [X] FRQ-01: A main-agent session using the bundled template without a custom prompt receives the common rules and conversation rules.
  - Origin: source. Confirmed target picture D1 and original FRQ-01.
  - Goal: retain conversation behavior for a person using the default package.
  - Goal achievement: Full. The main agent retains both rule groups.
  - Feasibility: Confirmed. The bundled template already supplies both groups.
- [X] FRQ-02: A subagent session using the bundled template without a custom prompt receives common rules and no conversation rules.
  - Origin: source. Confirmed target picture D1 and original FRQ-02.
  - Goal: give delegated agents rules appropriate to their role.
  - Goal achievement: Full. Rules for conversations with a person are absent from delegated sessions.
  - Feasibility: Confirmed. The package identifies its child processes at startup.
- [X] FRQ-03: The bundled template requires a subagent to report each defect outside its task separately to its caller, naming the file, triggering condition, and observed behavior. Reproducing the defect, designing a fix, and fixing it require caller approval.
  - Origin: source. Original FRQ-03 retained by D1.
  - Goal: pass discovered defects to the main agent.
  - Goal achievement: Partial. FRQ-04 governs the report to the person.
  - Feasibility: Confirmed. The instruction can be expressed for the delegated role.
- [X] FRQ-04: The bundled template requires the main agent to report each defect outside the task that it or another agent discovered, including pre-existing defects and defects without an effect on the task. In the first message ending its turn, it gives a separate finding with the initiating action, actual and expected behavior, file, triggering condition, proposed fix, and each unchecked fact. It takes facts from the named code. Reproduction, fix design, and modification require user approval.
  - Origin: source. Original FRQ-04 retained by D1.
  - Goal: let the person understand each discovered defect and decide whether to address it.
  - Goal achievement: Full. The finding includes the behavior, location, correction, and verification limits.
  - Feasibility: Confirmed. The instruction can be expressed in the main agent's conversation rules.
- [X] FRQ-05: For every session with a custom prompt, the extension preserves the prompt that Pi builds. This applies to bundled and custom templates, CLI text or files, trusted-project `.pi/SYSTEM.md`, agent-directory `SYSTEM.md`, and council participants. Active-tool reconciliation and selected-agent prompt contributions retain their existing behavior.
  - Origin: source. Original FRQ-05 and the preservation constraints in the confirmed solution.
  - Goal: retain the session author's prompt and existing tool behavior.
  - Goal achievement: Full. The extension leaves custom-prompt construction to Pi while preserving tool policy.
  - Feasibility: Confirmed. Pi exposes the selected custom prompt to extensions. Real runs show all sources reach that option.
- [X] FRQ-06: The extension documentation explains the custom-prompt exception and names CLI, trusted-project, and agent-directory sources.
  - Origin: source. Original FRQ-06 retained by D1.
  - Goal: explain when the configured template applies.
  - Goal achievement: Partial. Documentation explains FRQ-05 to users.
  - Feasibility: Confirmed. Existing extension documentation can describe these sources.

### Non-Functional Requirements
- [X] NRQ-01: For a main-agent session without a custom prompt, bundled-template output is byte-for-byte identical to the baseline except the FRQ-04 defect-reporting rule.
  - Origin: source. Original NRQ-01 and D1.
  - Goal: preserve the other rules existing users receive.
  - Goal achievement: Full. A one-time comparison can detect every unrelated text change.
  - Feasibility: Confirmed. The original bundled template is available for comparison.
- [X] NRQ-02: Custom templates without the new section markers render byte-for-byte as before in sessions without a custom prompt.
  - Origin: source. Original NRQ-02 and D2.
  - Goal: preserve user-authored template behavior.
  - Goal achievement: Full. Existing templates retain substitution behavior for both process kinds.
  - Feasibility: Confirmed. The existing substitution path can be retained for text common to both kinds.

## Open Questions
None. QST-01 is resolved in `facts.md`. Post-implementation runtime verification remains an acceptance check.

## Technical Supplement
The original `prd.md` specifies the mandatory block placement and exact defect-reporting text retained by D1. The original `solution.md` specifies section markers and invalid-template behavior. No additional implementation constraint is introduced here.

## References
- [target-picture.md](target-picture.md)
- [prd.md](prd.md)
- [facts.md](facts.md)
