# custom-compaction

## Purpose

`custom-compaction` owns custom pi compaction through a dedicated config file, bundled default prompt files, and optional custom prompt files.

## Behavior

- Handles `session_before_compact`.
- Reads configuration from `~/.pi/agent/config/custom-compaction.json`.
- Is enabled by default when `custom-compaction.json` is missing.
- Uses bundled prompt files when `systemPromptFile`, `historyPromptFile`, `updatePromptFile`, or `turnPrefixPromptFile` is missing.
- Bundled prompt files live under `pi-package/extensions/custom-compaction/prompts/`.
- Serializes compacted history into one `<conversation>` block before sending it to the model, so the model summarizes the discarded conversation instead of continuing it.
- Uses `systemPromptFile` as the role prompt for compaction model calls.
- Uses `historyPromptFile` as the user command when there is no previous summary.
- Uses `updatePromptFile` as the user command when a previous summary exists.
- Uses `turnPrefixPromptFile` as the user command in a separate model request when compaction cuts through one turn.
- Disables custom compaction and creates an issue only for `custom-compaction` when configuration is invalid.
- Supports three custom prompt path forms: absolute path, `~/` path, and relative path from the directory that contains `custom-compaction.json`.
- Uses the current session model when `model` is missing.
- Uses the current thinking level when `reasoning` is missing.
- Does not read configuration for other extensions.

## Configuration

File: `~/.pi/agent/config/custom-compaction.json`.

```json
{
  "enabled": true,
  "model": "provider/model",
  "reasoning": "medium"
}
```

`enabled` is optional and defaults to `true`. Missing config enables custom compaction with bundled prompts, the current session model, and the current thinking level.

Optional fields:

- `systemPromptFile`
- `historyPromptFile`
- `updatePromptFile`
- `turnPrefixPromptFile`
- `model`
- `reasoning`

Allowed `reasoning` values:

- `off`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

## Verification

Tests must verify:

- default custom compaction replacement when the config file is missing;
- successful reading of bundled default prompt files;
- successful reading of all custom prompt files;
- custom compaction disablement for an empty custom prompt file;
- absolute path, `~/` path, and relative path resolution;
- issue creation only for `custom-compaction` on configuration error;
- model calls through a fake model layer without real models;
- serialized `<conversation>` requests instead of direct chat-message continuation.
