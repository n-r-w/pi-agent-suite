# Domain Glossary

- active agent run: Processing that starts when Pi accepts a task and ends at `agent_settled`.
- automatic compaction: Compaction initiated without a user `/compact` command.
- compaction initiation: Blocking the next model request and starting Pi's compaction mechanism.
- compaction threshold: The effective threshold enforced by `compaction-trigger` before a model request.
- context projection: A provider-visible replacement of selected context content that does not rewrite persisted session history.
- `context-projection`: The extension responsible for context projection.
- `custom-compaction`: The extension responsible for creating a custom summary after Pi emits `session_before_compact`.
- effective compaction threshold: The value `min(contextWindow, contextWindow - reserveTokens + contextWindow * thresholdDeltaPercent / 100)` when Pi compaction and `compaction-trigger` are enabled.
- immediate compaction: Compaction that completes before Pi sends the next model request whose calculated context reaches the compaction threshold.
- maximum context: The active model's `contextWindow` value.
- model request: One provider request made by the agent loop for the active model.
- native compaction threshold: The value `contextWindow - reserveTokens` when Pi's `compaction.enabled` is `true`.
- threshold crossing: The state in which the calculated context for the next model request is at or above the compaction threshold.
- threshold delta percentage: The non-negative `thresholdDeltaPercent` value. It permits the enforced threshold to exceed the native compaction threshold by a percentage of `contextWindow`, subject to the maximum-context cap.
