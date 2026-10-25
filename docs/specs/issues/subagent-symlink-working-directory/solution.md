# Technical solution

## Problem statement

See [Problem statement](problem.md) and [Requirements](prd.md).

## Proposed solution

`working-directory.ts` owns physical directory resolution. It checks that the path identifies a directory and uses `realpathSync` to resolve its symlinks. The supervisor resolves the caller's physical directory before applying `path.resolve` to the child's relative request.

`InvocationSupervisor.launchAndAccept` resolves the caller's directory physically before combining it with the requested or saved directory. New acceptance metadata contains physical `cwd` and `callerCwd` paths. Existing journal fields and fork copying remain unchanged. Previously saved alias paths are resolved when an invocation continues.

`createCallerProjectLoader` resolves root and caller directories through the same helper. Equivalent aliases therefore retain the existing root registry snapshot.

The pending start renderer compares physical caller and requested directories. If the requested path cannot yet be resolved, it displays the original path until startup reports the failure. Accepted rendering uses the physical directory evidence from the supervisor.

Regression tests use temporary symlink fixtures and fake child processes. Tests cover nested launches, continuations from saved aliases, root registry snapshot retention, and compact and expanded pending presentation.

## Overengineering and overspecification considerations

The fix uses Node.js filesystem APIs and the existing session fields. The shared helper has three consumers: process startup, registry loading, and presentation. It introduces no dependency, path cache, migration, or alternate project loader.

## Open questions

None.

## References

Paths below are relative to `pi-package/extensions/run-subagent/`.

- `working-directory.ts`: `resolveWorkingDirectory`.
- `invocation-supervisor.ts`: `InvocationSupervisor.launchAndAccept`.
- `index.ts`: `createCallerProjectLoader`.
- `semantic-rendering.ts`: `getStartWorkingDirectory`.
