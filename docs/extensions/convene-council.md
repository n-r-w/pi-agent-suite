# convene-council

## Purpose

`convene-council` owns the `convene_council` tool and the bounded two-participant discussion loop.

Use it when a high-impact question benefits from two model participants comparing opinions before returning one answer.

## Behavior

- Registers tool `convene_council`.
- Accepts only `question`.
- Reads configuration from `~/.pi/agent/agent-suite/convene-council/config.json`.
- Is enabled by default when `config.json` is missing.
- Uses the current session model for each participant when that participant has no configured model ID.
- Uses the current thinking level for each participant when that participant has no configured thinking level.
- Allows LLM1 and LLM2 to use the same model or different configured models.
- Builds one base transcript from active branch conversation messages.
- Replays recorded `context-projection` placeholders or summaries before participant calls.
- Removes the pending `convene_council` tool call from participant transcripts.
- Gives LLM1 and LLM2 equivalent base context.
- Adds Pi-loaded context files such as `AGENTS.md` and `CLAUDE.md` to participant system prompts.
- Sends the council question through the first-turn task prompt.
- Uses a first-turn participant system prompt without structured output rules.
- Sends participant contexts with `tools: []`.
- Starts independent first-turn participant calls in parallel.
- Accepts first-turn participant opinions as non-empty text.
- Runs mutual missing-information answers and their clarification reviews in parallel.
- Keeps dependent review steps sequential when the next task uses the previous participant output.
- Requires later participant discussion responses as `<status>{AGREE|DIFF|NEED_INFO}</status><opinion>{text}</opinion>`.
- Retries malformed participant responses using `responseDefectRetries`.
- Retries defective final answers using `responseDefectRetries`.
- Retries provider request failures using `providerRequestRetries` and `providerRetryDelayMs`.
- Counts one participant iteration only after both LLM1 and LLM2 return accepted discussion responses.
- Stops when both participants report `AGREE` after reviewing an opponent opinion.
- Stops when `participantIterationLimit` is reached.
- Requests the final answer from `finalAnswerParticipant` after agreement.
- Returns a no-consensus result with `<result>`, `<answer1>`, and `<answer2>` blocks when the iteration limit is reached without agreement.
- Applies Pi-style output truncation to large tool results and writes the full result to a system temp file.
- Stores only truncation details when output is truncated.
- Emits live TUI progress through partial tool updates while the council is running.
- Keeps live TUI progress in partial result `details` only; final tool results keep the model-facing output contract.
- Shows a compact tool header with the current phase, iteration, elapsed time, question preview, and participant runtime mapping.
- Shows collapsed progress as the latest fixed-width council events with a standard Pi expand hint when older events are hidden.
- Shows short accepted-answer previews in response rows so users can see what each participant answered.
- Colors only participant labels: `A` uses the theme accent color and `B` uses the theme tool-output color.
- Keeps status, retry, and error colors semantic instead of coloring whole rows by participant.
- Shows expanded live progress with question, participant runtime details, and full retained progress history.
- Does not show raw transcripts, provider payloads, token deltas, or unbounded intermediate answers in progress rows.
- Publishes prompt guidance through `Agent Runtime Composition` only when `convene_council` is active for the current effective agent.
- Does not call `pi.setActiveTools()` directly.
- Does not own main-agent selection, `run_subagent`, or `consult_advisor`.

## Configuration

File: `~/.pi/agent/agent-suite/convene-council/config.json`.

```json
{
  "enabled": true,
  "llm1": {
    "model": {
      "id": "provider/model-a",
      "thinking": "high"
    }
  },
  "llm2": {
    "model": {
      "id": "provider/model-b",
      "thinking": "medium"
    }
  },
  "participantIterationLimit": 3,
  "finalAnswerParticipant": "llm2",
  "responseDefectRetries": 1,
  "providerRequestRetries": 4,
  "providerRetryDelayMs": 1000
}
```

All fields are optional.

Options:

- `enabled`: default `true`. Enables the `convene_council` tool.
- `llm1.model.id`: optional `provider/model` string. Uses the current model when missing.
- `llm1.model.thinking`: optional thinking level. Uses the current thinking level when missing.
- `llm2.model.id`: optional `provider/model` string. Uses the current model when missing.
- `llm2.model.thinking`: optional thinking level. Uses the current thinking level when missing.
- `participantIterationLimit`: default `3`. Must be a positive integer.
- `finalAnswerParticipant`: default `llm2`. Allowed values: `llm1`, `llm2`.
- `responseDefectRetries`: default `1`. Must be a non-negative integer.
- `providerRequestRetries`: default `4`. Must be a non-negative integer.
- `providerRetryDelayMs`: default `1000`. Must be a non-negative integer.

Allowed thinking values:

- `off`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

## Tool input

```json
{
  "question": "Which implementation approach should we use?"
}
```

`question` is required.

## Output

Agreement output is the final answer from the configured final answer participant.

Non-agreement output is:

```xml
<result>
Consensus was not reached.
<answer1> and <answer2> contain two different opinions.
</result>
<answer1>
latest LLM1 opinion
</answer1>
<answer2>
latest LLM2 opinion
</answer2>
```

The no-agreement output text is generated from `pi-package/extensions/convene-council/prompts/no-consensus-result.md`. The ordinary tool response does not include iteration count, retry count, participant statuses, or raw discussion history.

Live TUI progress is renderer metadata. It is emitted in partial tool updates while the tool runs and is not part of the final ordinary tool response.

Collapsed live progress example:

```text
convene_council · B reviews A · iter 2/3 · 18.2s
  Question: Which implementation should we use for TUI progress?
  A openai-codex/gpt-5.5/high · B anthropic/claude-sonnet-4-5/medium
→ A initial opinion
← A opinion: PostgreSQL is the safest default because hotel data is relational...
→ B initial opinion
← B opinion: I agree with PostgreSQL, but search requirements may need...
! B provider retry 1/4
... (7 more lines, 12 total, ctrl+o to expand)
```

Expanded live progress sections:

- `Question`
- `Participants`
- `Progress`

Progress event labels:

- `→ A initial opinion`
- `← A AGREE: short accepted opinion preview`
- `← A DIFF: short accepted opinion preview`
- `← A NEED_INFO: short accepted opinion preview`
- `→ B reviews A`
- `→ A answers missing info`
- `← A clarification: short accepted clarification preview`
- `→ B reviews clarification`
- `! A response retry 1/1`
- `! B provider retry 1/4`
- `✓ agreement reached`
- `→ B final answer`
- `✓ final answer accepted`
- `• iteration limit reached`
- `! provider request failed`

## Verification

Tests must verify:

- public `convene_council` schema with only `question`;
- default enabled behavior when config is missing;
- participant model configuration and current-model fallback;
- context parity for LLM1 and LLM2;
- pending `convene_council` tool call removal from participant transcripts;
- agreement only after opponent review;
- default final answer participant `llm2`;
- configured final answer participant `llm1`;
- iteration-limit output shape;
- response-defect retry for malformed participant output;
- final-answer retry for empty or tagged final answer;
- provider retry behavior separate from response-defect retry;
- `convene_council` preservation by `context-projection`;
- prompt contribution through `Agent Runtime Composition`;
- live progress partial updates through `onUpdate`;
- participant runtime mapping in the tool-call header;
- collapsed progress row width with Unicode and mixed-direction text;
- expanded live progress sections;
- retry events for response defects and provider failures;
- final results without persisted progress metadata.
