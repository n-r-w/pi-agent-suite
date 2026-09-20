# Technical Solution: Migration to Pi 0.86.1

## Problem Statement

See `problem.md`. Requirements are defined in `prd.md`, and domain terms are defined in `terms.md`.

The solution must target Pi 0.86.1 only and preserve repository extension functional capabilities and observable behavior.

## Proposed Solution

### Dependency target

**Behavior to preserve**

The repository and packaged extensions resolve one consistent Pi version and load through the existing package entry points.

**Pi change**

Pi 0.86.1 replaces contracts used by the repository and introduces new transcript and session variants.

**Adaptation**

- Set `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` to exact version `0.86.1` in the root development dependencies.
- Set the same four peer dependencies in `pi-package/package.json` to exact version `0.86.1`.
- Regenerate `bun.lock` and `pi-package/bun.lock` with Bun.
- Keep the direct `typebox` version unless the target typecheck produces a concrete incompatibility.
- Do not add Pi 0.85.1 branches, adapters, or fallback types.

**Preserved outcome**

The repository and package load against Pi 0.86.1 without a second runtime contract.

### Council context rendering

**Behavior to preserve**

Council participants receive user, assistant, tool, bash, and extension-visible conversation context. Pi control records and accounting records do not become participant context.

**Pi change**

`AgentMessage` includes system messages, and `SessionEntry` includes usage entries.

**Compatibility failure**

`pi-package/extensions/convene-council/context.ts` has no branches for these variants. The functions can return `undefined`, which later reaches block merging and can cause an exception.

**Adaptation**

- Add an explicit `usage` branch to `renderContextEntry` that returns no blocks.
- Add an explicit `system` branch to `renderContextMessage` that returns no blocks.
- Do not add a default branch. Future Pi union additions must remain visible to TypeScript exhaustiveness checks.

**Preserved outcome**

Adding system or usage records to a branch does not change the rendered participant-visible context and does not cause an exception.

### Context projection after compaction

**Behavior to preserve**

Context projection replaces eligible historical tool results with shorter representations and retains the source session entry for each projected result.

**Pi change**

A Pi 0.86.1 compaction entry can produce a system checkpoint followed by a compaction summary. Pi excludes pre-compaction system messages that the checkpoint replaces.

**Compatibility failure**

`pi-package/shared/context-projection.ts` reproduces Pi 0.85.1 compaction selection locally. It emits only the summary and can retain system messages that Pi 0.86.1 excludes. The resulting sequence can fail event-to-entry matching and disable projection after compaction.

**Adaptation**

- Replace the local compaction-selection and entry-conversion logic in `buildContextEntryMapping` with Pi `buildContextEntries` and `sessionEntryToContextMessages`.
- Emit one `MappedContextEntry` for every message returned by Pi and attach the source entry to each result.
- Allow one compaction entry to own both its checkpoint and summary messages.
- Keep repository-owned tool-result eligibility, protection, replacement, and savings logic unchanged.
- Remove local message-conversion functions that become unused.

**Preserved outcome**

Projection uses the same message order as Pi before and after compaction. Projected tool results remain associated with their original session entries.

### Auxiliary request isolation

**Behavior to preserve**

Replay-based auxiliary LLM requests use their dedicated system prompt, receive the intended conversation history, and expose no primary-agent tools.

**Pi change**

The primary session transcript now contains system messages with prompt and tool state. Pi normalization preserves those messages while also adding the auxiliary request's top-level system prompt.

**Compatibility failure**

Replaying the primary transcript into an auxiliary request can carry primary-agent instructions and tools into that request.

**Adaptation**

- Add one shared helper that removes system-role messages from a replayed message list.
- Apply the helper after replay and before assembling contexts in:
  - `pi-package/extensions/ask-llm/index.ts`;
  - `pi-package/extensions/consult-advisor/index.ts`;
  - `pi-package/extensions/run-subagent/subagent-query.ts`;
  - `pi-package/extensions/custom-compaction/index.ts`;
  - `pi-package/extensions/knowledge/algorithms.ts`.
- Apply it to both replay streams used by custom compaction.
- Do not apply it inside the core replay functions or the primary context-projection path.
- Do not change `vision/delegate.ts`, which does not replay the primary transcript.

**Preserved outcome**

Each auxiliary request has its dedicated system prompt and an empty resolved tool set. Primary context projection retains Pi system messages.

### Context-size estimation

**Behavior to preserve**

The repository estimates complete model input before auxiliary requests and compaction operations use a model context window.

**Pi change**

System prompt and tool state can be represented by ordered system messages. A system message can contain `content`, `sections`, `toolsAdded`, and `toolsRemoved`.

**Compatibility failure**

`pi-package/shared/context-size.ts` handles only user, assistant, and tool-result roles. A system message makes the accumulated estimate `NaN` and omits model-visible system state.

**Adaptation**

- Normalize the public `Context` with Pi `normalizeContext` before estimating messages.
- Add a system-message branch that counts:
  - textual `content`;
  - named `sections`;
  - each `toolsAdded` declaration with the existing tool reserve;
  - `toolsRemoved` declarations.
- Count ordered system messages as provided. Do not remove messages by value because Pi permits intentional sequential system changes.
- Preserve the existing reserves for model input, ordinary messages, tools, and images.
- In `test/integration/compaction-overflow-retry.test.ts`, estimate `event.messages` without also passing `ctx.getSystemPrompt()`.

**Preserved outcome**

Every valid Pi 0.86.1 context produces a finite non-negative estimate that includes all system state represented to the provider.

### Usage-entry ingestion

**Behavior to preserve**

The `usage` extension stores local model usage for `/usage`, the custom footer, and root and child session totals. Sessions that existed before process attachment are not imported.

**Pi change**

Pi stores cache-warming usage as a usage entry instead of an assistant response. Pi already calculates the tokens and cost in that entry.

**Compatibility failure**

The extension records assistant, compaction, branch-summary, and repository auxiliary events, but it does not record usage entries. Its SQLite totals can therefore omit usage that Pi includes in native session totals.

**Adaptation**

- Add a recorder path that accepts a Pi usage entry.
- Copy its provider, model, token counts, timestamp, and `usage.cost.total` into the existing `UsageEvent` shape. Do not recalculate Pi's total cost.
- Keep the existing validation, attribution, cache-savings calculation, and insertion failure behavior.
- Add the source value `pi-usage`. Treat every `UsageEntry.kind` value through this source without a closed kind mapping.
- Derive the database event ID as `pi-usage:<sessionId>:<entryId>`.
- Keep the SQLite schema unchanged and continue to use `INSERT OR IGNORE`.
- For the process-owned session:
  - mark usage entries present at `session_start` as the non-imported baseline;
  - ingest later entries before usage aggregate reads;
  - ingest remaining later entries during `session_shutdown`.
- For supervised child sessions, handle Pi 0.86.1 RPC `entry_appended` events in `InvocationSupervisor` and forward usage entries to the same recorder with child session, root session, and agent attribution.
- Do not add polling, timers, read barriers, or cross-process transactions.

**Preserved outcome**

The existing SQLite-backed views include Pi 0.86.1 cache-warming usage without importing previous-session history or changing persistence format.

### Provider context and JSON-compatible values

**Behavior to preserve**

The workflow provider fixture observes the active tool set, and message fixtures contain the same JSON data as before migration.

**Pi change**

Custom provider callbacks receive `TranscriptContext`. `ToolCall.arguments` uses `JsonObject`, `ToolResultMessage.details` must be JSON-compatible, and optional JSON details cannot be assigned `undefined` under the repository compiler settings.

**Compatibility failure**

The target typecheck reports failures in the provider fixture, message helpers, and the exhaustive switches described above. The provider fixture also reports an empty active tool list at runtime because it reads the removed `context.tools` field.

**Adaptation**

- Replace `context.tools` in `test/fixtures/workflow-agent-selection.ts` with `getCurrentTools(context.messages)`.
- Type tool-call arguments as Pi `JsonObject` instead of `Record<string, unknown>`.
- Type tool-result details as Pi `JsonValue` where details are accepted.
- Omit `details` when no value exists instead of assigning `undefined`.
- Apply changes only to locations reported by a fresh Pi 0.86.1 typecheck. Do not add broad casts or linter suppression.

**Preserved outcome**

The provider fixture observes the same active tools, message data remains JSON-compatible, and strict typecheck passes.

### Behavior verification

Follow RED-GREEN-REFACTOR after Pi 0.86.1 types are installed.

- Council tests must show that system and usage records add no rendered blocks and do not change participant-visible blocks.
- Projection tests must cover checkpoint-before-summary ordering, two messages owned by one compaction entry, exclusion of replaced system history, post-compaction updates, complete event mapping, and retained source IDs.
- Auxiliary tests must inspect message roles and resolved tools. They must not compare prompt text.
- Context-size tests must cover system content, sections, tool additions, tool removals, top-level normalization, multiple system records, and finite results.
- Usage tests must cover process baselines, one new entry, arbitrary kinds, duplicate delivery, session-qualified IDs, root and child attribution, aggregate-read ingestion, and shutdown ingestion.
- Provider and JSON changes must pass the workflow provider integration and normal typecheck.
- Replace the workflow-loop integration's prompt-text assertions with logic assertions for request order, message roles, resolved tools, and successful loop completion.

Run:

- `bun run test`;
- `bun run typecheck`;
- `bun run check`;
- `bun run verify`;
- single-extension Pi CLI loading for each changed extension;
- whole-package Pi CLI loading;
- the real workflow custom-provider integration;
- a post-compaction runtime context check;
- an auxiliary request check based on message roles and resolved tools.

## Overengineering and Overspecification Considerations

- The design uses Pi context-selection helpers instead of extending a local copy of Pi compaction rules.
- One role filter owns auxiliary isolation, while primary replay remains unchanged.
- Usage ingestion reuses the existing table, recorder, RPC stream, and idempotent insert path.
- The design adds no Pi 0.85.1 compatibility, database migration, polling loop, timer, cross-process transaction, kind registry, or historical importer.
- JSON changes follow Pi 0.86.1 types and fresh compiler diagnostics only.
- The solution changes internal representations only where Pi 0.86.1 changes an input contract.

## Open Questions

None.

## References

- `problem.md` - approved problem statement.
- `prd.md` - approved migration requirements.
- `terms.md` - domain terminology.
- `analysis.md` - preliminary findings and options that were evaluated against Pi 0.86.1 evidence.
- `package.json` and `pi-package/package.json` - Pi dependency declarations.
- `pi-package/extensions/convene-council/context.ts` - council session rendering.
- `pi-package/shared/context-projection.ts` - context mapping and projection replay.
- `pi-package/shared/context-size.ts` - model-input estimation.
- `pi-package/extensions/usage/` - SQLite usage recording and aggregate reads.
- `pi-package/extensions/run-subagent/invocation-supervisor.ts` - child Pi RPC event handling.
- `test/fixtures/workflow-agent-selection.ts` - custom provider fixture.
- `docs/extensions/usage.md` - SQLite-backed usage behavior.
- [Pi 0.86.0 release notes](https://pi.dev/news/releases/0.86.0) - breaking contracts included in Pi 0.86.1.
- [Pi 0.86.1 release notes](https://pi.dev/news/releases/0.86.1) - target patch release.
- [Pi session format](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/docs/session-format.md) - system messages, usage entries, compaction checkpoints, and context building.
