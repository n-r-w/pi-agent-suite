# vision

## Purpose

`vision` adds the `describe_image` tool. It lets a text-only primary model delegate analysis of one image to a configured vision model and receive a text answer.

The tool is visible only when all of the following hold: `enabled` is `true`, `provider` and `model` are configured, and the active model is text-only (its `input` does not include `image`). When the extension is enabled but unconfigured, or when the config file is malformed, a warning is shown at session start and the tool stays hidden.

The tool accepts required `image_path` and `prompt` strings. The image is a file path. `prompt` is limited to 2048 characters. Global errors (`not_configured`, `model_not_found`, `auth_error`) abort the call. Image loading and vision-model errors return `[error: code — message]` as the text result.

## Configuration file

Default path:

```text
~/.pi/agent/agent-suite/vision/config.json
```

If the config file is missing, defaults are used: `enabled` is `false` and `provider` and `model` are not set, so the tool stays hidden and no warning is shown.

## Full configuration example

```json
{
  "enabled": true,
  "provider": "openai",
  "model": "gpt-4.1-mini",
  "compression": {
    "enabled": true,
    "jpegQuality": 85,
    "maxBytes": 4718592
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000
  }
}
```

## Configuration parameters

| Parameter | Required | Type or shape | Default | Meaning |
| --- | --- | --- | --- | --- |
| `enabled` | No | Boolean | `false` | Enables or disables the tool. |
| `provider` | No | Non-empty string | Not set | Vision-model provider name. Both `provider` and `model` must be set for the tool to appear. |
| `model` | No | Non-empty string | Not set | Vision-model id under `provider`. Both `provider` and `model` must be set for the tool to appear. |
| `compression` | No | Object with optional `enabled`, `jpegQuality`, and `maxBytes` fields | Compression defaults | Controls image resizing. |
| `compression.enabled` | No | Boolean | `true` | Enables image compression before sending. |
| `compression.jpegQuality` | No | Integer from `1` to `100` | `85` | JPEG re-encode quality. |
| `compression.maxBytes` | No | Positive integer | `4718592` | Maximum base64 payload size in bytes. |
| `retry` | No | Object with optional `enabled`, `maxRetries`, and `baseDelayMs` fields | Retry defaults | Retry settings. |
| `retry.enabled` | No | Boolean | `true` | Enables retries. |
| `retry.maxRetries` | No | Non-negative integer | `3` | Maximum number of retry attempts. |
| `retry.baseDelayMs` | No | Non-negative integer | `2000` | Base retry delay in milliseconds. |
