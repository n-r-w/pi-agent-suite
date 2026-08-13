# Technical Solution: Vision extension — `describe_image` for text-only models

## Problem Statement
- PRB-01: A text-only primary model cannot analyze images; the built-in `read` tool returns only an omission note for such models.
- PRB-02: There is no extension in `pi-agent-suite` that delegates image analysis to a vision model and returns a text answer.

## Proposed Solution

### SOL-01: Extension entry point and registration
- Add `pi-package/extensions/vision/index.ts` as the extension entry point.
- Register it in `pi-package/package.json` under `pi.extensions` as `./extensions/vision/index.ts`.
- The factory subscribes to `session_start` and `model_select`, registers the `describe_image` tool via `registerPackageTool` (see SOL-11), and syncs tool visibility.

### SOL-02: Capability-aware tool visibility
- Add `isMultimodal(model) = !!model?.input?.includes("image")` (a model without `"image"` in `input` is text-only).
- On `session_start` and `model_select`, sync the active tool set with a read-merge-write over `pi.getActiveTools()`/`pi.setActiveTools()`.
- The tool is present in the active set only when `config.enabled === true` and the active model is text-only; otherwise it is removed. Other extensions' tools are preserved.

### SOL-03: `describe_image` tool definition
- Tool `describe_image`, label `Describe Image`, with TypeBox schema:
  - `image_path` — optional string; path to a single image, `data:` URL, or raw base64.
  - `image_paths` — optional string array; multiple images for one call.
  - `prompt` — required string; the question to answer about the image(s).
- `promptSnippet`: `"Analyze one or more image files and return text descriptions or answer questions about them"`.
- `promptGuidelines`: one bullet telling the model to call `describe_image` when the active model cannot process images natively, and to pass `image_paths` for 2+ images.
- Provide `renderCall` and `renderResult` for consistent TUI display (see SOL-11).
- No `compress` or `reasoning` parameters; compression is controlled only by config.
- Defense-in-depth: if `execute` runs while the model is multimodal (mid-session race), return a redirect message telling the model to use `read`.

### SOL-04: Config contract
- Config file: `~/.pi/agent/agent-suite/vision/config.json` via `getSuiteConfigLocation("vision")`.
- Shape and defaults:
  - `enabled` — boolean, default `true`.
  - `provider` — string; vision-model provider.
  - `model` — string; vision-model id under `provider`.
  - `compression` — object:
    - `enabled` — boolean, default `true`.
    - `jpegQuality` — integer 1–100, default `85`.
    - `maxBytes` — integer, default `4718592` (4.5 MB).
  - `batchConcurrency` — integer 1–20, default `5`.
  - `retry` — object `{ enabled, maxRetries, baseDelayMs }`, defaults `true`, `3`, `2000`.
- Config is loaded on `session_start`; a missing or malformed file yields defaults.

### SOL-05: Image loading and MIME detection
- Add `image.ts` with `loadImage(input, { compression, cwd })`.
- Accept a file path, a `data:` URL, or raw base64.
- Detect MIME by magic bytes for PNG, JPEG, GIF, WebP; reject other formats with `unsupported_format`.
- Enforce a 64 MB source-size cap (`too_large`); reject missing files (`not_found`) and non-files (`not_a_file`).
- Return `{ data, mimeType }` (base64 payload, no `data:` prefix).

### SOL-06: Compression without short-side collapse
- Reuse `resizeImage` exported from `@earendil-works/pi-coding-agent`.
- When `compression.enabled` is true, call `resizeImage(bytes, mimeType, { maxBytes: compression.maxBytes, jpegQuality: compression.jpegQuality, maxWidth: Number.MAX_SAFE_INTEGER, maxHeight: Number.MAX_SAFE_INTEGER })`.
- The huge `maxWidth`/`maxHeight` disables pi's default 2000×2000 pixel clamp, so compression is driven only by `maxBytes`; aspect ratio is preserved, and an under-limit image is returned untouched.
- On `null` (Photon unavailable), fall back to the original bytes.

### SOL-07: Delegation to the vision model
- Reuse `resolveAuxiliaryLlmRuntime(ctx, `${provider}/${model}`)` from `shared/auxiliary-llm.ts` to resolve the model and auth.
- Build the call context: one user message whose `content` is `[{ type: "image", data, mimeType }, { type: "text", text: prompt }]`.
- Call `completeAuxiliaryLlm(completeSimple, runtime, context, buildAuxiliaryLlmOptions(thinking, signal, runtime))`.
- Extract the response text via `getAuxiliaryLlmResponseText`.
- `completeSimple` serializes `ImageContent` into `{ "type": "image_url", "image_url": { "url": "data:...;base64,..." } }` for the openai-completions API (verified by experiment; see REF-07).

### SOL-08: Retry
- Reuse `withRetry` from `shared/retry.ts` with the config `retry`.
- Treat `stopReason === "error"` as retryable via `createRetryableExternalError`; abort errors are never retried.

### SOL-09: Batch execution
- Validate the call once before any image work: normalize `image_path`/`image_paths` into a deduped, order-preserving path list; reject an empty list (`no_image_path`) and more than 50 images (`batch_too_large`) by throwing (see SOL-10).
- Run delegations with bounded concurrency `config.batchConcurrency` (a small `mapWithConcurrency` helper).
- Each image delegates independently with its own retry; a per-image failure becomes an `[error: code — message]` section in the block, not a whole-batch failure.
- The result is one order-stable text block: `[Batch: N image(s)]` header, then `[Image 1] path` + description per image.

### SOL-10: Error handling
- Global errors — validated once before the image loop; thrown, so the TUI shows a red error and the message does not enter the LLM context:
  - `not_configured` — `provider` or `model` unset.
  - `model_not_found` — `provider/model` not in the model registry.
  - `auth_error` — `getApiKeyAndHeaders` fails.
  - `no_image_path` — neither `image_path` nor `image_paths` given.
  - `batch_too_large` — more than 50 images.
- Per-image errors — occur inside the loop; each becomes an `[error: code — message]` section in the batch text block (the model sees them and can recover):
  - `not_found`, `not_a_file`, `too_large`, `unsupported_format`, `invalid_data_url`, `invalid_base64`.

### SOL-11: Tool presentation in main window and subagent TUI
- Register the tool via `registerPackageTool(pi, definition)` from `shared/tool-presentation/registry.ts`, not bare `pi.registerTool`, so the renderers are published on the shared event bus.
- Provide `renderCall` and `renderResult` following the final-output tool pattern (skill `pi-tui-rendering`):
  - Keep the default tool shell (`renderShell` unset).
  - `renderCall`: compact, width-bounded preview of `image_path`/`image_paths` and `prompt`.
  - `renderResult`: collapsed view = label + text, wrapped via `Text.render(width)`, line budget applied after; expanded view = `Markdown`.
- This keeps rendering consistent in the main window and the `run-subagent` TUI, which resolves package renderers via `getPackageToolPresentation` (a generic "unknown" renderer is used only when no package renderer is published).

## Overengineering and Overspecification Considerations
- No cache, preview, audit log, or fallback model (explicitly out of scope).
- No `compress`/`reasoning` tool parameters; compression is config-only.
- Delegation reuses `shared/auxiliary-llm.ts` and `shared/retry.ts` instead of reimplementing provider calls or retry logic.
- No image file is loaded by any existing module, so a small self-contained `image.ts` is justified; it does not introduce a general image framework.

## Open Questions

None.

## References
- REF-01: `pi-package/shared/auxiliary-llm.ts` — runtime resolution and completion helpers for auxiliary LLM calls.
- REF-02: `pi-package/shared/retry.ts` — `withRetry` and `RetryConfig`.
- REF-03: `pi-package/shared/agent-suite-storage.ts` — `getSuiteConfigLocation`.
- REF-04: `pi-package/extensions/consult-advisor/index.ts` — existing tool registration and model-call pattern.
- REF-05: `/Users/rvnikulenk/dev/misc/pi-vision` — donor reference for `isMultimodal`, `syncToolAvailability`, `loadImage`, batch result format, and the tool schema.
- REF-06: `node_modules/@earendil-works/pi-coding-agent/dist/utils/image-resize.d.ts` — `resizeImage` and `ImageResizeOptions`.
- REF-07: collaboration desk topic `f35a410e-d842-4d2d-babd-633641d3839d` — experiment confirming `completeSimple` serializes `ImageContent` as a base64 data URL.
- REF-08: `pi-package/shared/tool-presentation/registry.ts` — `registerPackageTool` and `getPackageToolPresentation`.
- REF-09: `pi-package/shared/tool-presentation/bounded.ts` and `universal.ts` — bounded/fallback tool rendering components.
- REF-10: `pi-package/extensions/run-subagent/tool-rendering.ts` — subagent TUI tool presentation resolution.
- REF-11: `pi-package/extensions/consult-advisor/rendering.ts` — reference `renderCall`/`renderResult` final-output pattern.
- REF-12: `~/.agents/skills/pi-tui-rendering/SKILL.md` — Pi TUI rendering instructions for custom tools.
