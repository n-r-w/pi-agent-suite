# completion-sound

## Purpose

`completion-sound` plays a local sound after a successful top-level pi agent run.

## Behavior

- Missing `config.json` enables the extension with the platform default command when one exists.
- The extension does not play a sound for child agent runs.
- The extension does not play a sound when the agent run ends with `error` or `aborted`.
- Invalid configuration disables playback until the configuration is fixed.
- Playback failures do not interrupt the agent run.

## Configuration

File: `~/.pi/agent/agent-suite/completion-sound/config.json`.

Full config example:

```json
{
  "enabled": true,
  "command": "afplay",
  "args": ["/System/Library/Sounds/Glass.aiff"],
  "volume": 50
}
```

All parameters are optional unless noted in the table. Unknown parameters make the configuration invalid.

| Parameter | Required | Type or shape | Default | Meaning |
| --- | --- | --- | --- | --- |
| `enabled` | No | Boolean | `true` | Enables or disables completion sound playback. Set `false` to disable the extension. |
| `command` | Required when `args` is set | Non-empty string | Platform default command when available | Executable used to play the sound. Configure this when the platform has no default command or when you want a custom sound command. |
| `args` | No | Array of strings | `[]` when `command` is set; platform default arguments when `command` is omitted and a platform default exists | Arguments passed to `command`. An empty array is valid. Can be set only with `command`. |
| `volume` | No | Number from `0` to `150` | Omitted | Volume percentage for the built-in macOS and Linux default commands. It does not affect custom commands or the Windows default command. |

## Platform defaults

When `command` is omitted, the extension uses these defaults:

- macOS: `afplay` with `/System/Library/Sounds/Glass.aiff`.
- Linux: `paplay` with `/usr/share/sounds/freedesktop/stereo/complete.oga`.
- Windows: `powershell.exe` with a short console beep command.
- Other platforms: no default command; configure `command` and `args` to enable playback.
