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
- On `session_start`, resolve the effective config and the active model; on `model_select`, re-sync using the cached config.
- The tool is present in the active set only when all of: `config.enabled === true`, `provider` is set, `model` is set, and the active model is text-only. Otherwise it is removed (other extensions' tools are preserved) via a read-merge-write over `pi.getActiveTools()`/`pi.setActiveTools()`.
- When `enabled` is true but `provider`/`model` are unset, or the config file is malformed, show a warning via `ctx.ui?.notify(...)` at `session_start` and keep the tool hidden for the session.

### SOL-03: `describe_image` tool definition
- Tool `describe_image`, label `Describe Image`, with TypeBox schema:
  - `image_path` — required non-empty string; description "Path to one image file.".
  - `prompt` — required non-empty string, max length 2048; description "Question or instruction to answer about the image.".
- `promptSnippet`: `"Analyze one image file and return a text description or answer questions about it"`.
- `promptGuidelines`: one bullet telling the model to call `describe_image` when the active model cannot process images natively.
- Provide `renderCall` and `renderResult` for consistent TUI display (see SOL-11).
- No `compress` or `reasoning` parameters; compression is controlled only by config.
- Defense-in-depth: if `execute` runs while the model is multimodal (mid-session race), return a redirect message telling the model to use `read`.

### SOL-04: Config contract
- Config file: `~/.pi/agent/agent-suite/vision/config.json` via `getSuiteConfigLocation("vision")`.
- Shape and defaults:
  - `enabled` — boolean, default `false`.
  - `provider` — string; vision-model provider.
  - `model` — string; vision-model id under `provider`.
  - `compression` — object:
    - `enabled` — boolean, default `true`.
    - `jpegQuality` — integer 1–100, default `85`.
    - `maxBytes` — integer, default `4718592` (4.5 MB).
  - `retry` — object `{ enabled, maxRetries, baseDelayMs }`, defaults `true`, `3`, `2000`.
- Config is loaded on `session_start`; a missing or malformed file yields defaults.

### SOL-05: Image loading and MIME detection
- Add `image.ts` with `loadImage(input, { compression, cwd })`.
- Accept a file path.
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

### SOL-09: Single-image execution
- Redirect to `read` when the active model is multimodal.
- Throw `not_configured` when `provider` or `model` is unset, then resolve the configured vision runtime.
- Load `image_path` once with the configured compression and delegate it with `describeImage`.
- Return the description text on success. Return `[error: code — message]` when image loading or vision-model delegation fails.

### SOL-10: Error handling
- Global errors are thrown, so the TUI shows a red error and the message does not enter the LLM context:
  - `not_configured` — `provider` or `model` unset.
  - `model_not_found` — `provider/model` not in the model registry.
  - `auth_error` — `getApiKeyAndHeaders` fails.
- Image loading and vision-model delegation errors return `[error: code — message]` as the text result. Image-loading codes are `not_found`, `not_a_file`, `too_large`, `unsupported_format`, and `read_error`.

### SOL-11: Tool presentation in main window and subagent TUI
- Register the tool via `registerPackageTool(pi, definition)` from `shared/tool-presentation/registry.ts`, not bare `pi.registerTool`, so the renderers are published on the shared event bus.
- Keep the default tool shell (`renderShell` unset).
- `renderCall` collapsed view renders `describe_image:` and the full wrapped `image_path`, then a whitespace-normalized `Prompt:` preview limited to two visual lines and an expand hint. Expanded view renders the full wrapped `image_path`, `--- Prompt ---`, and the original prompt text.
- `renderResult` collapsed view renders `Description:` or `Error:`, whitespace-normalizes the result, limits it to two visual lines, and adds its own expand hint. Expanded view renders `--- Description ---` or `--- Error ---` followed by the full raw result text without Markdown rendering.
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
- REF-05: `/Users/rvnikulenk/dev/misc/pi-vision` — donor reference for `isMultimodal`, `syncToolAvailability`, `loadImage`, and the tool schema.
- REF-06: `node_modules/@earendil-works/pi-coding-agent/dist/utils/image-resize.d.ts` — `resizeImage` and `ImageResizeOptions`.
- REF-07: collaboration desk topic `f35a410e-d842-4d2d-babd-633641d3839d` — experiment confirming `completeSimple` serializes `ImageContent` as a base64 data URL.
- REF-08: `pi-package/shared/tool-presentation/registry.ts` — `registerPackageTool` and `getPackageToolPresentation`.
- REF-09: `pi-package/shared/tool-presentation/bounded.ts` and `universal.ts` — bounded/fallback tool rendering components.
- REF-10: `pi-package/extensions/run-subagent/tool-rendering.ts` — subagent TUI tool presentation resolution.
- REF-11: `pi-package/extensions/consult-advisor/rendering.ts` — reference `renderCall`/`renderResult` final-output pattern.
- REF-12: `~/.agents/skills/pi-tui-rendering/SKILL.md` — Pi TUI rendering instructions for custom tools.
