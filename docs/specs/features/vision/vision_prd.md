# Idea: Vision extension — `describe_image` for text-only models

## Definitions

- **Primary model:** the model the current agent/session runs on.
- **Vision model:** an auxiliary model accepting images on input, delegated image analysis when the primary model is text-only.
- **Multimodal model:** a model whose `input` includes `"image"`.
- **Text-only model:** a model whose `input` lacks `"image"`.
- **Delegation:** calling a vision model to obtain a text answer about an image.

## Context and Problem

The built-in `read` tool delivers images natively to multimodal models but returns only an omission note for text-only models. There is no tool that delegates image analysis to a vision model and returns a text answer.

## Goal

A text-only primary model can call `describe_image`, pass one or more images and a prompt, and receive a text answer from a configured vision model. A multimodal primary model needs nothing: `read` already delivers images natively.

## Scenarios

- Text-only model + user references an image path → model calls `describe_image` → text answer returned.
- Multimodal model → the extension does nothing (`read` handles images).
- Model switches mid-session → `describe_image` visibility re-synced.

## Scope and Non-Scope

**In scope:** capability-gated tool visibility, the `describe_image` tool, delegation to a vision model, image compression, retries, config file.

**Out of scope:** caching, terminal image preview, audit log, fallback model, paste hook / image markers.

## Requirements

- **Capability gating.** `describe_image` is visible to the active model only when the model is text-only; hidden for multimodal models. Visibility re-syncs on `model_select`.
- **Tool registration.** `describe_image` is registered with parameters `image_path` (optional string), `image_paths` (optional string array), `prompt` (required string), plus `promptSnippet` and `promptGuidelines`.
- **Image input forms.** Each image is accepted as a file path, a `data:` URL, or raw base64.
- **Delegation.** On execution, `describe_image` resolves the configured vision model, sends the image(s) and prompt, and returns the model's text response.
- **Compression.** Images are compressed before delegation, controlled by config: `compression.enabled` (boolean, default `true`), `compression.jpegQuality` (integer 1–100, default `85`), `compression.maxBytes` (integer, default `4718592`). Compression preserves aspect ratio and must not collapse the shorter side of a strongly non-uniform image to the point of unreadability.
- **Retries.** Retryable delegation failures are retried with exponential backoff, configurable via `retry.enabled`, `retry.maxRetries`, `retry.baseDelayMs`.
- **Batch cap.** A single `describe_image` call accepts at most 50 images; exceeding the cap returns an error.
- **Config storage.** Config is read from `~/.pi/agent/agent-suite/vision/config.json` with fields `enabled`, `provider`, `model`, `compression` (object `{ enabled, jpegQuality, maxBytes }`), `batchConcurrency`, `retry` (object `{ enabled, maxRetries, baseDelayMs }`).

## Open Questions

None.

## Technical Supplement

- `resizeImage` (pi 0.84.1) has defaults `maxWidth: 2000`, `maxHeight: 2000`, `maxBytes: 4.5MB`, `jpegQuality: 80`; it pixel-clamps before byte-limiting. The readability requirement therefore needs an explicit mechanism (byte-limit-only compression, no fixed pixel clamp) rather than relying on pi defaults.

## References

- Donor repository: `/Users/rvnikulenk/dev/misc/pi-vision`
- pi extension docs: `docs/extensions.md` (installed package)
