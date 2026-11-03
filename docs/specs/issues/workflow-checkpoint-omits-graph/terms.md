# Terms

- Workflow graph: all stages of a workflow with their descriptions and `initial` or `final` flags, and all transitions between the stages with their endpoints and types.
- Activation record: the hidden `<workflow_activated>` message that the workflow extension appends when a workflow starts.
- Checkpoint: the hidden `<workflow_checkpoint>` message that the workflow extension appends to restore the workflow state in the model context.
- Kept entries: the most recent session entries that Pi passes to the model unchanged after a compaction, about 20,000 tokens with the default setting `keepRecentTokens`.
- Summarized part: the session entries before the kept entries, which Pi replaces with a summary that a model writes.
