# Technical Solution: Current tasks in projection summaries

## Problem Statement
See [Problem statement](problem.md) and [Requirements](prd.md). The summary model writes each projection summary without the current tasks of the agent. The requirements set the algorithm: one request to the task model per batch reads the current session and names the current tasks, and each summary request of the batch receives the answer as a separate block.

## Proposed Solution

### M1. Shared task request (FRQ-01, FRQ-02)
A new module in `shared/` sends the task request for both extensions. It receives the session messages and returns the text of the current tasks or a failure. `shared/tool-result-summary.ts` already has 844 lines, so the task request lives in its own module.

- The module sends the session in the way that `ask-llm` and `consult-advisor` send it: it converts the session messages to LLM messages, removes system messages, appends a user message with the task prompt, and declares no tools. The system prompt of the request is the task system prompt.
- `context-projection` passes the session as the agent sees it: tool results that earlier projections replaced carry their summaries or omitted notices, and the tool results of the current batch are still full.
- `custom-compaction` passes `currentProjectedMainMessages`, which it already builds before compaction and which hold the session in the same form.
- The request does not carry the system prompt of the main agent. This prompt holds project rules and tool descriptions. The user requests and the workflow state are in the session messages, because `workflow` publishes its state as messages. The system prompt would add its size to the request without adding tasks.
- Rejected option: Pi `serializeConversation`. It truncates each tool result to 2,000 characters, so the task model would not read the whole session that FRQ-01 requires.

### M2. Task block in the summary request (FRQ-01)
`buildSummaryContext` adds a separate block with the task text to the user message of the summary request and escapes it in the same way as `<tool_call>` and `<tool_result>`. The block appears only when the task request returned tasks. The extension does not parse the task text and inserts it as the task model returned it. The bundled summary system prompt describes the block and asks the summary model to keep the facts of the tool result that these tasks need.

### M3. One task request per batch (FRQ-01, FRQ-02)
The module sends the task request only when summaries are enabled, the summary runtime configuration resolves, and the batch has at least one summary candidate. The task text stays in memory until the batch ends. The extensions do not persist it in the session.

### M4. Model and prompt settings (FRQ-04, FRQ-05)
- The task settings live in a nested object inside `summary` of the `context-projection` configuration. Both extensions already read `summary`, and the tasks serve only summaries. The object configures the task model, its thinking level, and the system and user prompt files. It follows the validation of `summary`: prompt paths are absolute or home-prefixed, and an unknown key makes the configuration invalid.
- The extension selects the task model in this order: the task model of the configuration, then `summary.model`, then the current model of the agent. Aliases and thinking levels resolve in the same way as for `summary.model`.
- The bundled default prompts live in `shared/prompts`.
- Retries of the task request use `summary.retryCount` and `summary.retryDelayMs`.
- Rejected option: a separate top-level key. It would allow task settings while summaries are disabled, and without summaries nothing uses the tasks.

### M5. Task request failure (FRQ-03)
- Each failure of the task request leads to the same result: the extension shows an error to the user and writes the summaries of the batch without the task block. Failures include a task model, alias, or authentication that does not resolve, a task prompt file that cannot be read or is empty, a session that does not fit into the context window of the task model, a provider error after all retries, an empty answer, and a thrown request.
- Before the request, the module checks with the existing estimator `doesContextFitModel` that the session fits into the context window of the task model.
- `context-projection` shows the error through `ctx.ui.notify` with level `error`. `custom-compaction` shows it through its progress reporter. When Pi has no UI, for example in `pi -p`, both extensions write the error to stderr, as `workflow` does with its warnings.
- When the user aborts the run, for example with Esc, the task request stops in the same way as summary requests stop now.

### M6. Usage records
The extension passes each response of the task model to `publishUsageEvent` with its own source name, as it does for summary responses. Without this record, `usage` does not count the cost of the task request.

### Trade-offs
- R1. Latency. Pi awaits the `context` handler before the provider request of the main agent. At each projection level and before compaction, the agent therefore also waits for the task request, which reads 200,000 to 250,000 tokens. Summary requests have no timeout, and the task request has none either. The user can abort it with Esc.
- R2. Context window. When the context window of the task model is smaller than the session, each batch ends with the error of M5. The user selects a task model with a larger window (FRQ-05).
- R3. Custom summary prompts. A summary system prompt that the user set through `summary.systemPromptFile` does not describe the task block. The user adds this description, and the documentation states it.
- R4. Older package versions. An older package version that reads a configuration with the new key treats the configuration as invalid and shows `CP!`.

The implementation updates `docs/extensions/context-projection.md` and `docs/extensions/custom-compaction.md`.

## Overengineering and Overspecification Considerations
- The shared module has two users: `context-projection` and `custom-compaction`.
- The fit check serves the case of FRQ-03 in which the session does not fit into the window of the task model.
- Retries reuse the existing summary settings and add no parameter. Provider errors occur for summary requests, which is why `summary.retryCount` exists.
- The usage record follows the existing rule that each helper request publishes its cost.
- Left out because no requirement needs them: a separate switch for tasks, persistence of tasks, diagnostic entries for task request failures, reuse of tasks between projection and compaction, and separate retry settings.
- Left to the implementer: names of the module, configuration keys, prompt files, and the task block; the wording of the error message; the text of the bundled prompts.

## Open Questions
No open questions.

## References
- [Problem statement](problem.md) - problem and scope
- [Requirements](prd.md) - FRQ-01 to FRQ-05
- [Idea](idea.md) - initial idea and cost estimate
- `pi-package/shared/tool-result-summary.ts` - summary request and runtime configuration
- `pi-package/shared/tool-result-projection.ts` - batch of summary requests
- `pi-package/extensions/context-projection/index.ts` - projection at L1, L2, and L3
- `pi-package/extensions/custom-compaction/compaction-source-projection.ts` - summaries before compaction
- `pi-package/extensions/ask-llm/index.ts` - existing pattern that sends the session to another model
