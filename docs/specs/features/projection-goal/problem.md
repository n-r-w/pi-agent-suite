# Problem Statement

## Key definitions and abbreviations
- Projection: `context-projection` replaces old large tool results in the provider context of the main agent with shorter text. The session file keeps the full results.
- Projection summary: the text that a separate summary model writes for one tool result. The main agent sees it in place of the full result after projection, and the compaction model reads it in place of the full result during compaction.

## Context
In a long session, `context-projection` frees context before Pi compacts the whole conversation. It acts at three levels, when the remaining context reaches 70,000, 50,000, and 30,000 tokens by default. At each level, it replaces old successful text tool results larger than a level threshold with projection summaries. With a 272,000-token context window, the first level starts at 202,000 tokens of context.

## Observed Problem
The summary model writes each projection summary without knowing what the main agent is working on. It keeps the facts that it considers important in general. When the main agent later needs a fact that the summary dropped, the agent either runs the tool again or continues without the fact.

## Affected Audience
- The main agent of a Pi session in which projection with summaries is enabled.
- The developer who works with this agent and receives its results.

## Evidence
- `buildSummaryContext` in `shared/tool-result-summary.ts` sends the summary model one user message with three parts: the tool call, the tool result, and a fixed request to summarize the result "for later task continuation". The request has no user messages, no plan, and no other part of the conversation.
- The system prompt `shared/prompts/tool-result-summary-system.md` asks the summary model to "Preserve exact facts needed to continue work" and lists categories of such facts: paths, line numbers, errors, test results, and others. The prompt gives no criterion for choosing among facts of the same category.
- Pi session logs from 2026-09-18 to 2026-10-26 hold 2,664 projected tool results in 85 sessions. Among them, 1,196 come from `read`, 835 from `bash`, 335 from `team_message_get`, and 132 from `grep`. The median original result has 17,951 characters, and the median replacement text has 1,737 characters.
- Example: the agent searched `pi-package/extensions/workflow/index.test.ts` for `setMainWorkflowPolicy`, and the result showed 22 call sites. The projection summary groups the call sites by purpose and gives line ranges. Lines 620, 1859, and 2526 fall outside these ranges. The summary does not state that its list is incomplete. The summary also states that the tests cover "invalid workflow names", which the result does not show. The test at line 2566 passes the name `another-workflow`.
- A replay of token usage covers 385 sessions of `gpt-6.1-sol` without subagents from 2026-09-29 to 2026-10-26. With a 272,000-token window, the replay gives 140 projections, and 65 sessions reach the first level. With the 372,000-token window that these sessions used, the replay gives 39 projections, and 11 sessions reach the first level.

## Impact
- HIGH: the main agent relies on a summary that lacks a fact that its task needs, and the result of the task changes. For example, the agent changes the signature of a function and updates only the call sites that the summary lists. The developer sees an incomplete change. This impact is an assumption: the logs were not checked for such cases.
- MEDIUM: the main agent runs the tool again to recover a dropped fact. The developer waits for the extra call, the session spends tokens on it, and the full result enters the context again.

Both impacts grow with the number of projections. With the 272,000-token window, the replay gives about 3.5 times more projections than with the 372,000-token window.

## Current State
Before each provider request, `context-projection` computes the remaining context. When the remaining context first crosses a level threshold after the latest compaction, the extension selects candidates for that level. A candidate is an old successful text tool result above the size threshold of the level, outside the newest tool-use turns that the configuration protects. For each candidate, the extension sends one request to the summary model in a separate provider session. The summary replaces the result in the provider context, under a notice that tells the main agent to run the tool again for the full result.

Before compaction, `custom-compaction` prepares the part of the conversation that compaction discards. When `projectCompactionSource` and `summary.enabled` are both `true`, it reuses existing projection summaries in this part. For each other successful text tool result of at least `minToolResultTokensL3` tokens, it generates a projection summary with the same request. The compaction model then reads these summaries in place of the full results.

## Desired State
Each projection summary keeps the facts of its tool result that the main agent needs for its current tasks. After projection, the main agent continues these tasks without running tools again to recover dropped facts.

## Problem Boundary
- In scope: projection summaries that `context-projection` writes at levels L1, L2, and L3 for the main agent.
- In scope: projection summaries that `custom-compaction` generates for tool results in the part of the conversation that compaction discards.
- In scope: sessions with projection summaries enabled, with any main model and any summary model.
- Out of scope: the summary that the compaction model writes for the whole conversation. The compaction model reads the conversation and therefore sees the tasks of the agent.
- Out of scope: tool results that projection replaces with the omitted notice only, without a summary.

## Assumptions
- The facts that the main agent needs from a tool result depend on its current tasks. For example, a list of all call sites matters for a change of a signature and does not matter for reading the purpose of a function.
- After projection, the main agent sometimes relies on the summary instead of running the tool again, despite the notice.

## Open Questions
No open questions.
