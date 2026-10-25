# Idea: Subagent working directory

## Definitions

See [Terms](terms.md).

## Context and problem

See [Problem statement](problem.md).

## Goal

A caller chooses the directory in which its subagent works and can continue that session in the same directory.

## Scenarios

- SCN-01: A caller in `/work/main` starts a subagent with `cwd: "/work/other"`. The child runs in `/work/other`.
- SCN-02: The caller continues that session after an owner restart or hierarchy fork. The child still runs in `/work/other`.
- SCN-03: The selected directory is absent. The extension returns `start_failed` with the directory and starts no process.
- SCN-04: A subagent in `/work/other` delegates without `cwd`. Its child runs in `/work/other`.
- SCN-05: A caller passes its own directory explicitly. The TUI omits the additional directory row.

## Scope and non-scope

The change includes request validation, process startup, nested delegation, durable continuation metadata, and directory presentation. Session storage, agent permission rules, and Pi's project-resource loading mechanisms remain unchanged. For nested delegation, the root supervisor uses the immediate caller's project registry when it checks availability and chooses launch settings.

## Requirements

### Functional requirements

- [x] FRQ-01: `subagent_start` accepts optional `cwd` and starts the child in that directory.
- [x] FRQ-02: Every terminal continuation retains the selected directory, including management-screen messages, owner restarts, and copied fork hierarchies.
- [x] FRQ-03: A new session without `cwd` uses the immediate caller's directory. Saved sessions without directory metadata keep the previous owner-directory behavior.
- [x] FRQ-04: An unavailable working directory causes `start_failed` with the directory before any child process starts.
- [x] FRQ-05: Pi and package extensions use their normal project-loading behavior from the selected process directory.
- [x] FRQ-06: The start-tool presentation and selected-session header show `cwd` only when the child directory differs from the immediate caller's directory. The tool presentation follows this condition in compact and expanded views on both conversation screens.

- [x] FRQ-07: For nested delegation, the root supervisor checks the immediate caller's restrictions and chooses the requested agent's launch settings from that caller's project registry. Project definitions can add agents and override global definitions.

### Non-functional requirements

- [x] NRQ-01: The model-visible parameter description states that the directory applies to the child and its continuations and defaults to the caller's directory.

## Open questions

None.

## Technical supplement

Relative `cwd` paths resolve against the immediate caller's directory. The extension stores the resolved absolute path. For example, `/work/main` with `cwd: "../other"` resolves to `/work/other`.

## References

- [Extension documentation](../../../extensions/run-subagent.md)
