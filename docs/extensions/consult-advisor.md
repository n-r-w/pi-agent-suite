# consult-advisor

## Purpose

`consult-advisor` owns the `consult_advisor` tool and advisor model call.

## Behavior

- Registers tool `consult_advisor`.
- Accepts only `question`.
- Reads configuration from `~/.pi/agent/config/consult-advisor.json`.
- Is enabled by default when `consult-advisor.json` is missing.
- Uses the current session model when `model.id` is missing.
- Uses the current thinking level when `model.thinking` is missing.
- Uses the bundled advisor prompt when `promptFile` is missing.
- Bundled advisor prompt lives at `pi-package/extensions/consult-advisor/prompts/advisor.md`.
- Allows optional `promptFile` and `debugPayloadFile`.
- Resolves `promptFile` and `debugPayloadFile` as absolute paths or relative paths from the directory that contains `consult-advisor.json`.
- Does not add `~/` path support.
- Requires a readable and non-empty advisor prompt.
- Resolves the advisor model, API key, and request headers through the pi model registry.
- Builds an advisor transcript from the current active branch context.
- Replays valid persisted `context-projection` placeholders before calling the advisor.
- Uses the full branch context when `context-projection` config is missing, disabled, invalid, or has no valid projection state.
- Keeps `consult-advisor` independent from raw `context-projection` custom-entry details by using the shared projection replay abstraction.
- Removes the pending `consult_advisor` tool call from the advisor transcript.
- Calls the advisor through `completeSimple` only when a tokenizer-based serialized-input estimate fits the advisor model context window.
- Returns an explicit context-size error without calling the provider when the advisor input may be too large.
- Sends the advisor context with `tools: []`.
- Adds a visible-text response instruction to prevent reasoning-only advisor output.
- Returns an explicit empty-response error when the provider returns no visible text.
- Applies Pi `truncateTail` behavior to the advisor answer before returning model-facing tool result `content`.
- Saves the complete advisor answer to a system temp file when the answer exceeds Pi output truncation limits.
- Adds a `Full output: {path}` notice to truncated model-facing `content`.
- Stores `truncation` and `fullOutputPath` in tool result `details` when the advisor answer is truncated.
- Renders the tool call as `consult_advisor: {question preview}`.
- Renders collapsed advisor output as `Advice: {answer preview}`.
- Shows `COLLAPSED_ADVICE_PREVIEW_LINES` collapsed advisor visual lines.
- `COLLAPSED_ADVICE_PREVIEW_LINES` is exported from `pi-package/extensions/consult-advisor/rendering.ts`.
- Shows `... (xx more lines, yy total, {key} to expand)` when collapsed output hides additional visual lines.
- Renders expanded advisor output as Markdown through Pi's standard tool expansion state.
- Publishes advisor guidance through `Agent Runtime Composition` only when `consult_advisor` is active for the current effective agent.
- Does not call `pi.setActiveTools()` directly.
- Does not own main-agent selection.
- Does not own `run_subagent`.

## Configuration

File: `~/.pi/agent/config/consult-advisor.json`.

```json
{
  "enabled": true,
  "model": {
    "id": "provider/model",
    "thinking": "high"
  },
  "debugPayloadFile": "/Users/rvnikulenk/dev/nrw/pi-harness/debug/consult-advisor-payload.json"
}
```

`enabled` is optional and defaults to `true`. Missing config enables `consult_advisor` with the current model, current thinking level, and bundled advisor prompt.

Optional fields:

- `model`
- `model.id`
- `model.thinking`
- `promptFile`
- `debugPayloadFile`

Allowed `model.thinking` values:

- `off`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

## Verification

Tests must verify:

- unchanged public `consult_advisor` schema;
- advisor config validation;
- default current-model and current-thinking behavior when the config file is missing;
- bundled default advisor prompt handling;
- unreadable or empty custom prompt handling;
- `tools: []` in the advisor context;
- resolved advisor API key and request headers in the model call options;
- visible-text response instruction in the advisor system prompt;
- `consult_advisor: {question preview}` in the tool call renderer;
- `Advice: {answer preview}` in the collapsed result renderer;
- collapsed answer preview height through `COLLAPSED_ADVICE_PREVIEW_LINES`;
- Pi-style hidden-line expansion hint for collapsed long answers;
- expanded advisor answer rendering through Pi's standard tool expansion;
- model-facing truncation of large advisor answers;
- exact full-output temp file content for truncated advisor answers;
- unchanged model-facing content when the advisor answer does not exceed Pi output truncation limits;
- pending `consult_advisor` call removal from the advisor transcript;
- projection replay from valid persisted `context-projection` state;
- full-context behavior when projection config is missing, disabled, invalid, or state is empty;
- provider call prevention when advisor input exceeds the advisor model context window;
- issue creation only for `consult-advisor` on configuration error;
- contribution publication to `Agent Runtime Composition` without direct `pi.setActiveTools()` calls;
- advisor guidance omission when the current effective agent does not enable `consult_advisor`.
