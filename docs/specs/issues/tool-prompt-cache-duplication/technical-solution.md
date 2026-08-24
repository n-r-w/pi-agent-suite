# Technical Solution: Tool and Workflow Prompt Cache Duplication

## Problem Statement
- PRB-01: The bundled system prompt repeats active tool names and prompt snippets even though the provider tool payload already contains each active tool's name, description, and parameter schema.
- PRB-02: MCP server instructions are appended through `before_agent_start`. The append occurs after system-prompt replacement and repeats the instruction text on each model request.
- PRB-03: The workflow extension appends a transient snapshot through the `context` event before every model request. The snapshot repeats extension guidance, activation options, workflow metadata, the full transition graph, and active-stage guidance.
- PRB-04: Transient workflow messages are absent from persisted session history. The next request inserts assistant and tool-result messages at the previous transient suffix position, so the provider cannot reuse that suffix as a stable prompt prefix.
- PRB-05: Moving mutable workflow state into the system prompt would invalidate the system-prompt prefix after activation, transition, edit, completion, policy change, or compaction.
- PRB-06: `sendMessage` with `triggerTurn: false` during tool execution writes to persisted agent state but not to the active loop's copied `currentContext`. The model does not receive the journal record until a later user-triggered run.
- PRB-07: Pi persists model-facing custom messages as `custom_message` session entries. Reading them as nested `message` entries prevents restore deduplication and can append duplicate activation options.
- PRB-08: Deferred MCP instructions persist inside the first successful `activate_toolset` result. Checking only standalone `mcp-instructions` messages during restoration appends a duplicate copy.
- PRB-09: Removing one or all MCP servers can leave their earlier instruction blocks visible. Coverage of retained servers does not prove that the persisted instruction set has no stale servers.
- PRB-10: Compaction without workflow state emits no checkpoint. Without a separate segment reset, activation-options deduplication suppresses availability in the new provider-visible segment.
- PRB-11: Workflow ID, status, and route-tail stage do not identify the model-visible workflow definition. A persisted stage edit without its journal record requires restoration repair. Treating old revisionless lifecycle records as missing records creates repeated checkpoints during branch navigation.

## Proposed Solution

### SOL-01: Provider tool payload ownership
- Keep tool names, descriptions, JSON Schema, and parameter descriptions in Pi tool definitions.
- Treat the provider tool payload as the authoritative model-facing tool catalog.
- Keep `promptSnippet` for Pi and custom templates that consume it outside the bundled system prompt.
- Cover the provider boundary with a real Pi `before_provider_request` integration test. The test compares `pi.getActiveTools()` with provider tool names and checks tool and parameter descriptions.

### SOL-02: Bundled system-prompt cleanup
- Remove `{{tools}}` from `SUPPORTED_TEMPLATE_VARIABLES`, `buildTemplateValues`, and the bundled `system.md` template.
- Retain `{{toolGuidelines}}` for behavioral instructions that do not belong in provider tool metadata.
- Normalize each guideline with `trim()`, discard empty values, and retain the first occurrence of each duplicate.
- Publish workflow extension guidance through each workflow tool's `promptGuidelines`. Deduplication renders the shared guidance once when one or more workflow tools are active.

### SOL-03: Persistent MCP instructions
- Remove MCP system-prompt mutation from `before_agent_start`.
- At `session_start`, derive the effective post-boundary instruction set from the latest hidden replacement plus later successful `activate_toolset` results. Persist a hidden replacement when its exact rendered server blocks differ from the active generated MCP servers.
- Add the activated server's rendered MCP instructions to the first successful `activate_toolset` result through the shared `Toolset.activationContext` contract.
- Omit `activationContext` from idempotent activation results so repeated activation does not duplicate instruction text.
- Persist `<mcp_instructions />` when no generated MCP server remains active but the provider-visible segment contains one or more instruction blocks. The self-closing record replaces all earlier MCP instructions in that segment.
- After `session_compact`, persist the non-empty instruction set for active generated MCP tools because pre-compaction records no longer belong to the provider-visible context segment.
- Compare exact rendered server-block sets during restoration. Matching requires both complete active-server coverage and no stale server block.

### SOL-04: Append-only workflow journal
- Remove the workflow `context` handler and its transient full snapshot.
- Persist model-facing workflow records with `customType: "workflow"`, `display: false`, and `deliverAs: "steer"`.
- Do not set `triggerTurn: false`. During an active tool loop, that option writes only to session state because the loop's `currentContext` is already a separate message array. `deliverAs: "steer"` adds the record to the next provider request in the active loop and persists it without starting a new turn when Pi is idle.
- Keep `workflow-state` custom entries as the authoritative runtime reconstruction data. Workflow journal messages provide model instructions and do not replace state replay.
- Append one activation message containing `<workflow_activated>` and the initial `<workflow_stage_activated guidelines="inline">` record.
- Append `<workflow_stage_activated>` on each transition. Use `guidelines="inline"` for a stage whose definition is unknown in the provider-visible context segment and `guidelines="reuse"` for a known unchanged definition.
- Include only route-allowed outgoing edges in each `<available_transitions>` block. Emit `<available_transitions />` when no outgoing edge is allowed.
- Append `<workflow_stage_updated>` with the replacement stage description, initial or final flags, and stage guidance after `workflow_edit_stage` persists.
- Append `<workflow_completed>` with rework transitions and no completed-stage prompt after `agent_settled` persists completion. Because settlement occurs after the active agent loop ends, the record is available to the next user-triggered provider request rather than the response that finishes the final stage.

### SOL-05: Workflow activation options
- Keep activation availability separate from workflow lifecycle records.
- Persist `<workflow_activation_options>` after session initialization and after workflow or policy changes when its rendered value changes.
- Reset activation-options deduplication at every `session_compact`, including compaction without active or completed workflow state, then publish availability for the new provider-visible segment. A repair checkpoint outside compaction preserves activation-options deduplication.
- Persist `<workflow_activation_options />` when no catalog workflow is available. This record replaces an older non-empty option list.
- Filter options through workflow policy and final active-tool reconciliation. A hidden or disallowed `workflow_activate` tool produces an empty options record.

### SOL-06: Compaction and restoration
- After `session_compact`, append one `<workflow_checkpoint>` for the replayed workflow state.
- An active checkpoint contains workflow ID, `status="active"`, active stage ID, root guidance, active-stage guidance, and route-allowed transitions.
- A completed checkpoint contains workflow ID, `status="completed"`, completed stage ID, root guidance, and rework transitions. It contains no stage prompt.
- Reset known stage definitions at compaction. Only the active stage definition remains known for an active checkpoint.
- Re-publish workflow activation options after the checkpoint because the pre-compaction availability record is outside the provider-visible context segment.
- During `session_start` and `session_tree`, scan `custom_message` workflow entries after the latest `compaction` or `branch_summary` boundary.
- Require `journalVersion: 1` in new `activated` and `created` workflow-state snapshots. Ignore an older root snapshot without this field, report the existing old-format warning, and append no repair checkpoint.
- Add a SHA-256 workflow-definition revision to every lifecycle record. The revision covers the normalized workflow snapshot, including stage edits.
- Append a checkpoint when current-format replayed `workflow-state` has no compatible workflow lifecycle record. Compatibility requires matching workflow ID, status, route-tail stage, and workflow-definition revision.
- Track the route-tail stage separately from an edited stage ID. Editing an inactive stage must not make that stage the restored active stage.

### SOL-07: Failure and ordering boundaries
- Persist `workflow-state` before publishing the corresponding workflow journal record.
- Apply workflow model settings before state persistence, preserving the existing rollback behavior when state persistence fails.
- Publish no activation, transition, edit, or completion journal record when state persistence fails.
- Repair a missing journal record from persisted workflow state on the next session start or branch navigation.
- Keep stage triggers after state persistence and in-memory state entry. Trigger failure does not invalidate the persisted workflow operation.

### SOL-08: Validation
- Run `bun run test` for behavior tests.
- Run `bun run typecheck` for strict TypeScript checks.
- Run `bun run check` for Biome formatting and lint checks.
- Run `bun run verify` for the full suite.
- Keep real Pi integration coverage for provider tool payloads, package loading, main-agent workflow policy, child workflow policy, and workflow message visibility in the provider request immediately after a workflow tool call.
- Unit tests inspect persisted workflow records directly. They do not simulate provider calls by returning the latest journal message from a test helper.

## Overengineering and Overspecification Considerations
- The solution uses Pi's existing tool payload, custom messages, tool results, state entries, and lifecycle events. It adds no storage service, cache, provider adapter, or model request.
- `Toolset.activationContext` is provider-neutral. The shared toolset runtime does not depend on MCP-specific types.
- Workflow state replay remains unchanged as the runtime authority. The journal adds only model-facing deltas and repair checkpoints.
- Compaction repair is limited to one workflow checkpoint, one activation-options replacement, and one MCP instruction replacement for the exact active-server set.

## Open Questions

No unresolved design questions remain for this solution.

## References
- REF-01: `pi-package/extensions/system-prompt/index.ts` - bundled template variables and guideline deduplication.
- REF-02: `pi-package/extensions/system-prompt/prompts/system.md` - bundled system-prompt structure.
- REF-03: `pi-package/shared/toolsets/contracts.ts` - shared activation-context contract.
- REF-04: `pi-package/shared/toolsets/runtime.ts` - first-activation result persistence.
- REF-05: `pi-package/extensions/mcp-wrapper/index.ts` - MCP instruction selection, persistence, activation, and compaction recovery.
- REF-06: `pi-package/extensions/workflow/context.ts` - workflow journal rendering, deduplication, restoration, and checkpoints.
- REF-07: `pi-package/extensions/workflow/index.ts` - workflow lifecycle, tool commits, policy changes, and journal publication.
- REF-08: `test/integration/runtime-package-loading.test.ts` - real Pi provider and workflow policy contracts.
- REF-09: `docs/extensions/system-prompt.md` - system-prompt user contract.
- REF-10: `docs/extensions/mcp-wrapper.md` - MCP wrapper user contract.
- REF-11: `docs/extensions/workflow.md` - workflow journal user contract.
