# Analysis Results: Migration from Pi 0.85.1 to Pi 0.86.1

This analysis identifies the repository changes required to migrate `pi-agent-suite` from Pi 0.85.1 to Pi 0.86.1. It records confirmed compatibility problems, their impact, available solution options, unresolved design questions, and the evidence needed for a later technical solution.

## Scope

In scope:

- Breaking changes introduced by Pi 0.86.0 and included in Pi 0.86.1.
- Transcript handling in extensions and shared context projection.
- Token estimation for transcript-backed contexts.
- Isolation of auxiliary LLM requests from the main agent system transcript.
- Accounting for transcript `UsageEntry` records.
- Custom provider test fixtures affected by `TranscriptContext`.
- JSON-compatible Pi message types.
- Dependency and lock-file updates.
- Tests, runtime checks, and extension documentation required for the migration.

Out of scope:

- Implementation of the selected technical solution.
- Compatibility with both Pi 0.85.1 and Pi 0.86.1 in one release.
- Unrelated Pi 0.86 features such as Meta Muse, Radius catalog updates, bug reporting, and new experimental harness APIs.
- The disabled overflow-compaction integration test. The same test is already disabled on Pi 0.85.1 and does not represent a new 0.86.1 regression.
- Changes to production custom providers. This repository has no production custom provider implementation.

## Key definitions and abbreviations

- `SystemMessage`: A Pi transcript message with `role: "system"`. It carries system prompt content, named prompt-section changes, tool declarations, and tool removals.
- `UsageEntry`: A Pi session entry with `type: "usage"`. It records model usage that is not an assistant response and does not participate in model context. Cache warming currently writes entries with `kind: "cache_warm"`.
- `Context`: The public `pi-ai` request input. Its `systemPrompt` and `tools` fields are shorthand for a leading system message, while `messages` can contain transcript system messages.
- `TranscriptContext`: The normalized provider-facing context introduced in Pi 0.86. Its system prompt and tool declarations are stored in `context.messages`.
- Main context: The transcript used by the primary Pi agent.
- Auxiliary LLM request: A model request initiated by an extension for advisory, compaction, knowledge, projection, query, or similar work.
- Context projection: The repository feature that replaces eligible historical tool results with shorter persisted or runtime projections.
- Compaction checkpoint: `CompactionEntry.systemMessage`, which stores the complete system prompt and tool state at a compaction boundary.
- Cache warming: A Pi request that refreshes a provider prompt cache. Pi 0.86.1 defaults to `"streaming"` mode and can also use `"off"` or `"idle"`.

## Executive Summary

A version-only update is insufficient. Pi 0.86 introduces transcript-backed system prompt and tool state, provider-facing `TranscriptContext`, standalone usage entries, and stricter JSON message types.

The migration has seven behavior or build concerns:

1. `convene_council` crashes when its context renderer receives either a system message or a usage entry.
2. Shared token estimation returns `NaN` when it receives a system message.
3. The repository's context mapping does not reproduce Pi 0.86 compaction semantics because it omits `CompactionEntry.systemMessage` and retains pre-compaction system messages.
4. Auxiliary LLM requests receive the main agent system transcript and tool declarations in addition to their own system prompt.
5. The usage extension does not account for `UsageEntry` records, so cache-warming cost and tokens are absent from `/usage`, the footer, and subagent usage totals.
6. The workflow custom provider fixture reads removed `context.tools` state instead of replaying tools from `context.messages`.
7. Pi 0.86 JSON types expose compile errors in message and test helpers.

The compaction checkpoint mismatch can disable context projection after compaction. Pi emits the checkpoint before the compaction summary, while `buildContextEntryMapping` emits only the summary. This difference can make `mapEventMessagesToBranchEntries` reject the complete post-compaction context.

The recommended direction is to reuse Pi's exported context-entry projection functions, filter system messages only at auxiliary request boundaries, estimate one canonical normalized transcript without value-based deduplication, and reconcile new usage entries through deterministic session-entry IDs. The exact token-estimation policy and usage-reconciliation triggers remain design decisions for the technical solution.

## Background and Context

Pi 0.86.0 moved system prompt and tool declarations into the persisted transcript. The first request in a session persists a leading `SystemMessage`. Later prompt or tool changes persist additional system messages. Replaying the messages in order yields the active prompt and tool state.

Pi also changed custom provider inputs from `Context` to `TranscriptContext`. Provider code must read system and tool state with `getCurrentSystemPrompt(context.messages)` and `getCurrentTools(context.messages)`.

Cache warming was added in the same release and is enabled in `"streaming"` mode by default. A successful refresh is persisted as a `UsageEntry`, not as an assistant message. Pi documentation requires consumers to treat unknown `UsageEntry.kind` values as ordinary model usage rather than reject them.

These changes affect this repository because several extensions replay the main branch into auxiliary requests, the context projection module maintains its own Pi-compatible branch mapping, and the usage extension stores model consumption in a separate SQLite database.

## Method and Data Sources

The analysis used the following methods:

- Compared Pi 0.85.1 and Pi 0.86.1 release notes and tagged source.
- Inspected Pi 0.86.1 message, transcript, session-entry, compaction, provider, and cache-warming contracts.
- Traced repository references to `SessionEntry`, `AgentMessage`, `Context`, `replayContextProjection`, `replayPersistedContextProjection`, provider `streamSimple`, and usage recording.
- Inspected all repository switches over `entry.type` and `message.role` that can receive the new variants.
- Ran the repository baseline on Pi 0.85.1 with `bun test` and `bun run typecheck` on 2026-09-20.
- Used recorded Pi 0.86.1 migration-probe results for the dependency-updated runtime suite, typecheck, package loading, and workflow provider integration.

Pi 0.85.1 repository baseline:

- `bun test`: 1,556 passed, 1 skipped, 0 failed.
- `bun run typecheck`: passed.

Pi 0.86.1 migration probe:

- Runtime tests: 1,555 passed, 1 failed, 1 skipped.
- Typecheck: 8 errors across 6 files.
- Whole-package CLI loading: passed.
- Workflow custom provider integration: expected `['bash']`, received `[]`.
- Overflow-compaction integration test: remained disabled and broken as on Pi 0.85.1.

Limitations:

- The migration probe changed dependencies only in an isolated environment; its exact typecheck output was not retained as a repository artifact. Implementation must rerun typecheck after the dependency update to recover exact diagnostic locations.
- Pi 0.86.1 source and session-format documentation define the cache-warming persistence path. A real billed cache-warming request was not executed because it requires a qualifying provider, context size, cache lifetime, and elapsed time.

## Observations

- Pi 0.86.1 `Message` includes `SystemMessage`, and `AgentMessage` consequently includes the same role.
- Pi 0.86.1 `SessionEntry` includes `UsageEntry` with `kind`, `provider`, `model`, `usage`, and optional `note`.
- `pi-package/extensions/convene-council/context.ts:renderContextMessage` has no `"system"` case. The function therefore returns `undefined` for a system message even though its declared result is `ContextBlock[]`.
- `pi-package/extensions/convene-council/context.ts:renderContextEntry` has no `"usage"` case. It also returns `undefined` for a usage entry.
- `renderExternalContextPackage` passes both results through `Array.flatMap` and then into `mergeAdjacentBlocks`. An `undefined` element causes the observed `TypeError` when code reads `block.kind`.
- Pi persists a system message during the first ordinary request in a 0.86 session. The system-message crash therefore does not require cache warming or a special session shape.
- `pi-package/shared/context-size.ts:estimateMessageTokens` handles only `"user"`, `"assistant"`, and `"toolResult"`. Adding its `undefined` result to the running total produces `NaN`.
- A system message can contain text in both `content` and `sections`, and tool state changes in both `toolsAdded` and `toolsRemoved`. Counting only `content` would remain incomplete.
- `Context.systemPrompt` and `Context.tools` are shorthand for an additional leading system message. Their simultaneous presence with transcript system messages is valid and can represent distinct instructions. Equality-based or presence-based deduplication cannot determine caller intent.
- The failing overflow-compaction integration callback constructs a duplicate estimate by passing `ctx.getSystemPrompt()` while `event.messages` already contains Pi 0.86 transcript system state.
- Pi 0.86.1 `sessionEntryToContextMessages` converts a compaction entry into `[entry.systemMessage, compactionSummary]` when the checkpoint exists.
- Pi 0.86.1 `buildContextEntries` excludes system messages from pre-compaction retained entries because the compaction checkpoint already contains their resolved state.
- `pi-package/shared/context-projection.ts:buildContextEntryMapping` creates only a compaction summary and does not read `CompactionEntry.systemMessage`.
- The repository-owned mapping keeps every retained entry from `firstKeptEntryId`, including system messages.
- `mapEventMessagesToBranchEntries` requires the locally mapped sequence to consume every message in Pi's context. A missing leading compaction checkpoint leaves an unmatched event message and returns `undefined`.
- `replayContextProjection` is used by `ask-llm`, `consult-advisor`, custom compaction, and knowledge accumulation. `replayPersistedContextProjection` is used by subagent query.
- Each of those auxiliary requests also supplies its own `Context.systemPrompt`. After Pi 0.86 normalization, the request contains both the auxiliary prompt and the main transcript system messages.
- Main transcript system messages can declare the primary agent's complete tool set. Passing them to an auxiliary request can expose tools despite each builder setting `tools: []`.
- Removing system messages inside the core replay functions would also remove them from the primary context projection path. The filtering boundary must therefore be specific to auxiliary requests.
- `pi-package/extensions/usage/index.ts` records assistant `message_end`, native compaction, branch summaries, and repository-specific auxiliary usage events. It does not inspect session `UsageEntry` records.
- Cache warming appends a `UsageEntry` directly through Pi's `SessionManager`. It does not emit an extension `message_end` event.
- Pi emits an internal `entry_appended` event after warming, but this event is not part of the public extension event API in 0.86.1.
- `docs/extensions/usage.md` states that the usage store records complete local model-usage events and supplies cumulative root and child totals. Missing `UsageEntry` records contradicts that stated behavior.
- `UsageEntry.kind` is an arbitrary string. Pi's session-format documentation instructs consumers to treat unknown kinds as normal usage.
- SQLite usage event IDs are global within the store. A bare Pi entry ID is not sufficient because entry IDs are generated within a session and can collide across sessions.
- `test/fixtures/workflow-agent-selection.ts` is the only custom provider implementation that reads `context.tools`. Other generated integration providers either ignore context state or read `context.messages`.
- Pi 0.86.1 restricts `ToolCall.arguments` to `JsonObject` and `ToolResultMessage.details` to JSON-compatible values. `ToolResultMessage` is now conditional on details compatibility, and `JsonValue` arrays are readonly.
- The repository has no `user_bash` handler, and every registered extension tool has a parameter schema.
- The `pi.on()` unsubscribe return value is additive and does not invalidate callers that ignore it.
- The clipboard and TUI spinner changes do not alter interfaces currently used by repository extensions.
- The root `package.json` pins the four directly imported Pi packages to 0.85.1. `pi-package/package.json` uses wildcard peer dependencies, but `pi-package/bun.lock` resolves them to 0.85.1.
- Pi 0.86.1 packages depend internally on a newer `typebox`, while this repository already uses a separate direct `typebox` version. The migration typecheck did not require changing that direct dependency.

## Analysis and Interpretations

- `convene_council` has two independent runtime failure paths. Skipping only system messages still leaves cache-warming sessions vulnerable to usage entries, and skipping only usage entries leaves every ordinary 0.86 session vulnerable to its persisted system message.
- The context projection compaction mismatch is more serious than an auxiliary prompt leak. It affects the primary `context` hook because local and Pi message sequences no longer have the same prefix after compaction.
- Reimplementing Pi's branch-context selection duplicates a framework responsibility that Pi already exports through `buildContextEntries` and `sessionEntryToContextMessages`. Reusing those functions reduces the chance that a later entry type changes local semantics again.
- Auxiliary filtering and primary projection preservation are separate responsibilities. A single filter inside `replayContextProjection` cannot satisfy both.
- Global system-message deduplication inside token estimation is unsafe. Two equal strings can still represent two intentionally submitted messages, while two different structures can render to equivalent provider input.
- A conservative estimator that counts the canonical normalized transcript can overestimate providers that collapse mid-conversation system changes, but it does not silently understate context-window pressure.
- Replaying only current prompt and tool state once can better approximate providers without mid-conversation system support, but it can undercount providers that preserve system updates in place. The estimator currently has no model compatibility input with which to select between those behaviors.
- Usage accounting requires reconciliation rather than one new event handler because Pi 0.86.1 exposes no public extension event after `UsageEntry` persistence.
- Default `"streaming"` cache warming occurs during long active runs and stops when the agent settles. Reconciliation at tool and lifecycle boundaries can capture most default-mode entries without polling, but root `"idle"` mode also requires reconciliation when UI aggregates are read or before the next agent run.
- Recording all usage entries under one generic source preserves future `kind` compatibility. Recording only `"cache_warm"` covers the only producer in Pi 0.86.1 but contradicts the documented arbitrary-kind consumer contract.
- `docs/extensions/usage.md` says previous Pi sessions are not scanned. A reconciliation design must distinguish entries that existed when the process attached from entries appended during the active process, or explicitly change the documented import policy.
- Package loading alone is not a behavior check. It cannot detect rendering crashes, post-compaction mapping failure, auxiliary tool leakage, token `NaN`, or missing usage accounting.

## Hypotheses and Tests

- Event-driven usage reconciliation plus reconciliation on usage-broker reads can keep root footer totals current without a polling timer.
  - What it means if true: cache-warming entries appear in the footer and `/usage` before process shutdown with no permanent interval.
  - What it means if false: an idle warm can remain invisible until the next lifecycle event, requiring either a bounded timer or an upstream Pi event.
  - How to test: append usage entries between lifecycle events in an isolated `SessionManager` fake, then invoke root and child aggregate reads.
  - Expected signal: each new entry is inserted once before the aggregate response.
  - Falsification signal: a new entry remains absent or is inserted more than once.
  - Effort/cost: bounded unit and integration tests; no provider request.
- Replacing local context selection with Pi's exported projection functions can preserve the source-entry association required by context projection.
  - What it means if true: the local mapping matches Pi before and after compaction while projected tool results still map to their original session entry IDs.
  - What it means if false: one Pi entry producing multiple messages requires a small local adapter around the upstream output.
  - How to test: construct a branch containing a system message, retained messages, a compaction checkpoint, and a later system update; compare local mapped messages with Pi `buildSessionContext` messages.
  - Expected signal: identical role ordering and successful `mapEventMessagesToBranchEntries`.
  - Falsification signal: any unmatched message or incorrect source entry for a projected tool result.
  - Effort/cost: one shared-module behavior test.
- Counting every message in a normalized transcript is a sufficiently safe model-independent context estimate.
  - What it means if true: all auxiliary context-window gates reject before provider overflow, with acceptable conservative margin.
  - What it means if false: system-update accumulation can reject requests that the selected provider would accept after collapsing system state.
  - How to test: compare estimator output with Pi provider payload token usage for representative models that support and do not support mid-conversation system messages.
  - Expected signal: no underestimation that crosses a model context-window boundary.
  - Falsification signal: provider-reported input exceeds the estimate or conservative error rejects normal repository workloads.
  - Effort/cost: unit tests plus optional live provider measurements.

## Options and Trade-offs

- OPT-01: Add explicit `"system"` and `"usage"` skip cases to the council renderer. Pros: smallest change; preserves compile-time exhaustiveness for future variants; behavior is clear. Cons: every new Pi variant still requires an explicit migration. Risk: low. Effort: small. Choose when maintaining exhaustive switches is preferred.
- OPT-02: Add a default skip branch to council entry and message rendering. Pros: unknown future variants cannot reproduce this crash. Cons: new context-bearing variants can be silently discarded; TypeScript no longer identifies missing handling. Risk: medium. Effort: small. Choose only when forward-compatible omission is more important than exhaustive review.
- OPT-03: Build context-entry mapping from Pi's exported `buildContextEntries` and `sessionEntryToContextMessages`, then attach each emitted message to its source entry. Pros: uses Pi's canonical compaction and new-entry semantics; removes duplicated framework logic. Cons: one source entry can emit two messages, so local mapping tests must cover duplicate source-entry IDs. Risk: low to medium. Effort: medium. Choose to minimize future migration drift.
- OPT-04: Extend the repository-owned compaction mapping with `systemMessage` ordering and retained-system exclusion. Pros: smaller diff and complete local control. Cons: continues duplicating Pi behavior and can drift again. Risk: medium. Effort: small to medium. Choose only when the upstream helpers cannot preserve source-entry association.
- OPT-05: Add one shared auxiliary-context helper that removes every `role: "system"` message after replay, and call it from ask-llm, consult-advisor, subagent query, custom compaction, and knowledge accumulation. Pros: one explicit policy; primary replay remains unchanged; easy role-based tests. Cons: each new auxiliary caller must use the helper. Risk: low. Effort: medium. Choose for clear boundary ownership.
- OPT-06: Remove system messages inside `replayContextProjection` and `replayPersistedContextProjection`. Pros: fewer call-site changes. Cons: breaks primary context projection and violates the requirement to preserve the main transcript. Risk: high. Effort: small. Do not choose.
- OPT-07: Normalize `Context.systemPrompt` and `Context.tools` into a leading system message, then estimate every resulting message and system tool delta. Pros: deterministic; conservative; preserves intentional multiple system messages; aligns with the public `Context` contract. Cons: can overestimate providers that collapse system updates. Risk: low for overflow prevention. Effort: medium. Choose when safety against undercounting is primary.
- OPT-08: Replay system messages into one current prompt and current tool set, count that state once, and count only non-system conversation messages. Pros: avoids historical system-state overcount; approximates providers that collapse updates. Cons: undercounts providers that preserve mid-conversation system messages; requires a policy for top-level `Context.systemPrompt` relative to transcript state. Risk: medium to high. Effort: medium. Choose only with model-aware evidence or a deliberate non-conservative policy.
- OPT-09: Reconcile unseen `UsageEntry` records at deterministic extension and aggregate-read boundaries. Use a globally unique derived event ID containing the Pi session ID and session entry ID. Pros: no permanent polling; SQLite idempotency; supports arbitrary kinds and child attribution. Cons: the technical solution must define all reconciliation boundaries and resume behavior. Risk: medium. Effort: medium. Choose as the default extension-only approach.
- OPT-10: Poll the active session branch for usage entries. Pros: bounded visibility delay, including idle warming. Cons: timer lifecycle, repeated scans, unnecessary wakeups, and more test complexity. Risk: medium. Effort: medium. Choose only when event-driven freshness is insufficient.
- OPT-11: Reconcile usage only during `session_shutdown`. Pros: simplest reliable final accounting. Cons: footer, `/usage`, and active subagent totals remain stale; crashes can lose accounting. Risk: high relative to documented behavior. Effort: small. Do not choose as the complete solution.
- OPT-12: Apply mechanical API adaptations only where the compiler identifies JSON incompatibility, and update the workflow fixture with `getCurrentTools(context.messages)`. Pros: minimal type-safe migration; no production provider changes. Cons: requires a fresh 0.86.1 diagnostic list during implementation. Risk: low. Effort: small. Choose for provider and JSON type changes.

## Recommendation

Use OPT-01 for the council renderer, OPT-03 for canonical post-compaction mapping, OPT-05 for auxiliary isolation, OPT-07 as the provisional safe token-estimation policy, OPT-09 for usage accounting, and OPT-12 for provider and JSON type adaptation.

The technical solution should not use OPT-06 or OPT-11 because those options violate primary transcript preservation or live usage behavior. OPT-02, OPT-04, OPT-08, and OPT-10 remain fallback choices only when tests disprove the recommended option for the corresponding boundary.

Before implementation begins, the technical solution must resolve the token-estimation policy and the complete set of usage reconciliation boundaries. These decisions affect observable context-window rejection and usage freshness, so they cannot be left to implementation inference.

No backward-compatibility layer for Pi 0.85.1 is recommended. The migration should converge directly on Pi 0.86.1 types and transcript semantics.

## Action Plan

- Update `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` to exact version `0.86.1` in the root development dependencies.
- Regenerate both `bun.lock` and `pi-package/bun.lock`. Leave the direct `typebox` version unchanged unless the fresh typecheck provides a concrete incompatibility.
- Capture the complete Pi 0.86.1 typecheck diagnostic list before changing TypeScript source.
- Add RED behavior tests for system and usage variants in `convene-council`.
- Add RED behavior tests proving canonical context ordering and successful event-to-entry mapping after a compaction checkpoint.
- Add RED behavior tests for finite system-message token estimates, sections, tool declarations, tool removals, and a caller that does not duplicate transcript-backed state.
- Add RED behavior tests proving every auxiliary request removes system-role transcript messages while the primary replay preserves them.
- Add RED behavior tests for arbitrary `UsageEntry.kind`, globally unique event IDs, idempotent reconciliation, root and child attribution, session replacement, branch navigation, and aggregate-read freshness.
- Update `test/fixtures/workflow-agent-selection.ts` to use `getCurrentTools(context.messages)`.
- Replace non-JSON message helper types with `JsonObject` and `JsonValue`, and omit optional `details` rather than assigning `undefined` where the new conditional type requires omission.
- Update `docs/extensions/usage.md` to define transcript usage entry accounting, source naming, resume behavior, and freshness.
- Run `bun run test`, `bun run typecheck`, `bun run check`, and `bun run verify`.
- Run single-extension CLI loading for each changed extension and whole-package loading with `pi --no-session -p -e .`.
- Run a real CLI workflow custom-provider integration to verify provider-visible active tools.
- Run a real post-compaction context check that compares Pi runtime context with context projection mapping. Inspect runtime data rather than only unit-test fakes.

Tests must assert behavior and structure, not prompt content. Auxiliary isolation tests should inspect message roles and resolved tool state rather than comparing system prompt text.

## Assumptions

- Pi 0.86.1 is the only target runtime after migration. No requirement exists to run the same repository revision on Pi 0.85.1.
- Pi 0.86.1 tagged source and published documentation define the intended transcript and session contracts.
- Production extensions in this repository do not register custom providers. The workflow provider is an isolated integration fixture.
- The usage extension's documented goal of complete local model-usage accounting includes model-attributed `UsageEntry` records.
- Previous-session import remains out of scope unless the technical solution explicitly changes `docs/extensions/usage.md`.
- Unknown `UsageEntry.kind` values contain ordinary Pi model usage and must not be rejected solely because the kind is unknown.

## Open Questions

### QST-01: Which model-independent system-message token policy should be normative?
  - Impact: determines whether context-window gates are conservative or can undercount providers with mid-conversation system support.
  - What the answer should look like: selection of OPT-07 or OPT-08, including exact treatment of `content`, `sections`, `toolsAdded`, `toolsRemoved`, top-level `systemPrompt`, and top-level `tools`.
  - What has been done: Pi's normalization and provider transcript behavior were inspected; the repository estimator has no model compatibility input.
  - How/when it will be resolved: during technical-solution design, before token-estimator tests are finalized.

### QST-02: Which public extension boundaries must trigger `UsageEntry` reconciliation?
  - Impact: determines freshness of `/usage`, footer totals, and active subagent totals without polling.
  - What the answer should look like: a closed event and read-boundary list covering streaming warming, idle warming, branch changes, session replacement, shutdown, root reads, and child reads.
  - What has been done: Pi 0.86.1 exposes no public post-append usage event; tool, agent, session, and broker boundaries are available.
  - How/when it will be resolved: prototype OPT-09 with deterministic tests; select OPT-10 only when a reachable freshness gap remains.

### QST-03: How should usage entries already present when a process attaches to a resumed session be handled?
  - Impact: recording them imports historical session usage, while ignoring them can leave usage produced before the process attached absent.
  - What the answer should look like: either mark the initial branch entries as seen without insertion or explicitly redefine the no-import policy and backfill them idempotently.
  - What has been done: `docs/extensions/usage.md` states that older sessions are not imported.
  - How/when it will be resolved: repository owner decision during technical-solution design.

### QST-04: How should arbitrary `UsageEntry.kind` values map to the usage store source field?
  - Impact: determines future compatibility, diagnostics, and whether source values remain a closed union.
  - What the answer should look like: one generic source such as `pi-usage`, a persisted kind field, or a validated mapping with a generic fallback.
  - What has been done: Pi documents `kind` as arbitrary; `pi-package/extensions/usage/store.ts` uses a closed `UsageEventSource` union and does not display source in the aggregate table.
  - How/when it will be resolved: select the smallest schema-compatible option in the technical solution.

## References

- `package.json` — direct Pi development dependency versions and validation scripts.
- `pi-package/package.json` — package extensions and wildcard Pi peer dependencies.
- `bun.lock` — root Pi 0.85.1 resolutions and nested dependency versions.
- `pi-package/bun.lock` — published-package Pi 0.85.1 resolutions.
- `pi-package/extensions/convene-council/context.ts` — external council context rendering and the missing entry/message variants.
- `pi-package/shared/context-size.ts` — serialized input estimation and the missing system-message branch.
- `pi-package/shared/context-projection.ts` — replay, compaction mapping, and event-to-entry matching.
- `pi-package/extensions/ask-llm/index.ts:buildContext` — auxiliary projected context with a dedicated system prompt.
- `pi-package/extensions/consult-advisor/index.ts:buildAdvisorContext` — auxiliary advisor context with a dedicated system prompt.
- `pi-package/extensions/run-subagent/subagent-query.ts:buildQueryContext` — persisted child-context replay with a dedicated system prompt.
- `pi-package/extensions/custom-compaction/index.ts:resolveProjectedContexts` — projected main and retained contexts used by custom compaction.
- `pi-package/extensions/knowledge/algorithms.ts:runLocalKnowledgeAccumulation` — projected transcript used as knowledge extraction input.
- `pi-package/extensions/usage/index.ts` — assistant, compaction, branch-summary, and auxiliary usage handlers.
- `pi-package/extensions/usage/recorder.ts` — pricing validation, attribution, and event construction.
- `pi-package/extensions/usage/store.ts` — global usage event IDs, source union, and aggregate queries.
- `docs/extensions/usage.md` — documented usage coverage, persistence, root totals, and child totals.
- `test/fixtures/workflow-agent-selection.ts` — custom provider fixture that reads the removed `context.tools` field.
- `test/integration/compaction-overflow-retry.test.ts` — transcript-backed context token observation used by the overflow integration check.
- [Pi 0.86.0 release notes](https://pi.dev/news/releases/0.86.0) — breaking changes, transcript-backed prompt/tool state, provider context, JSON types, and cache warming.
- [Pi 0.86.1 release notes](https://pi.dev/news/releases/0.86.1) — target patch release.
- [Pi 0.86.1 session format](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/docs/session-format.md) — `SystemMessage`, `UsageEntry`, arbitrary usage kinds, and compaction checkpoints.
- [Pi 0.86.1 session manager](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/src/core/session-manager.ts) — canonical `buildContextEntries` and `sessionEntryToContextMessages` behavior.
- [Pi 0.86.1 message types](https://github.com/earendil-works/pi/blob/v0.86.1/packages/ai/src/types.ts) — `SystemMessage`, JSON types, `Context`, and `TranscriptContext`.
- [Pi 0.86.1 transcript utilities](https://github.com/earendil-works/pi/blob/v0.86.1/packages/ai/src/utils/transcript.ts) — normalization and current prompt/tool replay.
- [Pi 0.86.1 cache warmer](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/src/core/cache-warmer.ts) — usage persistence and warming lifecycle.
- [Pi cache-warming settings](https://pi.dev/docs/latest/settings#cache-warming) — modes, default behavior, pricing threshold, and session accounting.
