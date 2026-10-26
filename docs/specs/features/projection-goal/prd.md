# Idea: Current tasks in projection summaries

## Definitions

See [Terms](terms.md).

## Context and problem

See [Problem statement](problem.md).

## Goal

Each projection summary keeps the facts of its tool result that the current tasks of the agent need.

## Scenarios

- SCN-01: The remaining context of a session crosses L1, L2, or L3, and `context-projection` writes summaries for new projected tool results. The summary model knows the current tasks of the agent.
- SCN-02: Before compaction, `custom-compaction` generates summaries for tool results in the part of the conversation that compaction discards. The summary model knows the current tasks of the agent.
- SCN-03: The request for the current tasks fails, or the session does not fit into the context window of the task model. The summaries are written without the tasks, the user sees an error, and the agent continues its work.

## Scope and non-scope

In scope: projection summaries of `context-projection` at L1, L2, and L3, and projection summaries that `custom-compaction` generates before compaction, in main sessions and in subagent sessions.

Out of scope: the summary that the compaction model writes for the whole conversation, and projection that replaces a tool result with the omitted notice only.

## Requirements

### Functional Requirements

- [x] FRQ-01: When `context-projection` projects tool results at L1, L2, or L3, the extension sends one request to the task model before the summary requests. The request holds the whole current session and a dedicated prompt that asks the task model which tasks and goal of the agent are current. The extension inserts the answer as a separate block into each summary request of this projection, and the summary model uses this block to choose the facts of the tool result that it keeps. Example: the task model answers "change the signature of `setMainWorkflowPolicy` and update every call", and the summary of a `grep` result lists all 22 call sites.
  - Origin: source. The algorithm that the task sets as a mandatory constraint.
  - Goal: projection summaries at L1, L2, and L3 keep the facts that the current tasks need.
  - Goal achievement: Full. The summary model receives the current tasks with each tool result.
  - Feasibility: Confirmed. At projection time, the extension receives the session messages and the system prompt of the agent, so it can send them to another model.
- [x] FRQ-02: The extension follows FRQ-01 for the summaries that `custom-compaction` generates before compaction for the part of the conversation that compaction discards.
  - Origin: formulated. Problem Boundary of the problem statement.
  - Goal: the compaction model reads summaries that keep the facts that the current tasks need.
  - Goal achievement: Full. These summaries use the same request as projection summaries.
  - Feasibility: Confirmed. Before compaction, the extension already builds the session that the agent sees, with existing projections applied.
- [x] FRQ-03: When the request for the current tasks fails, or the session does not fit into the context window of the task model, the extension writes the summaries without the block of tasks, as before this change. The agent continues its work, and the user sees an error.
  - Origin: source. `idea.md`, section How it works.
  - Goal: a failure of the task request stops neither projection nor the agent.
  - Goal achievement: Partial. Summaries of such a projection keep the facts without regard to the current tasks.
  - Feasibility: Confirmed. Both extensions already fall back for each tool result whose summary fails, and show notifications to the user. In a subagent session, Pi passes these notifications to the parent through RPC.
- [x] FRQ-04: The user can replace each prompt of the task request through the configuration, in the same way as `summary.systemPromptFile` and `summary.userPromptFile` replace the summary prompts. When the configuration names no prompt, the extension uses the prompt of the package.
  - Origin: source. The task.
  - Goal: the user adapts the choice of current tasks to the work without a change of the package.
  - Goal achievement: Full.
  - Feasibility: Confirmed. The package already replaces prompts of summaries and of compaction through configuration.
- [x] FRQ-05: The user can set the task model and its thinking level in the configuration. When the configuration names no task model, the extension uses the model of `summary.model`.
  - Origin: source. `idea.md`, section How it works.
  - Goal: the user chooses the task model apart from the summary model, for example a model with a larger context window.
  - Goal achievement: Full.
  - Feasibility: Confirmed. `summary.model` already resolves model aliases, thinking levels, and a fallback to the current model.

### Non-Functional Requirements

No non-functional requirements.

## Open Questions

No open questions.

## Technical Supplement

No technical supplement.

## References

- [Idea](idea.md)
- [Context projection](../../../extensions/context-projection.md)
- [Custom compaction](../../../extensions/custom-compaction.md)
