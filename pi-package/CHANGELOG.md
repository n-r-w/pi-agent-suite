# Changelog

## [Unreleased]

### Breaking changes

- Keep a workflow active on its final stage after the agent run ends. Leave it with the new `workflow_exit` tool, and add `workflow_exit` to an explicit `tools` allowlist that names only the older workflow tools.
- Require a nonempty `basis` in each `workflow_transition` call.
- Earlier package versions cannot restore workflow state saved by this version.

### Added

- Workflow format 3:
  - `nested: true`: the workflow starts on top of the active one, which continues at its stage after the nested workflow exits;
  - `workflow` on a transition: the request starts this nested check, and `allow` of `workflow_exit` permits or refuses the transition; the check starts regardless of the agent's `workflows` list;
  - `kind`: activation options are grouped by the kinds of `workflow/kinds.yaml`.
- `workflow_exit` tool, configurable by `exitDescriptionPromptFile`.
- File references `{{path}}` in strings of catalog workflows: the extension substitutes the file text, and a missing file excludes the workflow.

### Changed

- Rewrite the default shared guidance and the workflow tool descriptions. Review custom description overrides.
- Create format-3 workflows with `workflow_create`.
- Keep workflow tools offered after they first become applicable in the session, within the agent tool policy.

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
