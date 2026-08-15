# Problem Statement

## Context

pi-harness extensions provide agent selection and knowledge accumulation features. Currently these features are accessible only through interactive slash commands (`/agent <id>`) or workflow stage triggers. There is no way to control them from the command line at startup.

Users who run pi in scripts, CI pipelines, or one-shot operations cannot select an agent or invoke knowledge accumulation without entering an interactive session.

## Problem Statement

Extension functionality cannot be controlled through CLI flags at pi startup. Users must enter interactive mode to select an agent or manually trigger knowledge accumulation workflows.

## Who is affected

- Developers running pi in `-p` (print) mode for scripted operations
- CI pipelines that need a specific agent without persisted state side effects
- Users who want to run knowledge accumulation on a resumed session and exit immediately

## Evidence

- `pi.registerFlag(name, options)` API exists in pi framework and is used by 4 extensions in the pi distribution: `ssh.ts`, `preset.ts`, `sandbox/index.ts`, `plan-mode/index.ts`. All register flags in the factory function and read values in `session_start` handlers.
- No extension in pi-harness currently uses `registerFlag`. Confirmed by grep across `pi-package/` — only mock implementations in test files.
- main-agent-selection exposes `/agent <id>` command and `Ctrl+Alt+A` shortcut, but no CLI flag.
- knowledge extension registers a trigger runner via `registerWorkflowTriggerRunner`, but it is only invoked by the workflow extension when entering stages with triggers.

## Impact

- Scripted workflows requiring a specific agent must either pre-write agent state files or accept the persisted agent, which may not match the desired agent for the script.
- Knowledge accumulation cannot be triggered without an active workflow, preventing standalone maintenance operations.
- CI and automation scenarios are blocked from using these features without workarounds.

## Reproduction Steps

1. Run `pi --no-extensions -e ./extensions/main-agent-selection/index.ts -p "review this code"` — there is no way to specify which agent to use via CLI.
2. Run `pi -c` to resume a session — there is no way to trigger knowledge accumulation without entering interactive mode and using a workflow.

## Current State

- Agent selection: available via `/agent <id>` slash command (interactive only). State persisted to disk, restored at `session_start`.
- Knowledge accumulation: available via workflow stage triggers only. The trigger runner is registered on `pi.events` as a hidden property and invoked by the workflow extension.

## Desired Outcome

- Users can select an agent ephemerally (current session only, no disk persistence) via a CLI flag.
- Users can invoke any registered workflow trigger type via a CLI flag, with the process exiting after execution.
- Both features work in all pi modes: interactive, `-p` (print), RPC.

## Success Metrics

- `pi --agent <id>` applies the agent for the current session without modifying persisted state.
- `pi --agent none` clears the agent for the current session.
- `pi --trigger <type> -c` runs the specified trigger on a resumed session and exits.
- Invalid agent IDs and trigger types produce visible errors in all modes including `-p`.

## Scope

- Register `--agent` string flag in main-agent-selection extension
- Register `--trigger` string flag in workflow extension
- Ephemeral agent application via `applyAgentSelection` without `writeSelectedAgentState`
- Trigger invocation via `getWorkflowTriggerRunner(pi).run(...)` followed by `ctx.shutdown()`

## Out of Scope / Non-Goals

- Persistent agent selection via CLI (use `/agent <id>` for persistent selection)
- Interactive trigger type selection (flag value must be specified explicitly)
- New trigger types or knowledge algorithms
- Changes to the trigger runner registration mechanism

## Constraints

- Flag values become available after extension loading, before `session_start` — handlers must read flags in `session_start`, not in factory function
- `signal` is typically `undefined` during `session_start` — LLM calls from trigger runner will not be cancellable
- `reportIssue` in main-agent-selection returns early when `hasUI === false` — error output for `-p` mode requires a different mechanism (stderr)
- Child-process guards must be respected: `isChildSubagentProcess` for agent flag, `isKnowledgeChildProcess` for trigger flag
- Trigger type names must match values used in workflow YAML definitions (`WorkflowTriggerType`)

## Assumptions

- `ctx.shutdown()` during `session_start` exits the process in interactive mode because the agent is idle at that point. Justification: pi documentation states shutdown is deferred until agent becomes idle. Verification: test with `pi --trigger <type> -c` in interactive mode.
- Session messages are available at `session_start` for `--continue`/`--resume`. Justification: pi source code shows messages are loaded before `bindExtensions` emits `session_start`. Verification: confirmed by source code analysis (`core/sdk.js:231-236`, `core/agent-session.js:1759-1762`).

## Open Questions

None. All factual questions resolved during feasibility analysis.
