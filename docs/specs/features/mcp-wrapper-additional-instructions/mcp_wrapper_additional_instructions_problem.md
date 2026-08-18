# Problem Statement

## Context

`mcp-wrapper` registers MCP server tools as Pi tools. Each agent runtime determines its final active Pi tools after applying main-agent policy, child and depth policy, workflow restrictions, vision restrictions, and on-demand activation.

## Problem Statement

An agent suite administrator cannot define local instructions for a specific MCP server so that an agent receives those instructions only when at least one Pi tool from that MCP server is available to that agent.

## Who is affected

Developers and administrators who configure `mcp-wrapper` and agent system prompts in an agent suite.

## Evidence

- `pi-package/extensions/mcp-wrapper/config.ts` has no field for local MCP instructions and rejects unsupported fields.
- `registerMcpInstructionPromptHandler` in `pi-package/extensions/mcp-wrapper/index.ts` adds only instructions returned by an MCP server during initialization.
- The handler already checks `pi.getActiveTools()` and includes an MCP server's instructions only when at least one registered Pi tool from that server is active.
- `AgentRuntimeComposition` in `pi-package/shared/agent-runtime-composition.ts` computes the final active Pi tools after applying all tool restrictions.
- `test/integration/mcp-wrapper-system-prompt.test.ts` verifies that server-provided MCP instructions are filtered using final active Pi tools.

## Impact

An agent suite administrator must choose one of these inadequate alternatives:

- Put MCP-specific instructions in the global system prompt, where agents without access to the corresponding tools also receive them.
- Modify the MCP server to provide instructions specific to the agent suite.
- Leave agents without local guidance for using an available MCP server.

No quantitative data is available for the frequency or cost of this problem.

## Reproduction Steps

1. Configure an MCP server in `mcp-wrapper`.
2. Add local instructions to that server's configuration.
3. Observe that configuration parsing rejects the unsupported field.
4. Put the instructions in the global system prompt instead.
5. Observe that instruction visibility does not depend on whether the current agent can use a tool from that MCP server.

## Current State

Conditional prompt inclusion exists for instructions returned by an MCP server during initialization. No equivalent mechanism exists for local instructions defined by an agent suite administrator.

## Desired Outcome

Each agent runtime receives local instructions for an MCP server only when at least one Pi tool from that server remains active after all tool restrictions are applied to that runtime.

## Success Metrics

- When an MCP server has an active Pi tool, the agent's final system prompt contains that server's local instructions.
- When an MCP server has no active Pi tool, the agent's final system prompt omits that server's local instructions.
- Instruction visibility uses the final active Pi tools of the current agent runtime, not the registered tool catalog.

## Scope

- Local instructions associated with one MCP server.
- Main agents, regular subagents, and other child agents.
- Instruction visibility based on final tool availability in each agent runtime.

## Out of Scope / Non-Goals

- Changing the MCP protocol.
- Changing instructions returned by MCP servers during initialization.
- Redesigning tool restrictions or on-demand tool activation.
- Selecting the configuration shape, merge order, or implementation architecture; later design phases own these decisions.

## Constraints

- `AgentRuntimeComposition` remains the owner of final active Pi tool reconciliation.
- Each agent runtime determines tool activity independently.
- Tool registration alone must not make local MCP instructions visible.

## Assumptions

There are no assumptions that affect the problem definition.

## Open Questions

None at the problem-definition level.

# Domain Glossary

- **MCP server:** A server configured in `mcp-wrapper` that provides one or more MCP tools.
- **MCP tool:** A tool declared by an MCP server.
- **Pi tool:** The Pi representation of an MCP tool registered by `mcp-wrapper`.
- **Active Pi tool:** A Pi tool present in `pi.getActiveTools()` for an agent runtime after all tool restrictions are applied.
- **Agent runtime:** A separate Pi instance that determines its own active Pi tools and system prompt for a main agent or child agent.
- **Server-provided MCP instructions:** Instructions returned by an MCP server during initialization.
- **Local MCP instructions:** Instructions associated with a specific MCP server and defined by an agent suite administrator.
- **Active MCP server:** An MCP server with at least one active Pi tool in the current agent runtime.
