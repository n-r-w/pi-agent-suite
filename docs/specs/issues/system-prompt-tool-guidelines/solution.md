# Technical Solution: Active Tool Guideline Delivery

## Problem Statement
See [problem.md](problem.md) and [prd.md](prd.md). Terms are defined in [terms.md](terms.md).

## Proposed Solution

### SOL-01: Merge contributions in the common formatter
Requirements: FRQ-01, FRQ-02, FRQ-03.

The common formatter combines per-tool and global guidelines for the template. This fixes delivery for all tools that supply shared guidance.

In `pi-package/extensions/system-prompt/index.ts`, the `before_agent_start` handler registered by `systemPrompt` reconciles runtime policy and sets `options.selectedTools` from `pi.getActiveTools()`. `formatToolGuidelines` reads contributions in that order and excludes tool names in `options.hiddenTools`. It reads each tool's array from `options.toolGuidelines`; a tool without metadata contributes an empty array. It then appends global `options.promptGuidelines`, independently of tool selection.

The formatter trims each contribution, removes empty results, retains the first occurrence of each normalized value, and renders each retained value as a bullet. This follows Pi 1.3.0's selection and normalization of supplied contributions in `buildSystemPromptSections` and `buildRules` in `node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js`. The formatter renders only supplied contributions; template authors provide any static rules.

Individual tool descriptions reach the model through the provider tool payload. They are separate from both kinds of guidelines. `renderTemplate` in `pi-package/extensions/system-prompt/index.ts` retains the `{{variableName}}` syntax and inserts the formatter's result only where the template contains `{{toolGuidelines}}`.

For example, active tools `beta` and `alpha` contribute `[" BETA_MARKER ", "SHARED_MARKER"]` and `["ALPHA_MARKER", " SHARED_MARKER "]`. Global contributions `["SHARED_MARKER", " GLOBAL_MARKER ", ""]` produce bullets in this order: `BETA_MARKER`, `SHARED_MARKER`, `ALPHA_MARKER`, `GLOBAL_MARKER`.

### SOL-02: Verify delivery at both boundaries
Requirements: NRQ-01, NRQ-02, NRQ-03.

The extension unit test uses an isolated custom template and synthetic metadata. It checks active-tool mapping and order, exclusion of inactive and hidden entries, missing metadata, whitespace normalization, empty contributions, and deduplication across tools and globals. Existing global-only tests retain coverage of absent per-tool metadata.

`verifyWorkflowPolicyCases` in `test/integration/runtime-package-loading.test.ts` reuses configured synthetic workflow descriptions and shared guidance. Each case checks the marker count in the prompt dumped from `before_agent_start`: one when workflow tools are active, zero otherwise. Main-agent and child cases also check active-tool availability and individual descriptions.

`verifyWorkflowPolicyCases` creates a temporary working directory, agent state, and workflow configuration. It uses `writeWorkflowRuntimeDumpExtension` to create a temporary debug extension. Pi loads the complete package explicitly through `-e`, while `--no-extensions` disables automatic extension discovery. The debug extension registers a fake provider and exits with status 23 from the `context` hook before a provider request. The helper invokes Pi without `--offline` and removes temporary state in `finally`.

For NRQ-03, `bun run verify` runs behavior tests, type checks, lint and formatting checks, and Go validation. The provider-description contract has a separate runtime check: the test named `provider payload carries active tool definitions without prompt inventory` in `test/integration/runtime-package-loading.test.ts` inspects serialized tool definitions before a provider request.

## Overengineering and Overspecification Considerations
No elements extend beyond the smallest formatter correction and its regression checks. The common formatter already receives per-tool metadata, so selecting contributions there covers all tools. A workflow-specific fallback would duplicate delivery logic for one extension.

The formatter continues to depend on Pi's prompt-option fields. The correction adds no dependency, registration rule, schema, or abstraction. The unit test checks selection and normalization; the runtime cases check metadata delivery through the package.

Test-helper organization and synthetic marker wording are left to the implementer.

## Open Questions
None.

## References
- `pi-package/extensions/system-prompt/index.ts`: `systemPrompt`, `formatToolGuidelines`, and `renderTemplate`.
- `pi-package/extensions/system-prompt/index.test.ts`: test named `maps visible active tool guidelines before normalized global contributions`.
- `test/integration/runtime-package-loading.test.ts`: `verifyWorkflowPolicyCases` and `writeWorkflowRuntimeDumpExtension`.
- [Workflow-format-v2 solution](../../features/workflow-format-v2/technical-solution.md): SOL-09.1, prerequisite for FRQ-09.
