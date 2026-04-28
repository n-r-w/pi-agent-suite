# run-subagent

## Purpose

`run-subagent` owns the `run_subagent` tool and child `pi` execution.

## Behavior

- Is enabled by default when `run-subagent.json` is missing.
- Registers tool `run_subagent`.
- Accepts `agentId` and `prompt`.
- Runs one callable agent per tool call.
- Publishes the callable-agent list into the model context.
- Restores the selected main agent before building the callable-agent prompt.
- Filters callable agents by the selected main agent's `agents` allowlist.
- Rejects tool calls for callable agents blocked by the selected main agent's `agents` allowlist.
- Starts a child `pi` process with `--mode rpc`, `--no-session`, explicit `--model`, and explicit `--thinking`.
- Sends the child prompt through RPC stdin.
- Treats the RPC prompt response as prompt acceptance or prompt failure, not as subagent completion.
- Treats `agent_end` as the completion event for one child prompt.
- Cancels blocking child RPC UI requests with deterministic responses.
- Closes child stdin after normal completion.
- Sends RPC `abort` when the parent abort signal fires, waits for completion, closes child stdin, and terminates the child only after the abort timeout.
- Converts child RPC session events into logical progress events.
- Ignores raw `text_delta` chunks for TUI progress and never uses them as successful final output without a completed assistant message.
- Applies Pi `truncateTail` behavior to the final child answer before returning model-facing tool result `content`.
- Saves the complete final child answer to a system temp file when the answer exceeds Pi output truncation limits.
- Adds a `Full output: {path}` notice to truncated model-facing `content`.
- Stores `truncation` and `fullOutputPath` in tool result `details` when the final child answer is truncated.
- Renders live subagent status through a width-aware widget component.
- Shows positive child-owned context-projection savings before the same child's context usage in widget rows.
- Does not copy parent footer statuses or context-overflow limits into subagent widget rows.
- Renders collapsed and expanded tool results through width-aware components.
- Renders child agent, model, thinking level, context usage, and elapsed time in the `run_subagent` tool-call header.
- Does not repeat child runtime metadata as a separate row in collapsed or expanded result body.
- Shows the latest `COLLAPSED_SUBAGENT_RESULT_LINES` progress events in collapsed tool results.
- `COLLAPSED_SUBAGENT_RESULT_LINES` is exported from `pi-package/extensions/run-subagent/rendering.ts`.
- Does not duplicate the child final answer in collapsed tool results because the answer is already shown as assistant output.
- Shows `... (xx more lines, yy total, {key} to expand)` when collapsed output hides earlier progress events.
- Passes `PI_SUBAGENT_AGENT_ID` and `PI_SUBAGENT_DEPTH` to the child process environment.
- Owns the child process tool policy through child `pi` CLI tool flags.
- Passes `PI_SUBAGENT_TOOLS` when child tools are explicitly resolved.
- Uses `--tools` for a non-empty child tools list.
- Uses `--no-tools` for an empty child tools list.
- Does not pass tool flags when `tools` is missing from the agent definition.
- Rejects full wildcard `*`.
- Resolves narrower wildcard patterns against the tool list from `pi.getAllTools()`.
- Limits nesting through `maxDepth`.
- Removes `run_subagent` from active tools when the current process depth reaches `maxDepth`.
- Omits callable-agent guidance from the prompt when the current process depth reaches `maxDepth`.
- Publishes a contribution to `Agent Runtime Composition` for prompt and active tools.
- Does not call `pi.setActiveTools()` directly.
- Does not own main-agent selection.
- Does not own `consult_advisor`.

## Configuration

File: `~/.pi/agent/config/run-subagent.json`.

```json
{
  "enabled": true,
  "maxDepth": 1,
  "widgetLineBudget": 7
}
```

`enabled` is optional and defaults to `true`. `maxDepth` and `widgetLineBudget` are optional.

Rules:

- `enabled` must be a boolean value.
- Missing config enables `run_subagent` with default parameters.
- `enabled: false` prevents tool registration.
- `maxDepth` has integer type and must be greater than or equal to `0`.
- `widgetLineBudget` has integer type and must be greater than or equal to `1`.
- Default `maxDepth` is `1`.
- Default `widgetLineBudget` is `7`.
- Configuration error moves `run_subagent` to fail-closed state: `maxDepth` becomes `0`, `widgetLineBudget` becomes `7`, and the issue is shown only for `run-subagent`.

## Environment contract

- `PI_SUBAGENT_AGENT_ID`
- `PI_SUBAGENT_DEPTH`
- `PI_SUBAGENT_TOOLS`

## Verification

Tests must verify:

- no tool registration when `enabled` is `false`;
- unchanged public `run_subagent` schema;
- child `pi` startup with `--mode rpc`, `--no-session`, `--model`, and `--thinking`;
- environment contract propagation;
- `--tools`, `--no-tools`, and missing `tools` behavior;
- fail-closed behavior on configuration error;
- removal of `run_subagent` from active tools at `maxDepth`;
- omission of callable-agent guidance at `maxDepth`;
- contribution publication to `Agent Runtime Composition` without direct `pi.setActiveTools()` calls;
- callable-agent prompt filtering from the selected main agent's `agents` allowlist;
- execution rejection for callable agents blocked by the selected main agent's `agents` allowlist;
- TUI progress rendering that does not expose raw `text_delta` chunks;
- final output extraction from completed assistant `message_end` events before `agent_end`;
- deterministic cancellation of blocking RPC UI requests;
- stdin close after normal completion and bounded stdin error diagnostics;
- abort behavior that sends RPC `abort`, waits for completion, closes stdin, and terminates only after timeout;
- runtime metadata placement in the `run_subagent` tool-call header;
- absence of a standalone status/runtime row in the result body;
- collapsed result preview height through `COLLAPSED_SUBAGENT_RESULT_LINES`;
- collapsed result rendering that shows latest progress events, not earliest progress events;
- collapsed result rendering that does not duplicate the child final answer;
- model-facing truncation of large final child answers;
- exact full-output temp file content for truncated final child answers;
- unchanged model-facing content when the final child answer does not exceed Pi output truncation limits;
- Pi-style hidden-line expansion hint for collapsed long progress;
- widget rows that show positive child-owned context-projection savings before the same child's context usage;
- widget rows that ignore parent footer statuses, context-overflow limits, zero projection savings, projection errors, and cleared projection status;
- widget and collapsed result lines that stay within the terminal width passed to `render(width)`.
