# cmux

## Purpose

`cmux` sends [cmux](https://cmux.com/) notification only after completed top-level pi agent runs.

## Behavior

- Is enabled by default when `config.json` is missing.
- Runs on `agent_end`.
- Sends `cmux notify` only when the current process is not a child agent process and the latest assistant message did not end with `error` or `aborted`.
- Treats `PI_AGENT_SUITE_CHILD_AGENT_PROCESS=1` as the shared child agent process marker.
- Skips notification when no assistant message exists in the `agent_end` event.
- Uses title `Pi`.
- Uses subtitle `Task Complete`.
- Builds the body from run activity in this order:
  - changed files;
  - read files;
  - search and shell activity;
  - search activity;
  - shell activity;
  - elapsed duration.
- Appends elapsed duration to non-fallback bodies when the run takes at least 15 seconds.
- Uses `cmux notify` through `pi.exec` with a 5 second timeout.
- Ignores cmux command failures so missing or unavailable cmux does not interrupt the agent.
- Does not register tools, commands, shortcuts, prompt contributions, skills, active-tool changes, split commands, zoxide commands, review commands, continue commands, or open commands.
- Does not own subagent execution.

## Configuration

File: `~/.pi/agent/agent-suite/cmux/config.json`.

```json
{
  "enabled": true
}
```

All fields are optional. Missing config enables the extension.

Options:

- `enabled`: default `true`. Enables or disables all behavior owned by this extension.

Unsupported keys are invalid config. Invalid config fails closed, suppresses cmux notifications, and reports a warning during `session_start`.

## Notification body examples

- `Updated package.json`
- `Updated 2 files`
- `Reviewed README.md`
- `Reviewed 3 files`
- `Ran 1 search and 2 shell commands`
- `Searched the codebase`
- `Ran 2 shell commands`
- `Finished in 1s`
- `Updated package.json in 1m 12s`

## Verification

Tests must verify:

- default notification on successful `agent_end` in a top-level process;
- no notification when `PI_AGENT_SUITE_CHILD_AGENT_PROCESS=1`;
- no notification when there is no assistant message;
- no notification when the latest assistant message ends with `error` or `aborted`;
- missing config enables notification;
- `enabled: false` suppresses notification;
- non-boolean `enabled` fails closed and reports an extension warning;
- unsupported config keys fail closed and report an extension warning;
- changed-file, read-file, search, shell, duration fallback, and long-run duration body text;
- cmux command failures and timeouts do not throw from the `agent_end` handler.
