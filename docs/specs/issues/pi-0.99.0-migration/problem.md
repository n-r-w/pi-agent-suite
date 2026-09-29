# Problem statement

## Context

The package was pinned to Pi 0.87.1. The requested migration targets Pi 0.99.0 without enabling new Pi features.

## Observed problem

After installing Pi 0.99.0, the repository's type check reports four errors in test fixtures. Tool execution fixtures provide `ExtensionContext` instead of `ExtensionToolContext`. A council startup fixture omits `ToolInfo.exposure`.

## Evidence

- `bun run typecheck` reports errors in `consult-advisor/index.test.ts`, `mcp-wrapper/index.test.ts`, and `convene-council/startup.test.ts`.
- Pi 0.99.0 declares `ToolDefinition.execute()` with `ExtensionToolContext`, which adds `tools` and `executeTool`.
- Pi 0.99.0 requires `exposure` on `ToolInfo`.

## Impact

The type errors block `bun run verify` and prevent release validation against Pi 0.99.0.

## Desired state

Maintainers can validate and load the package on Pi 0.99.0 with the package's tool execution and agent startup behavior preserved.

## Problem boundary

The problem concerns the pinned Pi dependency contract and test fixtures affected by the 0.99.0 API. Adoption of built-in MCP, codemode, llama.cpp loading changes, and the new OpenAI login is outside this migration.

## Open questions

None.
