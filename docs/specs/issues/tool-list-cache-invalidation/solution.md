# Technical Solution: Preserve cached context across toolset activation

## Problem Statement
When the agent calls `activate_toolset`, the package changes the beginning of the provider request. The user then pays again for earlier conversation context. See [problem.md](problem.md), [terms.md](terms.md), and the approved requirements in [prd.md](prd.md).

## Proposed Solution
Use pi's shared extension API to retain the initial toolset guidance and append tool declarations and prompt updates to conversation history. Keep direct calls to activated tools. Pi owns provider-specific serialization; the package changes only its extensions and shared modules.

The primary targets are OpenAI models for which pi supports conversation-local prompt and tool changes. The installed catalogs enable that support for the current `openai/gpt-6.1-sol` configuration and for `openai-codex/gpt-6.1-sol`. On other providers or models, tool functionality remains available and cache loss is accepted as R1 in the PRD.

### Toolset catalog and activation state
The toolset runtime remains the owner of the registered catalog, policy-filtered eligibility, and active toolsets. Pi already stores activation results containing active-toolset snapshots in session history. Preserve this source of state for normal execution, branch restoration, and saved-session continuation.

The initial prompt contains brief guidance for all toolsets eligible for the agent. Render this catalog independently of activation state, so activating a toolset does not remove its entry or rewrite the initial instructions. Preserve the upstream permission filtering in `ToolsetRuntimeImpl` in `pi-package/shared/toolsets/runtime.ts`.

The runtime provides two views of eligible toolsets. Prompt rendering uses all eligible groups. The activation-tool availability check uses only eligible groups that remain inactive. Currently, `resolveVisibleToolsets` supplies both the prompt catalog and the check in `filterDeferredTools`. Removing its active-group filter for both consumers would keep `activate_toolset` available after the last eligible group activates. Separate the two views while retaining provider and policy ordering.

For example, activating `team-collaboration-desk` leaves its initial trigger description unchanged. The activation result and later tool declarations tell the agent that the group's tools are now available. If that was the last eligible inactive group, the runtime stops offering `activate_toolset` while retaining the initial catalog entry. This serves FRQ-01 and NRQ-01.

### Structured prompt composition
Retain the package's current prompt assembly and adapt its completed output to native history. Each contributor continues to compute the same complete text in the current handler order. A shared package composition boundary exposes the current rendered text to later contributors and records the completed text in a package-owned native section instead of returning a forced complete-prompt replacement.

One boundary instance and one `context_with_system` registration serve each extension runtime, including when extension entry points load individually. Reuse the cross-extension acquisition and lifecycle pattern in `getAgentRuntimeComposition` in `pi-package/shared/agent-runtime-composition.ts`. For example, loading `system-prompt` and `project-rules` as separate extensions still gives both contributors the same boundary and applies outgoing presentation once.

Currently, `ExtensionRunner.emitBeforeAgentStart` in the installed pi-coding-agent package turns a returned complete prompt into a forced replacement. `AgentSession._installAgentForcedPromptProjection` then combines that replacement and all current tool declarations into one leading message. All package contributors must publish through the shared composition boundary to leave this forced mode inactive:
- `systemPrompt` in `pi-package/extensions/system-prompt/index.ts` owns template rendering and main-agent versus child-agent selection.
- `AgentRuntimeCompositionImpl` in `pi-package/shared/agent-runtime-composition.ts` owns selected-agent and package prompt contributions.
- `projectRules` in `pi-package/extensions/project-rules/index.ts` owns project rules.
- `knowledgeExtension` in `pi-package/extensions/knowledge/index.ts` owns the knowledge block.

The native `context_with_system` hook gives the package access to the complete outgoing transcript. The shared boundary presents the recorded package text as the effective prompt and excludes the automatic native text that the package already replaced. It preserves the leading system message, tool declarations, and their recorded positions. Pi then serializes later declarations and prompt updates using its native provider support. The boundary owns prompt presentation only; it preserves non-system messages and tool availability.

Use the rendered text as the source of truth for prompt content. In particular, a custom template that omits a skills placeholder must continue to omit that text from the model-facing prompt. Pi's automatic generation of skills or project context must not add those omitted blocks back into the outgoing view. When package contributors leave native prompt assembly in control, preserve that native view.

Keep the current template parser, variable formatters, main-agent versus child-agent selection, custom-prompt precedence, configuration handling, and tool-eligibility decisions. Later contributors read the effective package text through the shared boundary, so their concatenation and ordering decisions remain the same. The native section stores the completed result; the current renderer continues to own its content.

`buildSystemPromptSections` in the installed pi-coding-agent package wraps custom section values in XML tags. The shared boundary removes the package section's pi-generated storage wrapper when exposing the effective prompt and preserves markup produced by the current renderer. For example, a rendered `<skills>...</skills>` block retains its tags in the outgoing prompt and acquires no enclosing tag named after the storage section. This distinction applies to initial presentation, historical updates, and effective-prompt accounting.

Leave the original skill metadata, project context, and appended-text inputs unchanged. Consequently, `collectLoadedSkillRoots` and the existing metadata readers in `askLlm`, `consultAdvisor`, `contextProjection`, and `knowledgeExtension` retain their current inputs. This avoids the earlier proposal to clear rendering inputs and maintain a separate metadata copy.

Prompt-budget consumers obtain the same effective rendered prompt through the shared boundary. This applies to `handleSessionBeforeCompact` in `pi-package/extensions/custom-compaction/index.ts` and to `getRequestSystemHead` in `pi-package/extensions/skill-restoration/index.ts`. Custom compaction currently reads `ctx.getSystemPrompt()`. Skill restoration currently substitutes the forced prompt into its accounting head and retains the replayed current tool declarations. Under native composition, both consumers need the effective prompt because the raw native state also contains automatic text excluded from the outgoing view.

Skill restoration retains the replayed current tool declarations when estimating input. Its candidate collection, selection limits, saved selections, and absent-file behavior remain unchanged. For example, when a template omits the skills block, both the outgoing prompt and the restoration estimate omit that automatic block while accounting still includes the current tool declarations. This preserves continuation behavior under FRQ-01.

Using the raw native prompt for these estimates could count excluded text and change which skill files fit after compaction. That accounting method is rejected because it changes a downstream behavior that the representation change must preserve. Reusing the shared effective-prompt view addresses this consumer dependency without another prompt store or a different estimation policy.

The intentional change is the representation of updates: pi records and announces later section updates and removals in history. The boundary derives each outgoing prompt update from the recorded state at that position. It must not replace the initial prompt with the latest rendered text on every request.

The package preserves the instruction bodies and the decisions about which bodies apply. The implementation uses `pi-package/shared/prompt-composition.ts` for shared publication, historical presentation, and effective-prompt accounting. Unit tests cover native-section publication, historical positions, section removal, empty renderings, and extension-runtime replacement.

The `runSession` helper in `test/integration/toolset-cache-invalidation.test.ts` starts real `AgentSession` instances with all four contributors above. Each main-agent and child-agent scenario activates a deferred group, executes its tools, and continues with another user turn. When a separate process reopens the saved native session, the fixture extension registers the same tools in reverse order. The restored agent executes a tool without reactivation. The tests intercept both target serializers before transport. For every consecutive request pair, they compare the previously submitted ordered `input` prefix and all remaining request fields, including Codex `instructions`. Fixture extensions supply scripted model responses and tool results.

The package-loading integration tests inspect the effective outgoing prompt through the real pi CLI in main-agent and child-agent modes. Provider cache-billing measurements are outside these checks.

### Conversation-local tool declarations
Keep the activation and permission logic in `ToolsetRuntimeImpl.activate`. The runtime changes actual tool availability through the existing composition and `pi.setActiveTools()` path. Pi records the corresponding tool declarations in history.

The target OpenAI APIs support those later declarations, so pi can submit them at their recorded conversation positions. The package needs no provider branches, custom request serializer, new invocation tool, or changes to pi core. The model continues calling activated tools by their registered names.

Pi also owns the delivery of full tool descriptions and parameter schemas. The activation result retains activation confirmation and provider-supplied usage instructions. Avoid maintaining a second declaration catalog in tool-result text. For example, after activating the collaboration toolset, the model calls `team_message_create` directly using the declaration that pi added later in the conversation. This serves FRQ-01 and NRQ-01.

### Request boundary verification
Assess NRQ-01 against the provider request after pi's native serialization. The OpenAI serializer includes the leading prompt in `input`; the Codex serializer places it in `instructions` while retaining conversation-local tool declarations in `input`. Verify zero activation- or restoration-attributable changes to previously submitted ordered input items and cache-relevant leading fields for both targets under fixed request conditions.

For example, a resumed Codex request with unchanged earlier input items but changed initial `instructions` fails prefix preservation. Comparing active tool names or an internal transcript alone cannot establish NRQ-01 because those checks bypass the provider request representation. This verification requires no provider-specific package implementation or live cache-billing measurement.

### Continuation and compaction
Keep the existing activation snapshots and branch restoration. Pi retains earlier declarations at their recorded positions in native system messages, so restoring active tools in another process does not require moving those declarations to the beginning of the request. Pi appends an order-only change in a regenerated section as a later section update on the supported targets.

Pi's compaction checkpoint contains current system sections and tool declarations. Continue restoring activation state from the existing toolset history, so the agent knows its available tools and remaining activation choices after compaction. After compaction, pi forms a new cacheable context; preserving the cache across compaction itself remains outside scope.

These mechanisms serve FRQ-01 and NRQ-01 without another persistent toolset state store.

### Alternatives and trade-offs
The shared native API is selected because the target OpenAI configurations support conversation-local changes. The agent retains deferred tool discovery and direct tool calls. Under accepted risk R1, pi can rebuild the prefix on other providers or models while tools remain functional.

Declaring every permitted tool at session start would stabilize the declarations across more providers, but the user would submit and pay for schemas of unused toolsets from the first request. This is unnecessary for the agreed target.

A permanent generic invocation tool could keep provider-facing declarations fixed, but it would change model-facing calls and move target-specific argument validation out of provider sampling. This is also unnecessary for the agreed target.

The first request using native composition establishes the cache baseline for subsequent activation and continuation. The solution includes no migration mechanism for a prefix cached before installation.

## Overengineering and Overspecification Considerations
The design reuses the existing renderers, toolset runtime, activation history, native prompt sections, native tool declarations, and pi's provider serializers. The shared composition boundary is necessary to keep completed prompt text authoritative while retaining native tool-update positions. Its outgoing view and effective-prompt accessor serve model requests, compaction, and skill-restoration accounting. All complete-prompt contributors use it because any remaining forced replacement would collapse the history again.

The design adds no provider-specific branch, permanent invocation tool, full-catalog preload, metadata copy, independent activation store, or pi-core patch. Exact section names, internal helper signatures, and test organization are left to implementation.

## Open Questions
None.

## References
- `pi-package/shared/toolsets/runtime.ts`, `ToolsetRuntimeImpl.activate`, `restoreFromBranch`, `getVisibleToolsets`, `resolveVisibleToolsets`, and `filterDeferredTools`: activation, restoration, and the current shared dependency of catalog rendering and activation-tool availability.
- `pi-package/extensions/system-prompt/index.ts`, `systemPrompt`: current complete-template replacement.
- `pi-package/shared/agent-runtime-composition.ts`, `AgentRuntimeCompositionImpl` and `getAgentRuntimeComposition`: current complete-prompt contribution, active-tool reconciliation, and cross-extension shared-runtime acquisition.
- `pi-package/extensions/project-rules/index.ts`, `projectRules`: current complete-prompt return for project rules.
- `pi-package/extensions/knowledge/index.ts`, `knowledgeExtension`: current complete-prompt return for knowledge.
- `pi-package/shared/context-projection.ts`, `collectLoadedSkillRoots`: downstream use of loaded-skill metadata.
- `pi-package/extensions/ask-llm/index.ts`, `askLlm`, and `pi-package/extensions/consult-advisor/index.ts`, `consultAdvisor`: downstream use of loaded skills and project context files.
- `pi-package/extensions/custom-compaction/index.ts`, `handleSessionBeforeCompact`: use of the effective main prompt during compaction.
- `pi-package/extensions/skill-restoration/index.ts`, `skillRestoration` and `getRequestSystemHead`, and `pi-package/extensions/skill-restoration/restoration.ts`, `selectRestoration`: request-head accounting and selection of restored skill files.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js`, `buildSystemPromptSections`: native section storage wrappers.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js`, `ExtensionRunner.emitContext`: the native full-transcript hook.
- `node_modules/@earendil-works/pi-ai/dist/utils/text.js`, `getSystemMessageText` and `renderSystemMessageUpdate`: rendering of recorded prompt sections and later changes.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js`, `ExtensionRunner.emitBeforeAgentStart`: interpretation of complete-prompt returns.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`, `AgentSession._installAgentForcedPromptProjection`, `_preparePromptAndToolLoadout`, and `_restoreToolsFromTranscript`: forced projection, native updates, and restoration.
- `node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js`, `getResponsesToolSupport` and `convertResponsesMessages`: conversation-local tool serialization.
- `node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js`, `buildParams`, and `api/openai-codex-responses.js` in the same package, `buildRequestBody`: target request shapes and placement of the initial prompt.
- `node_modules/@earendil-works/pi-ai/dist/providers/data/openai.json` and `openai-codex.json`: target model capabilities.
