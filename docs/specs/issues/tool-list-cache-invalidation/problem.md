# Problem Statement

## Key definitions and abbreviations
See [terms.md](terms.md).

## Context
In a long session, pi repeatedly sends earlier conversation context to the model. When pi changes the request prefix, the provider loses the ability to reuse cached context after the point of change and bills that context as new input.

## Observed Problem
When the agent calls `activate_toolset`, pi adds the selected toolset's tools and changes the beginning of the request to the model. The provider then loses the ability to reuse cached context after the point of change. The user spends quota or money again on conversation history already submitted in the same session.

## Affected Audience
Users whose main agents or subagents call `activate_toolset` in long sessions, including users who subsequently continue or resume those sessions.

## Evidence
In session `ab81b213-8738-40be-8b68-5bbcd44bfa5c` on 2026-10-25, using `openai-codex`:
- The agent called `activate_toolset` for `team-collaboration-desk`.
- Pi recorded five added tool declarations and an updated `tools` section.
- For the next response, the provider reported 12,800 cached input tokens and 211,308 new input tokens.
- Before a later user prompt, pi recorded the same visible tool names in another order.

An isolated run with pi 1.4.0 reproduced that order change when another process reopened a saved session after toolset activation. A second prompt in the original process preserved the tested active-tool order.

## Impact
HIGH: users pay again for previously submitted conversation history when they activate tools. The repeated expense grows with the amount of context after the changed prefix.

## Current State
The agent uses `activate_toolset` to make deferred tools available. Pi updates the tools supplied to the model, including declarations near the beginning of the request. During later session continuation, pi can also reorder the activated tools without changing their membership.

After compaction, pi retains current tool declarations and toolset activation state, so the agent can continue using activated tools.

## Desired State
The agent activates tools through `activate_toolset` while preserving the provider's ability to reuse cached context from earlier requests.

## Problem Boundary
- In scope: toolset activation and subsequent prompts or saved-session continuation for main agents and subagents, including reordered tools after restoration.
- In scope: providers that cache request prefixes. The usage measurements above concern `openai-codex`.
- Out of scope: cache misses caused by thinking-level changes, cache expiration, context projection, or compaction itself.

## Assumptions
No assumptions are needed to state the observed problem. Usage effects on providers other than `openai-codex` have not been measured.

## Open Questions
None for the problem statement.
