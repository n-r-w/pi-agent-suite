# Problem Statement

## Context

Pi extensions can request a global TUI render after periodic refreshes or runtime events.

## Observed Problem

Background refreshes can request a global TUI render even when the component's visible state remains unchanged.

## Affected Audience

Users who keep interactive Pi sessions or the subagent management screen open.

## Evidence

- `footer` requested a render every 10 seconds after reading unchanged usage totals.
- A 2.4 MB session required approximately 100–120 ms of CPU for each global render.
- `codex-quota` published repeated status text after identical background refresh results.
- The subagent management screen refreshed active elapsed time every second.

## Impact

Idle sessions produce recurring CPU spikes. Frequent elapsed-time updates also render the complete subagent management screen more often than required.

## Current State

Pi computes the full component tree for each `requestRender()` call before writing changed lines to the terminal.

## Desired State

Background component activity requests global rendering only when visible state changes, at a refresh cadence acceptable to users.

## Problem Boundary

This problem covers background render requests from extensions in this package. It does not cover interactive input or streaming updates that change visible state.

## Assumptions

None.

## Open Questions

None.
