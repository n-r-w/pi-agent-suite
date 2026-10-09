# Pi 1.1.0 compatibility assessment

This supplement supplies the whole-project evidence used by [the technical solution](solution.md). The scope is every extension entry in `pi-package/package.json`, shared model aliases, and the interactions listed below. The [implementation report](implementation.md) records the completed adaptations and regression validation on Pi 1.1.0.

## Assessment boundary

- The baseline assessment compared Pi 1.0.2 with Pi 1.1.0 before production adaptations. Development and peer dependencies now pin Pi 1.1.0.
- Isolated copies of the package ran the same validation scripts on both versions. The target needed two render-context fixture adaptations before strict type checking passed.
- On both versions, Bun reported 1676 passing tests, one skipped test, and zero failed tests across 193 test files and 6417 assertions. After the target fixture adaptations, the TypeScript, Biome, Go test, formatting, and Go vet validators also reported success.
- Real Pi checks used temporary state, deterministic providers, and a local stdio MCP fixture. Additional handler checks used fake extension APIs, configuration files, and playback effects. Those handler checks establish extension-layer behavior; they do not establish provider or desktop behavior.
- Passing checks establish the exercised behavior. Configuration combinations outside those checks and real external effects remain unverified. Private user configuration and authentication were excluded by NRQ-01.

## Confirmed adaptation findings

| Capability | Baseline and target evidence | Assessment |
| --- | --- | --- |
| Host dependency alignment | The isolated `make pi-update PI_VERSION=1.1.0` succeeded. Both package roots resolved all four host-provided Pi packages to 1.1.0. | Use the tested update target and exact pins. |
| Tool-render test contexts | Target strict type checking reported missing required context metadata in two fixtures. Completing those contexts restored full validation. | Fixture adaptation required; no production renderer compatibility layer is justified. |
| Main and subagent native tool presentation | With padding zero and a saved 2500-millisecond duration, the target main component rendered padding zero and `Took 2.5s`; the management pane rendered padding one and omitted the duration. Baseline components both used padding one and omitted timing. | Preserve duration and effective padding in the management pane. |
| Council participant tool restrictions | A native echo call through `codemode` was denied with `read,codemode` on 1.0.2 and permitted on 1.1.0. Selective exclusions restored denial. Separate checks preserved an allowed native tool and an allowed resource helper while denying unlisted peers. | Selective participant-startup filtering required. |
| Vision image type after compression | Both versions resized a generated 100 by 100 pixel PNG to a 75 by 75 pixel JPEG of 3545 bytes. The vision loader returned those JPEG bytes with `image/png`. | Pre-existing defect; correction explicitly included in FRQ-04. |

The rendering check exercised public Pi components and the repository's conversation pane with controlled saved entries. The MCP check exercised the real CLI with the package loaded. Neither check used a real model response or a real user's session.

## Capability inventory

The table records capabilities examined through source tracing, public-contract comparison, and tests. "No target incompatibility identified" is limited to that evidence. The external-effects section names the live checks that were excluded.

The full test suite was rerun after implementation through `bun run verify`, with 1690 passing tests, one skipped test, and zero failures. TypeScript, Biome, Go tests, formatting, and Go vet also passed. The conclusions below retain the baseline assessment wording; the implementation report records the outcome for each required adaptation.

Unless a row names another location, its unit evidence is under `pi-package/extensions/<extension>/`. Additional unit tests for quota, council, footer, and advisor behavior are under `test/extensions/<extension>/`. Extension registration and runtime loading also have evidence in `test/integration/runtime-package-loading.test.ts`.

| Extension or shared capability | Examined behavior and evidence | Migration conclusion |
| --- | --- | --- |
| `system-prompt` | Template configuration, variable composition, selected-tool and skill availability; entry-point tests and MCP/system-prompt loading integration. | No target incompatibility identified in the examined composition paths. |
| `project-rules` | Global and project rule discovery, path policy, configuration errors, and context contribution; configuration and entry-point tests. | No target incompatibility identified. |
| `mcp-wrapper` | Client lifecycle, cached and live catalogs, tool registration, deferred activation, errors, and compact/expanded presentation; unit tests and real package-order/presentation checks. | Production paths examined had no target incompatibility; its render-context fixture needs adaptation. |
| `enable-tools` | Default search-tool inclusion, disabled configuration, include/exclude selection, unavailable names, and restrictive-owner policy; `test/extensions/enable-tools/index.test.ts`, shared composition tests, and five isolated handler scenarios. | Tested extension-layer outcomes passed. No target public-contract change identified. |
| `footer` | Status segments, model and context display, cost and token totals, cache hit rate, and bounded rendering; entry-point and shared usage/context tests. | No target incompatibility identified in formatter and data-source paths. |
| `codex-fast` | Supported-model selection, command state, persisted state, request modification, and footer contribution; entry-point tests. | No target incompatibility identified in the examined request and state paths. |
| `codex-verbosity` | Enabled, missing, disabled, and invalid configuration; preservation of other payload content and provider filtering; `test/extensions/codex-verbosity/index.test.ts` and five isolated handler scenarios. The handler targets provider `openai` with API `openai-codex-responses`; provider `openai-codex` remains outside that filter. | Tested extension-layer outcomes passed. Actual provider handling remains unverified. |
| `codex-quota` | Configuration, credential access through the model registry, quota parsing, refresh state, and footer status; entry-point tests, `test/extensions/codex-quota/index.test.ts`, and API review. | No target incompatibility identified in extension logic. Authentication and quota service responses were faked. |
| `custom-compaction` | Adaptive summaries, projected source messages, active tool definitions, usage reporting, and failure propagation; module and integration tests. | Tested compaction paths passed; the native passive-restoration limitation below remains. |
| `context-projection` | Replacement validity, branch ordering, effective context, reset behavior, pending savings, and usage interaction; unit tests and projection/usage navigation integration. | No target incompatibility identified in the examined projection paths. |
| `compaction-trigger` | Threshold interruption, settled-run continuation, cancellation, reset, and package order; unit tests and real AgentSession integration. | Tested managed interruption and continuation paths passed. The added settlement abort indicator alone does not justify replacing the controller's state decisions. |
| `model-response-timeout` | Per-request timers, timer cleanup, timeout abort, retry scheduling, retry exhaustion, and hidden-trigger filtering; unit tests and real AgentSession integration. | Tested timeout and retry paths passed. |
| `completion-sound` | Successful root completion, error, abort, child suppression, disabled configuration, and invalid configuration; `test/extensions/completion-sound/index.test.ts` and six isolated handler scenarios with fake playback. | Tested extension-layer outcomes passed. Audio playback and platform defaults remain unverified. |
| `cmux` | Completion eligibility, child suppression, configuration, and command dispatch; entry-point tests and the shared completion predicate. | No target incompatibility identified in notification logic. Actual cmux execution remains unverified. |
| `main-agent-selection` | Catalog and configuration handling, switching, model/thinking/tool contributions, session restoration, and startup barriers; unit tests and startup/workflow integration. | Tested selection and composition paths passed. |
| `run-subagent` | Start, steer, query, wait, continuation, cancellation, hierarchy, worker startup, extension modes, child policy, and management-screen navigation; unit tests and real child-RPC integration. | Tested orchestration paths passed. Native tool presentation requires the adaptation above. |
| `usage` | Response attribution, auxiliary and native-summary usage, tier-aware cache savings, persistent aggregation, reset, model grouping, and display; module tests and projection/navigation integration. | No target incompatibility identified in examined accounting paths. Native reported cost remains the source for charged cost. |
| `knowledge` | Context snapshots, storage scopes, algorithm coordination, nested-session aggregation, manual triggers, and usage publication; unit tests and shared broker tests. | No target incompatibility identified in examined storage and coordination paths. |
| `algorithms` | Registry validation, triggers, configuration, and algorithm invocation; entry-point and knowledge/workflow tests. | No target incompatibility identified. |
| `workflow` | Catalog availability, activation, creation/editing, transitions, model/thinking/tool composition, reminders, snapshots, and lifecycle completion; unit tests and workflow integration. | Tested workflow paths passed. Native overflow restoration retains the baseline limitation below. |
| `structured-prompt` | Field editing, review, completion, paste, submission, cancellation, and formatting; form, command, and formatter tests. | No target incompatibility identified in examined form logic. Clipboard effects remain unverified. |
| `ask-llm` | Model aliases, effective conversation context, project/knowledge context, dialog state, completion, errors, and usage; entry-point and dialog tests. | No target incompatibility identified in extension-side request assembly and result handling. |
| `consult-advisor` | Auxiliary-model selection, context assembly, cancellation/error handling, usage, and shared tool presentation; entry-point and rendering tests. | No target incompatibility identified in examined logic. |
| `convene-council` | Participant startup, context selection, RPC opinions, completion/cancellation, limits, and presentation; module tests plus paired real-CLI MCP checks. | Tested orchestration paths passed. Native MCP restrictions require the startup adaptation above. |
| `vision` | Main-model capability gating, auxiliary model selection, file/base64 loading, compression, retries, usage, and rendering; unit tests and real resize/loader checks with generated image data. | Resize output matched across versions. Correct the approved image-type mismatch; actual provider image acceptance remains unverified. |
| `remote-image` | Receiver validation, configuration, environment selection, clipboard-helper exchange, paste, and redraw request; extension tests and helper Go validation. | No target incompatibility identified in examined logic. Live SSH and desktop clipboard delivery remain unverified. |
| Shared model aliases and thinking levels | Alias loading, provider/model resolution, configuration errors, supported thinking-level selection, and use by main agents, child agents, workflows, and auxiliary requests; alias and model-settings tests. | No target incompatibility identified in resolver logic. Availability of private configured model IDs in the target catalog remains unverified. |
| Shared auxiliary LLM runtime | API key/header resolution, session identity, completion options, cancellation, and usage publication; shared auxiliary-runtime/session tests and extension callers. | No target public-contract incompatibility identified. Real authentication and provider responses remain unverified. |
| Shared child RPC completion | Parent abort, transport failure, pending failure, timeout retry, threshold continuation, and successful completion; shared completion tests and child-RPC integration. | Tested outcomes passed. Retain the project state machine; no new defect was established from the added `agent_settled` abort indicator. |

## Cross-extension evidence

- `test/integration/main-agent-startup-barrier.test.ts` and `workflow-agent-selection.test.ts` exercise selection, workflow contribution, and startup ordering.
- `test/integration/tool-presentation-loading.test.ts` exercises single registration and presentation sharing across separately loaded extensions.
- `test/integration/subagent-extensions.test.ts`, `subagents-runtime-bridge.test.ts`, `subagents-rpc-steer.test.ts`, and `subagents-rpc-abort.test.ts` exercise child loading, continuation, steering, and cancellation.
- `test/integration/projection-usage-navigation.test.ts` exercises effective context, branch navigation, and usage interaction.
- `test/integration/model-response-timeout.test.ts` and `compaction-overflow-retry.test.ts` exercise real session lifecycle decisions with deterministic providers. The passive-restoration scenario remains skipped.
- `test/integration/mcp-wrapper-system-prompt.test.ts` supplies evidence about runtime catalog availability and package composition.

## Baseline limitation retained

The isolated public reproducer in `docs/pi-issues/session-compact-message-misses-overflow-retry/index.ts` completed two RPC prompt cycles on each version. Both second cycles compacted after overflow, retried, and reported that passively restored context was absent from the immediate retry.

This is a known failure on both Pi versions. It explains the skipped test and prevents an unconditional claim that every compaction/restoration scenario works. Its correction remains outside the approved scope.

## Unverified external effects

- Real LLM response quality and acceptance of image/request payloads.
- Real authentication refresh, provider headers at external services, and quota endpoint responses.
- Audible playback and platform-specific default sound commands.
- Desktop clipboard operation, cmux execution, and remote SSH clipboard delivery.
- Private configuration, provider/model availability, and combinations beyond the exercised fixtures.

## Conclusion

The five approved adaptation areas are implemented. The full regression run and isolated real-Pi checks passed on Pi 1.1.0, including selective native MCP restrictions, native tool padding and timing, and image-type preservation. These results support compatibility of the exercised extension and shared-functionality paths. The retained overflow-restoration failure and unverified external effects prevent an unconditional claim that every project capability works in every environment.

## Open questions

None requiring another design decision. The retained baseline failure and unverified external effects remain explicit limits of the compatibility conclusion.
