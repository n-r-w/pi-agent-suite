# completion-sound

## Purpose

`completion-sound` plays a completion sound only after successful top-level pi agent runs.

## Behavior

- Is enabled by default when `config.json` is missing.
- Runs on `agent_end`.
- Plays sound only when the current process is not a child agent process and the latest assistant message did not end with `error` or `aborted`.
- Treats `PI_AGENT_SUITE_CHILD_AGENT_PROCESS=1` as the shared child agent process marker.
- Uses a platform default playback command when `command` is omitted.
- Uses configured `command` and `args` when both are provided.
- Allows an empty `args` array.
- Requires `command` when `args` is set.
- Fails closed on invalid config and does not play sound.
- Reports invalid config during `session_start` without interrupting other extensions.
- Ignores playback process failures so sound problems do not interrupt the agent.
- Does not register tools, commands, shortcuts, prompt contributions, or active-tool changes.
- Does not own subagent execution.

## Configuration

File: `~/.pi/agent/agent-suite/completion-sound/config.json`.

```json
{
  "enabled": true,
  "command": "afplay",
  "args": ["/System/Library/Sounds/Glass.aiff"]
}
```

All fields are optional. Missing config enables the extension with the platform default playback command.

Defaults:

- `enabled`: `true`
- macOS: `command` is `afplay`, `args` is `["/System/Library/Sounds/Glass.aiff"]`
- Linux: `command` is `paplay`, `args` is `["/usr/share/sounds/freedesktop/stereo/complete.oga"]`
- Windows: `command` is `powershell.exe`, `args` is `["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "[console]::beep(880,180)"]`
- AIX, Android, Cygwin, FreeBSD, Haiku, NetBSD, OpenBSD, and SunOS: no platform default playback command

`enabled: false` disables all behavior owned by this extension.

`command` selects the executable used for sound playback. `args` passes arguments to that executable. When `args` is set, `command` must also be set.

## Verification

Tests must verify:

- default sound playback on successful `agent_end` in a top-level process;
- no sound playback when `PI_AGENT_SUITE_CHILD_AGENT_PROCESS=1`;
- no sound playback when the latest assistant message ends with `error` or `aborted`;
- configured playback command and arguments are used;
- disabled config prevents playback;
- playback failures do not throw from the `agent_end` handler;
- invalid config fails closed and reports an extension warning.
