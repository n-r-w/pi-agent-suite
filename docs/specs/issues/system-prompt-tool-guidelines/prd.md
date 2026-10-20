# Idea: Active Tool Guideline Delivery

## Definitions
See [terms.md](terms.md).

## Context and Problem
See [problem.md](problem.md).

## Goal
Deliver active tools' shared guidance to the model through the system-prompt template.

## Scenarios
- Several active tools contribute common guidance.
- Inactive or hidden tools retain guideline metadata.
- Extensions supply global guidance alongside per-tool guidance.

## Scope and Non-Scope
Scope: the common formatter, synthetic regressions, isolated package-loading checks, and documentation.

Outside scope: workflow implementation, template syntax, individual descriptions, registration, schemas, dependencies, and lint suppressions.

## Requirements

### Functional Requirements
- [X] FRQ-01: When rendering `{{toolGuidelines}}`, the formatter shall include per-tool guidelines in active-tool order, excluding hidden tools, followed by global guidelines.
  - Origin: source. The approved bugfix addresses missing shared guidance from active tools, as described in [problem.md](problem.md), Observed Problem.
  - Goal: Deliver active tools' shared guidance to the model.
  - Goal achievement: Full. The formatter includes every active, visible tool's contributions before global guidance.
  - Feasibility: Confirmed. Pi supplies tool selection, visibility, and both kinds of guidance to the extension before prompt rendering.
- [X] FRQ-02: When contributions contain surrounding whitespace, empty strings, or normalized duplicates, the formatter shall trim them, omit empty results, and render the first occurrence of each remaining value as one bullet.
  - Origin: formulated. Several active tools can supply the same shared guidance, as described in Scenarios.
  - Goal: Deliver shared guidance once for each nonempty normalized contribution.
  - Goal achievement: Full. Normalization and first-occurrence deduplication retain one copy in contribution order.
  - Feasibility: Confirmed. The formatter already normalizes and deduplicates global contributions; it can apply the same rule to the combined contributions.
- [X] FRQ-03: When a tool is inactive, the formatter shall exclude its per-tool contributions while retaining global contributions.
  - Origin: formulated. Pi retains guideline metadata for tools outside the active selection, as described in [problem.md](problem.md), Current State.
  - Goal: Restrict per-tool guidance to tools available to the agent.
  - Goal achievement: Full. Inactive tools contribute no guidance, while global guidance remains independent of tool selection.
  - Feasibility: Confirmed. The extension receives active tool names separately from guideline metadata.

### Non-Functional Requirements
- [X] NRQ-01: Regression tests shall reproduce missing active-tool contributions before the production fix and check synthetic data rather than production prompt prose.
  - Origin: source. The project testing rules require RED-GREEN-REFACTOR and prohibit tests of prompt content.
  - Goal: Check guideline-delivery logic independently of production wording.
  - Goal achievement: Partial. Synthetic contributions expose formatter omissions; isolated runtime checks cover package delivery.
  - Feasibility: Confirmed. Isolated templates and fake tool metadata let tests exercise selection and normalization with synthetic markers.
- [X] NRQ-02: Isolated real-Pi package runs shall demonstrate configured workflow markers in `before_agent_start.systemPrompt` and tool availability through `getActiveTools()`, without real provider, network, or authentication access.
  - Origin: source. The project validation rules require real-Pi checks of live prompt and tool availability with temporary state and a debug extension.
  - Goal: Check that shared guidance reaches the model-facing package prompt.
  - Goal achievement: Full. Runtime checks observe the assembled prompt and active tools in both main-agent and child modes.
  - Feasibility: Confirmed. Pi supports isolated state, a fake provider, and lifecycle hooks that capture runtime data and exit before a provider request.
- [X] NRQ-03: The change shall pass `bun run verify` and preserve template syntax and individual tool-description contracts.
  - Origin: source. The project validation rules require package validation; the approved bugfix is limited to shared-guideline delivery.
  - Goal: Deliver shared guidance while preserving template use and individual tool descriptions.
  - Goal achievement: Partial. Validation checks regressions; the functional requirements define the guideline-delivery result.
  - Feasibility: Confirmed. Shared-guideline formatting is separate from template-variable parsing and provider tool-description delivery.

## Open Questions
None.

## Technical Supplement
Pi supplies per-tool guidelines through `options.toolGuidelines` and global guidelines through `options.promptGuidelines`. The formatter reads the active selection after runtime policy reconciliation.

For example, active tools `beta` and `alpha` contribute `[" BETA_MARKER ", "SHARED_MARKER"]` and `["ALPHA_MARKER", " SHARED_MARKER "]`. Global contributions `["SHARED_MARKER", " GLOBAL_MARKER ", ""]` produce bullets in this order: `BETA_MARKER`, `SHARED_MARKER`, `ALPHA_MARKER`, `GLOBAL_MARKER`. If `alpha` is inactive or hidden, the formatter omits `ALPHA_MARKER` and retains the other three markers in their order.

## References
- [System-prompt documentation](../../../extensions/system-prompt.md): template variables and guideline rendering.
- [Issue solution](solution.md): formatter and runtime-check source references.
- [Workflow-format-v2 solution](../../features/workflow-format-v2/technical-solution.md): SOL-09.1, delivery prerequisite for workflow guidance.
- [Project rules](../../../../AGENTS.md): testing and validation requirements.
