# Idea: Preserve stdio MCP server diagnostics

## Definitions

See [terms.md](terms.md).

## Context and Problem

See [problem.md](problem.md).

## Goal

Preserve stdio MCP server diagnostics without writing them through the Pi terminal interface or allowing the local log set to grow without a size boundary.

## Scenarios

- A stdio MCP server reports a startup failure before initialization completes.
- Several Pi processes append diagnostics from different stdio MCP servers.
- Repeated server diagnostics make the active log exceed its size limit.
- One local append attempt fails transiently.

## Scope and Non-Scope

In scope:

- One shared stdio diagnostic log for every MCP wrapper process.
- Configured server key and available MCP server name on each appended stderr chunk.
- Best-effort size-based rotation and one append retry.

Out of scope:

- Guaranteed ordering or retention during concurrent writes and rotation.
- Filtering, redaction, parsing, or display in the Pi terminal interface.
- User-configurable logging behavior.
- Streamable HTTP diagnostics.

## Requirements

### Functional Requirements

- [X] FRQ-01: The wrapper shall append each received stdio MCP server stderr chunk to `mcp-wrapper/stdio.log` under the agent-suite directory.
  - Origin: source. The user selected a shared local log instead of terminal output.
  - Goal: Preserve stdio MCP server diagnostics outside the terminal interface.
  - Goal achievement: Full. Each received chunk has a persistent local destination.
- [X] FRQ-02: Each appended record shall contain the timestamp, configured server key, and MCP server name without field labels.
  - Origin: source. The user selected the minimal shared-file design, excluded process identifiers, and required both server identities.
  - Goal: Distinguish the wrapper route and the MCP implementation that produced each diagnostic.
  - Goal achievement: Full. Each record uses `[configured-key] [server-name]`; startup records use `initializing`, and connected servers without a reported name use `unnamed`.
- [X] FRQ-03: A failed append shall be retried once and discarded after a second failure.
  - Origin: source. The user requested one retry without complex recovery.
  - Goal: Tolerate a transient local file-open or write failure.
  - Goal achievement: Full. One additional append attempt occurs before discard.
- [X] FRQ-04: When `stdio.log` exceeds 5 MiB, the wrapper shall replace `stdio.log.1` with it before appending to a new active log.
  - Origin: source. The user selected minimal bounded rotation in O10-1.
  - Goal: Prevent accumulated diagnostics from growing without a size boundary across writes.
  - Goal achievement: Full. The log set contains one active file and one archive.

### Non-Functional Requirements

- [X] NRQ-01: Concurrent append and rotation races may lose or archive nearby diagnostic records but shall not block MCP server operation.
  - Origin: source. The user explicitly accepted diagnostic loss from concurrent local writes.
  - Goal: Keep local logging simple and independent from MCP availability.
  - Goal achievement: Full. Logging failures and races do not propagate to MCP operations.

## Open Questions

None.

## Technical Supplement

See [solution.md](solution.md).

## References

- [MCP wrapper documentation](../../../extensions/mcp-wrapper.md)
