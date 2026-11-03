# Changelog

## [Unreleased]

### Breaking changes

- For all workflow formats, keep workflows active on final stages after an agent run settles, including their settings, reminders, and rework transitions. Finish stage work and call `workflow_exit` explicitly with a nonempty `basis`. Update custom workflow guidance that describes automatic completion.
- If an agent's explicit `tools` allowlist names only the older workflow tools, add `workflow_exit` so it can leave a workflow or resume its parent. A `workflow_*` pattern already includes it.
- Require a nonempty free-text `basis` in every `workflow_transition` call, for all workflow formats. Update callers to state the facts that justify the transition; declared `ground` requirements remain unchanged. Invalid basis leaves workflow state unchanged. Basis stays in tool-call arguments and is omitted from saved workflow-state entries.
- If you downgrade to an earlier package, the earlier extension cannot restore workflow state from entries written with `journalVersion: 2`.

### Added

- Bind format-3 transitions to catalog nested workflows through optional `workflow`. Requests start the check while the parent waits; `workflow_exit` with boolean `allow` permits the pending transition or resumes the unchanged parent at any check stage. Validate bindings on catalog load and creation, preserve pending requests through replay and compaction, and project permitted target stages in child status.
- Support workflow format 3 with optional `nested: true` in catalog files and `workflow_create`. Nested starts preserve waiting parents, and ordinary exits return to their same stage, including in child agents. Reload, branch navigation, and compaction preserve the whole chain.
- Add optional ordered workflow kinds in `workflow/kinds.yaml` and optional format-3 `kind` in catalog definitions and `workflow_create`. Activation options group allowed, non-running workflows by kind with descriptions and a separate unclassified group. Unknown kinds are rejected at creation/load boundaries; saved kinds survive catalog changes. Kinds change presentation only and appear in shared streamed-create YAML.
- Add sequential `workflow_exit` with a required nonempty free-text `basis`, saved exit operations, shared main/subagent tool presentation, and `exitDescriptionPromptFile` configuration support.

### Changed

- Rewrite the default shared guidance and the descriptions of workflow tools and their parameters so that each rule stands once, in terms of records that the agent sees. Stage completion also requires the completion conditions of stage guidelines, and the active stage is the one that the latest workflow record names. `advance` requires the checks that stage guidelines name before leaving a stage, and `rework` runs none. The exit, activation, and parameter descriptions omit implementation details.
- Describe the required boolean `allow` of a pending exit in the `workflow_exit` parameter schema, so description overrides need no guidance on bound checks. Ordinary exits ignore a supplied boolean `allow`.
- Make `workflow_create` produce format 3. Formats 1 and 2 retain their schema and use ordinary replacement. Reject IDs already anywhere in the running chain.
- Mark nested workflows in activation options before the first start. Update custom shared guidance overrides to explain nested return and ordinary replacement of the entire chain.
- Append chain-aware context and recovery checkpoints without rewriting earlier provider-visible messages. Resume an unchanged parent without rerunning its stage-entry triggers, and restore its effective model settings. Ordinary replacement restores the original root baseline before capturing new settings.
- On a nested exit, reapply the resumed parent's effective stage settings. On the last exit, restore the original pre-workflow model and thinking snapshot. Before an ordinary replacement captures its snapshot, restore that original snapshot. Roll back model changes when workflow persistence fails.
- Keep workflow-owned tools offered after they first become applicable in the session, subject to agent tool policy. Inapplicable registered calls return explicit errors; applicable calls after a nested exit operate on the resumed parent.
- Write journal version 2 and replay mixed sessions with version-1 roots and their unversioned operations. Legacy completion restores an empty workflow state unless an already-saved historical rework follows it.

### Fixed

- Correct README descriptions of omitted, empty, and explicit `workflows` settings. Runtime policy is unchanged.

## [2.21.2] - 2026-11-02

### Fixed

- Restore the workflow stage and transition graph after compaction and when resuming older compacted sessions. Checkpoints omit the graph when it is already visible in the model context.

## [2.21.1] - 2026-11-02

### Added

- Package changelog for Pi's "Extension Updates" notices after future package updates.
- Patch, minor, and major release preparation checks for a nonempty changelog entry for the target version before installing dependencies or running tests.

### Changed

- Require Pi 1.5.0. Update Pi before installing this release.

## [2.21.0] - 2026-11-01

### Added

- Configurable WebSocket transport for OpenAI Responses requests through the `openai` provider.
