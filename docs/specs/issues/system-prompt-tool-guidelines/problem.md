# Problem Statement

## Key definitions and abbreviations
Tools supply per-tool guidelines as shared guidance keyed by tool name. Extensions can also supply global guidelines independently of tool selection. Individual tool descriptions accompany tool schemas in the provider tool payload. See [terms.md](terms.md).

## Context
The system-prompt extension replaces Pi's base prompt with a Markdown template. Through `{{toolGuidelines}}`, the formatter inserts shared guidance into that template.

## Observed Problem
At commit `9bc9dfd`, when active tools supplied shared guidance, the replacement prompt omitted their per-tool contributions. As a result, models using the package received tool descriptions without the associated shared instructions.

## Affected Audience
Main agents and subagents with active tools that supply shared guidance receive incomplete tool instructions. For example, agents with active workflow tools miss the shared workflow guidance.

## Evidence
At commit `9bc9dfd`, `formatToolGuidelines` in `pi-package/extensions/system-prompt/index.ts` read only `options.promptGuidelines`.

Pi 1.3.0 supplies per-tool contributions through `options.toolGuidelines` in `AgentSession._rebuildSystemPrompt` in `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`. Because the formatter read only global guidelines, it omitted these per-tool contributions.

## Impact
Agents miss instructions shared by active tools. In particular, workflow agents need the guidance specified in [workflow-format-v2 requirements](../../features/workflow-format-v2/prd.md), FRQ-09.

## Current State
The formatter includes active, visible tools' contributions and global guidelines. Pi can retain per-tool metadata for inactive tools, so the formatter selects contributions by active tool name. See [solution.md](solution.md), SOL-01, for selection and normalization.

## Desired State
The model receives each nonempty normalized contribution once, with per-tool contributions restricted to active, visible tools.

## Problem Boundary
Shared-guideline delivery through the common system-prompt placeholder for main agents and subagents. Individual tool descriptions, workflow execution, and provider tool schemas are outside this problem.

## Assumptions
None.

## Open Questions
None.
