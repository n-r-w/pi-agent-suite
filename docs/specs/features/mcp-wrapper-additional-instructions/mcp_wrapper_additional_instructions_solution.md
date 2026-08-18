# Technical Solution: Conditional Local Instructions for MCP Servers

## Problem Statement

- TS-P1: `mcp-wrapper` cannot accept local MCP instructions in an MCP server configuration.
- TS-P2: Local MCP instructions must appear in an agent runtime's final system prompt exactly when at least one Pi tool from that MCP server is present in the runtime's final `pi.getActiveTools()` result.
- TS-P3: The solution must preserve server-provided MCP instructions and must not change active-tool reconciliation.

## Proposed Solution

### Configuration contract

- TS-C1: Add `additionalInstructions?: string` to both variants of `McpServerConfig` in `pi-package/extensions/mcp-wrapper/config.ts`.
- TS-C2: Add `additionalInstructions` to the allowed keys for `stdio` and `streamableHttp` server configurations.
- TS-C3: Reject a defined non-string `additionalInstructions` value as an invalid MCP server configuration.
- TS-C4: Use `additionalInstructions.trim()` only to determine whether the string contains text. Omit a value whose trimmed result is empty; otherwise preserve the original string without trimming it.
- TS-C5: An absent or omitted `additionalInstructions` value preserves the behavior of configurations that predate this feature.

Example:

```json
{
  "mcpServers": {
    "docs": {
      "type": "streamableHttp",
      "url": "https://example.com/mcp",
      "additionalInstructions": "Use this server for internal documentation."
    }
  }
}
```

### Instruction record assembly

- TS-A1: Keep one `ServerInstructionRecord` per MCP server. The record remains the single input to active-tool filtering and prompt rendering.
- TS-A2: Replace `buildActiveServerInstructions` with a builder that receives server-provided MCP instructions, parsed MCP server configurations, and accepted `PiToolCatalogEntry` values.
- TS-A3: Create a record only when the MCP server has at least one accepted Pi tool and at least one non-empty instruction source.
- TS-A4: For one MCP server, compose the record text from server-provided MCP instructions followed by local MCP instructions, separated by exactly one blank line. A single available source is used without an added separator.
- TS-A5: Preserve the relative order of records backed by server-provided MCP instructions. Append records that contain only local MCP instructions in MCP server configuration order.
- TS-A6: A server without accepted Pi tools produces no instruction record, including when `additionalInstructions` contains text.

### Prompt visibility and rendering

- TS-R1: Keep `registerMcpInstructionPromptHandler` as the only MCP instruction prompt handler.
- TS-R2: On every `before_agent_start` event, filter instruction records against the final names returned by `pi.getActiveTools()` for that agent runtime.
- TS-R3: Include a server record when at least one name in its `registeredPiToolNames` exists in `pi.getActiveTools()`; otherwise omit the record.
- TS-R4: Render the result through the existing `<mcp_instructions>` and `<server name="...">` structure. This keeps one server block when both instruction sources exist.
- TS-R5: Pass the combined text through the existing `escapeMcpInstructionText` function before adding it to the final system prompt.
- TS-R6: Do not add a new `AgentRuntimeComposition` contribution. `AgentRuntimeComposition` remains the owner of final active-tool reconciliation, while `mcp-wrapper` remains the owner of MCP instruction rendering.

### Metadata cache

- TS-M1: Do not store `additionalInstructions` in `CachedMcpServerMetadata`.
- TS-M2: Exclude `additionalInstructions` from `computeMcpServerConfigHash` together with `onDemand`, because neither field changes MCP connection identity or discovered metadata.
- TS-M3: Read local MCP instructions from the parsed configuration during each session start and associate them with the accepted Pi tool catalog built from cached or discovered metadata.
- TS-M4: Changing only `additionalInstructions` must not trigger MCP metadata discovery. The new value takes effect on the next runtime reload or session start that reads the configuration.

### Failure behavior

- TS-F1: A non-string `additionalInstructions` value follows the existing invalid-configuration path: `mcp-wrapper` registers no MCP tools for that session and reports its configuration warning.
- TS-F2: An empty or whitespace-only `additionalInstructions` value produces no local MCP instructions and does not affect server-provided MCP instructions.
- TS-F3: MCP metadata failure behavior remains unchanged. A server without accepted tool metadata has no active Pi tool and therefore cannot expose local MCP instructions.

### Verification

- TS-V1: Add parser tests for non-empty strings, exact preservation of non-empty text, empty and whitespace-only omission, non-string rejection, and both MCP transport variants.
- TS-V2: Add metadata-cache tests proving that changing only `additionalInstructions` does not change the server configuration hash.
- TS-V3: Add behavior tests proving local-only rendering, server-provided-then-local ordering, omission without an active server tool, and omission for empty local instructions.
- TS-V4: Extend system-prompt integration tests to prove that final active-tool restrictions control local MCP instruction visibility without changing server-provided instruction behavior.
- TS-V5: Verify the main-agent and child-agent prompt paths using the repository's required real `pi` CLI runtime check with temporary configuration, state, and debug output.
- TS-V6: Run `bun run test`, `bun run typecheck`, `bun run check`, and `bun run verify` after implementation.

### Documentation

- TS-D1: Update `docs/extensions/mcp-wrapper.md` with the new server parameter, configuration example, empty-value behavior, merge order, active-tool condition, and metadata-cache behavior.
- TS-D2: Keep the Problem Statement, Light PRD, and this Technical Solution under `docs/specs/features/mcp-wrapper-additional-instructions/`.

## Overengineering and Overspecification Considerations

- TS-O1: The design reuses the existing instruction record, active-tool filter, XML-like prompt structure, and lifecycle handler instead of adding another prompt handler or composition layer.
- TS-O2: The configuration accepts one string rather than arrays, file references, templates, or per-agent overrides because the approved requirements do not require those capabilities.
- TS-O3: Local MCP instructions remain outside the metadata cache because they do not affect transport setup or MCP discovery.

## Open Questions

- TS-Q1: None.

## References

- TS-REF1: `docs/specs/features/mcp-wrapper-additional-instructions/mcp_wrapper_additional_instructions_problem.md` - approved Problem Statement and Domain Glossary.
- TS-REF2: `docs/specs/features/mcp-wrapper-additional-instructions/mcp_wrapper_additional_instructions_prd.md` - approved Light PRD.
- TS-REF3: `pi-package/extensions/mcp-wrapper/config.ts` - MCP server configuration types and strict parser.
- TS-REF4: `pi-package/extensions/mcp-wrapper/index.ts` - instruction assembly, active-tool filtering, and prompt rendering.
- TS-REF5: `pi-package/extensions/mcp-wrapper/metadata-cache.ts` - MCP metadata cache identity and storage.
- TS-REF6: `pi-package/shared/agent-runtime-composition.ts` - final active-tool reconciliation.
