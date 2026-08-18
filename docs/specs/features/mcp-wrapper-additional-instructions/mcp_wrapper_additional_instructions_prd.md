# Idea: Conditional Local Instructions for MCP Servers

## Definitions

- **MCP server:** A server configured in `mcp-wrapper` that provides one or more MCP tools.
- **Pi tool:** The Pi representation of an MCP tool registered by `mcp-wrapper`.
- **Active Pi tool:** A Pi tool present in `pi.getActiveTools()` for an agent runtime after all tool restrictions are applied.
- **Agent runtime:** A separate Pi instance that determines its own active Pi tools and system prompt for a main agent or child agent.
- **Server-provided MCP instructions:** Instructions returned by an MCP server during initialization.
- **Local MCP instructions:** Instructions associated with a specific MCP server and defined by an agent suite administrator.

## Context and Problem

`mcp-wrapper` conditionally adds server-provided MCP instructions to an agent's system prompt. An agent suite administrator cannot define equivalent local MCP instructions whose visibility follows the final active Pi tools of each agent runtime.

## Goal

Allow an agent suite administrator to define local MCP instructions that each agent runtime receives exactly when at least one Pi tool from the corresponding MCP server is active.

## Scenarios

- An MCP server has an active Pi tool and non-empty local MCP instructions. The final system prompt contains both its server-provided MCP instructions and local MCP instructions.
- An MCP server has no active Pi tools. The final system prompt omits its local MCP instructions.
- An MCP server has absent or empty local MCP instructions. The value is treated as not configured.

## Scope and Non-Scope

In scope:

- One local MCP instruction string for each configured MCP server.
- Conditional visibility based on final active Pi tools in each agent runtime.
- Coexistence of local and server-provided MCP instructions.

Out of scope:

- Replacing server-provided MCP instructions.
- Changing active-tool reconciliation.
- Defining multiple local instruction entries for one MCP server.

## Requirements

- Each `mcpServers.<server>` configuration accepts an optional `additionalInstructions` field containing a multiline string.
- An agent runtime includes an MCP server's local MCP instructions in its final system prompt exactly when `pi.getActiveTools()` contains at least one Pi tool registered from that MCP server.
- When local and server-provided MCP instructions exist for the same MCP server, the final system prompt includes both.
- An absent or empty `additionalInstructions` string is treated as local MCP instructions not being configured.

## Open Questions

None.

## Technical Supplement

Excluded. Implementation design belongs to the technical solution.

## References

- `docs/specs/features/mcp-wrapper-additional-instructions/mcp_wrapper_additional_instructions_problem.md`
- `docs/extensions/mcp-wrapper.md`
