# Changelog

## [2.22.2] - 2026-11-08

### Added

- `{{#workflowAgent}}...{{/workflowAgent}}` sections in `system-prompt` templates: only an agent with the active `workflow_activate` tool receives their text. They may stand at the top level or inside a role section.

### Changed

- When `/agent` selects another main agent, the workflow extension offers only the workflow tools that apply to the new agent. For example, an agent with `workflows: []` loses `workflow_activate` after the switch.
- When the agent activates an unchanged catalog workflow again, the workflow extension refers to the rules and stage graph that the session already shows and does not repeat them. For a workflow from `workflow_create`, the extension still sends the rules and graph on each activation.
- Refined the bundled system prompt and subagent rules: conversation style of the main agent, token usage, and skill loading.

### Fixed

- When Pi drops a workflow record before saving it, for example when you press Escape during a response, the workflow extension sends the instructions of that stage again on the next entry into it. The extension also starts the next run of the agent with the current workflow state, so the agent does not continue without the dropped activation, stage entry, or exit.
- After a compaction or a session resume, the workflow extension restores the current rules and stage graph of a workflow when the session shows only an earlier version of its definition, for example after a change of the catalog file.

## [2.22.1] - 2026-11-04

### Added

- Package logo in the [Pi package gallery](https://pi.dev/packages) and in the README.

## [2.22.0] - 2026-11-04

### Breaking changes

- Keep a workflow active on its final stage after the agent run ends. Leave it with the new `workflow_exit` tool, and add `workflow_exit` to an explicit `tools` allowlist that names only the older workflow tools.
- Require a nonempty `basis` in each `workflow_transition` call.
- Earlier package versions cannot restore workflow state saved by this version.

### Added

- Workflow format 3:
  - `nested: true`: the workflow starts on top of the active one, which continues at its stage after the nested workflow exits;
  - `workflow` on a transition: the request starts this nested check, and `allow` of `workflow_exit` permits or refuses the transition; the check starts regardless of the agent's `workflows` list;
  - `workflow` on a stage of a catalog workflow: each entry into the stage starts this nested workflow after the stage record, regardless of the agent's `workflows` list;
  - `kind`: activation options are grouped by the kinds of `workflow/kinds.yaml`.
- `workflow_exit` tool, configurable by `exitDescriptionPromptFile`.
- File references `{{path}}` in strings of catalog workflows: the extension substitutes the file text, and a missing file excludes the workflow.

### Changed

- Rewrite the default shared guidance and the workflow tool descriptions. Review custom description overrides.
- Create format-3 workflows with `workflow_create`.
- Keep workflow tools offered after they first become applicable in the session, within the agent tool policy.
- Accept a `workflow_transition` call without `ground` when the selected transition declares exactly one ground, in formats 2 and 3. A rejected ground lists each declared ground with its condition.

### Fixed

- Correct README descriptions of `workflows` settings.

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
