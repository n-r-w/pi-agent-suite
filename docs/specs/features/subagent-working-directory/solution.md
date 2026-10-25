# Technical solution: Subagent working directory

## Problem statement

See [Problem statement](problem.md) and [Requirements](prd.md).

## Proposed solution

### Request and process startup

`SubagentStartParameters` and `parseSubagentStartRequest` in `contracts.ts` accept optional `cwd`. The boundary rejects blank paths, null bytes, non-string values, and paths longer than 4,096 characters.

`SubagentCoordinator.acceptNewInvocation` passes the path to the supervisor. `InvocationSupervisor.launchAndAccept` resolves the immediate parent's physical directory through `working-directory.ts` before calculating the child's relative path. For example, if the parent was started through `/work/alias`, pointing to `/work/projects/parent`, the nested request `../sibling` resolves to `/work/projects/sibling`. The supervisor identifies an active parent by its Pi session ID. A direct root call uses the configured launch directory. A continuation uses its saved directory.

The supervisor checks that the resolved path is a directory before startup authorization and again before each process creation. It reports `start_failed` with the path when the check fails. The child process receives the resolved path through the existing spawn `cwd` option. Pi retains responsibility for loading project context and resources.

### Project agents in nested delegation

`createCallerProjectLoader` in `index.ts` resolves the immediate caller's physical directory from its catalog session. It also resolves the root directory physically before comparing them, so a symlink alias for the root project retains its registry snapshot. For a caller in another directory, it loads callable definitions through the existing shared registry. The root project retains its existing registry snapshot.

The coordinator awaits the availability check against this registry, including the immediate caller's `agents` restriction. The supervisor uses the same project source to resolve model, thinking, tools, and workflows before startup. For example, a subagent in `/work/other` can call `/work/other/.pi/agents/LocalReviewer.md` even when the root project has no definition with that ID.

### Durable sessions and hierarchy copies

Acceptance metadata includes the resolved `cwd` and initial `callerCwd`. The coordinator retains both in `LogicalSession` and its accepted journal record. `parseLogicalSession` accepts these optional fields so older records remain readable. Existing persistence and fork materialization retain the fields when they copy session records.

A saved `cwd` takes precedence over the new caller's directory on terminal continuation. For an older session without directory metadata, the supervisor keeps the previous configured owner-directory behavior when no active immediate parent is available.

Session storage continues to use the existing owner-directory grouping independently of the process working directory.

### Presentation

`getDisplayedWorkingDirectory` in `domain.ts` returns a display path only when the child directory differs from its immediate caller's directory. Accepted presentation evidence carries both directories through the nested-operation protocol. Hierarchy projection retains both directories as visible node facts.

The start renderer and selected-session header use the existing clipped-row renderer for `cwd:`. Compact and expanded tool views share this row. Before acceptance, the start renderer resolves the requested path against the rendering context's physical directory. If the requested path is unavailable, the renderer keeps that path visible until startup reports its error. The management screen supplies the selected session's directory to conversation tool renderers, so pending nested calls use their immediate caller's directory.

### Verification

Behavior tests cover request validation, nested inheritance, saved continuations in a new supervisor, unavailable directories before spawning, coordinator publication, journal and wire round trips, hierarchy forks, and bounded directory rows. Process tests use controlled child processes and temporary directories. Full package validation uses the repository scripts.

## Overengineering and overspecification considerations

The change reuses spawn's existing `cwd`, journal records, hierarchy copying, and clipped text rendering. It introduces no alternate project-resource loader, directory-changing command, dependency, or session-storage layout. Nested agent resolution reuses the shared registry and permission rules with the immediate caller's directory.

The original caller directory is retained because TUI presentation must distinguish a changed directory even after restoration or hierarchy copying.

## Open questions

None.

## References

All implementation paths below are relative to `pi-package/extensions/run-subagent/`.

- `contracts.ts`: `SubagentStartParameters` and `parseSubagentStartRequest`.
- `invocation-supervisor.ts`: `InvocationSupervisor.launchAndAccept` and `spawnWorkerProcess`.
- `coordinator.ts`: `SubagentCoordinator.publishNewSession`.
- `journal-codec.ts`: `parseLogicalSession`.
- `semantic-rendering.ts`: `renderSubagentStartCall`.
- `management-screen/hierarchy.ts`: `renderSelectedSessionHeader`.
