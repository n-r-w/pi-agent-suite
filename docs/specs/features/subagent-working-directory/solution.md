# Technical solution: Subagent working directory

## Problem statement

See [Problem statement](problem.md) and [Requirements](prd.md).

## Proposed solution

### Request and process startup

`SubagentStartParameters` and `parseSubagentStartRequest` in `contracts.ts` accept optional `cwd`. The boundary rejects blank paths, null bytes, non-string values, and paths longer than 4,096 characters. The registered start tool also uses this parser as its `prepareArguments` hook so it validates original values before Pi removes optional nulls or converts primitives. For example, numeric `cwd: 42` produces `invalid_request`, while string `cwd: "42"` retains its relative-path meaning. The execute callback retains the same parser for direct invocations; both paths reuse one validation implementation.

`SubagentCoordinator.acceptNewInvocation` passes the path to the supervisor. `InvocationSupervisor.launchAndAccept` resolves the immediate parent's physical directory through `working-directory.ts` before calculating the child's path with `path.resolve`. For example, if the parent was started through `/work/alias`, pointing to `/work/projects/parent`, the nested request `../sibling` resolves to `/work/projects/sibling`. The supervisor identifies an active parent by its Pi session ID. A direct root call uses the configured launch directory. A continuation uses its saved directory.

`resolveWorkingDirectory` in `working-directory.ts` checks that a path identifies a directory and resolves symlinks through Node.js `realpathSync`. This helper is shared by process startup, project-registry loading, and pending tool presentation.

The supervisor checks that the resolved path is a directory before startup authorization and again before each process creation. It reports `start_failed` with the path when the check fails. The child process receives the resolved path through the existing spawn `cwd` option. Pi retains responsibility for loading project context and resources.

### Project agents in nested delegation

`createCallerProjectLoader` in `index.ts` resolves the immediate caller's physical directory from its catalog session. For callers in the root directory, it retains the registry captured during runtime initialization. It compares physical paths so aliases of the root directory use that snapshot. For a caller in another directory, it loads callable definitions through the existing shared registry.

The coordinator awaits the availability check against this registry, including the immediate caller's `agents` restriction. The supervisor uses the same project source to resolve model, thinking, tools, and workflows before startup. For example, a subagent in `/work/other` can call `/work/other/.pi/agents/LocalReviewer.md` even when the root project has no definition with that ID.

### Durable sessions and hierarchy copies

Acceptance metadata includes the physical `cwd` and initial physical `callerCwd`. The coordinator retains both in `LogicalSession` and its accepted journal record. `parseLogicalSession` accepts these optional fields so older records remain readable. Existing persistence and fork materialization retain the fields when they copy session records.

A saved `cwd` takes precedence over the new caller's directory on terminal continuation. The launcher resolves previously saved symlink paths before continuation, without changing the journal format. For an older session without directory metadata, the supervisor keeps the previous configured owner-directory behavior when no active immediate parent is available.

Session storage continues to use the existing owner-directory grouping independently of the process working directory.

### Presentation

`getDisplayedWorkingDirectory` in `domain.ts` returns a display path only when the child directory differs from its immediate caller's directory. Accepted presentation evidence carries both directories through the nested-operation protocol. Hierarchy projection retains both directories as visible node facts.

The start renderer uses the existing clipped-row renderer with the emphasized `Cwd:` label, matching the card's `Name:` and `Prompt:` labels. Compact and expanded tool views share this row. The selected-session header clips its lowercase `cwd:` row with Pi's width utility and applies ordinary muted styling to the complete row. Before acceptance, the start renderer resolves the requested path against the rendering context's physical directory. If the requested path is unavailable, the renderer keeps that path visible until startup reports its error. The management screen supplies the selected session's directory to conversation tool renderers, so pending nested calls use their immediate caller's directory.

### Verification

Behavior tests cover nested inheritance, saved continuations in a new supervisor, unavailable directories before spawning, coordinator publication, journal and wire round trips, and hierarchy forks. Process tests use controlled child processes and temporary directories.

Request tests invoke the registered tool through Pi's public `wrapRegisteredTool` and agent-core's `runToolCall`, covering preparation, schema validation, and execution. They verify `invalid_request` with zero authorization and process calls for null, numeric, boolean, array, and object `cwd` values. Positive cases cover omission, absolute and relative paths, and numeric string directory names.

Symlink fixtures cover new and continued parents with relative child paths, including competing existing sibling directories. Registry tests verify retention of the root snapshot for aliases of the same directory. Presentation tests cover compact and expanded tool cards, physical-directory equality, label capitalization, muted header styling without bold emphasis, and width clipping.

Full package validation uses the repository scripts.

## Overengineering and overspecification considerations

The change reuses spawn's existing `cwd`, journal records, hierarchy copying, and clipped text rendering. It introduces no alternate project-resource loader, directory-changing command, dependency, or session-storage layout. Nested agent resolution reuses the shared registry and permission rules with the immediate caller's directory.

The original caller directory is retained because TUI presentation must distinguish a changed directory even after restoration or hierarchy copying.

## Open questions

None.

## References

All implementation paths below are relative to `pi-package/extensions/run-subagent/`.

- `contracts.ts`: `SubagentStartParameters` and `parseSubagentStartRequest`.
- `working-directory.ts`: `resolveWorkingDirectory`.
- `index.ts`: `registerStartTool` and `createCallerProjectLoader`.
- `invocation-supervisor.ts`: `InvocationSupervisor.launchAndAccept` and `spawnWorkerProcess`.
- `coordinator.ts`: `SubagentCoordinator.publishNewSession`.
- `journal-codec.ts`: `parseLogicalSession`.
- `semantic-rendering.ts`: `renderSubagentStartCall`.
- `management-screen/hierarchy.ts`: `renderSelectedSessionHeader`.
