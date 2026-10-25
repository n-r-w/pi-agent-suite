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
- SCN-05: A caller passes its own directory explicitly or through a symlink alias. The TUI omits the additional directory row.
- SCN-06: A caller supplies `cwd: null` or `cwd: 42`. The tool returns `invalid_request` before authorization or process startup. String `cwd: "42"` remains a valid relative directory name.
- SCN-07: A parent starts through `/work/alias`, pointing to `/work/projects/parent`, and delegates with `cwd: "../sibling"`. Its child runs in `/work/projects/sibling`, including after the parent continues from a saved session.

## Scope and non-scope

The change includes request validation, process startup, nested delegation, durable continuation metadata, and directory presentation. Session storage, agent permission rules, and Pi's project-resource loading mechanisms remain unchanged. For nested delegation, the root supervisor uses the immediate caller's project registry when it checks availability and chooses launch settings.

## Requirements

### Functional requirements

- [x] FRQ-01: `subagent_start` accepts optional `cwd` and starts the child in that directory.
- [x] FRQ-01.1: When a caller supplies a non-string `cwd`, the tool returns `invalid_request` before authorization or process startup. For example, `cwd: 42` fails while `cwd: "42"` selects a relative directory.
- [x] FRQ-02: Every terminal continuation retains the selected directory, including management-screen messages, owner restarts, and copied fork hierarchies.
- [x] FRQ-03: A new session without `cwd` uses the immediate caller's directory. Saved sessions without directory metadata keep the previous owner-directory behavior.
- [x] FRQ-03.1: New and continued invocations resolve relative requests against the immediate caller's physical directory. Previously saved symlink paths remain supported without migration, as in SCN-07.
- [x] FRQ-04: An unavailable working directory causes `start_failed` with the directory before any child process starts.
- [x] FRQ-05: Pi and package extensions use their normal project-loading behavior from the selected process directory.
- [x] FRQ-06: The start-tool presentation and selected-session header show the working directory only when it differs from the immediate caller's physical directory. The tool presentation follows this condition in compact and expanded views on both conversation screens.
- [x] FRQ-06.1: The start-tool card uses an emphasized `Cwd:` label, matching `Name:` and `Prompt:`. The management screen's selected-session header uses lowercase `cwd:` with ordinary muted text across the complete row. Both presentations clip the row to the available width.
- [x] FRQ-07: For nested delegation, the root supervisor checks the immediate caller's restrictions and chooses the requested agent's launch settings from that caller's project registry. Project definitions can add agents and override global definitions.

### Non-functional requirements

- [x] NRQ-01: The model-visible parameter description states that the directory applies to the child and its continuations and defaults to the caller's directory.

## Open questions

None.

## Technical supplement

Relative `cwd` paths resolve against the immediate caller's physical directory. The extension stores the resolved physical absolute path. For example, `/work/main` with `cwd: "../other"` resolves to `/work/other`.

Path segments inside the supplied `cwd` retain lexical normalization. Traversing a symlink before a following `..` inside that input is outside scope. For example, a supplied `/work/alias/../sibling` normalizes to `/work/sibling`, even if `/work/alias` points to `/work/projects/parent`.

## References

- [Extension documentation](../../../extensions/run-subagent.md)
