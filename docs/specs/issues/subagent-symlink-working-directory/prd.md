# Idea: Physical subagent working directories

## Definitions

See [Terms](terms.md).

## Context and problem

See [Problem statement](problem.md).

## Goal

A child runs in the directory selected by filesystem traversal from its immediate caller's physical directory.

## Scenarios

- SCN-01: `/work/alias` points to `/work/projects/parent`. A parent launched through the alias delegates with `cwd: "../sibling"`. The child runs in `/work/projects/sibling`.
- SCN-02: A saved parent session contains the alias. After continuation, the nested request selects the same physical sibling.
- SCN-04: A caller names its own physical directory through an alias. The TUI omits the extra `cwd` row, and the registry loader retains the root snapshot when applicable.

## Scope and non-scope

The fix includes physical path resolution, reuse of the root registry snapshot, directory presentation, and regression tests. It changes no public request fields or saved-session format. Permission validation, model-error precedence, and parent traversal through symlinks inside the requested `cwd` itself are outside scope.

## Requirements

### Functional requirements

- [x] FRQ-01: New and continued invocations resolve relative directories against the immediate caller's physical directory.
- [x] FRQ-03: Directory comparison in the project-registry loader and pending start presentation recognizes aliases of the same directory.
- [x] FRQ-04: The launcher accepts previously saved symlink paths without a data migration.

### Non-functional requirements

No additional non-functional requirements.

## Open questions

None.

## Technical supplement

No additional details.

## References

- [Feature requirements](../../features/subagent-working-directory/prd.md)
