# Idea: Preserve cached context across toolset activation

## Definitions
See [terms.md](terms.md).

## Context and Problem
See [problem.md](problem.md).

## Goal
The agent continues to use `activate_toolset` while the user retains the benefit of caching previously submitted context on supported OpenAI models.

## Scenarios
- The agent activates a toolset during a session and uses its tools.
- The agent sends another prompt after activation or resumes the saved session in another process.
- After compaction, the agent continues using activated tools and can identify toolsets that remain available for activation.

These scenarios apply to main agents and subagents.

## Scope and Non-Scope
In scope: toolset activation, subsequent prompts, and saved-session continuation for main agents and subagents. Tool functionality applies to all providers. Prefix preservation applies to OpenAI models that support adding tool declarations within conversation history, including the targeted `openai` and `openai-codex` configurations.

After compaction, the requirements apply to the context formed after compaction. Preserving the cache across compaction itself is outside this task. Cache expiration, thinking-level changes, and context projection are also outside this task.

## Requirements

### Functional Requirements
- [X] FRQ-01: After a successful `activate_toolset` call, the agent can use the selected toolset's tools that its policy permits. During session continuation, including after compaction, the agent knows which tools are available and which toolsets it can still activate.
  - Origin: source. The desired state in problem.md and the agreed problem statement.
  - Goal: preserve the ability to activate and use tools.
  - Goal achievement: Partial. The agent retains its capabilities; NRQ-01 addresses repeated context costs.
  - Feasibility: Confirmed. Pi already enables tools on activation and restores activation state from session history.
  - Example: after activating `web-fetch`, the agent can call that toolset's tools and can still use them when it continues the session.

### Non-Functional Requirements
- [X] NRQ-01: For OpenAI models that support adding tool declarations within conversation history, an `activate_toolset` call and subsequent session continuation preserve the previously submitted cacheable request prefix. The number of changes to that prefix caused by activation or restoration of activated tools is zero.
  - Origin: source. The agreed problem of paying again for earlier context after `activate_toolset`, with OpenAI as the primary target and cache loss on other providers accepted.
  - Goal: eliminate cache invalidation caused by tool activation on the targeted OpenAI models.
  - Goal achievement: Full for the agreed cause of repeated costs on those models, while the provider cache remains valid and other request parameters remain unchanged.
  - Feasibility: Confirmed at the local request boundary. Pi supports conversation-local tool declarations for the targeted OpenAI models.
  - Verification: compare the cacheable prefix in requests to the targeted OpenAI models before and after activation and session continuation. There must be zero changes attributable to activation or restoration of activated tools.
  - Example: after `activate_toolset`, the next request contains information about the activated tools while preserving its previously submitted beginning.

## Accepted Risks
- R1: On other providers or models, pi may rebuild the request prefix after tool activation. Tools remain functional, but the provider may bill earlier context as new input. Cache preservation on those configurations is outside NRQ-01.

## Open Questions
None for the requirements.

## Technical Supplement
No implementation approach is prescribed by these requirements.

