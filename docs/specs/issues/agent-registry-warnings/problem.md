# Problem statement

## Context

Pi users define main agents and subagents in global and project Markdown files.

## Observed problem

A user cannot determine why an agent is missing from the selector when the loader skips its definition without reporting the failure.

## Affected audience

Users who maintain agent definitions or diagnose missing agents.

## Evidence

A definition with an unindented continuation of the YAML `tools` list causes the frontmatter parser to throw. The registry previously caught that exception and excluded the definition silently. Invalid metadata and ambiguous project filenames also caused silent exclusions.

## Impact

Users must run a separate parser or inspect extension code to discover why an agent is unavailable.

## Desired state

Users can identify the affected file and the reason an agent is unavailable while continuing to use Pi.

## Problem boundary

Failures while discovering, reading, and validating agent definitions, including project filename collisions after Unicode normalization.

## Open questions

None.
