# Deferred workflow activation options

`/agent` previously published workflow activation options through the policy-change callback. Selecting agents without starting work appended intermediate values to session history. Steering those values during a run could also request extra model responses.

The approved behavior is:
- Agent selection while idle updates runtime settings without publishing workflow options.
- Selection during a run retains only the last pending agent, including the no-agent choice. The next idle input applies that selection before model validation and prompt assembly.
- `before_agent_start` returns an activation-options message only when the selected branch requires a new value. Pi appends the message with the new input.
- Published history remains append-only. Deduplication uses persisted branch evidence, not an undelivered candidate.
- Workflow lifecycle messages and automatic compaction retain their continuation behavior.

Runtime contracts are documented in [main-agent-selection](../../../extensions/main-agent-selection.md) and [workflow](../../../extensions/workflow.md).

Regression coverage includes idle selection sequences, busy command and shortcut selection, cancellation, shutdown, branch changes, manual and automatic compaction, and unpersisted message preparation. `test/integration/workflow-agent-selection.test.ts` uses real Pi CLI with an isolated fake provider to check model and tool selection, request counts, workflow-record counts, and preservation of the session-history prefix.
