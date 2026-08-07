# Idea: CLI Flags for Extension Control

## Definitions

- **Extension flag**: CLI flag registered by an extension through `pi.registerFlag(name, { type, default })`. Parsed by pi from `--name value` or `--name=value`. Value available through `pi.getFlag(name)` after extension loading, before `session_start`.
- **Ephemeral agent selection**: Applying an agent to the runtime composition (`applyAgentSelection`) without persistent disk write (`writeSelectedAgentState`). Applies only to the current session.
- **Trigger runner**: Process-local object on `pi.events` (property `__piHarnessWorkflowTriggerRunner`), registered by an extension through `registerWorkflowTriggerRunner`. Method `run(trigger, ctx, signal)` executes the trigger. Trigger types are defined by the `WorkflowTriggerType` abstraction and extended without changing consumers.
- **Run-and-exit**: CLI flag behavior where the process calls `ctx.shutdown()` after completing the operation. In interactive mode, shutdown is deferred until the agent becomes idle. In `-p` mode, shutdown is a no-op (the process exits automatically after processing prompts).

## Context and Problem

pi-harness extensions provide agent selection and knowledge accumulation. These features are accessible only through interactive slash commands or workflow stage triggers. Users running pi in scripts, CI, or one-shot operations cannot control them from the command line.

## Goal

Enable CLI flag control for two extension features at pi startup: ephemeral agent selection and workflow trigger invocation with automatic exit.

## Scenarios

1. **Scripted agent selection**: `pi --agent reviewer -p "review this code"` — applies the reviewer agent for this session without changing persisted state.
2. **Clear agent for session**: `pi --agent none -p "general question"` — runs without any agent contribution.
3. **Knowledge accumulation on resumed session**: `pi --trigger global_knowledge_accumulation -c` — resumes the previous session, runs global knowledge accumulation, exits.
4. **Invalid trigger type**: `pi --trigger unknown_type` — exits with error about unknown trigger type.
5. **Invalid agent ID**: `pi --agent nonexistent` — reports error about agent not found.

## Scope and Non-Scope

**In scope:**
- `--agent <id>` string flag in main-agent-selection extension
- `--trigger <type>` string flag in workflow extension
- Ephemeral agent application (no disk persistence)
- Trigger invocation via trigger runner with automatic exit
- Error reporting in all modes including `-p`

**Out of scope:**
- Persistent agent selection via CLI (existing `/agent <id>` command covers this)
- Interactive trigger type selection
- New trigger types or knowledge algorithms
- Changes to trigger runner registration mechanism

## Requirements

### Feature 1: `--agent <id>` — ephemeral agent selection

- main-agent-selection extension SHALL register an `--agent` string flag through `pi.registerFlag`.
- WHEN `--agent <id>` is set with a valid agent ID, the system SHALL apply the agent through `applyAgentSelection` WITHOUT calling `writeSelectedAgentState`.
- WHEN `--agent` is set, the system SHALL skip disk-based agent restoration in `handleSessionStart`.
- WHEN `--agent none` is specified, the system SHALL clear the main agent contribution for the current session without writing to disk.
- WHEN `--agent <id>` does not match any registered agent, the system SHALL report an error visible in all modes, including `-p`.
- The system SHALL NOT process `--agent` in child subagent processes.

### Feature 2: `--trigger <type>` — workflow trigger invocation

- workflow extension SHALL register a `--trigger` string flag through `pi.registerFlag`.
- WHEN `--trigger <type>` value does not match any known `WorkflowTriggerType`, the system SHALL exit with an error.
- WHEN `--trigger <type>` is valid AND trigger runner is registered, the system SHALL invoke `getWorkflowTriggerRunner(pi).run({ type }, ctx, signal)`.
- WHEN trigger runner is not registered (extension disabled), the system SHALL exit with an error.
- AFTER successful trigger execution, the system SHALL call `ctx.shutdown()`.
- The system SHALL NOT process `--trigger` in child subagent processes.

## Open Questions

None. All design decisions resolved during feasibility analysis and PRD review.

## Technical Supplement

### Flag value availability timing

CLI flag values are applied by `applyExtensionFlagValues` after extension loading and before `session_start` emission. Flag values MUST be read in `session_start` handlers, not in factory functions.

Evidence: pi source `core/extensions/loader.js:215-221` (registerFlag sets defaults), `core/agent-session-services.js:8-49` (applyExtensionFlagValues applies CLI values), `core/agent-session.js:1759-1762` (session_start emitted in bindExtensions).

### Session message availability

Session messages are loaded before `session_start` fires, including for `--continue`/`--resume`. The `session_start` reason is always `"startup"` for initial CLI launch, even with `--continue`/`--resume`.

Evidence: `core/sdk.js:81` (`buildSessionContext`), `core/sdk.js:231-236` (message restore before AgentSession construction), `main.js:631-635` (initial runtime without sessionStartEvent override).

### Model auth resolution

Model authentication is resolved before `session_start`. `ctx.modelRegistry.getApiKeyAndHeaders(model)` is callable during `session_start` handlers.

Evidence: `core/agent-session-services.js` (`modelRuntime.refresh` before session construction), `core/model-registry.js:30` (`getApiKeyAndHeaders`), `core/extensions/runner.js:481-483` (context modelRegistry getter).

### Error reporting in `-p` mode

`reportIssue` in main-agent-selection returns early when `hasUI === false`. In `-p` mode, invalid agent IDs produce no feedback. Error output for `-p` mode requires writing to stderr directly.

Evidence: `pi-package/extensions/main-agent-selection/index.ts:1156-1162` (`reportIssue` checks `ctx.hasUI === false`).

## References

- `docs/extensions/main-agent-selection.md` — agent selection extension documentation
- `pi-package/shared/workflow-trigger-runtime.ts` — trigger runner abstraction and `WorkflowTriggerType` definition
- `pi-package/extensions/knowledge/index.ts` — knowledge extension trigger runner registration
- `pi-package/extensions/workflow/index.ts` — workflow extension trigger dispatch
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` — pi extension API documentation (registerFlag, session_start, events)
