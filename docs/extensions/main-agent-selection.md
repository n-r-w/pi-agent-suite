# main-agent-selection

## Purpose

`main-agent-selection` owns main-agent selection for top-level pi sessions.

## Behavior

- Is enabled by default when `main-agent-selection.json` is missing.
- Registers command `/agent`.
- Supports `/agent none` to store the explicit no-agent state for the current directory.
- Registers shortcut `Ctrl+Shift+A`.
- Shows `No agent` as the first interactive selector option.
- Reopens the interactive selector with the current directory selection highlighted.
- Restores the selected main agent before each model turn when runtime composition needs selected-agent state.
- Does not restore persisted main-agent state inside child subagent processes because `run-subagent` owns child prompt and tool policy.
- Resolves exact tool names and wildcard tool patterns with the same policy as `run-subagent` before applying active tools.
- Reads agent definitions from `~/.pi/agent/agents`.
- Owns selected-agent state under `~/.pi/agent/agent-selection/state/`.
- Stores only `cwd` and `activeAgentId` in the state file.
- Stores `activeAgentId: null` for the explicit no-agent state.
- Does not store model, thinking level, or tools in the state file.
- Applies `model` only when the agent defines `model.id`.
- Applies thinking level only when the agent defines `model.thinking`.
- Publishes a contribution to `Agent Runtime Composition` for prompt and active tools.
- Clears the main-agent prompt and restores baseline active tools when no agent is selected.
- Does not call `pi.setActiveTools()` directly.
- Does not own `run_subagent`.
- Does not own `consult_advisor`.

## Configuration

File: `~/.pi/agent/config/main-agent-selection.json`.

```json
{
  "enabled": true
}
```

`enabled` is optional and defaults to `true`. Missing config enables main-agent selection. `enabled: false` prevents command and shortcut registration.

## Agent definition contract

Allowed top-level keys:

- `description`
- `type`
- `model`
- `tools`
- `agents`

Allowed `type` values:

- `main`
- `subagent`
- `both`

Allowed `model` keys:

- `id`
- `thinking`

Allowed `model.thinking` values:

- `off`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

## State contract

Directory: `~/.pi/agent/agent-selection/state/`.

Allowed fields:

- `cwd`
- `activeAgentId`

Invalid state is not migrated or silently fixed. Invalid state disables selected-agent application and creates a visible state issue.

## Verification

Tests must verify:

- no command or shortcut registration when `enabled` is `false`;
- agent selection through `/agent`;
- no-agent selection through `/agent none` and the interactive `No agent` option;
- current selection restoration when opening `/agent` without arguments;
- agent selection through `Ctrl+Shift+A`;
- state file persistence under `~/.pi/agent/agent-selection/state/`;
- strict state file schema;
- separate model and thinking level application;
- contribution publication to `Agent Runtime Composition` without direct `pi.setActiveTools()` calls.
