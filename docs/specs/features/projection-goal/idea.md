# Idea: Current Tasks in Projection Summaries

The problem is described in [problem.md](problem.md).

## Idea
Before the summary model writes a batch of projection summaries, a separate request learns the current tasks of the main agent from the session history. The extension then adds these tasks to the request of each projection summary in the batch. With the tasks, the summary model can choose the facts of a tool result that the main agent needs for them.

## How it works
1. A batch starts in two cases: `context-projection` crosses a projection level, or `custom-compaction` prepares the part of the conversation that compaction discards.
2. Before the batch, the extension sends one request to the task model: the model that lists the current tasks of the main agent. The request holds the session history that the main agent sees and asks for the list of its current tasks.
3. The task model answers with the list of current tasks.
4. The extension adds this list to the request of each projection summary in the batch, next to the tool call and the tool result.
5. The system prompt of the projection summary asks the summary model to keep the facts of the tool result that these tasks need.

The task model has its own setting. When this setting is not set, the extension uses the model of `summary.model`.

The extension shows an error to the user and continues the batch without the list of tasks in two cases:
- the session history does not fit into the context window of the task model;
- the request of step 2 fails or returns no tasks.

The summaries of such a batch are written as now, from the tool call and the tool result only. The main agent continues its work.

Example: the current task is "change the signature of `setMainWorkflowPolicy` and update every call". A `grep` result shows 22 call sites. The task tells the summary model that every call site matters, so the summary model has a reason to keep all 22 lines in the summary.

## Cost
The task model differs from the main model, so the request of step 2 cannot reuse the provider cache of the main session. The request reads the whole history at the input price of the task model.

- One request serves the whole batch, so the cost depends on the number of batches and does not depend on the number of summaries.
- With a 272,000-token context window, the first projection level starts at 202,000 tokens of context, and the third at 242,000. With a task model priced at $0.2 per million input tokens, one request costs about $0.04 to $0.05.
- This is about 15% of the cost that one projection already adds: the projection changes old messages of the main session, and the next request of the main agent reads the whole context without the provider cache, about $0.31 at these sizes.
- A replay of 385 sessions from one month gives 140 projections, which adds about $6, or about 1% of the spending of these sessions.

## Risks
- A summary that fits the current tasks can drop a fact that a later task needs. The notice above each summary already tells the main agent to run the tool again for the full result, so the main agent can recover such a fact.
- The task model can name the current tasks wrongly, for example after the user changed the direction of the work. The summaries of this batch then keep facts for wrong tasks.

## Open Questions
No open questions.
