# enable-tools

## Purpose

`enable-tools` enables built-in search tools that this package expects agents to use.

## Behavior

- Is enabled by default.
- Runs when a pi session starts.
- Adds `grep`, `find`, and `ls` to the active tool list when pi has registered them.
- Keeps active tools that were already enabled.
- Does not register new tools.
- Does not enable tools that pi has not registered.
- Does not own main-agent tool selection, subagent tool selection, or advisor tool disabling.

## Configuration

None.

## Verification

Tests must verify:

- `grep`, `find`, and `ls` are enabled on session start when registered;
- missing search tools are not added;
- already active tools are preserved.
