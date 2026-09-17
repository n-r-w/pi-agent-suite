# Problem Statement

## Context

The MCP wrapper starts configured stdio MCP servers as child processes through `@modelcontextprotocol/client`.

## Observed Problem

The wrapper discards every diagnostic that a stdio MCP server writes to stderr.

## Affected Audience

Users and maintainers who diagnose startup failures, runtime failures, or server warnings from stdio MCP servers.

## Evidence

- `pi-package/extensions/mcp-wrapper/sdk-client-factory.ts` passes `stderr: "ignore"` to every `StdioClientTransport`.
- `@modelcontextprotocol/client@2.0.0` otherwise inherits the parent process stderr by default.

## Impact

Server diagnostics are unavailable after they are emitted. Failures can therefore lack the server-provided information needed to identify their cause.

## Current State

Every configured stdio MCP server starts with its stderr ignored.

## Desired State

Diagnostics from stdio MCP servers remain available in a bounded local log without disrupting the Pi terminal interface.

## Problem Boundary

This problem covers stderr produced by MCP servers that use the stdio transport. It does not cover MCP protocol responses or Streamable HTTP servers.

## Assumptions

None.

## Open Questions

None.
