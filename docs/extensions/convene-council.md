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
- Builds one external `<context>` package from active branch conversation messages.
- Treats `<context>` as external evidence, not participant session memory, tool availability, or instructions.
- Replays recorded `context-projection` placeholders or summaries before rendering `<context>`.
- Removes only the current pending `convene_council` tool call and matching result from `<context>`.
- Keeps previous completed `convene_council` results in `<context>` as prior evidence.
- Sends the same `<context>` package to LLM1 and LLM2 in the first participant prompt only.
- Does not seed participant sessions with main-agent conversation messages.
- Adds Pi-loaded context files such as `AGENTS.md` and `CLAUDE.md` to participant system prompts.
- Starts isolated child `pi --mode rpc` sessions for participant prompts.
- Shares only tools configured by `tools` with each participant.
- Adds the selected participant tool names to each participant system prompt.
- Instructs participants that current runtime tool access overrides historical tool-access claims inside Project Context and `<context>`.
- Allows participants to use configured tools only to gather evidence for the council question.
- Instructs participants to use relevant available tools before concluding on facts not established by `<context>` or prior tool evidence.
- Sends no tools to participants when `tools` is missing or empty.
- Sends the council question through the first-turn task prompt.
- Starts independent first-turn participant calls in parallel.
- Accepts first-turn participant opinions as non-empty text.
- Runs mutual missing-information answers and their clarification reviews in parallel.
- Keeps dependent review steps sequential when the next task uses the previous participant output.
- Requires later participant discussion responses as `<status>{AGREE|DIFF|NEED_INFO}</status><opinion>{text}</opinion>`.
- Retries malformed participant responses using `responseDefectRetries`.
- Retries defective final answers using `responseDefectRetries`.
- Does not retry participant transport failures in the parent process.
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
- Estimates first participant requests before child startup. The estimate includes the participant system prompt, first task prompt, external `<context>`, and configured tool schemas.
- Summarizes only the external `<context>` package with Pi `generateSummary(...)` when the first request exceeds `contextWindowUsageLimit`.
- Fails before child startup when summary input cannot fit the summary model or when the summarized first request still exceeds the participant limit.
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
  "tools": ["read", "grep"],
  "contextWindowUsageLimit": 0.7,
  "contextSummary": {
    "model": {
      "id": "provider/summary-model",
      "thinking": "medium"
    }
  }
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
- `tools`: optional array of non-empty tool-name patterns. Missing or empty means participants receive no tools. Exact tool names and constrained wildcard patterns are allowed. Full wildcard `*` is rejected.
- `contextWindowUsageLimit`: default `0.7`. Must be greater than `0` and less than or equal to `1`. The limit is applied to each participant model context window before child startup.
- `contextSummary.model.id`: optional `provider/model` string. Uses the current model when missing and summarization is needed.
- `contextSummary.model.thinking`: optional thinking level. Uses the current thinking level when missing and summarization is needed.

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
! B response retry 1/1
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
- `✓ agreement reached`
- `→ B final answer`
- `✓ final answer accepted`
- `• iteration limit reached`
- `! participant request failed`

## Verification

Tests must verify:

- public `convene_council` schema with only `question`;
- default enabled behavior when config is missing;
- participant model configuration and current-model fallback;
- equivalent first-prompt external `<context>` for LLM1 and LLM2;
- participant sessions without main-agent conversation messages;
- pending current `convene_council` tool call removal from external `<context>`;
- previous completed `convene_council` results retained in external `<context>`;
- context-size preflight, summary trigger, real Pi summary prompt envelope overflow, post-summary overflow, and tool schema budgeting;
- agreement only after opponent review;
- default final answer participant `llm2`;
- configured final answer participant `llm1`;
- iteration-limit output shape;
- response-defect retry for malformed participant output;
- final-answer retry for empty or tagged final answer;
- participant transport failures separate from response-defect retry;
- `convene_council` preservation by `context-projection`;
- prompt contribution through `Agent Runtime Composition`;
- live progress partial updates through `onUpdate`;
- participant runtime mapping in the tool-call header;
- collapsed progress row width with Unicode and mixed-direction text;
- expanded live progress sections;
- retry events for response defects;
- final results without persisted progress metadata.
