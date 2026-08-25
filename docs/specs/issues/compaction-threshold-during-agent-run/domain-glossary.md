# Domain Glossary

- active agent run: Processing that starts when Pi accepts a task and ends at `agent_settled`.
- automatic compaction: Compaction initiated without a user `/compact` command.
- compaction initiation: Blocking the next model request and starting Pi's compaction mechanism.
- compaction threshold: The value `contextWindow - reserveTokens` when `compaction.enabled` is `true`.
- context projection: A provider-visible replacement of selected context content that does not rewrite persisted session history.
- `context-projection`: The extension responsible for context projection.
- `custom-compaction`: The extension responsible for creating a custom summary after Pi emits `session_before_compact`.
- immediate compaction: Compaction that completes before Pi sends the next model request whose calculated context reaches the compaction threshold.
- maximum context: The active model's `contextWindow` value.
- model request: One provider request made by the agent loop for the active model.
- threshold crossing: The state in which the calculated context for the next model request is at or above the compaction threshold.
