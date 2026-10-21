# Analysis Results: Skill restoration integration facts

## Scope

FRQ-01 through FRQ-04 and the integration points in `solution.md`. No implementation changes were made during this investigation.

## Key definitions and abbreviations

Definitions follow `terms.md`. Pi sources below are relative to `node_modules/@earendil-works/pi-coding-agent/dist`.

## Executive Summary

Pi exposes compaction events, branch projection, custom session entries, skill command metadata, model-specific settings, and context handlers. Package helpers already provide request estimation and effective context mapping. The package extension list contains no skill-restoration entry.

## Background and Context

`target-picture.md` records the approved outcome and authority. `project-state.md` records the passing baseline after rebasing onto local main and isolating validation from inherited subagent variables.

## Method and Data Sources

The investigation traced package and installed Pi source and read adjacent tests. The baseline ran the full project checks. Historical user-session samples and provider-cache behavior were not measured again.

## Observations

- Pi `core/agent-session.js`, `AgentSession.compact` and `_runAutoCompaction`, append compaction, refresh context, and emit `session_compact` for native and extension summaries. The completion event has no pre-compaction message array. Its compaction lookup matches summary text, so equal summaries can select an earlier entry. The current branch contains the newly appended compaction.
- Pi `core/session-manager.js`, `buildSessionProjection`, applies context-edit omissions and replacements to the selected branch. `buildContextEntries` places the latest compaction first and retains entries from its first-kept ID. Older compactions inside that retained range contribute no messages.
- `pi-package/shared/context-projection.ts`, `buildContextEntryMapping`, associates effective messages with source entries. Its replay helpers apply package projection. `context-projection.test.ts` covers context edits, checkpoint mapping, and retained suffix replay.
- Pi `AgentSession._expandSkillCommand` inserts a user-message skill block with a location attribute containing the skill file path. `AgentSession._bindExtensionCore` exposes skill commands through `getCommands` with source and sourceInfo.
- Pi resource loading assigns skill-file source paths for default and metadata loading. A custom resource-loader override can preserve its supplied sourceInfo. The public command catalog therefore exposes the loader's declared provenance.
- `pi-package/shared/context-projection.ts` resolves read arguments from path or file_path, strips a leading @, expands home prefixes, and resolves against cwd. Its containment predicate rejects every relative name beginning with two dots, including a descendant named ..notes.md.
- Pi custom entries persist data but contribute no model messages. Session start and tree events allow branch-scoped state reconstruction. `pi-package/extensions/context-projection/index.ts` already reconstructs state on these events.
- Pi `SettingsManager.getCompactionSettings(model)` returns reserveTokens and keepRecentTokens with selected model overrides. `pi-package/shared/native-compaction-settings.ts` currently omits the model and returns only reserveTokens. Its callers are compaction-trigger and footer.
- Pi's native comparison is strictly greater than its numeric threshold. compaction-trigger interrupts at equality. This investigation does not change that comparison contract.
- `pi-package/shared/context-size.ts`, `estimateSerializedInputTokens`, estimates normalized system content, tools, and messages with o200k_base and framing reserves. `active-tool-definitions.ts` provides active tool schemas.
- Pi runs context handlers in extension order and removes system messages from ordinary context events. Context-projection requires matching session-message provenance. Compaction-trigger can block a request with an empty message list and reads usage independently of the context event's messages.
- Pi context accounting uses provider usage or projected estimates depending on the branch and response. Dynamically inserted messages are not persisted canonical messages. Stable inserted content is observable in a request; provider cache behavior remains provider-dependent.
- Suite storage helpers honor PI_AGENT_SUITE_DIR. cmux and project-rules provide enabled configuration patterns, but no shared once-only-warning guarantee. Entry renderers receive an expanded flag.
- run-subagent passes the package path explicitly to child Pi. Its conversation filter excludes plain custom entries. Existing runtime loading tests cover main and child package loading.
- The package system prompt currently names compaction and truncation as reread conditions. The proposed change removes the compaction condition and retains truncation.
- Raw HTML and JSONL exports include persisted custom entries. A context-only inserted message is not a separately persisted transcript entry. consult-advisor replays session projection without the main context-handler chain.

## Analysis and Interpretations

Deferred to the problem, requirements, and technical-solution stages.

## Hypotheses and Tests

Restoration-specific behavior has no implementation or tests yet. Implementation verification must cover record replay, selection, packing, configuration, rendering, and real runtime loading. Existing tests cover the adjacent helpers listed above.

## Options and Trade-offs

No alternatives evaluated in this facts stage.

## Recommendation

No recommendation in this facts-only result.

## Action Plan

No implementation actions in this stage.

## Assumptions

Historical sample totals in problem.md and provider-cache outcomes were not used as newly measured facts.

## Open Questions

No unresolved user decision blocks the agreed scope. Restoration-specific behavior will be verified during implementation because the feature does not yet exist.

## References

- `pi-package/shared/context-projection.ts` and its tests.
- `pi-package/shared/context-size.ts` and its tests.
- `pi-package/shared/native-compaction-settings.ts` and its tests.
- `pi-package/extensions/compaction-trigger/index.ts`.
- `pi-package/extensions/custom-compaction/index.ts`.
- `test/integration/runtime-package-loading.test.ts`.
- Installed Pi `core/agent-session.js`, `core/session-manager.js`, `core/settings-manager.js`, and `core/extensions/runner.js`.
