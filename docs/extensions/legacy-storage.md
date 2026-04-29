# Legacy storage compatibility

## Purpose

Pi Agent Suite reads earlier storage paths only when the matching suite file or directory is missing.

New writes use the suite directory. Legacy files are not migrated or rewritten automatically.

## Default suite directory

```text
~/.pi/agent/agent-suite/
```

Set `PI_AGENT_SUITE_DIR` to use another suite directory.

## Legacy config files

| Extension | Suite file | Legacy file |
| --- | --- | --- |
| `enable-tools` | `~/.pi/agent/agent-suite/enable-tools/config.json` | `~/.pi/agent/config/enable-tools.json` |
| `footer` | `~/.pi/agent/agent-suite/footer/config.json` | `~/.pi/agent/config/footer.json` |
| `codex-verbosity` | `~/.pi/agent/agent-suite/codex-verbosity/config.json` | `~/.pi/agent/config/codex-verbosity.json` |
| `codex-quota` | `~/.pi/agent/agent-suite/codex-quota/config.json` | `~/.pi/agent/config/codex-quota.json` |
| `custom-compaction` | `~/.pi/agent/agent-suite/custom-compaction/config.json` | `~/.pi/agent/config/custom-compaction.json` |
| `context-projection` | `~/.pi/agent/agent-suite/context-projection/config.json` | `~/.pi/agent/config/context-projection.json` |
| `context-overflow` | `~/.pi/agent/agent-suite/context-overflow/config.json` | `~/.pi/agent/config/context-overflow.json` |
| `main-agent-selection` | `~/.pi/agent/agent-suite/agent-selection/config.json` | `~/.pi/agent/config/main-agent-selection.json` |
| `run-subagent` | `~/.pi/agent/agent-suite/run-subagent/config.json` | `~/.pi/agent/config/run-subagent.json` |
| `consult-advisor` | `~/.pi/agent/agent-suite/consult-advisor/config.json` | `~/.pi/agent/config/consult-advisor.json` |

## Legacy artifacts

| Artifact | Suite location | Legacy location |
| --- | --- | --- |
| Agent definitions | `~/.pi/agent/agent-suite/agent-selection/agents/` | `~/.pi/agent/agents/` |
| Selected-agent state | `~/.pi/agent/agent-suite/agent-selection/state/` | `~/.pi/agent/agent-selection/state/` |

## Precedence

- Suite files and directories have priority.
- Legacy config is read only when the suite config file is missing.
- Legacy selected-agent state is read only when the suite state file for the current working directory is missing.
- Legacy agent definitions are read only when the suite agent directory is missing.
- Invalid or unreadable suite config prevents fallback to legacy config.
