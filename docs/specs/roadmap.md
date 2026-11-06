# Roadmap

This roadmap lists specifications and issues whose implementation is not complete.

- [ ] [Repeated compaction can corrupt retained context](issues/repeated-compaction-retained-context/)
- [ ] [Agent retry drops partial response from model context](issues/agent-retry-drops-partial-response/)
- [ ] [Subagent feedback is not reconciled](issues/subagent-feedback-not-reconciled/)

## Potential improvements

Items in this section need a decision on whether to implement them.

- [ ] [Repeated workflow stage information duplicates model context](issues/repeated-workflow-stage-context/): under this proposal, the workflow extension omits the stage goal and transition grounds from the record of a repeated entry into a known stage. FRQ-05 and FRQ-07 of [workflow format 2](features/workflow-format-v2/prd.md) require both parts in this record. In the session that the problem statement cites, stage goals, available transitions, and final-stage leave guidance in such records take 9,001 of 58,193 characters of workflow records.
