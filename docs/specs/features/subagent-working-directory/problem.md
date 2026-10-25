# Problem statement

## Key definitions and abbreviations

See [Terms](terms.md).

## Context

A caller can delegate work in another project through `subagent_start`.

## Observed problem

The caller needs the child process to use another project's directory for relative file paths, shell commands, and normal project configuration loading. A process started in the caller's directory cannot provide that behavior.

## Affected audience

Agents that delegate work across project directories and users who continue those sessions.

## Evidence

The launch configuration in `pi-package/extensions/run-subagent/agent-policy.ts`, function `resolveLaunchConfiguration`, supplies the root runtime's `ctx.cwd`. The supervisor uses this configuration to create processes for direct children, nested children, and terminal continuations.

## Impact

HIGH. A subagent started in the wrong project can read or change files outside the project intended by its caller.

## Current state

The caller can choose a working directory with `cwd`. The extension retains that directory for continuations and shows it when it differs from the immediate caller's directory.

## Desired state

A subagent and its continuations work in the chosen directory. Nested delegation defaults to the immediate caller's directory.

## Problem boundary

Process working directories and their presentation in `run-subagent`. Session storage locations remain unchanged.

## Assumptions

No assumptions.

## Open questions

None.
