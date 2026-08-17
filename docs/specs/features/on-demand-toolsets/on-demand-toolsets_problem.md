# Problem Statement

## Context

`mcp-wrapper` exposes tools from configured MCP servers to an LLM session. Users may configure many specialized tool providers, while each task usually requires only a subset of their capabilities.

## Problem Statement

`mcp-wrapper` makes all discovered tools available to the model provider regardless of their relevance to the current task. Irrelevant tool definitions consume context and make the available-tool catalog harder for the LLM to navigate.

## Who is affected

Users who configure multiple specialized MCP servers whose tools are not expected to be used simultaneously.

## Evidence

- `pi-package/extensions/mcp-wrapper/index.ts`: `registerCatalogTools` registers every catalog entry produced from discovered MCP tools.
- `pi-package/extensions/mcp-wrapper/index.ts`: `handleSessionStart` loads metadata and builds the catalog for configured servers.
- `pi-package/extensions/system-prompt/index.ts`: `buildTemplateValues` provides active tool and skill content to system-prompt macros.
- `docs/extensions/system-prompt.md`: `{{tools}}` expands active tool prompt text, while `{{skills}}` provides a compact catalog for progressive disclosure.
- The reported user scenario states that loading all tools creates excessive context.

No token measurements or provider-specific limits have been collected.

## Impact

- Irrelevant tool schemas consume model input.
- A large tool catalog increases the amount of unrelated information the LLM must inspect.
- Reduced signal-to-noise ratio may impair tool selection. This is a hypothesis; it requires comparison of representative sessions before and after the change.

## Reproduction Steps

1. Configure several MCP servers in `mcp-wrapper`.
2. Start a pi session with `mcp-wrapper` enabled.
3. Inspect active tools and the tool definitions sent to the model provider.
4. Observe that tools from all successfully discovered servers are available even when the current task needs only one specialized toolset.

## Current State

Every successfully discovered MCP tool is registered for normal use. The system has no user-visible distinction between immediately available toolsets and toolsets that should become available only when relevant.

## Desired Outcome

Users can keep specialized toolsets outside the initial model context while preserving enough information for the LLM to identify and enable a relevant toolset during the session.

## Success Metrics

1. Toolsets designated for deferred availability contribute no tool definitions to the initial model-provider request.
2. The initial system prompt retains a compact activation signal for each deferred toolset.
3. A relevant deferred toolset can become available within the current session without restarting pi.
4. Toolsets not designated for deferred availability retain their established behavior.

## Scope

- Context and model-provider tool-list growth caused by specialized MCP toolsets.
- Discoverability of deferred toolsets.
- Transition of a deferred toolset to normal availability within a session.

## Out of Scope / Non-Goals

- Reducing MCP connection or discovery startup cost as an independent goal.
- Reducing resource usage of connected MCP servers.
- Supporting tool providers other than MCP servers in the initial feature.
- Measuring or optimizing provider-specific token limits.

## Constraints

- The current source of toolsets is `mcp-wrapper` and its configured MCP servers.
- The system-prompt extension owns project template variables described in `docs/extensions/system-prompt.md`.
- Existing non-deferred MCP usage must remain viable.
- No baseline token or tool-count threshold is available.

## Assumptions

- Removing irrelevant tool definitions reduces initial context size. Verify by comparing serialized model-provider requests with identical configurations.
- A compact trigger catalog gives the LLM enough information to select a deferred toolset. Verify through behavior tests and representative live pi scenarios.
- Users can classify specialized toolsets when configuring them. Verify through configuration usability review.

## Open Questions

None at the problem-definition level.

# Domain Glossary

- **tool**: An individual operation that an LLM can invoke.
- **toolset**: A named collection of tools that becomes available as one unit.
- **tool provider**: A source that supplies one or more tools.
- **MCP server**: The tool-provider type supported by the initial feature.
- **model provider**: The service receiving the LLM request, including active tool definitions.
- **activation trigger**: Compact metadata describing when an LLM should make a deferred toolset available.
- **deferred toolset**: A toolset excluded from initial model context and model-provider tool definitions but represented by an activation trigger.
- **active toolset**: A toolset whose tools are available to the LLM under normal session behavior.
