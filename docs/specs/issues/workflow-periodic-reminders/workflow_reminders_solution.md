# Technical Solution: Periodic Workflow Reminders

## Problem Statement

- **PRB-01:** A long-running active stage publishes no new workflow state until a lifecycle change or compaction occurs.
- **PRB-02:** A reminder must follow the configured activity interval and contain only the active workflow and stage IDs.

## Proposed Solution

### Configuration

- **CFG-01:** Add `reminderToolCallInterval` to `workflow/config.json`.
- **CFG-02:** Accept safe integers greater than or equal to `0`. Default to `50`. A value of `0` disables reminders.
- **DEC-04:** The default remains `50`. The source analysis measured 6,467 tool-call intervals across 688 workflow sessions, but it did not measure reasoning turns and does not predict reminder frequency under activity counting.
- **CFG-03:** Extend the existing strict atomic configuration parser. Invalid values follow the existing workflow configuration failure path.

```json
{
  "reminderToolCallInterval": 50
}
```

### Reminder scheduler

- **SOL-01:** Add a small scheduler that owns the activity count and tracks whether current workflow state was published during the active model turn.
- **SOL-02:** At `turn_end`, count the greater of `event.toolResults.length` and one reasoning unit. A final assistant message has one reasoning unit when any `thinking` block contains text, a `thinkingSignature`, or `redacted: true`.
- **DEC-01:** Pi emits `turn_end` after the complete tool batch and before it reads queued `steer` messages for the next model request.
- **DEC-02:** Scheduling at `turn_end` produces at most one reminder per parallel batch and uses workflow state after every tool has finished.

### Algorithm

- **ALG-01:** Clear the per-turn workflow-publication marker when a model turn starts.
- **ALG-02:** Workflow activation, stage entry, current-stage editing, checkpoint publication, and reminder publication reset the counter.
- **ALG-03:** When current workflow state was published during a turn, do not count that turn. The model receives the fresh state with the turn result.
- **ALG-04:** Otherwise, add the greater of the completed tool-call count and one reasoning unit. Multiple reasoning blocks contribute one unit per completed turn.
- **ALG-05:** When the interval is reached during a reasoning-only turn and workflow status remains `active`, publish one reminder through `deliverAs: "nextTurn"`. Pi queues the reminder for the next user prompt without starting a provider request.
- **ALG-06:** When the interval is reached during a non-terminating tool turn and workflow status remains `active`, publish one reminder through `deliverAs: "steer"`.
- **ALG-07:** Reset the counter to zero after publication. Discard overshoot because one completed turn produces at most one reminder.

### Message contract

- **EVC-01:** Add a persistent journal record with this shape:

```xml
<workflow_reminder id="delivery" active_stage_id="implementation" />
```

- **EVC-02:** Include no transitions, guidelines, descriptions, route history, or inactive-stage data.
- **EVC-03:** Use `customType: "workflow"`, `display: false`, `deliverAs: "steer"`, and journal kind `reminder`.
- **EVC-04:** A reminder does not change the route, stage definitions, or the journal's known-stage set.

### Lifecycle

- **SOL-03:** Reset the scheduler only for journal records that carry current workflow state. An inactive-stage update and activation options do not reset it.
- **SOL-04:** Reset runtime count on `session_start` and `session_tree` so another process or branch cannot contribute stale count.
- **SOL-05:** Compaction already publishes a checkpoint and therefore starts a new reminder interval.
- **SOL-06:** Keep the counter in runtime memory. Do not add it to `workflow-state` or reconstruct it from session history.

### Context and prompt cache

- **DEC-03:** Publish reminders through the existing persistent journal. Do not add a `context` handler or mutate the system prompt.
- **TRD-01:** Each reminder extends history but leaves the earlier prompt prefix unchanged. The self-closing marker and configurable interval limit context growth.
- **TRD-02:** Runtime reset can delay a reminder by at most the configured number of new tool calls after restart or branch navigation. Exact restoration would add history parsing without material benefit.

### Validation

- **TST-01:** Configuration behavior test.
  - Purpose: Prove the `reminderToolCallInterval` contract.
  - Input and expected output: An omitted field gives `50`; `0` and a positive integer are retained.
  - Edge cases: Negative, fractional, unsafe integer, and string values reject configuration.
  - Dependencies: Temporary `config.json` files and the existing loader.
- **TST-02:** Journal behavior test.
  - Purpose: Prove reminder content and metadata.
  - Input and expected output: Active state produces one self-closing `workflow_reminder` with the current workflow and stage IDs.
  - Edge case: XML-sensitive ID characters are escaped.
  - Dependencies: `WorkflowJournal` and validated workflow state.
- **TST-03:** Scheduler behavior test.
  - Purpose: Prove threshold, reset, reasoning, and batching behavior.
  - Input and expected output: Batches of `20` and `30` calls with interval `50` produce one reminder decision. Two reasoning-only turns reach interval `2` and produce one reminder decision.
  - Edge cases: A batch of `125` produces one decision; fresh workflow state resets the interval.
  - Dependencies: A scheduler with no Pi runtime dependency.
- **TST-04:** Extension event test.
  - Purpose: Prove the connection between `turn_end`, active workflow state, reasoning, and the journal.
  - Input and expected output: Plain reasoning and signature-only encrypted reasoning each contribute one unit. A tool turn at the interval sends one reminder with `deliverAs: "steer"`; a reasoning-only turn at the interval sends one reminder with `deliverAs: "nextTurn"`.
  - Edge cases: Multiple reasoning blocks in one turn contribute one unit; an empty unsigned block contributes none; `nextTurn` does not start a provider request; a stage transition in the same batch leaves only the fresh stage record for the next request.
  - Dependencies: The existing fake Pi in `pi-package/extensions/workflow/index.test.ts`.
- **TST-05:** Real Pi integration test.
  - Purpose: Prove that the reminder reaches the next provider request.
  - Input and expected output: An isolated provider executes the required tool calls and receives `workflow_reminder` in its next context.
  - Edge case: The test exits before any network request.
  - Dependencies: `test/integration/runtime-package-loading.test.ts`.

## Overengineering and Overspecification Considerations

- **CHK-01:** The design uses existing `turn_end`, journal, and `deliverAs: "steer"` contracts.
- **CHK-02:** It adds no provider adapter, `context` handler, persistent counter, or workflow schema field.
- **CHK-03:** Exact count restoration and adaptive intervals remain outside scope.

## Open Questions

No open questions remain.

## References

- **REF-01:** `pi-package/extensions/workflow/context.ts` - Journal and transition rendering.
- **REF-02:** `pi-package/extensions/workflow/index.ts` - Workflow events and lifecycle.
- **REF-03:** `pi-package/extensions/workflow/config.ts` - Strict configuration parsing.
- **REF-04:** `docs/extensions/workflow.md` - Workflow model-context contract.
- **REF-05:** `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` - Pi event order and `steer` delivery.
- **REF-06:** `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` - `turn_end` and steering queue order.
