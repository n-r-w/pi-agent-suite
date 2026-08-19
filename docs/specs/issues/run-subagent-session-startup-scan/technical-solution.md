# Technical Solution: Run-subagent session startup isolation

## Problem Statement
- PRB-01: A fresh launch that passes a shared `--session-dir` with a new `--session-id` makes Pi perform session discovery and scan the shared JSONL catalog before Node IPC readiness. The project-key and child-ID directory layout removes this unbounded shared scan while continuations reopen their persisted physical session.

## Proposed Solution

### Storage contract
- APC-01: A fresh child stores its Pi session under `run-subagent/sessions/<encoded-resolved-cwd>/<childPiSessionId>/`. `createRootSupervisor` supplies the project directory and `InvocationSupervisor` appends the generated `childPiSessionId` before spawning Pi.
- APC-02: A continuation reuses the persisted `childPiSessionId`, `childSessionDir`, and `childSessionFile` from `LogicalSession`. It passes `--session-dir <childSessionDir> --session <childSessionFile>` to Pi rather than selecting a new directory or session ID.

### Pi project key
- ALG-01: The project key matches Pi 0.84.2 exactly:
  1. Resolve `cwd`.
  2. Remove one leading slash or backslash.
  3. Replace every slash, backslash, and colon with `-`.
  4. Wrap the result with `--`.

  The resulting expression is ``--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--``.

### Startup branches
- SCN-01: For a fresh child, `createInvocationHandle` generates `childPiSessionId`, selects `join(projectSessionDir, childPiSessionId)`, creates that directory before spawn, and `buildChildArgs` passes `--session-dir` with `--session-id`.
- SCN-02: For a continuation, `InvocationSupervisor.continue` passes the saved physical identity to `launchAndAccept`. The explicit saved directory bypasses fresh-directory selection, and `buildChildArgs` passes `--session-dir` with `--session`.

### Component responsibilities
- CMP-01: `project-session-directory.ts` resolves and encodes the project working directory.
- CMP-02: `createRootSupervisor` combines the run-subagent session root and `ctx.cwd` into the project directory.
- CMP-03: `InvocationSupervisor.createInvocationHandle` owns fresh child ID generation, leaf-directory selection, and directory creation before process spawn. It preserves a request-provided directory.
- CMP-04: `buildChildArgs` selects Pi's fresh `--session-id` form or continuation `--session` form from the presence of `childSessionFile`.

### TDD verification
- ACC-01: `project-session-directory.test.ts` checks the Pi 0.84.2 encoding for resolved paths, slash and backslash separators, colons, and storage-root joining.
- ACC-02: `invocation-supervisor.test.ts`, "groups fresh child sessions by project and creates the directory before spawn", captures the spawned arguments and observes that the exact fresh directory exists at spawn time.
- ACC-03: `invocation-supervisor.test.ts`, "waits for prior same-session teardown before continuation", checks reuse of the saved child Pi session ID, directory, and file, plus the exact `--session-dir` and `--session` arguments for a legacy flat directory.
- ACC-04: `invocation-process.test.ts`, "builds new and resumed worker arguments with explicit launch policy", checks the mutually exclusive fresh and resumed Pi argument forms. The tests use captured arguments, directory state at spawn, and controlled process closure rather than elapsed startup-time assertions.

### Trade-offs and boundaries
- TRD-01: The extension keeps a small local implementation of Pi 0.84.2's pure project-key algorithm because Pi does not expose its default-session-directory helper through the package root export. Updating Pi requires reviewing this algorithm.
- OSP-01: Timeout behavior, IPC, logical session identity, legacy migration, and fork behavior are not changed. Persisted directories remain authoritative for continuations, including legacy flat paths.

## Overengineering and Overspecification Considerations
- DEC-01: The solution adds one project-key helper and one child-ID leaf directory. It does not add a storage registry, migration path, alternate cwd source, or private Pi import.
- NGL-01: This document defines only session-startup storage selection and continuation reuse. It does not define changes to session lifecycle, process control, or fork copying.

## Open Questions
None.

## References
- REF-01: `pi-package/extensions/run-subagent/project-session-directory.ts` - Pi-compatible project-key encoding and project-directory construction.
- REF-02: `pi-package/extensions/run-subagent/index.ts` - root supervisor composition from the suite session root and `ctx.cwd`.
- REF-03: `pi-package/extensions/run-subagent/invocation-supervisor.ts` - fresh directory creation and persisted continuation identity forwarding.
- REF-04: `pi-package/extensions/run-subagent/invocation-process.ts` - fresh and continuation Pi command arguments.
- REF-05: `pi-package/extensions/run-subagent/project-session-directory.test.ts`, `pi-package/extensions/run-subagent/invocation-supervisor.test.ts`, and `pi-package/extensions/run-subagent/invocation-process.test.ts` - behavioral coverage for encoding, startup isolation, continuation reuse, and Pi arguments.
- REF-06: `@earendil-works/pi-coding-agent/dist/core/session-manager.js`, `getDefaultSessionDirPath` - Pi 0.84.2 project-key implementation.
