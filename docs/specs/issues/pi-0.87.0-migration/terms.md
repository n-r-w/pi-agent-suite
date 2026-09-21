# Domain Terms

- Pi 0.87.0 migration: The repository transition from Pi 0.86.1 to Pi 0.87.0.
- Component purpose: The user-facing outcome for which a component exists.
- Correct component behavior: Behavior that fulfills the component purpose under Pi 0.87.0 without restoring removed content, using stale context, or breaking the component's primary scenario.
- Effective context: The messages Pi will send to a model after compaction and context edits are applied.
- Raw session history: The original append-only session entries before model-context projection.
- Canonical session projection: The effective context and source-entry ownership produced by Pi `buildSessionProjection()`.
- Context edit: A `ContextEditEntry` that omits or replaces model-visible content without changing raw session history.
- Context projection: Repository behavior that shortens eligible historical tool results to reduce model context while retaining useful recent context.
- Auxiliary request: A model request outside the main agent request, including query, advisor, knowledge, and custom-compaction requests.
- Raw council context: Raw session evidence supplied to council participants without applying model-context edits.
- Compatibility: The ability of a component to fulfill its purpose under Pi 0.87.0.
- Blocker: A situation in which a component cannot fulfill its purpose without a separate product decision.
- Preliminary finding: A statement from the initial analysis that requires evidence before it is included in the technical solution.
