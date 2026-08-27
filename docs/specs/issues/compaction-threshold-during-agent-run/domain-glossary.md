# Domain Glossary

- active agent run: Processing that starts when Pi accepts a task and ends at `agent_settled`.
- automatic compaction: Compaction initiated without a user `/compact` command.
- compaction coordination: Selection between a successful native post-run compaction and a manual compaction that is still required after request interruption.
- compaction initiation: Blocking the next model request and starting Pi's compaction mechanism when no successful compaction has already completed for the threshold crossing.
- compaction threshold: The value `contextWindow - reserveTokens` enforced by `compaction-trigger` before a model request when Pi compaction is enabled.
- context projection: A provider-visible replacement of selected context content that does not rewrite persisted session history.
- `context-projection`: The extension responsible for context projection.
- `custom-compaction`: The extension responsible for creating a custom summary after Pi emits `session_before_compact`.
- immediate compaction: Compaction that completes before Pi sends the next model request whose projection-aware context usage reaches the compaction threshold.
- maximum context: The active model's `contextWindow` value.
- model request: One provider request made by the agent loop for the active model.
- native post-run compaction: Automatic compaction performed by Pi after the low-level agent run ends and before `agent_settled`.
- native compaction threshold: The value `contextWindow - reserveTokens` when Pi's `compaction.enabled` is `true`.
- projection-aware context usage: The token count returned by `getProjectionAwareContextUsage` from Pi's context usage after pending projection savings are subtracted.
- threshold crossing: The state in which projection-aware context usage for the next model request is at or above the compaction threshold.
