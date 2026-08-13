# Problem Statement

## Context

`pi-agent-suite` is a set of extensions for the pi coding agent. Extensions live in `pi-package/extensions/<name>/index.ts` and are registered in `pi-package/package.json`. The suite has no tool for analyzing images with a text-only primary model.

## Problem Statement

A text-only primary model cannot analyze an image: the built-in `read` tool detects the image but returns only an omission note without attaching it. There is no tool that delegates image analysis to a separate vision model and returns a text answer.

## Who is affected

Users of `pi-agent-suite` running a text-only primary model who need to analyze images (screenshots, diagrams, photos) through a vision model.

## Evidence

- No vision/image extension exists under `pi-package/extensions/`; grep for `describe_image`, `getpipher`, `pi-vision-tool`, `pi-paster` returns 0 matches.
- The project branch is named `vision`.
- The built-in `read` tool (`dist/core/tools/read.js`) detects image MIME types and returns image-content for multimodal models; for a model whose `input` lacks `"image"` it returns only the note `"Current model does not support images. The image will be omitted from this request."` without image content.
- The pi platform exposes `pi.registerTool`, `pi.setActiveTools`/`pi.getActiveTools`/`pi.getAllTools`, the `model_select` event, and `model.input` (`("text" | "image")[]`).
- `shared/` provides reusable infrastructure: `auxiliary-llm`, `model-settings` + `model-aliases`, `retry`.
- The donor repository is at `/Users/rvnikulenk/dev/misc/pi-vision`.

## Impact

A text-only primary model cannot obtain any image description: it sees only a file path, and `read` omits the image. Image-based workflows (screenshot review, diagram understanding, error screenshots) are entirely unavailable for text-only models.

## Reproduction Steps

1. Start pi with a text-only primary model.
2. Reference an image path in a message (for example `/tmp/screenshot.png`).
3. The model calls `read`; `read` returns only an omission note and no image content.
4. There is no `describe_image` tool to delegate analysis to a vision model.

## Current State

- Multimodal primary model: the built-in `read` tool delivers the image as native image-content. No extension is needed.
- Text-only primary model: `read` returns only an omission note. No delegation tool exists.

## Desired Outcome

A text-only primary model can call `describe_image`, pass an image path and a prompt, and receive a text answer from a configured vision model. A multimodal primary model needs no extension: `read` already delivers images natively.

## Success Metrics

- With a text-only primary model and a configured vision model, `describe_image` returns a non-empty text answer for a valid image path.
- With a multimodal primary model, `describe_image` is not visible to the model (not present in the active tool set).

## Scope

- Capability-aware tool visibility: `describe_image` is visible only to a text-only primary model.
- `describe_image` accepts a mandatory prompt and one or more image paths.
- `describe_image` is described via `promptSnippet`/`promptGuidelines` so the model knows when to call it.
- Retries with exponential backoff on retryable vision-model failures.
- Integration as a `vision` extension reusing `shared/` modules.

## Out of Scope / Non-Goals

- Multimodal primary models (the built-in `read` tool already covers them; the extension does nothing).
- Paste hook and `[Image-#N]` markers (the extension does not process image links in message text).
- Caching of delegation results.
- Terminal image preview.
- Audit log.
- Fallback vision model.

## Constraints

- No cache (user decision: the mandatory prompt makes the cache ineffective).
- `describe_image` has a mandatory prompt (user decision).
- Retries with exponential backoff (user decision).
- Reuse `shared/` infrastructure where applicable.

## Assumptions

- `pi.setActiveTools()` re-syncs tool visibility for the active model when called on the `model_select` event, so `describe_image` can be gated on model modality. Verification: confirm in `collect_facts` by inspecting pi source and a live debug extension.

## Open Questions

None at the problem level. Requirement-level details (vision-model configuration method, the exact `describe_image` parameter set, and retry parameters) are deferred to the PRD stage.
