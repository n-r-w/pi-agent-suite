# structured-prompt

## Purpose

`structured-prompt` opens a focused form for writing structured user requests. Use it to fill prompt sections, review the generated prompt, and send it as one user message.

## Configuration

Default config file: `~/.pi/agent/agent-suite/structured-prompt/config.json`.

If `PI_AGENT_SUITE_DIR` is set, the config file is `$PI_AGENT_SUITE_DIR/structured-prompt/config.json`.

Missing config enables the extension.

### Full config example

```json
{
  "enabled": true
}
```

### Parameters

| Parameter | Required | Type or shape | Default | Meaning |
| --- | --- | --- | --- | --- |
| `enabled` | No | Boolean | `true` | Enables `/prompt` and the `ctrl+alt+p` shortcut when set to `true`. Set to `false` to disable them. |

No other config keys are allowed. Invalid config prevents `/prompt` and the shortcut from loading.

## Usage

- Run `/prompt` or press `ctrl+alt+p` to open the form.
- `ctrl+alt+p` can be intercepted by a terminal, operating system, or user keybinding before Pi receives it. `/prompt` is the reliable entry point.
- The form requires interactive UI.
- The form sections are fixed: Goal, Task, Context, Criteria, Constraints, Work order.
- Section text can span multiple lines.
- Empty sections are omitted from the generated prompt.
- `@...` file suggestions are available in section editors when `fd` is available in `PATH`.
- Review the generated prompt before sending it.
- On the review screen, `Ctrl+Y` copies the generated prompt to the clipboard without closing the form.
- On the review screen, `Ctrl+T` places the generated prompt in the main input field and sends no message.
- If the agent is idle, submitting sends the generated prompt as one user message.
- If the agent is busy, Pi asks whether to queue the generated prompt as a follow-up.
- Cancelling the form sends no message.
- Submitting an empty form sends no message.

## Generated prompt format

Only non-empty sections are included. Section order is fixed.

Example:

```md
## Goal
Create structured requests.

## Task
Implement the structured-prompt extension.

## Constraints
Keep tests isolated.
```
