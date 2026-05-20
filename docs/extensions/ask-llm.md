# ask-llm

## Purpose

`ask-llm` owns the `/ask` command for one-off model questions that are not saved to the current session.

## Behavior

- Registers command `/ask`.
- Reads configuration from `~/.pi/agent/agent-suite/ask-llm/config.json`.
- Is enabled by default when `config.json` is missing.
- Does not write the question or answer to the current session.
- Uses command arguments as the question and runs without opening the question dialog.
- Opens a centered question dialog when command arguments are empty.
- Supports `@...` file autocomplete in the question dialog when executable `fd` is available in `PATH`.
- Keeps normal question entry available when `fd` is unavailable.
- Cancels without a model call when the question is empty.
- Requires interactive UI and exits before the model call when UI is unavailable.
- Uses the current session model when `model.id` is missing.
- Uses the current thinking level when `model.thinking` is missing.
- Uses the bundled system prompt when `systemPromptFile` is missing.
- Bundled system prompt lives at `pi-package/extensions/ask-llm/prompts/system.md`.
- Requires `systemPromptFile` to be an absolute path.
- Requires a readable and non-empty system prompt.
- Resolves the model, API key, and request headers through the pi model registry.
- Rejects the request before the provider call when the exact provider input exceeds the selected model context window.
- Sends the active branch conversation as provider context.
- Replays recorded `context-projection` placeholders or summaries before calling the model.
- Appends Pi-loaded context files such as `AGENTS.md` and `CLAUDE.md` to the system prompt.
- Does not write the `/ask` question or answer to the active branch conversation.
- Appends the `/ask` question as the final provider-only user message.
- Wraps the question in `<user_question>...</user_question>`.
- Sends `tools: []`.
- Shows a centered cancellable loading UI while the model request is running.
- Shows the question and model answer in a centered focused UI.
- Renders the answer as Markdown.
- Keeps long questions and answers inside the focused UI with scroll controls.
- Copies the model answer to the clipboard when `Ctrl+Y` is pressed in the focused answer UI.
- Retries retryable provider failures through bounded shared retry config.
- Reports configuration, prompt, model, auth, provider, context-window, and empty-response issues as `ask-llm` warnings.
- Leaves other extensions unchanged when an execution-time issue occurs.

## Configuration

File: `~/.pi/agent/agent-suite/ask-llm/config.json`.

```json
{
  "enabled": true,
  "model": {
    "id": "provider/model",
    "thinking": "medium"
  },
  "systemPromptFile": "/absolute/path/to/system.md",
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000
  }
}
```

`enabled` is optional and defaults to `true`. Missing config enables `/ask` with the current model, current thinking level, and bundled system prompt.

Optional fields:

- `enabled`
- `model`
- `model.id`
- `model.thinking`
- `systemPromptFile`
- `retry`
- `retry.enabled`
- `retry.maxRetries`
- `retry.baseDelayMs`

Allowed `model.thinking` values:

- `off`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

## Verification

Tests must verify:

- default command registration when the config file is missing;
- command omission when `enabled` is `false`;
- command argument use as the question;
- centered question dialog use when command arguments are empty;
- `@...` file autocomplete in the centered question dialog when `fd` is available;
- normal question entry when `fd` is unavailable;
- centered loading UI use while the model request is running;
- model call prevention when UI is unavailable;
- active-branch conversation forwarding to the model;
- projection replay from recorded `context-projection` state;
- Pi-loaded context files such as `AGENTS.md` and `CLAUDE.md` in the system prompt;
- absence of current-session writes for the question and answer;
- current model use when `model.id` is missing;
- configured model use when `model.id` is present;
- current thinking use when `model.thinking` is missing;
- configured thinking use when `model.thinking` is present;
- bundled default system prompt loading;
- custom `systemPromptFile` loading;
- scoped warning for invalid config;
- provider call prevention when config is invalid;
- provider call prevention when input exceeds the selected model context window;
- retry of retryable provider failures;
- retry of retryable provider error responses;
- no retry for aborted requests;
- question and Markdown answer display in centered focused UI;
- scrolling for long question and answer content;
- answer copying from the focused UI with `Ctrl+Y`.
